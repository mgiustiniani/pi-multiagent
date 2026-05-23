#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="${PROJECT_ROOT:-$(pwd)}"
DATA_DIR="${STRUCTURIZR_DATA_DIR:-$ROOT_DIR/docs/c4}"
PORT="${STRUCTURIZR_PORT:-9090}"
AUTO_REFRESH="${STRUCTURIZR_AUTOREFRESHINTERVAL:-2000}"
AUTO_SAVE="${STRUCTURIZR_AUTOSAVEINTERVAL:-5000}"
IMAGE="${STRUCTURIZR_IMAGE:-docker.io/structurizr/structurizr}"

if [[ -n "${CONTAINER_RUNTIME:-}" ]]; then
  RUNTIME="$CONTAINER_RUNTIME"
elif command -v podman >/dev/null 2>&1; then
  RUNTIME="podman"
elif command -v docker >/dev/null 2>&1; then
  RUNTIME="docker"
else
  echo "Podman or Docker is required to run Structurizr local." >&2
  exit 1
fi

# Run as the host user so Structurizr local can write workspace.json/layout
# into the bind-mounted data directory without changing file ownership.
RUN_ARGS=(--user "$(id -u):$(id -g)")
if [[ "$RUNTIME" == "podman" ]]; then
  RUN_ARGS=(--userns=keep-id "${RUN_ARGS[@]}")
fi

mkdir -p "$DATA_DIR"
if [[ ! -f "$DATA_DIR/structurizr.properties" && -f "$SKILL_DIR/templates/c4/structurizr.properties" ]]; then
  cp "$SKILL_DIR/templates/c4/structurizr.properties" "$DATA_DIR/structurizr.properties"
fi

echo "Starting Structurizr local"
echo "  runtime:        $RUNTIME"
echo "  image:          $IMAGE"
echo "  data directory: $DATA_DIR"
echo "  URL:            http://localhost:$PORT"

"$RUNTIME" pull "$IMAGE" >/dev/null
exec "$RUNTIME" run -it --rm "${RUN_ARGS[@]}" \
  -p "$PORT:$PORT" \
  -e PORT="$PORT" \
  -e STRUCTURIZR_AUTOREFRESHINTERVAL="$AUTO_REFRESH" \
  -e STRUCTURIZR_AUTOSAVEINTERVAL="$AUTO_SAVE" \
  -v "$DATA_DIR:/usr/local/structurizr" \
  "$IMAGE" local
