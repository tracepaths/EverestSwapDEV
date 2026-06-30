// everestswap/everestswap-dev/scripts/lib/octra-tx.mjs
//
// Shared crypto + RPC helpers used by redeploy-pool-and-seed.mjs and
// finalize-redeploy.mjs. Single source of truth so we don't get bit-rot
// between two copies (this exact bug bit us once with the Math.floor vs
// Date.now()/1000 timestamp diff).

import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
// bs58 ships CJS by default; ESM `import bs58 from 'bs58'` lands the namespace
// at `bs58.default` on some Node versions and at `bs58` on others. This
// shape-aware lookup avoids the dry-run crash `Cannot read properties of
// undefined (reading 'encode')`.
const bs58Lib = bs58?.default ?? bs58 ?? _require('bs58');
const bs58Encode = (input) =>
  typeof bs58Lib.encode === 'function'
    ? bs58Lib.encode(input)
    : bs58Lib.default.encode(input);

// ── Network constants (canonical deployment on devnet) ────────────────
export const WOCT_ADDRESS = 'octLtzi5z7Ls6BFdrBgdGQKiqBKxDPojpfHLpWhHfbDbF8c';
export const OES_ADDRESS  = 'oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD';
export const FACTORY_ADDRESS = 'octF2kc1Spgxo6BsUazFrg4gCYUMLffEPbcReg6SmmApa2F';
export const ROUTER_ADDRESS  = 'octAAy94fnLmCavamhcL3LVHB7pa2amxv9By53UqNGMLDgr';

// ── Defaults (overridable via EVERESTSWAP_* env vars or --* CLI flags) ─
export const DEFAULT_TX_MAX_WAIT_MS = 600_000;       // 10 min per tx
export const DEFAULT_RPC_CALL_TIMEOUT_MS = 15_000;   // 15 s per fetch
export const RECEIPT_POLL_MS = 2_000;                // 2 s between receipt polls

// ── CLI arg parser ─────────────────────────────────────────────────────
// Supports both `--name value` and `--name=value`. Rejects the
// neighbor-flag case (`--max-wait-ms --dry-run`) where the next argv
// element is itself another flag — otherwise we'd silently pass
// `'--dry-run'` down to parseInt.
export function cliArg(name) {
  const prefix = `--${name}`;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === prefix) {
      const v = process.argv[i + 1];
      if (v && !v.startsWith('--')) return v;
      return null;
    }
    if (a.startsWith(prefix + '=')) {
      return a.slice(prefix.length + 1);
    }
  }
  return null;
}

// ── Strict ms validator ────────────────────────────────────────────────
// Rejects every invalid input (null, '', NaN, '1.5', '-1', '0', whitespace
// only, etc.) with a single warning. Uses `Number()` rather than
// `parseInt()` so fractional input ('1.5') isn't silently truncated.
// Null short-circuit: missing override (no arg, no env) is silent.
export function parseMs(raw, fallback, label) {
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    // eslint-disable-next-line no-console
    console.warn(`  ⚠️  invalid ${label}='${raw}' \u2014 must be a positive integer (ms). Falling back to default ${fallback}.`);
    return fallback;
  }
  return parsed;
}

// ── Wallet / signing ───────────────────────────────────────────────────
// Mnemonic → seed → keypair. Derives the canonical Octra address from the
// Ed25519 public key via sha256 → bs58 → leading-zero padding → "oct" prefix.
export function getDeployer(mnemonic) {
  const seed64 = crypto.pbkdf2Sync(mnemonic, 'mnemonic', 2048, 64, 'sha512');
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(seed64));
  const hdSeed32 = hmac.digest().slice(0, 32);
  const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
  const hash = crypto.createHash('sha256').update(Buffer.from(keypair.publicKey)).digest();
  let b58 = bs58Encode(hash);
  if (typeof b58 !== 'string') b58 = Buffer.from(b58).toString('utf-8');
  while (b58.length < 44) b58 = '1' + b58;
  return { keypair, address: 'oct' + b58 };
}

