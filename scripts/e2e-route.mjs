// Exercises multi-hop routing across three pools.
//
// A single-pool trade never proves a route: the intermediate token has to be
// received by the router, counted, and spent again, and the direction of each
// hop has to survive being handed to a different pool. This opens A/B and B/C
// pools, funds both, then trades A -> B -> C and back, exact-input and
// exact-output, checking the router keeps nothing at the end.
import './lib/env.mjs';
import fs from 'node:fs';
import { compileFile } from './lib/aml.mjs';
import {
  signerFromEnv, nonceOf, deployContract, callContract, viewValue, currentEpoch,
} from './lib/octra-chain.mjs';

const OUT = 'deployments-cl.json';
const d = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
const save = () => fs.writeFileSync(OUT, JSON.stringify(d, null, 2) + '\n');
const signer = signerFromEnv();
const next = async () => (await nonceOf(signer.address)) + 1;

const Q96 = 2n ** 96n;
const SQRT_ONE = Q96.toString();
const FEE = '3000';
const SPACING = 60n;
const DEADLINE = async () => String((await currentEpoch()) + 20000);

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
};
const step = (s) => console.log(`\n── ${s} ──`);
const bal = async (token, who) => BigInt(await viewValue(token, 'balance_of', [who]));

// A third token, so a route has somewhere to pass through. Deployed once and
// remembered, since a repeat run wants the same pools rather than new ones.
step('a third token');
if (!d.tokenC) {
  const c = await compileFile('contracts/TestToken.aml');
  if (!c.ok) { console.error(c.error); process.exit(1); }
  d.tokenC = (await deployContract({ bytecode: c.bytecode, signer, nonce: await next(), label: 'TestToken C' })).address;
  save();
  await callContract({
    to: d.tokenC, method: 'label', params: ['Everest Test Gamma', 'GAMMA'],
    signer, nonce: await next(), label: 'tokenC.label',
  });
}
console.log(`  tokenC ${d.tokenC}   ${await viewValue(d.tokenC, 'get_symbol', [])}`);

// One pool per adjacent pair. `create_pool` spawns a contract, which the node
// charges far more effort for than a plain call.
async function poolFor(x, y, key) {
  d.routePools = d.routePools || {};
  if (d.routePools[key]) return d.routePools[key];
  // The pair may already have a pool at this tier from an earlier run, and the
  // factory allows exactly one, so ask before spawning.
  const existing = await viewValue(d.factory, 'get_pool', [x, y, FEE]);
  if (existing && existing !== '0' && existing !== '') {
    d.routePools[key] = existing; save();
    return existing;
  }
  await callContract({
    to: d.factory, method: 'create_pool', params: [x, y, FEE, SQRT_ONE],
    signer, nonce: await next(), label: `create_pool ${key}`, ou: '400000',
  });
  const p = await viewValue(d.factory, 'get_pool', [x, y, FEE]);
  d.routePools[key] = p; save();
  return p;
}

step('two pools sharing a token');
const poolAB = await poolFor(d.tokenA, d.tokenB, 'AB');
const poolBC = await poolFor(d.tokenB, d.tokenC, 'BC');
console.log(`  A/B ${poolAB}`);
console.log(`  B/C ${poolBC}`);
ok(poolAB !== poolBC, 'the two pairs got separate pools');

// Which side of each pool holds which token decides the direction of each hop.
const ab0 = await viewValue(poolAB, 'get_token0', []);
const bc0 = await viewValue(poolBC, 'get_token0', []);
// 1 means selling token0 for token1, so the hop's direction is 1 exactly when
// the token being sold is that pool's token0.
const dirOf = (pool0, sell) => (pool0 === sell ? '1' : '0');

step('fund both pools with a range around the price');
const AMOUNT = 10n ** 21n;                       // 1000 of each token
const LOWER = String(-100n * SPACING), UPPER = String(100n * SPACING);

async function provide(pool, x, y, label) {
  if (BigInt(await viewValue(pool, 'get_liquidity', [])) > 0n) {
    console.log(`  ${label} already funded`);
    return;
  }
  for (const t of [x, y]) {
    await callContract({
      to: t, method: 'grant', params: [d.positionManager, AMOUNT.toString()],
      signer, nonce: await next(), label: `grant manager ${label}`,
    });
  }
  await callContract({
    to: d.positionManager, method: 'mint',
    params: [pool, LOWER, UPPER, AMOUNT.toString(), AMOUNT.toString(), '0', '0', signer.address, await DEADLINE()],
    signer, nonce: await next(), label: `mint ${label}`, ou: '400000',
  });
  console.log(`  ${label} liquidity ${await viewValue(pool, 'get_liquidity', [])}`);
}
await provide(poolAB, d.tokenA, d.tokenB, 'A/B');
await provide(poolBC, d.tokenB, d.tokenC, 'B/C');
ok(BigInt(await viewValue(poolAB, 'get_liquidity', [])) > 0n, 'A/B is tradeable');
ok(BigInt(await viewValue(poolBC, 'get_liquidity', [])) > 0n, 'B/C is tradeable');

