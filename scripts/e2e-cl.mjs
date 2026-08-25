// End-to-end exercise of the concentrated-liquidity exchange against devnet.
//
// Creates a pool, opens a range position through the position manager, trades
// across it in both directions, then collects fees, withdraws and burns. Every
// step reads state back and asserts what it should be, so a silent accounting
// error fails here rather than in the interface.
import './lib/env.mjs';
import fs from 'node:fs';
import {
  signerFromEnv, nonceOf, callContract, viewValue, currentEpoch,
} from './lib/octra-chain.mjs';

const d = JSON.parse(fs.readFileSync('deployments-cl.json', 'utf-8'));
const signer = signerFromEnv();

// The nonce is read fresh before every transaction rather than counted up from
// a cached value. A transaction the node rejects outright never consumes its
// nonce, so a counter drifts one ahead of the chain the moment anything fails
// and every later send is refused for a reason that has nothing to do with it.
const next = async () => (await nonceOf(signer.address)) + 1;

const Q96 = 2n ** 96n;
let pass = 0, fail = 0;
// A trade direction goes over the wire as 1 or 0, never as a boolean: a flag
// handed from one contract to another arrives as `true` whatever it was, so no
// contract here takes a bool where a direction is meant.
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
};
const step = (s) => console.log(`\n── ${s} ──`);

// sqrt(1) * 2^96 — a 1:1 opening price, both tokens carrying 18 decimals.
const SQRT_ONE = Q96.toString();
const DEADLINE = async () => String((await currentEpoch()) + 20000);

// The fee tier to exercise. Each run wants a pool nothing has traded through
// yet, so a repeat run is pointed at a different tier rather than at a pool
// still holding the last run's position.
const FEE = process.argv[2] || '3000';

// Token order inside the pool is whatever the creator passed, so read it back
// rather than assuming; every amount below is labelled by the pool's own order.
step(`create pool at the ${FEE} tier`);
d.pools = d.pools || {};
let pool = d.pools[FEE];
if (!pool) {
  await callContract({
    to: d.factory, method: 'create_pool',
    params: [d.tokenA, d.tokenB, FEE, SQRT_ONE],
    signer, nonce: await next(), label: 'create_pool', ou: '400000',
  });
  pool = await viewValue(d.factory, 'get_pool', [d.tokenA, d.tokenB, FEE]);
  d.pools[FEE] = pool; fs.writeFileSync('deployments-cl.json', JSON.stringify(d, null, 2) + '\n');
}
console.log(`  pool ${pool}`);

// Fields of state_packed, by position: token0|token1|fee|spacing|sqrtPrice|
// tick|liquidity|feeGrowth0|feeGrowth1|feeProtocol0|feeProtocol1|
// protocolOwed0|protocolOwed1|started
const stateField = async (i) => String(await viewValue(pool, 'state_packed', [])).split('|')[i];

const packed = await viewValue(pool, 'state_packed', []);
console.log(`  state_packed ${packed}`);
const [t0, t1, fee, spacing, sqrtP, tick, liq] = String(packed).split('|');
ok(fee === FEE, `fee tier is ${FEE}`, fee);
ok(BigInt(spacing) > 0n, 'the tier has a tick spacing', spacing);
ok(sqrtP === SQRT_ONE, 'opening price is 1:1', sqrtP);
ok(tick === '0', 'opening tick is 0', tick);
ok(liq === '0', 'opens with no liquidity', liq);
ok(await viewValue(d.factory, 'get_is_pool', [pool]) === true, 'factory recognizes the pool');

const AMT = 10n ** 21n;            // 1000 tokens of each side
step('open a range position');
await callContract({ to: t0, method: 'grant', params: [d.positionManager, (AMT * 4n).toString()], signer, nonce: await next(), label: 'grant token0' });
await callContract({ to: t1, method: 'grant', params: [d.positionManager, (AMT * 4n).toString()], signer, nonce: await next(), label: 'grant token1' });

// A symmetric range around the opening price: 100 spacings either side, which
// has to land on the tier's own spacing or the pool will refuse the tick.
const SPACING = BigInt(spacing);
const LOWER = String(-100n * SPACING), UPPER = String(100n * SPACING);
console.log(`  range ${LOWER} .. ${UPPER}`);
const wantLiq = await viewValue(pool, 'liquidity_for_amounts', [LOWER, UPPER, AMT.toString(), AMT.toString()]);
console.log(`  liquidity_for_amounts -> ${wantLiq}`);
const need0 = await viewValue(pool, 'amount0_for_liquidity', [LOWER, UPPER, String(wantLiq)]);
const need1 = await viewValue(pool, 'amount1_for_liquidity', [LOWER, UPPER, String(wantLiq)]);
console.log(`  requires ${need0} token0 and ${need1} token1`);
ok(BigInt(need0) > 0n && BigInt(need1) > 0n, 'a range spanning the price needs both tokens');
ok(BigInt(need0) <= AMT && BigInt(need1) <= AMT, 'stays inside what was offered');

