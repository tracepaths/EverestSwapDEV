// [V12] Live E2E sweep on devnet proving the creator-remove-pool chain that was
// previously impossible: launch -> accept_ownership -> verify getters ->
// remove_liquidity (drain) -> remove_pool -> verify deregistered.
// Frugal: ~0.1 OCT of WOCT liquidity, unwrapped back at the end.
// Usage: MNEMONIC="..." node scripts/e2e-v12-remove-pool.js
const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const D = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments.json'), 'utf-8'));
const FACTORY = D.SwapFactory;
const WOCT = D.WOCT;

async function rpc(method, params) {
  const res = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const d = await res.json();
  if (d.error) throw new Error('RPC ' + method + ': ' + d.error.message);
  return d.result;
}
function esc(s) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function canon(tx) {
  let s = `{"from":"${esc(tx.from)}","to_":"${esc(tx.to_)}","amount":"${esc(tx.amount)}","nonce":${tx.nonce},"ou":"${esc(tx.ou)}","timestamp":${tx.timestamp},"op_type":"${esc(tx.op_type)}"`;
  if (tx.encrypted_data) s += `,"encrypted_data":"${esc(tx.encrypted_data)}"`;
  if (tx.message) s += `,"message":"${esc(tx.message)}"`;
  return s + '}';
}
function sign(tx, sk) {
  tx.signature = Buffer.from(nacl.sign.detached(Buffer.from(canon(tx), 'utf-8'), sk)).toString('base64');
  tx.public_key = Buffer.from(sk.slice(32, 64)).toString('base64');
}
async function receipt(h, max = 120) {
  for (let i = 0; i < max; i++) {
    try { const r = await rpc('contract_receipt', [h]); if (r && r.success !== undefined) return r; } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('receipt timeout ' + h);
}
// [FIX] Local nonce tracking — re-querying octra_balance.nonce right after a
// prior tx's receipt hits a lag where the node still reports the OLD nonce,
// so the next tx collides and is silently dropped from the mempool (nonce never
// advances, no receipt). Seed once, increment locally.
const NONCE = { v: 0 };
async function seedNonce(a) { NONCE.v = (await rpc('octra_balance', [a])).nonce; }
async function fee(t) { try { const f = await rpc('octra_recommendedFee', [t]); return String(f.recommended || f.minimum || '2000'); } catch { return '2000'; } }
// [FIX] Retry with a FRESH nonce re-seed on transient failures. Two distinct
// things go wrong on this devnet and both look the same from the outside:
//   - octra_submit intermittently answers "malformed transaction" / "invalid
//     nonce" even for a well-formed tx,
//   - a tx is accepted but never lands (no receipt) because it reverted, and a
//     revert here consumes no nonce — so the local counter drifts ahead.
// Re-seeding from the chain before each retry fixes the drift; without it every
// subsequent tx in the run collides and the whole script stalls.
async function send(from, to_, amount, method, params, sk, label, ouOverride, maxWait = 120, attempts = 3) {
  const ou = ouOverride || await fee('call');
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      await new Promise(r => setTimeout(r, 3000));
      await seedNonce(from);
      console.log(`    retry ${attempt}/${attempts} for ${label} (nonce re-seeded to ${NONCE.v})`);
    }
    NONCE.v += 1;
    const n = NONCE.v;
    let ts = Date.now() / 1000; if (ts % 1 === 0) ts += 1e-6;
    const tx = { from, to_, amount, nonce: n, ou, timestamp: ts, op_type: 'call', encrypted_data: method, message: JSON.stringify(params) };
    sign(tx, sk);
    try {
      const r = await rpc('octra_submit', [tx]);
      const rc = await receipt(r.tx_hash, maxWait);
      console.log(`  ${rc.success ? 'OK' : 'FAIL'} ${label} (${r.tx_hash.slice(0,12)}… effort ${rc.effort}, ou ${ou})`);
      if (!rc.success) throw new Error(`${label} failed: ${rc.error}`);
      return rc;
    } catch (e) {
      lastErr = e;
      console.log(`    attempt ${attempt} failed: ${e.message.slice(0, 90)}`);
    }
  }
  throw lastErr;
}
async function view(addr, method, params = []) { return rpc('contract_call', [addr, method, params]); }
function scalar(r) { return r && typeof r === 'object' ? (r.result ?? null) : r; }
function addr(mn) {
  const seed = crypto.pbkdf2Sync(mn, 'mnemonic', 2048, 64, 'sha512');
  const h = crypto.createHmac('sha512', 'Octra seed'); h.update(Buffer.from(seed));
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(h.digest().slice(0, 32)));
  const sha = crypto.createHash('sha256').update(Buffer.from(kp.publicKey)).digest();
  let b = bs58.default.encode(sha); while (b.length < 44) b = '1' + b;
  return { kp, address: 'oct' + b };
}