step('quote and trade A -> B -> C');
const IN = 10n ** 19n;
const z1 = dirOf(ab0, d.tokenA), z2 = dirOf(bc0, d.tokenB);
const hop1 = BigInt(await viewValue(d.router, 'quote_exact_input_single', [poolAB, z1, IN.toString()]));
const routed = BigInt(await viewValue(d.router, 'quote_exact_input_two', [poolAB, z1, poolBC, z2, IN.toString()]));
console.log(`  ${IN} A -> ${hop1} B -> ${routed} C`);
ok(hop1 > 0n && routed > 0n, 'both legs quote an output');
ok(routed < hop1, 'the second hop takes its own fee', `${routed} < ${hop1}`);

await callContract({
  to: d.tokenA, method: 'grant', params: [d.router, IN.toString()],
  signer, nonce: await next(), label: 'grant router A',
});
const cBefore = await bal(d.tokenC, signer.address);
const bBefore = await bal(d.tokenB, signer.address);
await callContract({
  to: d.router, method: 'exact_input_two',
  params: [poolAB, z1, poolBC, z2, IN.toString(), '1', signer.address, await DEADLINE()],
  signer, nonce: await next(), label: 'router.exact_input_two',
});
const gotC = (await bal(d.tokenC, signer.address)) - cBefore;
console.log(`  received ${gotC} C`);
ok(gotC === routed, 'the route delivered exactly what was quoted', `${gotC} vs ${routed}`);
ok((await bal(d.tokenB, signer.address)) === bBefore, 'the intermediate token never reached the trader');
ok(await bal(d.tokenB, d.router) === 0n, 'the router kept none of the intermediate token');
ok(await bal(d.tokenA, d.router) === 0n, 'the router kept none of the input');
ok(BigInt(await viewValue(d.tokenA, 'allowance', [signer.address, d.router])) === 0n, 'no standing allowance left');

step('trade back C -> B -> A');
const z3 = dirOf(bc0, d.tokenC), z4 = dirOf(ab0, d.tokenB);
const backQuote = BigInt(await viewValue(d.router, 'quote_exact_input_two', [poolBC, z3, poolAB, z4, gotC.toString()]));
await callContract({
  to: d.tokenC, method: 'grant', params: [d.router, gotC.toString()],
  signer, nonce: await next(), label: 'grant router C',
});
const aBefore = await bal(d.tokenA, signer.address);
await callContract({
  to: d.router, method: 'exact_input_two',
  params: [poolBC, z3, poolAB, z4, gotC.toString(), '1', signer.address, await DEADLINE()],
  signer, nonce: await next(), label: 'router.exact_input_two back',
});
const gotA = (await bal(d.tokenA, signer.address)) - aBefore;
console.log(`  received ${gotA} A for ${gotC} C`);
ok(gotA === backQuote, 'the reverse route matched its quote', `${gotA} vs ${backQuote}`);
ok(gotA < IN, 'a round trip through two pools costs both fees', `${gotA} < ${IN}`);

step('exact output through two pools');
const WANT = 10n ** 18n;
const cost = BigInt(await viewValue(d.router, 'quote_exact_output_two', [poolAB, z1, poolBC, z2, WANT.toString()]));
console.log(`  ${WANT} C costs ${cost} A`);
ok(cost > WANT, 'buying through two pools costs more than it yields', `${cost} > ${WANT}`);
const cap = cost * 2n;
await callContract({
  to: d.tokenA, method: 'grant', params: [d.router, cap.toString()],
  signer, nonce: await next(), label: 'grant router for exact output',
});
const c2 = await bal(d.tokenC, signer.address);
const a2 = await bal(d.tokenA, signer.address);
await callContract({
  to: d.router, method: 'exact_output_two',
  params: [poolAB, z1, poolBC, z2, WANT.toString(), cap.toString(), signer.address, await DEADLINE()],
  signer, nonce: await next(), label: 'router.exact_output_two',
});
const deliveredC = (await bal(d.tokenC, signer.address)) - c2;
const spentA = a2 - (await bal(d.tokenA, signer.address));
console.log(`  delivered ${deliveredC} C for ${spentA} A`);
ok(deliveredC === WANT, 'exact output delivered precisely the amount asked for', `${deliveredC}`);
ok(spentA <= cap, 'never spent more than the ceiling', `${spentA} <= ${cap}`);
ok(await bal(d.tokenA, d.router) === 0n, 'residue swept back to the trader');
ok(await bal(d.tokenB, d.router) === 0n, 'no intermediate token stranded in the router');

step('a route may not reuse a pool');
let refused = false;
try {
  await callContract({
    to: d.router, method: 'exact_input_two',
    params: [poolAB, z1, poolAB, z1, IN.toString(), '1', signer.address, await DEADLINE()],
    signer, nonce: await next(), label: 'router.exact_input_two duplicate', ou: '2000',
  });
} catch (e) {
  refused = /revert|failed/i.test(e.message);
}
ok(refused, 'the same pool twice in a route is refused');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
