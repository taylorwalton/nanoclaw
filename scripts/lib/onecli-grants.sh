# shellcheck shell=bash
#
# Shared helper: attach a Vault secret to every OneCLI agent.
#
# Source this after defining log()/warn() (fallbacks are provided below).
# Requires: onecli, curl, python3.
#
# OneCLI has two generations of this API:
#
#   grants (current)  onecli agents grants list|attach-secret
#   legacy  (<=1.18)  onecli agents secrets|set-secrets
#
# The legacy endpoints were removed server-side and now answer with
# {"error": "... was removed ...", "code": "GONE"} while STILL being listed
# in `onecli agents --help`. Help output is therefore not a usable capability
# probe — we probe the live gateway instead and pick a path from the response.
#
# Callers use onecli_attach_secret_to_all_agents <secret_id> <onecli_url>.

type log  >/dev/null 2>&1 || log()  { printf '[onecli-grants] %s\n' "$*"; }
type warn >/dev/null 2>&1 || warn() { printf '[onecli-grants] WARN: %s\n' "$*" >&2; }

# The onecli CLI exits non-zero on failure but ALSO prints {"error": ...} JSON.
# Check both: a future version that keeps exiting 0 on error still gets caught.
_onecli_json_error() {
  printf '%s' "$1" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
except Exception:
  sys.exit(0)
if isinstance(d, dict) and d.get('error'):
  print(d['error'])
" 2>/dev/null || true
}

# Sets _ONECLI_GRANTS_API to "grants" or "legacy". Probes once per run.
_onecli_detect_grants_api() {
  [ -n "${_ONECLI_GRANTS_API:-}" ] && return 0

  local probe_agent=$1 out err
  out=$(onecli agents grants list --id "$probe_agent" 2>&1) || true
  err=$(_onecli_json_error "$out")

  if [ -z "$err" ] && printf '%s' "$out" | grep -q '"secrets"'; then
    _ONECLI_GRANTS_API="grants"
  else
    _ONECLI_GRANTS_API="legacy"
    warn "grants API unavailable ($err) — falling back to legacy set-secrets"
    warn "if this OneCLI is current, upgrade the gateway rather than trusting the fallback"
  fi
}

# Current API: read grants, attach only when missing.
_onecli_attach_secret_grants() {
  local agent_id=$1 agent_label=$2 secret_id=$3 out err

  out=$(onecli agents grants list --id "$agent_id" 2>&1) || true
  err=$(_onecli_json_error "$out")
  if [ -n "$err" ]; then
    warn "  agent '$agent_label': cannot read grants — $err"
    return 1
  fi

  if printf '%s' "$out" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ids = {s.get('secretId') for s in d.get('secrets', []) if isinstance(s, dict)}
sys.exit(0 if '$secret_id' in ids else 1)
" 2>/dev/null; then
    log "  agent '$agent_label': already granted"
    return 0
  fi

  out=$(onecli agents grants attach-secret --id "$agent_id" --secret-id "$secret_id" 2>&1) || true
  err=$(_onecli_json_error "$out")
  if [ -n "$err" ]; then
    warn "  agent '$agent_label': attach-secret failed — $err"
    return 1
  fi
  log "  agent '$agent_label': granted"
}

# Legacy API: set-secrets REPLACES the list, so read-append-write.
_onecli_attach_secret_legacy() {
  local agent_id=$1 agent_label=$2 secret_id=$3 current new_list out err

  current=$(onecli agents secrets --id "$agent_id" 2>/dev/null | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  if isinstance(d, dict): d = d.get('data', [])
  print(','.join(d))
except Exception:
  print('')
" 2>/dev/null || echo "")

  case ",$current," in
    *",$secret_id,"*) log "  agent '$agent_label': already assigned"; return 0 ;;
  esac

  if [ -z "$current" ]; then
    new_list="$secret_id"
  else
    new_list="${current},${secret_id}"
  fi

  out=$(onecli agents set-secrets --id "$agent_id" --secret-ids "$new_list" 2>&1) || true
  err=$(_onecli_json_error "$out")
  if [ -n "$err" ]; then
    warn "  agent '$agent_label': set-secrets failed — $err"
    return 1
  fi
  log "  agent '$agent_label': assigned"
}

# Attach $1 to every agent the gateway at $2 knows about.
# Returns non-zero if any agent failed, so callers can surface a real error.
onecli_attach_secret_to_all_agents() {
  local secret_id=$1 onecli_url=$2 agents failures=0 aid aname

  if [ -z "$secret_id" ]; then
    warn "could not determine secret ID — skipping agent assignment"
    return 1
  fi

  agents=$(curl -sf -m 5 "${onecli_url}/api/agents" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
if isinstance(d, dict): d = d.get('data', [])
for a in d:
  print(a.get('id', '') + '\t' + a.get('identifier', '?'))
" 2>/dev/null || true)

  if [ -z "$agents" ]; then
    warn "no agents returned by ${onecli_url}/api/agents — nothing to grant"
    return 1
  fi

  log "granting secret to all agents..."
  # Fed by here-string, not a pipe, so the loop runs in this shell and
  # failures actually reach the caller.
  while IFS=$'\t' read -r aid aname; do
    [ -n "$aid" ] || continue
    _onecli_detect_grants_api "$aid"
    if [ "$_ONECLI_GRANTS_API" = "grants" ]; then
      _onecli_attach_secret_grants "$aid" "$aname" "$secret_id" || failures=$((failures + 1))
    else
      _onecli_attach_secret_legacy "$aid" "$aname" "$secret_id" || failures=$((failures + 1))
    fi
  done <<< "$agents"

  if [ "$failures" -gt 0 ]; then
    warn "$failures agent(s) did not receive the secret — containers using them will fail with 401"
    return 1
  fi
}
