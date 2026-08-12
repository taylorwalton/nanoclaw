#!/usr/bin/env bash
# Migrate the SIEM (OpenSearch) credential from siem/.env to the OneCLI Vault.
#
# Default behavior (safe):
#   - Reads OPENSEARCH_HOSTS / OPENSEARCH_USERNAME / OPENSEARCH_PASSWORD
#     from siem/.env
#   - Registers a generic Vault secret that injects
#     "Authorization: Basic <base64(user:pass)>" on requests to the
#     OpenSearch host
#   - Assigns the secret to every detected OneCLI agent
#   - Leaves siem/.env untouched so you can verify before stripping
#
# With --strip-env:
#   - Backs up siem/.env, replaces real OPENSEARCH_USERNAME/PASSWORD
#     values with the literal "vault-managed" so the MCP server still
#     starts (most opensearch clients require non-empty creds even
#     when the auth header is overridden by a proxy)
#
# Idempotent: re-running detects an existing Vault secret with the same
# name and skips the create call.
#
# Exit codes:
#   0 = secret registered and granted to every agent
#   1 = preflight failed (no onecli, no siem/.env, no creds, gateway down)
#   2 = secret create call failed
#   3 = python3 missing (required for JSON parsing)
#   4 = secret registered but one or more agents were not granted access

set -euo pipefail

ENV_FILE="${ENV_FILE:-$(pwd)/.env}"
SIEM_DIR="${SIEM_DIR:-$(pwd)/siem}"
SIEM_ENV="${SIEM_ENV:-$SIEM_DIR/.env}"
SECRET_NAME="${SECRET_NAME:-OpenSearch-SIEM}"
STRIP_ENV=0

for arg in "$@"; do
  case "$arg" in
    --strip-env) STRIP_ENV=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# //;s/^#//'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

