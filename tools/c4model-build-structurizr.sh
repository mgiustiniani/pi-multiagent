#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${PROJECT_ROOT:-$(pwd)}"
SRC_DIR="${STRUCTURIZR_SOURCE_DIR:-$ROOT_DIR/.cache/structurizr-source}"
WAR_DIR="${STRUCTURIZR_WAR_DIR:-$ROOT_DIR/.cache/structurizr}"
WAR_PATH="$WAR_DIR/structurizr.war"
REPO="${STRUCTURIZR_REPO:-https://github.com/structurizr/structurizr.git}"
REF="${STRUCTURIZR_REF:-main}"
MAVEN_ARGS="${STRUCTURIZR_MAVEN_ARGS:--Dmaven.test.skip=true package}"

mkdir -p "$WAR_DIR"

if [[ ! -d "$SRC_DIR/.git" ]]; then
  rm -rf "$SRC_DIR"
  git clone --depth 1 --branch "$REF" "$REPO" "$SRC_DIR"
else
  git -C "$SRC_DIR" fetch --depth 1 origin "$REF"
  git -C "$SRC_DIR" checkout "$REF"
  git -C "$SRC_DIR" reset --hard "origin/$REF" 2>/dev/null || true
fi

cd "$SRC_DIR"
# shellcheck disable=SC2086
./mvnw $MAVEN_ARGS

BUILT_WAR="$(find "$SRC_DIR" -path '*/target/*.war' -type f | sort | head -n 1)"
if [[ -z "$BUILT_WAR" ]]; then
  echo "No Structurizr WAR found under $SRC_DIR after build." >&2
  exit 1
fi

cp "$BUILT_WAR" "$WAR_PATH"

echo "Structurizr WAR built from source: $WAR_PATH"
echo "Use with:"
echo "  STRUCTURIZR_WAR=$WAR_PATH bash scripts/c4model-export-images.sh png workspace"
