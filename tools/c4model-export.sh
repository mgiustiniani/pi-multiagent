#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${PROJECT_ROOT:-$(pwd)}"
DATA_DIR="${STRUCTURIZR_DATA_DIR:-$ROOT_DIR/docs/c4}"
FORMAT="${1:-${STRUCTURIZR_EXPORT_FORMAT:-static}}"

if [[ "$FORMAT" == "png" || "$FORMAT" == "svg" ]]; then
  # Workspace export is the safe default; use STRUCTURIZR_IMAGE_SOURCE=url only when Structurizr local is already running.
  exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/c4model-export-images.sh" "$FORMAT" "${STRUCTURIZR_IMAGE_SOURCE:-workspace}"
fi

IMAGE="${STRUCTURIZR_IMAGE:-docker.io/structurizr/structurizr}"

if [[ -n "${CONTAINER_RUNTIME:-}" ]]; then
  RUNTIME="$CONTAINER_RUNTIME"
elif command -v podman >/dev/null 2>&1; then
  RUNTIME="podman"
elif command -v docker >/dev/null 2>&1; then
  RUNTIME="docker"
else
  echo "Podman or Docker is required to run Structurizr export." >&2
  exit 1
fi

RUN_ARGS=(--user "$(id -u):$(id -g)")
if [[ "$RUNTIME" == "podman" ]]; then
  RUN_ARGS=(--userns=keep-id "${RUN_ARGS[@]}")
fi

# workspace.json preserves manual layout saved by Structurizr local.
# Fall back to workspace.dsl when no curated layout has been saved yet.
if [[ -f "$DATA_DIR/workspace.json" ]]; then
  WORKSPACE="workspace.json"
elif [[ -f "$DATA_DIR/workspace.dsl" ]]; then
  WORKSPACE="workspace.dsl"
else
  echo "No workspace.json or workspace.dsl found in $DATA_DIR" >&2
  exit 1
fi

case "$FORMAT" in
  png|svg)
    OUTPUT_DIR="${STRUCTURIZR_EXPORT_OUTPUT:-images}"
    ;;
  static)
    OUTPUT_DIR="${STRUCTURIZR_EXPORT_OUTPUT:-export/static}"
    ;;
  plantuml|plantuml/structurizr|plantuml/c4plantuml|mermaid|websequencediagrams|json|theme)
    SAFE_FORMAT="${FORMAT//\//-}"
    OUTPUT_DIR="${STRUCTURIZR_EXPORT_OUTPUT:-export/$SAFE_FORMAT}"
    ;;
  *)
    SAFE_FORMAT="${FORMAT//\//-}"
    OUTPUT_DIR="${STRUCTURIZR_EXPORT_OUTPUT:-export/$SAFE_FORMAT}"
    ;;
esac

mkdir -p "$DATA_DIR/$OUTPUT_DIR"

echo "Running Structurizr export"
echo "  runtime:   $RUNTIME"
echo "  image:     $IMAGE"
echo "  workspace: $DATA_DIR/$WORKSPACE"
echo "  format:    $FORMAT"
echo "  output:    $DATA_DIR/$OUTPUT_DIR"

set +e
"$RUNTIME" run --rm "${RUN_ARGS[@]}" \
  -v "$DATA_DIR:/usr/local/structurizr" \
  "$IMAGE" export \
  -workspace "/usr/local/structurizr/$WORKSPACE" \
  -format "$FORMAT" \
  -output "/usr/local/structurizr/$OUTPUT_DIR"
STATUS=$?
set -e

if [[ $STATUS -ne 0 && ( "$FORMAT" == "png" || "$FORMAT" == "svg" ) ]]; then
  cat >&2 <<'EOF'

PNG/SVG export uses the Structurizr browser-based renderer.
If this failed with "Exporting to PNG/SVG is not supported in this build",
the selected Structurizr distribution does not include the PNG/SVG exporter.
Use a Structurizr preview/source build that supports export -format png|svg.
Do not replace this workflow with PlantUML/DOT rendering.
EOF
fi

exit "$STATUS"
