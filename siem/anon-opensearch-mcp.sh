#!/usr/bin/env bash
# Anonymizing OpenSearch MCP proxy for NanoClaw
#
# Wraps opensearch-mcp-server and anonymizes tool results before they reach
# the cloud model. Sensitive field values are replaced with consistent tokens
# (USER_1, HOST_1, IP_INT_1, etc.). A built-in `deanonymize` tool reverses
# the substitution for report writing.
#
# Field definitions live in anon_proxy/fields.yaml — git pull to get updates.
# Token map is persisted at /workspace/group/session_tokens.json.
#
# This script is called by Claude Code as the MCP server command.
# Do not run it directly — start NanoClaw normally.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_SCRIPT="$SCRIPT_DIR/anon_proxy/anon_proxy.py"

LOCAL_PYTHON="$SCRIPT_DIR/.venv/bin/python3"
SYSTEM_PYTHON="/opt/opensearch-mcp/bin/python3"

# Check if a binary is native to the current OS (handles macOS venv in Linux container)
_is_native_exec() {
    local bin="$1"
    [[ -x "$bin" ]] || return 1
    if [[ "$(uname -s)" == "Linux" ]]; then
        local magic
        magic=$(head -c 4 "$bin" 2>/dev/null | od -An -tx1 | tr -d ' \n')
        [[ "$magic" == "7f454c46" ]] || return 1
    fi
    return 0
}

# Try the local siem venv first, then fall back to the container's system venv.
#
# Two booby-traps we have to avoid here:
#
#   1. Stale pip shebang. `.venv/bin/pip` is a python script with a hard-coded
#      shebang baked in at venv creation time (e.g.
#      `#!/opt/talon/siem/.venv/bin/python`). When the venv was built on a
#      different machine and rsync'd / restored to this host, that shebang
#      points at a path that doesn't exist locally — bare `pip install ...`
#      then fails with "no such file or directory" before pip's logic even
#      runs. Workaround: invoke pip via the python interpreter
#      (`python -m pip`) which bypasses pip's shebang entirely.
#
#   2. `set -e` killing the script on local-venv failure. The previous
#      `cmd1 || cmd2` pattern, where cmd2 was the pip install, triggers
#      `set -e` exit if cmd2 fails — set -e treats the command after the
#      final `||` as a normal terminating command. We wrap the local-venv
#      branch in `if/then/fi` so a failure naturally falls through to the
#      system-venv fallback instead of aborting the whole script.

_try_python() {
    local py="$1"
    [[ -x "$py" ]] || return 1
    # If pyyaml already importable, we're done.
    if "$py" -c "import yaml" 2>/dev/null; then
        return 0
    fi
    # Otherwise install via `python -m pip` (NOT bare pip — that has the stale
    # shebang trap). Suppress noise; surface only fatal failures via exit code.
    "$py" -m pip install --quiet pyyaml >&2 2>/dev/null
}

if _is_native_exec "$LOCAL_PYTHON" && _try_python "$LOCAL_PYTHON"; then
    exec "$LOCAL_PYTHON" "$PROXY_SCRIPT"
fi

if [[ -x "$SYSTEM_PYTHON" ]] && _try_python "$SYSTEM_PYTHON"; then
    exec "$SYSTEM_PYTHON" "$PROXY_SCRIPT"
fi

echo "[anon-opensearch-mcp] ERROR: no working python3 environment found." >&2
echo "[anon-opensearch-mcp]   Tried: $LOCAL_PYTHON" >&2
echo "[anon-opensearch-mcp]   Tried: $SYSTEM_PYTHON" >&2
echo "[anon-opensearch-mcp]   In a container: rebuild the image (container/build.sh)" >&2
echo "[anon-opensearch-mcp]   On the host: rerun siem/setup.sh to recreate the venv" >&2
exit 1