// Escape `\` and `"` for inclusion inside a JSON-encoded string.
export function jsonEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Build the canonical signed-byte string for `tx` and write signature +
// public_key back onto `tx`. The canonical order matches what the chain's
// RPC expects: from, to_, amount, nonce, ou, timestamp, op_type, then the
// optional encrypted_data and message fields, in that order.
export function signTx(tx, secretKey) {
  let s = `{"from":"${jsonEscape(tx.from)}","to_":"${jsonEscape(tx.to_)}","amount":"${jsonEscape(tx.amount)}","nonce":${tx.nonce},"ou":"${jsonEscape(tx.ou)}","timestamp":${tx.timestamp},"op_type":"${jsonEscape(tx.op_type)}"`;
  if (tx.encrypted_data) s += `,"encrypted_data":"${jsonEscape(tx.encrypted_data)}"`;
  if (tx.message) s += `,"message":"${jsonEscape(tx.message)}"`;
  s += '}';
  tx.signature = Buffer.from(nacl.sign.detached(Buffer.from(s, 'utf-8'), secretKey)).toString('base64');
  tx.public_key = Buffer.from(secretKey.slice(32, 64)).toString('base64');
}

// ── RPC ────────────────────────────────────────────────────────────────
export function getRpcUrl() {
  return process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
}

// JSON-RPC POST with AbortController timeout. Default 15 s so a hung node
// can't burn the whole per-tx budget on one fetch.
export async function rpcCall(method, params, timeoutMs = DEFAULT_RPC_CALL_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(getRpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`RPC ${method} timed out after ${timeoutMs}ms`);
    throw e;
  }
  clearTimeout(timer);
  const data = await res.json();
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

// ── Receipt polling (multi-shape) ──────────────────────────────────────
// Different RPC implementations return contract_receipt with different
// fields. We treat ANY of `success: true`, `status: success|ok|SUCCESS|OK`
// as success. `success: false` / `status: reverted|failed|REVERTED|FAILED`
// is a failure. Unrecognized shapes keep polling.
// We intentionally do NOT use `r.code` since that's a JSON-RPC transport
// field, not an execution status — early code flagged this as a Sev-2 bug.
//
// The pre-iteration budget check (`Date.now() + perIterMaxMs >= deadline`)
// ensures we never START an RPC that would complete past the deadline,
// so wall-clock time is bounded by the configured TX_MAX_WAIT_MS.
export async function waitReceipt(txHash, label = 'tx', options = {}) {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_TX_MAX_WAIT_MS;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_CALL_TIMEOUT_MS;
  const deadline = Date.now() + maxWaitMs;
  const perIterMaxMs = rpcTimeoutMs + RECEIPT_POLL_MS;
  const ON_CHAIN_FAILURE = `${label} failed on-chain`;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    if (Date.now() + perIterMaxMs >= deadline) break;
    try {
      const r = await rpcCall('contract_receipt', [txHash], rpcTimeoutMs);
      if (!r) continue;
      const success =
        r.success === true ||
        r.status === 'success' || r.status === 'ok' ||
        r.status === 'SUCCESS' || r.status === 'OK';
      const failed =
        r.success === false ||
        r.status === 'reverted' || r.status === 'failed' ||
        r.status === 'REVERTED' || r.status === 'FAILED';
      if (success) return { receipt: r, attempts: attempt };
      if (failed) {
        // Surface the original error message verbatim so callers can detect
        // specific revert reasons (e.g. "pool already exists for this pair").
        throw new Error(`${ON_CHAIN_FAILURE}: ${r.error || JSON.stringify(r)}`);
      }
      // shape unrecognized — keep polling
    } catch (e) {
      if (e?.message?.startsWith(ON_CHAIN_FAILURE)) throw e;
      // else transient RPC error, keep polling
    }
    await new Promise((res) => setTimeout(res, RECEIPT_POLL_MS));
  }
  throw new Error(
    `Timeout waiting for ${label} (${txHash}) after ${maxWaitMs / 1000}s / ${attempt} polls`,
  );
}