const before0 = BigInt(await viewValue(t0, 'balance_of', [signer.address]));
const before1 = BigInt(await viewValue(t1, 'balance_of', [signer.address]));

await callContract({
  to: d.positionManager, method: 'mint',
  params: [pool, LOWER, UPPER, AMT.toString(), AMT.toString(), '0', '0', signer.address, await DEADLINE()],
  signer, nonce: await next(), label: 'manager.mint',
});
const held = await viewValue(d.positionManager, 'position_count', [signer.address]);
const tokenId = await viewValue(d.positionManager, 'token_of_owner_at', [signer.address, String(BigInt(held) - 1n)]);
console.log(`  position token id ${tokenId}`);

const spent0 = before0 - BigInt(await viewValue(t0, 'balance_of', [signer.address]));
const spent1 = before1 - BigInt(await viewValue(t1, 'balance_of', [signer.address]));
ok(spent0 === BigInt(need0), 'charged exactly the quoted token0', `${spent0} vs ${need0}`);
ok(spent1 === BigInt(need1), 'charged exactly the quoted token1', `${spent1} vs ${need1}`);
ok(BigInt(await viewValue(pool, 'get_liquidity', [])) === BigInt(wantLiq), 'pool liquidity is now active');
ok(BigInt(await viewValue(pool, 'tick_liquidity_net', [LOWER])) === BigInt(wantLiq), 'lower tick adds liquidity');
ok(BigInt(await viewValue(pool, 'tick_liquidity_net', [UPPER])) === -BigInt(wantLiq), 'upper tick removes liquidity');
ok(await viewValue(pool, 'tick_is_initialized', [LOWER]) === true, 'lower tick is flagged in the bitmap');
console.log(`  position_packed ${await viewValue(d.positionManager, 'position_packed', [String(tokenId)])}`);
console.log(`  tick_range_data ${await viewValue(pool, 'tick_range_data', [String(-120n * SPACING), String(120n * SPACING)])}`);

step('quote and trade token0 for token1');
const IN = 10n ** 19n;             // 10 tokens in
const quoted = await viewValue(pool, 'quote', ['1', IN.toString(), '0']);
const qpacked = await viewValue(pool, 'quote_packed', ['1', IN.toString(), '0']);
console.log(`  quote ${quoted}   quote_packed ${qpacked}`);
ok(BigInt(quoted) > 0n, 'quote returns an output');
ok(BigInt(quoted) < IN, 'output is below input after fees on a 1:1 pool', `${quoted} < ${IN}`);
const routerQuote = await viewValue(d.router, 'quote_exact_input_single', [pool, '1', IN.toString()]);
ok(String(routerQuote) === String(quoted), 'router quote matches the pool', `${routerQuote}`);

await callContract({ to: t0, method: 'grant', params: [d.router, IN.toString()], signer, nonce: await next(), label: 'grant router' });
const out1Before = BigInt(await viewValue(t1, 'balance_of', [signer.address]));
await callContract({
  to: d.router, method: 'exact_input_single',
  params: [pool, '1', IN.toString(), '1', signer.address, await DEADLINE()],
  signer, nonce: await next(), label: 'router.exact_input_single',
});
const got1 = BigInt(await viewValue(t1, 'balance_of', [signer.address])) - out1Before;
console.log(`  received ${got1} token1`);
ok(got1 === BigInt(quoted), 'trade delivered exactly what was quoted', `${got1} vs ${quoted}`);
ok(BigInt(await viewValue(pool, 'get_sqrt_price', [])) < Q96, 'selling token0 moved the price down');
ok(BigInt(await stateField(7)) > 0n, 'fee growth accrued on token0');
ok(BigInt(await viewValue(t0, 'allowance', [signer.address, d.router])) === 0n, 'router left no standing allowance');
ok(BigInt(await viewValue(t0, 'balance_of', [d.router])) === 0n, 'router kept none of the input');

step('trade back, token1 for token0');
const IN2 = got1;
await callContract({ to: t1, method: 'grant', params: [d.router, IN2.toString()], signer, nonce: await next(), label: 'grant router back' });
const out0Before = BigInt(await viewValue(t0, 'balance_of', [signer.address]));
await callContract({
  to: d.router, method: 'exact_input_single',
  params: [pool, '0', IN2.toString(), '1', signer.address, await DEADLINE()],
  signer, nonce: await next(), label: 'router.exact_input_single back',
});
const got0 = BigInt(await viewValue(t0, 'balance_of', [signer.address])) - out0Before;
console.log(`  received ${got0} token0`);
ok(got0 < IN, 'a round trip costs the trader the fee', `${got0} < ${IN}`);
ok(BigInt(await stateField(8)) > 0n, 'fee growth accrued on token1');

