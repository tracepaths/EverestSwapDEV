#!/usr/bin/env bash
# run-tests.sh — Phase 5 test orchestrator for EverestSwap.
# Runs: frontend lint, type-check, unit tests, dep audit, + contract verification.
set -euo pipefail

FRONTEND="/home/workspace/everestswap/EverestSwap"
BACKEND="/home/workspace/everestswap/EverestSwapDEV"

echo "════════════════════════════════════════════"
echo "  EverestSwap Test Suite (Phase 5)"
echo "════════════════════════════════════════════"

# 1. ESLint
echo -e "\n[1/5] ESLint (frontend)..."
cd "$FRONTEND"
if npx eslint . 2>&1 | tail -3; then echo "  ✓ ESLint passed"; else echo "  ✗ ESLint FAILED"; fi

# 2. Type-check
echo -e "\n[2/5] TypeScript type-check..."
if npx tsc -b 2>&1 | tail -5; then echo "  ✓ Type-check passed"; else echo "  ✗ Type-check FAILED"; fi

# 3. Unit tests (vitest)
echo -e "\n[3/5] Vitest unit tests..."
if npx vitest run 2>&1 | tail -15; then echo "  ✓ Unit tests passed"; else echo "  ✗ Unit tests FAILED"; fi

# 4. Dependency audit
echo -e "\n[4/5] npm audit (frontend)..."
if npm audit --omit=dev --audit-level=high 2>&1 | tail -5; then echo "  ✓ No high/critical deps"; else echo "  ⚠ Audit findings (review)"; fi

# 5. Contract verification (read-only RPC)
echo -e "\n[5/5] Contract verification (devnet RPC)..."
cd "$BACKEND"
if node scripts/verify-contracts.mjs 2>&1; then echo "  ✓ Contracts verified"; else echo "  ✗ Contract verification FAILED"; fi

echo -e "\n════════════════════════════════════════════"
echo "  Test suite complete."
echo "════════════════════════════════════════════"
