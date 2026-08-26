// Full pool-lifecycle exercise: create, read, add liquidity, remove it, and
// delist — with the access-control and the emptiness rule proven, not assumed.
//
// The pair is tokenA/tokenC, which no other script touches, so this runs
// independently of e2e-cl (A/B) and e2e-route (A/B, B/C). It cleans up after
// itself: the pair+tier slot is left free, so the script is re-runnable.
//
// The two facts under test that a naive implementation gets wrong:
//   1. Emptiness is the pool's TOTAL outstanding liquidity, not the active-range
//      figure. A position parked out of range makes get_liquidity() read 0 while
//      real tokens sit in the pool; delist must still refuse. So the position
//      here is opened ABOVE the opening price on purpose.
//   2. Only the pool's creator or the factory owner may delist, and only at zero
//      liquidity. A stranger is refused at the authorization check, which sits
//      before the emptiness check, so that refusal is unambiguous.
import { deploymentsPath } from './lib/env.mjs';
import fs from 'node:fs';
import {
  signerFromEnv, nonceOf, callContract, viewCall, viewValue, currentEpoch,
} from './lib/octra-chain.mjs';

const OUT = deploymentsPath();
const d = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
const signer = signerFromEnv();
const next = async () => (await nonceOf(signer.address)) + 1;

const Q96 = 2n ** 96n;
const SQRT_ONE = Q96.toString();
const DEADLINE = async () => String((await currentEpoch()) + 20000);
// Any wallet that is neither the pool's creator nor the factory owner. The
// default view caller serves as an arbitrary third party; no key is needed
// because the authorization check reverts read-only, before any state changes.
const STRANGER = 'oct1111111111111111111111111111111111111111111';

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
};
const step = (s) => console.log(`\n── ${s} ──`);

const factory = d.factory;
const A = d.tokenA, C = d.tokenC;
const FEE = '3000';
if (!C) { console.error('tokenC missing; run e2e-route once to mint it'); process.exit(1); }

const unset = (a) => a === '' || a === '0' || a === undefined || a === null;
const listContains = async (pool) => {
  const packed = String(await viewValue(factory, 'pool_list_packed', ['0', '256']));
  return packed.split(';').some((row) => row.split('|')[0] === pool);
};
// Executes a state-changing method read-only under `who`, returns whether it
// reverted. Used only for the negative authorization checks, which fail before
// touching state.
const reverts = async (contract, method, params, who) => {
  try { await viewCall(contract, method, params, who); return false; }
  catch (e) { return /execution reverted/i.test(String(e.message)); }
};

console.log(`deployer ${signer.address}`);
console.log(`pair     A=${A}  C=${C}  fee ${FEE}`);

// Idempotency: clear any listed leftover from an interrupted run.
step('start from a free pair+tier slot');
const pre = await viewValue(factory, 'get_pool', [A, C, FEE]);
if (!unset(pre)) {
  const preLiq = await viewValue(pre, 'total_liquidity', []).catch(() => '0');
  if (BigInt(preLiq) === 0n) {
    await callContract({ to: factory, method: 'delist_pool', params: [pre], signer, nonce: await next(), label: 'delist leftover' });
    console.log(`  cleared leftover ${pre}`);
  } else {
    console.error(`  leftover pool ${pre} holds liquidity ${preLiq}; clean up manually`); process.exit(1);
  }
}
ok(unset(await viewValue(factory, 'get_pool', [A, C, FEE])), 'pair+tier is free to create');

// ── create ────────────────────────────────────────────────────────────
step('anyone can create a pool');
const listedBefore = BigInt(await viewValue(factory, 'get_listed_count', []));
await callContract({ to: factory, method: 'create_pool', params: [A, C, FEE, SQRT_ONE], signer, nonce: await next(), label: 'create_pool', ou: '400000' });
const pool = await viewValue(factory, 'get_pool', [A, C, FEE]);
console.log(`  pool ${pool}`);
ok(!unset(pool), 'pool address is registered');
ok(await viewValue(factory, 'get_pool_creator', [pool]) === signer.address, 'creator recorded as the caller');
ok(await viewValue(factory, 'is_delisted', [pool]) === false, 'starts listed, not delisted');
ok(BigInt(await viewValue(factory, 'get_listed_count', [])) === listedBefore + 1n, 'listed count went up by one');
ok(await listContains(pool), 'appears in the registry listing');
ok(await viewValue(factory, 'get_is_pool', [pool]) === true, 'factory recognizes it as a pool');

const spacing = BigInt(String(await viewValue(pool, 'state_packed', [])).split('|')[3]);
const t0 = await viewValue(pool, 'get_token0', []);
const t1 = await viewValue(pool, 'get_token1', []);

// ── add liquidity, deliberately out of range ────────────────────────────
step('add liquidity parked above the price (out of range)');
const AMT = 10n ** 21n;
await callContract({ to: t0, method: 'grant', params: [d.positionManager, (AMT * 4n).toString()], signer, nonce: await next(), label: 'grant token0' });
await callContract({ to: t1, method: 'grant', params: [d.positionManager, (AMT * 4n).toString()], signer, nonce: await next(), label: 'grant token1' });
// Both ticks above the opening tick 0 → the whole position is on one side and
// contributes nothing to the active-range liquidity.
const LOWER = String(spacing), UPPER = String(10n * spacing);
console.log(`  range ${LOWER} .. ${UPPER} (opening tick 0 sits below it)`);
await callContract({
  to: d.positionManager, method: 'mint',
  params: [pool, LOWER, UPPER, AMT.toString(), AMT.toString(), '0', '0', signer.address, await DEADLINE()],
  signer, nonce: await next(), label: 'manager.mint (out of range)',
});
const held = BigInt(await viewValue(d.positionManager, 'position_count', [signer.address]));
const tokenId = String(await viewValue(d.positionManager, 'token_of_owner_at', [signer.address, String(held - 1n)]));
const activeLiq = BigInt(await viewValue(pool, 'get_liquidity', []));
const totalLiq = BigInt(await viewValue(pool, 'total_liquidity', []));
console.log(`  active (in-range) liquidity ${activeLiq}`);
console.log(`  total outstanding liquidity ${totalLiq}`);
ok(activeLiq === 0n, 'active-range liquidity reads zero — the naive emptiness test', String(activeLiq));
ok(totalLiq > 0n, 'total outstanding liquidity is non-zero — the correct emptiness test', String(totalLiq));

