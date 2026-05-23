#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${PROJECT_ROOT:-$(pwd)}"
DATA_DIR="${STRUCTURIZR_DATA_DIR:-$ROOT_DIR/docs/c4}"
FORMAT="${1:-png}"
SOURCE="${2:-${STRUCTURIZR_IMAGE_SOURCE:-url}}"
OUTPUT_DIR="${STRUCTURIZR_IMAGES_OUTPUT:-$DATA_DIR/images}"
MODE="${STRUCTURIZR_EXPORT_MODE:-light}"
ANIMATION="${STRUCTURIZR_EXPORT_ANIMATION:-false}"
PORT="${STRUCTURIZR_PORT:-9090}"
URL="${STRUCTURIZR_EXPORT_URL:-http://localhost:$PORT/workspace/1/diagrams}"

case "$FORMAT" in
  png|svg) ;;
  *)
    echo "Usage: $0 [png|svg] [url|workspace]" >&2
    exit 1
    ;;
esac

case "$SOURCE" in
  url|workspace) ;;
  *)
    echo "Usage: $0 [png|svg] [url|workspace]" >&2
    exit 1
    ;;
esac

DEFAULT_WAR="$ROOT_DIR/.cache/structurizr/structurizr.war"

if [[ -n "${STRUCTURIZR_WAR:-}" ]]; then
  COMMAND=(java -jar "$STRUCTURIZR_WAR")
elif [[ -f "$DEFAULT_WAR" ]]; then
  COMMAND=(java -jar "$DEFAULT_WAR")
elif [[ -n "${STRUCTURIZR_COMMAND:-}" ]]; then
  # Simple command splitting is intentional; use STRUCTURIZR_WAR for paths/args.
  read -r -a COMMAND <<< "$STRUCTURIZR_COMMAND"
else
  COMMAND=(structurizr)
fi

mkdir -p "$OUTPUT_DIR"

ARGS=(export -format "$FORMAT" -output "$OUTPUT_DIR" -mode "$MODE" -animation "$ANIMATION")

if [[ "$SOURCE" == "url" ]]; then
  ARGS+=(-url "$URL")
  SOURCE_LABEL="$URL"
else
  if [[ -f "$DATA_DIR/workspace.json" ]]; then
    WORKSPACE="$DATA_DIR/workspace.json"
  elif [[ -f "$DATA_DIR/workspace.dsl" ]]; then
    WORKSPACE="$DATA_DIR/workspace.dsl"
  else
    echo "No workspace.json or workspace.dsl found in $DATA_DIR" >&2
    exit 1
  fi
  ARGS+=(-workspace "$WORKSPACE")
  SOURCE_LABEL="$WORKSPACE"
fi

echo "Running Structurizr browser-based image export"
echo "  command:   ${COMMAND[*]}"
echo "  format:    $FORMAT"
echo "  source:    $SOURCE_LABEL"
echo "  output:    $OUTPUT_DIR"
echo "  mode:      $MODE"
echo "  animation: $ANIMATION"

set +e
"${COMMAND[@]}" "${ARGS[@]}"
STATUS=$?
set -e

if [[ $STATUS -ne 0 ]]; then
  cat >&2 <<'EOF'

PNG/SVG export must use the Structurizr browser-based renderer described at:
https://docs.structurizr.com/export/png-and-svg

This feature currently requires building Structurizr from source or using the
preview Java WAR. It is not available via the prebuilt structurizr/structurizr
container image, and must not be replaced with PlantUML, Mermaid, DOT, or
Graphviz rendering.

Examples:
  STRUCTURIZR_WAR=/path/to/structurizr.war bash scripts/c4model-export-images.sh png url
  STRUCTURIZR_WAR=/path/to/structurizr.war bash scripts/c4model-export-images.sh svg workspace
EOF
fi

exit "$STATUS"
