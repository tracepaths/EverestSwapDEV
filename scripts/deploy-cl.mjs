// Deploys the concentrated-liquidity exchange: factory, pool template, position
// manager, router, the token launcher with its own template, and two tokens to
// exercise it with.
//
// Everything is written to deployments-cl.json as it happens, so a run that dies
// halfway can be resumed by re-running with the surviving addresses in place
// rather than starting over and orphaning what already landed.
import './lib/env.mjs';
import fs from 'node:fs';
import { compileFile } from './lib/aml.mjs';
import { labelReport } from './lib/jdest.mjs';
import {
  signerFromEnv, nonceOf, balanceOf, deployContract, callContract, viewValue, currentEpoch,
} from './lib/octra-chain.mjs';

const OUT = 'deployments-cl.json';
const state = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf-8')) : {};
const save = () => fs.writeFileSync(OUT, JSON.stringify(state, null, 2) + '\n');

const signer = signerFromEnv();

// Read the nonce fresh for every send. A transaction the node rejects outright
// never consumes its nonce, so a counter kept in memory drifts one ahead of the
// chain after any failure and refuses everything that follows.
const next = async () => (await nonceOf(signer.address)) + 1;

const bal = await balanceOf(signer.address);
console.log(`deployer ${signer.address}`);
console.log(`balance  ${bal.balance} OCT   nonce ${await nonceOf(signer.address)}   epoch ${await currentEpoch()}`);

const bytecode = {};
for (const name of ['EverestFactory', 'EverestPool', 'EverestPositionManager', 'EverestRouter', 'EverestTokenLauncher', 'Token', 'TestToken']) {
  const r = await compileFile(`contracts/${name}.aml`);
  if (!r.ok) { console.error(`compile ${name}: ${r.error}`); process.exit(1); }
  const label = labelReport(r);
  if (label.willReject) {
    console.error(`${name} declares ${label.functions} functions; the node accepts at most ${label.limit}`);
    process.exit(1);
  }
  bytecode[name] = r.bytecode;
  console.log(`compiled ${name.padEnd(24)} ${r.bytecode.length} bytes   ${label.headroom} functions spare`);
}

async function deployOnce(key, name) {
  if (state[key]) { console.log(`have     ${name.padEnd(24)} ${state[key]}`); return state[key]; }
  const d = await deployContract({ bytecode: bytecode[name], signer, nonce: await next(), label: name });
  state[key] = d.address; save();
  console.log(`deployed ${name.padEnd(24)} ${d.address}`);
  return d.address;
}

async function once(key, to, method, params, label) {
  if (state.done?.[key]) { console.log(`have     ${label}`); return; }
  await callContract({ to, method, params, signer, nonce: await next(), label });
  state.done = state.done || {}; state.done[key] = true; save();
  console.log(`called   ${label}`);
}

// A template upload is the largest call either contract takes, so it is skipped
// when the chain already holds exactly these bytes. Comparing the length is
// enough: a recompile that changes anything changes the length in practice, and
// re-uploading when it does not is only wasted fee, never a wrong state.
async function uploadTemplate(holder, method, name, label) {
  const onChain = Number(await viewValue(holder, 'get_template_size', []).catch(() => 0));
  if (onChain === bytecode[name].length) {
    console.log(`have     ${label.padEnd(28)} ${onChain} bytes`);
    return;
  }
  await callContract({
    to: holder, method, params: [bytecode[name]],
    signer, nonce: await next(), label, ou: '400000',
  });
  console.log(`called   ${label.padEnd(28)} ${onChain} -> ${bytecode[name].length} bytes`);
}

console.log('\n── core ──');
const factory = await deployOnce('factory', 'EverestFactory');
await uploadTemplate(factory, 'set_pool_template', 'EverestPool', 'factory.set_pool_template');

const manager = await deployOnce('positionManager', 'EverestPositionManager');
await once('managerFactory', manager, 'set_factory', [factory], 'manager.set_factory');

const router = await deployOnce('router', 'EverestRouter');
await once('routerFactory', router, 'set_factory', [factory], 'router.set_factory');

console.log('\n── token launcher ──');
// The launcher exists because a wallet on this chain can call a contract but
// cannot deploy one. It holds the token bytecode and stamps out a copy on
// request; it has no power over anything it spawns.
const launcher = await deployOnce('tokenLauncher', 'EverestTokenLauncher');
await uploadTemplate(launcher, 'set_token_template', 'Token', 'launcher.set_token_template');

console.log('\n── test tokens ──');
const tokenA = await deployOnce('tokenA', 'TestToken');
await once('labelA', tokenA, 'label', ['Everest Test Alpha', 'ALPHA'], 'tokenA.label');
const tokenB = await deployOnce('tokenB', 'TestToken');
await once('labelB', tokenB, 'label', ['Everest Test Beta', 'BETA'], 'tokenB.label');

state.woct = state.woct || 'oct4g33tzC2cJncL5RFr9TRiyk8yCNP1h2xaogiWJS5opNv';
state.deployer = signer.address;
state.templateBytes = bytecode.EverestPool.length;
state.tokenTemplateBytes = bytecode.Token.length;
save();

console.log('\n── verify ──');
const check = async (label, fn) => {
  try { console.log(`  ${label.padEnd(34)} ${await fn()}`); }
  catch (e) { console.log(`  ${label.padEnd(34)} ERR ${e.message.slice(0, 100)}`); }
};
await check('factory.get_owner', () => viewValue(factory, 'get_owner', []));
await check('factory.get_template_size', () => viewValue(factory, 'get_template_size', []));
await check('factory.fee_tiers_packed', () => viewValue(factory, 'fee_tiers_packed', []));
await check('factory.get_pool_count', () => viewValue(factory, 'get_pool_count', []));
await check('manager.get_factory', () => viewValue(manager, 'get_factory', []));
await check('router.get_factory', () => viewValue(router, 'get_factory', []));
await check('launcher.get_owner', () => viewValue(launcher, 'get_owner', []));
await check('launcher.get_template_size', () => viewValue(launcher, 'get_template_size', []));
await check('launcher.get_token_count', () => viewValue(launcher, 'get_token_count', []));
await check('tokenA.get_symbol', () => viewValue(tokenA, 'get_symbol', []));
await check('tokenB.get_symbol', () => viewValue(tokenB, 'get_symbol', []));
await check('tokenA.balance_of(deployer)', () => viewValue(tokenA, 'balance_of', [signer.address]));

console.log(`\nwrote ${OUT}`);
