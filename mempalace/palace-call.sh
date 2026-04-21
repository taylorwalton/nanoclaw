#!/usr/bin/env bash
# One-shot MemPalace helper invoked by NanoClaw's node process.
#
# Wraps palace_call.py with the same venv-resolution logic as
# mempalace-mcp.sh so the script works both on the host (developer machine)
# and inside the agent container image.
#
# Reads a JSON request on stdin, writes a JSON response on stdout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$SCRIPT_DIR/.env"
    set +a
fi

PALACE_PATH="${MEMPALACE_PALACE_PATH:-$SCRIPT_DIR/../mempalace-data/palace}"
export MEMPALACE_PALACE_PATH="$PALACE_PATH"

LOCAL_PYTHON="$SCRIPT_DIR/.venv/bin/python3"
SYSTEM_PYTHON="/opt/mempalace/bin/python3"

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

if _is_native_exec "$LOCAL_PYTHON"; then
    PYTHON="$LOCAL_PYTHON"
elif [[ -x "$SYSTEM_PYTHON" ]]; then
    PYTHON="$SYSTEM_PYTHON"
else
    echo '{"error": "python3 not found — run mempalace/setup.sh"}' >&2
    exit 1
fi

exec "$PYTHON" "$SCRIPT_DIR/palace_call.py"
