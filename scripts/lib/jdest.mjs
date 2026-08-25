// Pre-flight for the defect the node rejects as "invalid_bytecode: duplicate
// JDEST <n>". There is no RPC that validates bytecode without submitting it, so
// without this every attempt costs a transaction and a two-minute wait for a
// rejection that names an opaque number.
//
// The cause, measured: every function gets an entry label numbered 100, 200, 300…
// in declaration order, and branch labels inside function bodies are numbered from
// 10000 up. A contract with 100 or more functions therefore hands its hundredth
// function the label 10000, which some `if` already owns, and the program is
// refused. It matches every case measured — a 1200-function contract of
// branch-free views deploys because it has no branch labels to collide with, while
// 100 functions that each contain a single `if` do not.
//
// So the gate is the declared function count, not the byte size: the highest entry
// label must stay below where branch labels begin.
export const LABEL_STRIDE = 100;
export const BRANCH_LABEL_BASE = 10_000;
/** Functions a contract may declare, less one for the constructor's own label. */
export const MAX_FUNCTIONS = BRANCH_LABEL_BASE / LABEL_STRIDE - 2; // 98

/** `{ functions, limit, headroom, willReject }` from a compile result. */
export function labelReport(compileResult) {
  const abi = typeof compileResult.raw?.abi === 'string'
    ? JSON.parse(compileResult.raw.abi)
    : compileResult.raw?.abi;
  const functions = abi?.functions?.length ?? 0;
  return {
    functions,
    limit: MAX_FUNCTIONS,
    headroom: MAX_FUNCTIONS - functions,
    willReject: functions > MAX_FUNCTIONS,
  };
}