log()  { printf '[migrate-siem] %s\n' "$*"; }
warn() { printf '[migrate-siem] WARN: %s\n' "$*" >&2; }
fail() { printf '[migrate-siem] FAIL: %s\n' "$*" >&2; exit "${2:-1}"; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/onecli-grants.sh
. "$SCRIPT_DIR/lib/onecli-grants.sh"

GRANT_FAILED=0

# --- Phase 0: prerequisites ---

command -v onecli  >/dev/null || fail "onecli not in PATH — run scripts/install-onecli.sh first" 1
command -v curl    >/dev/null || fail "curl not in PATH" 1
command -v base64  >/dev/null || fail "base64 not in PATH" 1
command -v python3 >/dev/null || fail "python3 required for JSON parsing — apt install python3" 3
[ -f "$SIEM_ENV" ] || fail "siem/.env not found at $SIEM_ENV — run from your nanoclaw install dir" 1
[ -f "$ENV_FILE" ] || fail ".env not found at $ENV_FILE — run from your nanoclaw install dir" 1

# Read ONECLI_URL from project .env
ONECLI_URL="${ONECLI_URL:-}"
if [ -z "$ONECLI_URL" ]; then
  ONECLI_URL=$( { grep -E '^ONECLI_URL=' "$ENV_FILE" 2>/dev/null || true; } | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
fi
[ -n "$ONECLI_URL" ] || fail "ONECLI_URL not set in .env — run install-onecli.sh first" 1

curl -sf -m 5 "${ONECLI_URL}/api/health" >/dev/null \
  || fail "OneCLI gateway not healthy at $ONECLI_URL" 1
log "OneCLI gateway healthy at $ONECLI_URL"

# --- Phase 1: read SIEM creds from siem/.env ---

get_env_value() {
  local raw
  raw=$( { grep -E "^${1}=" "$SIEM_ENV" 2>/dev/null || true; } | head -1 | cut -d= -f2- || true)
  printf '%s' "$raw" | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//'
}

OS_HOSTS=$(get_env_value OPENSEARCH_HOSTS)
OS_USER=$(get_env_value OPENSEARCH_USERNAME)
OS_PASS=$(get_env_value OPENSEARCH_PASSWORD)

[ -n "$OS_HOSTS" ] || fail "OPENSEARCH_HOSTS not found in $SIEM_ENV" 1
[ -n "$OS_USER" ]  || fail "OPENSEARCH_USERNAME not found in $SIEM_ENV" 1
[ -n "$OS_PASS" ]  || fail "OPENSEARCH_PASSWORD not found in $SIEM_ENV" 1

# Extract bare host (strip scheme + port + path)
HOST_ONLY=$(printf '%s' "$OS_HOSTS" | sed -E 's#^https?://##; s#[:/].*##')
[ -n "$HOST_ONLY" ] || fail "could not parse host from OPENSEARCH_HOSTS=$OS_HOSTS" 1

log "found OpenSearch creds in $SIEM_ENV"
log "  host:  $HOST_ONLY"
log "  user:  $OS_USER"
log "  pass:  …(len=${#OS_PASS})"

# --- Phase 2: idempotency check ---

EXISTING_ID=$(curl -sf -m 5 "${ONECLI_URL}/api/secrets" 2>/dev/null | python3 -c "
import sys, json
try:
  data = json.load(sys.stdin)
  if isinstance(data, dict): data = data.get('data', [])
  for s in data:
    if s.get('name') == '$SECRET_NAME':
      print(s.get('id', ''))
      break
except Exception:
  pass
" 2>/dev/null || echo "")

if [ -n "$EXISTING_ID" ]; then
  log "Vault secret '$SECRET_NAME' already exists — id=$EXISTING_ID"
  log "skipping create. To replace: onecli secrets delete --id $EXISTING_ID && re-run"
  SECRET_ID="$EXISTING_ID"
else
  # base64-encode user:pass for Basic auth
  B64=$(printf '%s:%s' "$OS_USER" "$OS_PASS" | base64 | tr -d '\n')

  log "registering '$SECRET_NAME' in Vault (type=generic, host=$HOST_ONLY)"
  log "  injection: Authorization: Basic <base64(user:pass)>"

  if onecli secrets create \
       --name "$SECRET_NAME" \
       --type generic \
       --value "$B64" \
       --host-pattern "$HOST_ONLY" \
       --header-name Authorization \
       --value-format 'Basic {value}' >/dev/null 2>&1; then
    log "secret registered successfully"
    SECRET_ID=$(curl -sf -m 5 "${ONECLI_URL}/api/secrets" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, dict): data = data.get('data', [])
for s in data:
  if s.get('name') == '$SECRET_NAME':
    print(s.get('id', ''))
    break
" 2>/dev/null || echo "")
  else
    fail "onecli secrets create failed — try manually with -v output to debug" 2
  fi
fi

# --- Phase 3: grant secret to all detected agents ---
#
# Registering a secret does NOT make it usable — each agent needs an explicit
# grant or the gateway refuses injection. See scripts/lib/onecli-grants.sh.

onecli_attach_secret_to_all_agents "${SECRET_ID:-}" "$ONECLI_URL" || GRANT_FAILED=1

# --- Phase 4: optionally strip the cred from siem/.env ---

if [ "$STRIP_ENV" -eq 1 ]; then
  BACKUP_FILE="$SIEM_ENV.pre-vault.$(date +%Y%m%d-%H%M%S)"
  cp -p "$SIEM_ENV" "$BACKUP_FILE"
  log "backed up siem/.env -> $BACKUP_FILE"

  # Replace credential values with "vault-managed" so opensearch-mcp-server
  # still starts (the lib usually requires non-empty creds even when the
  # actual auth header gets overridden by the proxy)
  sed -i -E "s|^OPENSEARCH_USERNAME=.*|OPENSEARCH_USERNAME=vault-managed|" "$SIEM_ENV"
  sed -i -E "s|^OPENSEARCH_PASSWORD=.*|OPENSEARCH_PASSWORD=vault-managed|" "$SIEM_ENV"
  log "replaced OPENSEARCH_USERNAME/PASSWORD with 'vault-managed' in $SIEM_ENV"
else
  warn "OPENSEARCH_USERNAME/PASSWORD still in $SIEM_ENV — re-run with --strip-env to remove"
  warn "(safe to leave for now; OneCLI takes precedence at the network layer)"
fi

# --- Phase 5: report + verify instructions ---

echo
log "DONE."
log "  Vault secret:   $SECRET_NAME (generic, host=$HOST_ONLY)"
log "  Injection:      Authorization: Basic <base64(user:pass)>"
log "  siem/.env:      $([ "$STRIP_ENV" -eq 1 ] && echo "creds stripped (backup: $(basename "${BACKUP_FILE:-?}"))" || echo "left in place")"
echo
log "NEXT — restart Talon and trigger a SIEM query to test:"
echo
log "  Linux:    sudo systemctl restart talon"
log "  macOS:    launchctl kickstart -k gui/\$(id -u)/com.nanoclaw"
echo
log "Then send a message to the agent that triggers an OpenSearch query"
log "(e.g. ask it to investigate an alert, list indices, or run a search)."
echo
log "Watch the container logs for SIEM activity:"
log "  ls -lt \$(pwd)/groups/copilot/logs/ | head -3"
log "  tail -f \$(pwd)/groups/copilot/logs/<latest>.log"
echo

if [ "$STRIP_ENV" -eq 0 ]; then
cat <<EOF
Once verified, replace the raw creds with vault-managed placeholders:
  bash scripts/migrate-siem-to-vault.sh --strip-env

ROLLBACK (if anything breaks):
  onecli secrets delete --id ${SECRET_ID:-<id from: onecli secrets list>}
  sudo systemctl restart talon

EOF
else
cat <<EOF
ROLLBACK (if anything breaks):
  cp '$BACKUP_FILE' '$SIEM_ENV'
  onecli secrets delete --id ${SECRET_ID:-<id>}
  sudo systemctl restart talon

EOF
fi

if [ "$GRANT_FAILED" -ne 0 ]; then
  warn "secret is in the Vault but NOT granted to every agent — those groups will 401."
  warn "inspect with: onecli agents grants list --id <agent id from: onecli agents list>"
  warn "grant with:   onecli agents grants attach-secret --id <agent id> --secret-id ${SECRET_ID:-<secret id>}"
  exit 4
fi
