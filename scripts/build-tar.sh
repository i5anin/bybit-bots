#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="builds"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT_FILE="$OUT_DIR/bybit-bots-$STAMP.tar.gz"

mkdir -p "$OUT_DIR"

tar -czf "$OUT_FILE" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='logs' \
  --exclude='.env' \
  --exclude='builds' \
  --exclude='.idea' \
  --exclude='.td-maps' \
  .

echo "Собрано: $OUT_FILE"
