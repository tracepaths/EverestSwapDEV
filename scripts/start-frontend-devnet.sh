#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/frontend"
echo "=== Starting Frontend (devnet) ==="
NETWORK=devnet npx vite --mode devnet
