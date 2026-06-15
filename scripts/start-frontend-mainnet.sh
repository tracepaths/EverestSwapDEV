#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/frontend"
echo "=== Starting Frontend (mainnet) ==="
NETWORK=mainnet npx vite --mode mainnet