step('collect fees');
const owed0 = await viewValue(d.positionManager, 'fees_owed_0', [String(tokenId)]);
const owed1 = await viewValue(d.positionManager, 'fees_owed_1', [String(tokenId)]);
console.log(`  claimable ${owed0} token0 and ${owed1} token1`);
ok(BigInt(owed0) > 0n && BigInt(owed1) > 0n, 'the only position earned fees on both sides');

const c0 = BigInt(await viewValue(t0, 'balance_of', [signer.address]));
const c1 = BigInt(await viewValue(t1, 'balance_of', [signer.address]));
await callContract({
  to: d.positionManager, method: 'collect',
  params: [String(tokenId), signer.address, owed0.toString(), owed1.toString()],
  signer, nonce: await next(), label: 'manager.collect',
});
const paid0 = BigInt(await viewValue(t0, 'balance_of', [signer.address])) - c0;
const paid1 = BigInt(await viewValue(t1, 'balance_of', [signer.address])) - c1;
console.log(`  collected ${paid0} token0 and ${paid1} token1`);
ok(paid0 > 0n && paid1 > 0n, 'fees actually paid out');
ok(paid0 <= BigInt(owed0) && paid1 <= BigInt(owed1), 'never paid more than was owed');

step('exact output trade');
const WANT = 10n ** 18n;
const need = await viewValue(d.router, 'quote_exact_output_single', [pool, '1', WANT.toString()]);
console.log(`  ${WANT} token1 costs ${need} token0`);
ok(BigInt(need) > WANT, 'buying an exact amount costs more than it yields', `${need} > ${WANT}`);
await callContract({ to: t0, method: 'grant', params: [d.router, (BigInt(need) * 2n).toString()], signer, nonce: await next(), label: 'grant for exact output' });
const eo1 = BigInt(await viewValue(t1, 'balance_of', [signer.address]));
await callContract({
  to: d.router, method: 'exact_output_single',
  params: [pool, '1', WANT.toString(), (BigInt(need) * 2n).toString(), signer.address, await DEADLINE()],
  signer, nonce: await next(), label: 'router.exact_output_single',
});
const eoGot = BigInt(await viewValue(t1, 'balance_of', [signer.address])) - eo1;
ok(eoGot === WANT, 'exact output delivered precisely the amount asked for', `${eoGot}`);
ok(BigInt(await viewValue(t0, 'balance_of', [d.router])) === 0n, 'residue swept back to the trader');

step('withdraw and burn');
// Field 5 of position_packed is the position's liquidity.
const liveLiquidity = BigInt(String(await viewValue(d.positionManager, 'position_packed', [String(tokenId)])).split('|')[5]);
console.log(`  position holds ${liveLiquidity} liquidity`);
const w0 = BigInt(await viewValue(t0, 'balance_of', [signer.address]));
const w1 = BigInt(await viewValue(t1, 'balance_of', [signer.address]));
await callContract({
  to: d.positionManager, method: 'decrease_liquidity',
  params: [String(tokenId), liveLiquidity.toString(), '0', '0', await DEADLINE()],
  signer, nonce: await next(), label: 'manager.decrease_liquidity',
});
const back0 = BigInt(await viewValue(t0, 'balance_of', [signer.address])) - w0;
const back1 = BigInt(await viewValue(t1, 'balance_of', [signer.address])) - w1;
console.log(`  withdrew ${back0} token0 and ${back1} token1`);
ok(back0 > 0n || back1 > 0n, 'principal returned');
ok(BigInt(await viewValue(pool, 'get_liquidity', [])) === 0n, 'pool has no active liquidity left');

const rem0 = await viewValue(d.positionManager, 'fees_owed_0', [String(tokenId)]);
const rem1 = await viewValue(d.positionManager, 'fees_owed_1', [String(tokenId)]);
if (BigInt(rem0) > 0n || BigInt(rem1) > 0n) {
  await callContract({
    to: d.positionManager, method: 'collect',
    params: [String(tokenId), signer.address, rem0.toString(), rem1.toString()],
    signer, nonce: await next(), label: 'manager.collect remainder',
  });
}
await callContract({ to: d.positionManager, method: 'burn', params: [String(tokenId)], signer, nonce: await next(), label: 'manager.burn' });
ok(BigInt(await viewValue(d.positionManager, 'position_count', [signer.address])) === BigInt(held) - 1n, 'position retired');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
