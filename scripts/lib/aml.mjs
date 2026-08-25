// Thin wrapper around the compiler + view-call RPCs. Both are free (no tx,
// no nonce), so they're the cheap half of any capability probe.
//
// The public node rate-limits aggressively and answers 429 with an HTML error
// page rather than JSON-RPC, so every call here retries on transient failures.
// Without this a probe run reports a wall of bogus "FAIL"s that look like
// language limitations but are just backpressure.
import { rpcCall } from './octra-tx.mjs';
import fs from 'node:fs';

const TRANSIENT = /non-JSON|not valid JSON|Unexpected token|\b(429|502|503|504)\b|rate|ECONNRESET|timed out|fetch failed/i;

async function withRetry(fn, attempts = 7) {
  let delay = 600;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1 || !TRANSIENT.test(e.message || '')) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 8000);
    }
  }
}

export async function compile(src) {
  try {
    const r = await withRetry(() => rpcCall('octra_compileAml', [src], 60_000));
    return { ok: true, bytecode: r?.bytecode ?? r?.code ?? r, raw: r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function compileFile(path) {
  return compile(fs.readFileSync(path, 'utf-8'));
}

// A `view fn` executes for free through contract_call — no signature, no
// nonce, no fee. This is the workhorse for runtime probing.
export async function view(address, method, args = []) {
  try {
    const r = await withRetry(() => rpcCall('contract_call', [{
      contract: address, method,
      params: args.map((a) => String(a)),
      caller: 'oct1111111111111111111111111111111111111111111',
    }], 60_000));
    const v = r?.result ?? r?.return_value ?? r?.value;
    return { ok: r?.status !== 'failed' && r?.success !== false, value: v, raw: r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
