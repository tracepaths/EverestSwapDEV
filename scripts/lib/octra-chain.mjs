// Deploy + call helpers built on octra-tx.mjs. Written once so the
// concentrated-liquidity tooling does not re-derive the tx envelope in every
// script the way the older `.js` deploy scripts do.
import {
  getDeployer, signTx, rpcCall, rpcCallRetry, waitReceipt, isTransientRpcError,
} from './octra-tx.mjs';

export const FEE_DEPLOY = '200000';
export const FEE_CALL = '1000';

export async function nonceOf(address) {
  const bal = await rpcCallRetry('octra_balance', [address]);
  return Number(bal?.nonce ?? 0);
}

export async function balanceOf(address) {
  const bal = await rpcCallRetry('octra_balance', [address]);
  return { balance: bal?.balance, nonce: Number(bal?.nonce ?? 0) };
}

export async function currentEpoch() {
  const e = await rpcCallRetry('epoch_current', []);
  return Number(e?.epoch_id ?? e?.epoch ?? e);
}

// Timestamps MUST be floats or the signature is rejected.
function stamp() {
  return Date.now() / 1000;
}

async function submit(tx, secretKey, label, opts = {}) {
  signTx(tx, secretKey);
  const res = await rpcCall('octra_submit', [tx]);
  const hash = res?.tx_hash ?? res?.hash ?? res;
  if (!hash) throw new Error(`${label}: submit returned no hash: ${JSON.stringify(res)}`);
  const { receipt } = await waitReceipt(hash, label, opts);
  return { hash, receipt };
}

export async function deployContract({ bytecode, signer, nonce, ou = FEE_DEPLOY, label = 'deploy', maxWaitMs }) {
  const addr = await rpcCallRetry('octra_computeContractAddress', [bytecode, signer.address, nonce]);
  const address = addr?.contract_address ?? addr?.address ?? addr;
  const tx = {
    from: signer.address, to_: address, amount: '0', nonce, ou,
    timestamp: stamp(), op_type: 'deploy', encrypted_data: bytecode,
  };
  const { hash, receipt } = await submit(tx, signer.keypair.secretKey, `${label} deploy`, maxWaitMs ? { maxWaitMs } : {});
  return { address, hash, receipt };
}

// `ou` is bumped by the caller on retry: a reverted call leaves no receipt and
// burns no nonce, so a retry at the same fee is rejected as a duplicate.
// Nothing on this chain takes a boolean parameter, and a boolean is exactly what
// a caller reaches for when a parameter is named like a flag. The string "false"
// arrives at the contract as `true` — any text reads as true — and a boolean sent
// to a contract that now expects an int is a decoding accident waiting to happen.
// Flags travel as 1 and 0, so refuse anything else here rather than let it revert
// somewhere unrelated.
function checkParams(method, params) {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (typeof p === 'boolean' || p === 'true' || p === 'false') {
      throw new Error(`${method} param ${i} is ${JSON.stringify(p)}; flags travel as 1 or 0`);
    }
  }
  return params;
}

export async function callContract({ to, method, params = [], signer, nonce, amount = '0', ou = FEE_CALL, label, maxWaitMs }) {
  const tx = {
    from: signer.address, to_: to, amount: String(amount), nonce, ou,
    timestamp: stamp(), op_type: 'call',
    encrypted_data: method, message: JSON.stringify(checkParams(method, params)),
  };
  return submit(tx, signer.keypair.secretKey, label || `call ${method}`, maxWaitMs ? { maxWaitMs } : {});
}

// Free read. Views cost nothing and consume no nonce, but the public node
// rate-limits and answers with an HTML error page when exceeded — hence the
// serialized queue plus backoff on non-JSON / 429 responses.
const MAX_INFLIGHT = Number(process.env.EVERESTSWAP_VIEW_CONCURRENCY || 2);
const MIN_VIEW_GAP_MS = Number(process.env.EVERESTSWAP_VIEW_GAP_MS || 120);
let inflight = 0;
let lastViewAt = 0;
const waiters = [];

function acquire() {
  if (inflight < MAX_INFLIGHT) { inflight++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}
function release() {
  const next = waiters.shift();
  if (next) next(); else inflight--;
}

async function viewOnce(contract, method, params, caller) {
  return rpcCall('contract_call', [
    contract, method, checkParams(method, params).map((p) => (typeof p === 'boolean' ? p : String(p))),
    caller || 'oct1111111111111111111111111111111111111111111',
  ], 60_000);
}

export async function viewCall(contract, method, params = [], caller) {
  await acquire();
  try {
    let delay = 500;
    for (let attempt = 0; attempt < 7; attempt++) {
      const gap = MIN_VIEW_GAP_MS - (Date.now() - lastViewAt);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      lastViewAt = Date.now();
      try {
        return await viewOnce(contract, method, params, caller);
      } catch (e) {
        if (attempt === 6 || !isTransientRpcError(e.message)) throw e;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 8000);
      }
    }
  } finally {
    release();
  }
}

export function signerFromEnv() {
  const m = process.env.MNEMONIC;
  if (!m) throw new Error('MNEMONIC not set');
  const { keypair, address } = getDeployer(m);
  const expected = process.env.EVERESTSWAP_DEVNET_DEPLOYER_ADDRESS;
  if (expected && expected !== address) {
    throw new Error(`derived deployer ${address} != expected ${expected} — wrong mnemonic`);
  }
  return { keypair, address };
}

// `contract_call` answers with `{ result, storage }` where `storage` is the
// contract's ENTIRE state map — invaluable for debugging, but callers almost
// always want just the return value.
export async function viewValue(contract, method, params = [], caller) {
  const r = await viewCall(contract, method, params, caller);
  return r?.result ?? r?.return_value ?? r?.value ?? r;
}

export async function viewStorage(contract, method = null, params = []) {
  const r = await viewCall(contract, method || 'get_storage_probe', params);
  return r?.storage ?? {};
}