// ── delete is gated ─────────────────────────────────────────────────────
step('a stranger cannot delist');
ok(await reverts(factory, 'delist_pool', [pool], STRANGER),
  'delist by a non-creator, non-owner is refused', '(authorization check, before emptiness)');
ok(await viewValue(factory, 'is_delisted', [pool]) === false, 'pool is still listed after the refused attempt');

step('even the creator cannot delist while liquidity is outstanding');
let blockedByLiquidity = false;
try {
  await callContract({ to: factory, method: 'delist_pool', params: [pool], signer, nonce: await next(), label: 'delist (should fail)' });
} catch (e) {
  blockedByLiquidity = /failed on-chain|reverted/i.test(String(e.message));
}
// The creator passes authorization, so the only guard left to stop this is the
// emptiness rule — and it reads total_liquidity, which is non-zero here even
// though the active-range figure is 0. A naive check on get_liquidity would
// have let this through.
ok(blockedByLiquidity, 'delist reverts because total liquidity is non-zero');
ok(await viewValue(factory, 'is_delisted', [pool]) === false, 'pool survived the blocked delist');

// ── remove own liquidity ────────────────────────────────────────────────
step('the owner removes their own liquidity');
const posLiq = BigInt(String(await viewValue(d.positionManager, 'position_packed', [tokenId])).split('|')[5]);
await callContract({
  to: d.positionManager, method: 'decrease_liquidity',
  params: [tokenId, posLiq.toString(), '0', '0', await DEADLINE()],
  signer, nonce: await next(), label: 'manager.decrease_liquidity',
});
ok(BigInt(await viewValue(pool, 'total_liquidity', [])) === 0n, 'total outstanding liquidity is now zero');

// ── delete succeeds ───────────────────────────────────────────────────────
step('the creator delists the now-empty pool');
const listedPeak = BigInt(await viewValue(factory, 'get_listed_count', []));
await callContract({ to: factory, method: 'delist_pool', params: [pool], signer, nonce: await next(), label: 'delist_pool' });
ok(await viewValue(factory, 'is_delisted', [pool]) === true, 'pool is marked delisted');
ok(BigInt(await viewValue(factory, 'get_listed_count', [])) === listedPeak - 1n, 'listed count went back down');
ok(!(await listContains(pool)), 'no longer appears in the registry listing');
ok(unset(await viewValue(factory, 'get_pool', [A, C, FEE])), 'pair+tier slot reads free again');
ok(await viewValue(factory, 'get_is_pool', [pool]) === true, 'is_pool stays true — the pool is hidden, not destroyed');

// ── still alive for address-holders ─────────────────────────────────────
step('a delisted pool still works for anyone holding its address');
// The manager admits it because get_is_pool is still true, even though the
// registry lookup now returns nothing.
await callContract({
  to: d.positionManager, method: 'mint',
  params: [pool, String(-spacing), String(spacing), (10n ** 18n).toString(), (10n ** 18n).toString(), '0', '0', signer.address, await DEADLINE()],
  signer, nonce: await next(), label: 'mint into delisted pool',
});
const held2 = BigInt(await viewValue(d.positionManager, 'position_count', [signer.address]));
const tokenId2 = String(await viewValue(d.positionManager, 'token_of_owner_at', [signer.address, String(held2 - 1n)]));
ok(BigInt(await viewValue(pool, 'total_liquidity', [])) > 0n, 'liquidity can still be added to a delisted pool');
const liq2 = BigInt(String(await viewValue(d.positionManager, 'position_packed', [tokenId2])).split('|')[5]);
await callContract({
  to: d.positionManager, method: 'decrease_liquidity',
  params: [tokenId2, liq2.toString(), '0', '0', await DEADLINE()],
  signer, nonce: await next(), label: 'withdraw from delisted pool',
});
ok(BigInt(await viewValue(pool, 'total_liquidity', [])) === 0n, 'and it can still be withdrawn');
await callContract({ to: d.positionManager, method: 'burn', params: [tokenId2], signer, nonce: await next(), label: 'burn temp position' });

// ── recreate the same pair+tier ─────────────────────────────────────────
step('the freed pair+tier can be created afresh');
await callContract({ to: factory, method: 'create_pool', params: [A, C, FEE, SQRT_ONE], signer, nonce: await next(), label: 'recreate', ou: '400000' });
const pool2 = await viewValue(factory, 'get_pool', [A, C, FEE]);
console.log(`  new pool ${pool2}`);
ok(!unset(pool2), 'a new pool exists for the pair+tier');
ok(pool2 !== pool, 'it is a different contract from the delisted one', `${pool2} != ${pool}`);
ok(await viewValue(factory, 'is_delisted', [pool2]) === false, 'the new pool is listed');
ok(await listContains(pool2), 'the new pool appears in the listing');

// cleanup: leave the slot free for the next run (new pool is empty).
await callContract({ to: factory, method: 'delist_pool', params: [pool2], signer, nonce: await next(), label: 'cleanup delist' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
