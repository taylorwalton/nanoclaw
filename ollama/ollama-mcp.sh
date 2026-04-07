#!/usr/bin/env bash
# Ollama MCP server wrapper for NanoClaw
#
# Starts the Ollama MCP stdio server, which exposes ollama_generate,
# ollama_list_models, ollama_pull_model, and related tools to the agent.
#
# Ollama is OPTIONAL. If it is not reachable, this script exits cleanly
# and the agent simply has no ollama_* tools for this session.
#
# Default Ollama endpoint: http://host.docker.internal:11434 (inside container)
# Override by setting OLLAMA_HOST in ollama/.env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load optional .env (OLLAMA_HOST override, etc.)
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$SCRIPT_DIR/.env"
    set +a
fi

# Determine Ollama host — prefer env override, then container default, then localhost
OLLAMA_HOST="${OLLAMA_HOST:-}"
if [[ -z "$OLLAMA_HOST" ]]; then
    # Inside the container, the host machine is reachable via host.docker.internal
    # On the host itself, fall back to localhost
    if grep -q "docker\|container" /proc/1/cgroup 2>/dev/null || \
       [[ -f /.dockerenv ]] || [[ -f /run/.containerenv ]]; then
        OLLAMA_HOST="http://host.docker.internal:11434"
    else
        OLLAMA_HOST="http://localhost:11434"
    fi
fi
export OLLAMA_HOST

# Check if Ollama is reachable before starting the MCP server.
# A failed check exits 0 — an unavailable Ollama is not an error.
if ! curl -sf --max-time 3 "${OLLAMA_HOST}/api/tags" > /dev/null 2>&1; then
    echo "[ollama-mcp] Ollama not reachable at ${OLLAMA_HOST} — skipping (not an error)" >&2
    exit 0
fi

# Ollama is up — start the MCP server
LOCAL_JS="$SCRIPT_DIR/../container/agent-runner/dist/ollama-mcp-stdio.js"
CONTAINER_JS="/app/dist/ollama-mcp-stdio.js"

if [[ -f "$CONTAINER_JS" ]]; then
    exec node "$CONTAINER_JS"
elif [[ -f "$LOCAL_JS" ]]; then
    exec node "$LOCAL_JS"
else
    echo "[ollama-mcp] ERROR: ollama-mcp-stdio.js not found." >&2
    echo "[ollama-mcp]   In a container: rebuild the image (container/build.sh)" >&2
    echo "[ollama-mcp]   On the host: run npm run build in container/agent-runner/" >&2
    exit 1
fi
