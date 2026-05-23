#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${PROJECT_ROOT:-$(pwd)}"
DATA_DIR="${STRUCTURIZR_DATA_DIR:-$ROOT_DIR/docs/c4}"
WORKSPACE="${STRUCTURIZR_WORKSPACE:-workspace.dsl}"
IMAGE="${STRUCTURIZR_IMAGE:-docker.io/structurizr/structurizr}"

if [[ -n "${CONTAINER_RUNTIME:-}" ]]; then
  RUNTIME="$CONTAINER_RUNTIME"
elif command -v podman >/dev/null 2>&1; then
  RUNTIME="podman"
elif command -v docker >/dev/null 2>&1; then
  RUNTIME="docker"
else
  echo "Podman or Docker is required to validate with the Structurizr vNext command image." >&2
  exit 1
fi

RUN_ARGS=(--user "$(id -u):$(id -g)")
if [[ "$RUNTIME" == "podman" ]]; then
  RUN_ARGS=(--userns=keep-id "${RUN_ARGS[@]}")
fi

if [[ ! -f "$DATA_DIR/$WORKSPACE" ]]; then
  echo "Workspace not found: $DATA_DIR/$WORKSPACE" >&2
  exit 1
fi

"$RUNTIME" run --rm "${RUN_ARGS[@]}" \
  -v "$DATA_DIR:/usr/local/structurizr" \
  "$IMAGE" validate \
  -workspace "/usr/local/structurizr/$WORKSPACE"
