#!/usr/bin/env bash
# OpenSearch MCP Server wrapper for NanoClaw SIEM
#
# - Loads credentials from .env in the same directory
# - Runs the MCP server from the local .venv (no host Python conflicts)
#
# This script is called by Claude Code as the MCP server command.
# Do not run it directly — use `claude` from the siem/ directory instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load credentials from .env
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$SCRIPT_DIR/.env"
    set +a
else
    echo "[opensearch-mcp] ERROR: .env not found at $SCRIPT_DIR/.env" >&2
    echo "[opensearch-mcp] Run setup.sh first and fill in your OpenSearch credentials." >&2
    exit 1
fi

VENV_PYTHON="$SCRIPT_DIR/.venv/bin/python"

if [[ ! -x "$VENV_PYTHON" ]]; then
    echo "[opensearch-mcp] ERROR: venv not found at $SCRIPT_DIR/.venv" >&2
    echo "[opensearch-mcp] Run setup.sh to create the virtual environment." >&2
    exit 1
fi

exec "$SCRIPT_DIR/.venv/bin/opensearch-mcp-server"