async function main() {
  const mn = process.env.MNEMONIC; if (!mn) { console.error('set MNEMONIC'); process.exit(1); }
  const { kp, address: me } = addr(mn); const sk = kp.secretKey;
  const bal0 = await rpc('octra_balance', [me]);
  console.log(`Creator ${me} | ${bal0.balance} OCT | factory ${FACTORY}\n`);
  await seedNonce(me);

  const LIQ_TOKEN = '1000000';   // 1 token (6 dec)
  const LIQ_WOCT = '100000';     // 0.1 WOCT
  const SUPPLY = '1000000000';   // 1000 tokens

  console.log('1) Deposit 0.1 OCT -> WOCT (skip if WOCT balance already covers liquidity)');
  {
    const woctBal = scalar(await view(WOCT, 'balance_of', [me]));
    if (woctBal && BigInt(woctBal) >= BigInt(LIQ_WOCT)) {
      console.log(`  WOCT balance ${woctBal} already >= ${LIQ_WOCT}, skipping deposit`);
    } else {
      // amount is RAW micro-OCT (integer string). 0.1 OCT = 100000 micro-OCT.
      await send(me, WOCT, '100000', 'deposit', [], sk, 'deposit');
    }
  }

  console.log('2) Grant WOCT to factory');
  await send(me, WOCT, '0', 'grant', [FACTORY, LIQ_WOCT], sk, 'grant WOCT');

  console.log('3) launch() token + pool + liquidity');
  const epoch = (await rpc('epoch_current', [])).epoch_id || 0;
  const deadline = epoch + 60;
  const sym = 'E2E' + String(Date.now()).slice(-4);
  const params = [
    'E2E Test '+sym, sym, sym+'Token', SUPPLY, '6',
    me, FACTORY, '0','0','0','0', me, '0',
    false,false,false,false,false,false,false,false,false,
    '','','','','',
    3,1000,0, LIQ_TOKEN, LIQ_WOCT, 1, deadline, 0,
  ];
  // launch() deploys TWO contracts (Token ~3150 + SwapPool ~4399 instr) via
  // SPAWN2 plus several internal calls — a very high effort budget. ou 500000
  // was too low: the node accepted the submit (returned a tx_hash) but the tx
  // never landed (execution effort exceeded ou -> dropped, no receipt). Give it
  // a deploy-2x-sized ceiling.
  await send(me, FACTORY, '0', 'launch', params, sk, 'launch', '3000000', 240);
  // NOTE: there is no get_pool_at() on SwapFactory — resolve the new pool from
  // the storage map that every contract_call returns (pools:<index>).
  const ap = await view(FACTORY, 'all_pools');
  const st = ap && ap.storage ? ap.storage : {};
  const plen = Number(st.pools_len ?? scalar(await view(FACTORY, 'pools_length')) ?? 0);
  const pool = st[`pools:${plen - 1}`] || null;
  console.log(`  pools_length=${plen}  new pool=${pool}`);
  if (!pool) throw new Error('could not resolve new pool address');

  console.log('4) Verify NEW getters on pool');
  for (const m of ['get_owner','get_pending_owner','get_reserve_a','get_reserve_b','total_lp_supply','get_total_liquidity','is_active']) {
    const r = await view(pool, m); console.log(`  ${m.padEnd(20)} = ${JSON.stringify(scalar(r) ?? (r.storage && (r.storage[m]||'')) )}`);
  }
  const ownerBefore = scalar(await view(pool, 'get_owner'));
  const pendingBefore = scalar(await view(pool, 'get_pending_owner'));
  console.log(`  owner=${ownerBefore} pending=${pendingBefore} (expect owner=factory, pending=me)`);

  console.log('5) accept_ownership (creator claims pool)');
  await send(me, pool, '0', 'accept_ownership', [], sk, 'accept_ownership');
  const ownerAfter = scalar(await view(pool, 'get_owner'));
  console.log(`  owner now = ${ownerAfter} ${ownerAfter === me ? 'OK (creator)' : 'FAIL'}`);

  console.log('6) remove_liquidity position #1 (drain user LP)');
  console.log(`  position #1 = ${JSON.stringify(scalar(await view(pool, 'get_position', [1])))}`);
  const epoch2 = (await rpc('epoch_current', [])).epoch_id || 0;
  await send(me, pool, '0', 'remove_liquidity', [1, 0, 0, epoch2 + 60], sk, 'remove_liquidity');
  const tl = scalar(await view(pool, 'get_total_liquidity'));
  console.log(`  total_liquidity now = ${tl} ${String(tl)==='0'?'OK drained':'FAIL'}`);

  console.log('7) remove_pool (the previously-impossible creator action)');
  await send(me, FACTORY, '0', 'remove_pool', [pool], sk, 'remove_pool');

  console.log('8) Verify pool deregistered');
  const plen2 = Number(scalar(await view(FACTORY, 'pools_length')));
  const tokenA = scalar(await view(pool, 'get_token_a'));
  const gp = scalar(await view(FACTORY, 'get_pool', [tokenA, WOCT]));
  console.log(`  pools_length ${plen} -> ${plen2}  get_pool(tokenA,WOCT)='${gp}' ${(!gp||gp==='')?'OK removed':'FAIL still registered'}`);

  console.log('9) Unwrap leftover WOCT back to OCT (frugal cleanup)');
  const woctBal = scalar(await view(WOCT, 'balance_of', [me]));
  console.log(`  WOCT balance = ${woctBal}`);
  if (woctBal && String(woctBal) !== '0') {
    await send(me, WOCT, '0', 'withdraw', [String(woctBal)], sk, 'withdraw WOCT');
    try { await send(me, WOCT, '0', 'claim_withdrawal', [], sk, 'claim_withdrawal'); }
    catch (e) { console.log('  (claim_withdrawal:', e.message, ')'); }
  }

  const bal1 = await rpc('octra_balance', [me]);
  console.log(`\nDONE. Balance ${bal0.balance} -> ${bal1.balance} OCT (spent ${(Number(bal0.balance)-Number(bal1.balance)).toFixed(6)})`);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
