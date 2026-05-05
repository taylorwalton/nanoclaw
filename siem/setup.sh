#!/usr/bin/env bash
# NanoClaw SIEM — one-time setup
#
# What this does:
#   1. Creates a Python virtual environment (.venv/) to avoid host Python conflicts
#   2. Installs opensearch-mcp-server into it
#   3. Creates .env from .env.example if not already present
#   4. Generates .claude/settings.json with the absolute path to opensearch-mcp.sh
#
# After running this, edit .env with your OpenSearch credentials, then:
#   cd siem && claude

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
ENV_FILE="$SCRIPT_DIR/.env"
SETTINGS_FILE="$SCRIPT_DIR/.claude/settings.json"
MCP_WRAPPER="$SCRIPT_DIR/opensearch-mcp.sh"

echo "=== NanoClaw SIEM Setup ==="
echo ""

# ── Python check ─────────────────────────────────────────────────────────────
# opensearch-mcp-server requires Python 3.10–3.13 (pydantic-core has no 3.14 wheel yet).
# Prefer the highest compatible version found on the system.
PYTHON_BIN=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" &>/dev/null; then
        ver=$("$candidate" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
        major=$(echo "$ver" | cut -d. -f1)
        minor=$(echo "$ver" | cut -d. -f2)
        if [[ "$major" -eq 3 && "$minor" -ge 10 && "$minor" -le 13 ]]; then
            PYTHON_BIN="$candidate"
            PYTHON_VERSION="$ver"
            break
        fi
    fi
done

if [[ -z "$PYTHON_BIN" ]]; then
    echo "ERROR: Python 3.10–3.13 is required (pydantic-core does not yet support 3.14+)."
    echo "       Install Python 3.13 via Homebrew: brew install python@3.13"
    exit 1
fi

echo "Using $PYTHON_BIN ($PYTHON_VERSION)  ✓"

# ── Virtual environment ───────────────────────────────────────────────────────
# Recreate if:
#   1. Missing entirely.
#   2. Has no pip (Debian/Ubuntu strip ensurepip from python3-venv).
#   3. Has a stale shebang in pip pointing at a path that doesn't exist —
#      happens when the venv was rsync'd or restored from another host. The
#      old shebang lingers (e.g. #!/opt/talon/siem/.venv/bin/python from the
#      build host) and pip silently fails with "no such file" before its own
#      logic runs.
_venv_pip_shebang_stale() {
    [[ -f "$VENV_DIR/bin/pip" ]] || return 1
    local shebang
    shebang=$(head -n 1 "$VENV_DIR/bin/pip" 2>/dev/null)
    # Strip the leading `#!` and any args, take the first token (the interpreter).
    local interp="${shebang#\#!}"
    interp="${interp%% *}"
    [[ -n "$interp" && ! -x "$interp" ]]
}

needs_recreate=0
reason=""
if [[ ! -d "$VENV_DIR" ]]; then
    needs_recreate=1
    reason="Creating virtual environment..."
elif [[ ! -f "$VENV_DIR/bin/pip" ]]; then
    needs_recreate=1
    reason="Virtual environment missing pip — recreating..."
elif _venv_pip_shebang_stale; then
    needs_recreate=1
    reason="Virtual environment has stale pip shebang (likely copied from another host) — recreating..."
fi

if [[ "$needs_recreate" -eq 1 ]]; then
    [[ -d "$VENV_DIR" ]] && rm -rf "$VENV_DIR"
    echo "$reason"
    "$PYTHON_BIN" -m venv "$VENV_DIR"
    # Bootstrap pip on distros that strip ensurepip (Debian/Ubuntu)
    if [[ ! -f "$VENV_DIR/bin/pip" ]]; then
        "$VENV_DIR/bin/python" -m ensurepip --upgrade 2>/dev/null || \
            curl -sS https://bootstrap.pypa.io/get-pip.py | "$VENV_DIR/bin/python"
    fi
else
    echo "Virtual environment exists  ✓"
fi

# ── Install dependencies ──────────────────────────────────────────────────────
echo "Installing dependencies..."
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$SCRIPT_DIR/requirements.txt"
echo "Dependencies installed  ✓"

# ── .env ─────────────────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
    cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
    echo ""
    echo "  Created .env from template."
    echo "  ➜ Edit $ENV_FILE with your OpenSearch credentials before running 'claude'."
    echo ""
else
    echo ".env exists  ✓"
fi

# ── Claude Code MCP settings ─────────────────────────────────────────────────
chmod +x "$MCP_WRAPPER"
mkdir -p "$SCRIPT_DIR/.claude"

cat > "$SETTINGS_FILE" <<EOF
{
  "mcpServers": {
    "opensearch": {
      "command": "$MCP_WRAPPER",
      "env": {}
    }
  }
}
EOF

echo "Generated .claude/settings.json  ✓"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
if grep -q "your-opensearch-host" "$ENV_FILE" 2>/dev/null; then
    echo "  1. Edit siem/.env with your OpenSearch URL, username, and password"
    echo "  2. cd $(basename "$SCRIPT_DIR") && claude"
else
    echo "  1. cd $(basename "$SCRIPT_DIR") && claude"
fi
echo ""
