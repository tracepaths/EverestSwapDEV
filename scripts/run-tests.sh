#!/usr/bin/env bash
# Everything that can be checked without spending money.
#
# Five gates: the interface's lint, types and unit tests, a dependency audit, and
# a read-only sweep of the deployed contracts. None of them signs a transaction,
# so this is safe to run against any network and safe to run repeatedly.
#
# Each gate's output is captured and only shown when it fails, because a passing
# run should be five lines and a failing one should be the error. The exit status
# is the point: it is non-zero if any gate failed, so this can gate a commit.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$HERE/.." && pwd)"
FRONTEND="${FRONTEND:-$(cd "$BACKEND/../everestswap-frontend" 2>/dev/null && pwd || true)}"

if [[ -z "$FRONTEND" || ! -d "$FRONTEND" ]]; then
  echo "cannot find the interface — expected it beside $BACKEND, or set FRONTEND=/path" >&2
  exit 1
fi

failed=()
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# Runs one gate in one directory. `set -e` is deliberately off: the whole report
# is worth more than the first failure, and the exit status is accumulated
# instead. Output goes to a file so that a pass stays quiet — piping to `tail`
# would hand back tail's exit status and every gate would "pass".
gate() {
  local name="$1" dir="$2"; shift 2
  printf '  %-28s' "$name"
  if (cd "$dir" && "$@") >"$log" 2>&1; then
    echo 'ok'
  else
    echo 'FAILED'
    sed 's/^/      /' "$log" | tail -25
    failed+=("$name")
  fi
}

# A warning-only gate: reported, never fatal. An advisory about a transitive
# dependency should not block a commit that has nothing to do with it.
advisory() {
  local name="$1" dir="$2"; shift 2
  printf '  %-28s' "$name"
  if (cd "$dir" && "$@") >"$log" 2>&1; then
    echo 'ok'
  else
    echo 'findings — review'
    sed 's/^/      /' "$log" | tail -15
  fi
}

echo "interface  $FRONTEND"
echo "contracts  $BACKEND"
echo

gate     'lint'                 "$FRONTEND" npx eslint .
gate     'types'                "$FRONTEND" npx tsc -b --force
gate     'unit tests'           "$FRONTEND" npx vitest run
advisory 'dependency audit'     "$FRONTEND" npm audit --omit=dev --audit-level=high
gate     'deployed contracts'   "$BACKEND"  node scripts/verify-contracts.mjs

echo
if ((${#failed[@]})); then
  echo "failed: ${failed[*]}"
  exit 1
fi
echo 'all gates passed'
