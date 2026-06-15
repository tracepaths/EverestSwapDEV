#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() {
  echo ""
  echo "Shutting down..."
  [ -n "${INDEXER_PID:-}" ] && kill "$INDEXER_PID" 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "=== Starting Indexer (devnet) ==="
cd "$ROOT/indexer"
NETWORK=devnet node index.mjs &
INDEXER_PID=$!

sleep 2

echo "=== Starting Frontend (devnet) ==="
cd "$ROOT/frontend"
NETWORK=devnet npx vite --mode devnet
