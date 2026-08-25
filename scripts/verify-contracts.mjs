#!/usr/bin/env node
// Checks that what is deployed is what was meant to be deployed.
//
// Read-only. Every call here is a `view fn`, which the node runs for free, so
// this needs no key, no nonce and no fee, and it is safe to point at anything
// including a live deployment. It is what to run after deploying, and what to run
// first when the interface misbehaves — it separates "the contracts are wrong"
// from "the interface is wrong" without having to read either.
//
// The checks are relationships rather than recorded values, because the values
// change: a pool count grows, a price moves. What must not change is that the
// manager and the router point at the same factory the registry belongs to, that
// every fee tier carries its intended spacing, and that each pool's own account
// of itself agrees with the registry's.
//
// Addresses come from deployments-cl.json, which the deployer writes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewValue } from './lib/octra-chain.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const NETWORK = process.env.NETWORK || (/mainnet/.test(RPC) ? 'mainnet' : 'devnet');
const STATE = path.join(__dirname, '..', 'deployments-cl.json');

if (!fs.existsSync(STATE)) {
  console.error(`no ${path.basename(STATE)} — run scripts/deploy-cl.mjs first`);
  process.exit(1);
}
const state = JSON.parse(fs.readFileSync(STATE, 'utf-8'));

/** Fee tier to tick spacing. A tier with the wrong spacing accepts positions the
 *  pool will then refuse, and the failure surfaces much later as a mint that
 *  reverts for no visible reason. */
const FEE_TIERS = [[100, 1], [500, 10], [3000, 60], [10000, 200]];

/** Fields in a pool's state_packed, in order. Checked by count, because a change
 *  in shape silently shifts every reader that indexes into it. */
const STATE_FIELDS = 14;

let passed = 0;
const failures = [];

const view = async (contract, method, params = []) => {
  const v = await viewValue(contract, method, params);
  if (v === undefined || v === null) throw new Error(`${method} returned nothing`);
  return String(v).trim();
};

const asBool = (s) => s.toLowerCase() === 'true';

/** Runs one check. A thrown error is a failure, not a crash — the point of the
 *  script is the whole report, and the first broken contract is usually not the
 *  only thing worth knowing. */
async function check(label, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ok    ${label}${detail ? `  ${detail}` : ''}`);
  } catch (e) {
    failures.push(`${label}: ${e.message}`);
    console.log(`  FAIL  ${label}  ${e.message.slice(0, 140)}`);
  }
}

function expect(condition, detail) {
  if (!condition) throw new Error(detail);
  return detail;
}

function missing(what, key) {
  failures.push(`${what}: no "${key}" in ${path.basename(STATE)}`);
  console.log(`  FAIL  ${what} address missing`);
}

const { factory, positionManager, router, tokenLauncher } = state;
const short = (a) => `${String(a).slice(0, 10)}…`;

console.log(`verifying ${path.basename(STATE)} against ${RPC}\n`);

console.log('── factory ──');
if (!factory) missing('factory', 'factory');
else {
  await check('answers get_owner', async () => {
    const owner = await view(factory, 'get_owner');
    return expect(owner.startsWith('oct'), `owner=${owner}`);
  });
  await check('is not paused', async () => {
    const paused = await view(factory, 'is_paused');
    return expect(!asBool(paused), `paused=${paused}`);
  });
  await check('holds the pool template', async () => {
    const size = Number(await view(factory, 'get_template_size'));
    return expect(size > 0, `${size} bytes`);
  });
  await check('has every fee tier at its intended spacing', async () => {
    const packed = await view(factory, 'fee_tiers_packed');
    const seen = new Map(packed.split(';').filter((r) => r.trim()).map((row) => {
      const [fee, spacing] = row.split(':');
      return [Number(fee), Number(spacing)];
    }));
    for (const [fee, spacing] of FEE_TIERS) {
      expect(seen.has(fee), `fee tier ${fee} is not enabled`);
      expect(seen.get(fee) === spacing, `fee ${fee} has spacing ${seen.get(fee)}, expected ${spacing}`);
    }
    return `${seen.size} tiers`;
  });
  await check('reports a pool count', async () => {
    const n = Number(await view(factory, 'get_pool_count'));
    return expect(Number.isInteger(n) && n >= 0, `${n} pools`);
  });
}

console.log('\n── position manager ──');
if (!positionManager) missing('position manager', 'positionManager');
else {
  await check('points at this factory', async () => {
    const seen = await view(positionManager, 'get_factory');
    return expect(seen === factory, `points at ${short(seen)}, expected ${short(factory)}`);
  });
  await check('reports its position registry', async () => {
    const issued = Number(await view(positionManager, 'total_issued'));
    const next = Number(await view(positionManager, 'get_next_id'));
    // Ids are handed out in sequence and never reused, so the next id can only
    // run ahead of the number issued, never behind it.
    expect(next > issued || (next === issued && issued === 0), `next id ${next} is behind ${issued} issued`);
    return `${issued} issued, next id ${next}`;
  });
}

console.log('\n── router ──');
if (!router) missing('router', 'router');
else {
  await check('points at this factory', async () => {
    const seen = await view(router, 'get_factory');
    return expect(seen === factory, `points at ${short(seen)}, expected ${short(factory)}`);
  });
}

if (tokenLauncher) {
  console.log('\n── token launcher ──');
  await check('answers get_owner', async () => {
    const owner = await view(tokenLauncher, 'get_owner');
    return expect(owner.startsWith('oct'), `owner=${owner}`);
  });
  await check('is not paused', async () => {
    const paused = await view(tokenLauncher, 'is_paused');
    return expect(!asBool(paused), `paused=${paused}`);
  });
  await check('holds the token template', async () => {
    const size = Number(await view(tokenLauncher, 'get_template_size'));
    return expect(size > 0, `${size} bytes`);
  });
  await check('reports its token count', async () => `${Number(await view(tokenLauncher, 'get_token_count'))} launched`);
}

// The tokens the interface is configured to know about, checked against the
// tokens themselves. This is the one mismatch that is invisible from either side
// alone: a token holding 6 decimals while the interface believes 18 does not
// error anywhere, it just shows and sends every amount off by a factor of a
// million. Skipped when the interface is not checked out beside this repo.
const CONFIG_TS = path.join(__dirname, '..', '..', 'everestswap-frontend', 'src', 'config', `${NETWORK}.ts`);
if (fs.existsSync(CONFIG_TS)) {
  console.log(`\n── tokens the interface expects (${NETWORK}.ts) ──`);
  const src = fs.readFileSync(CONFIG_TS, 'utf-8');
  const declared = [];
  for (const m of src.matchAll(/export const (\w+_TOKEN)\s*:[^=]*=\s*\{([\s\S]*?)\n\};/g)) {
    const [, name, body] = m;
    const address = body.match(/address:[^,]*?'(oct[1-9A-HJ-NP-Za-km-z]{40,50})'/)?.[1];
    const symbol = body.match(/symbol:\s*'([^']*)'/)?.[1];
    const decimals = body.match(/decimals:\s*(\d+)/)?.[1];
    // The native token has no address by design; there is no contract to ask.
    if (address && symbol && decimals) declared.push({ name, address, symbol, decimals: Number(decimals) });
  }
  if (declared.length === 0) console.log('  none parsed — the config shape may have changed');
  for (const t of declared) {
    await check(`${t.symbol.padEnd(6)} ${short(t.address)}`, async () => {
      const symbol = await view(t.address, 'get_symbol');
      expect(symbol === t.symbol, `interface calls it ${t.symbol}, the contract says ${symbol}`);
      const decimals = Number(await view(t.address, 'decimals'));
      expect(decimals === t.decimals, `interface expects ${t.decimals} decimals, the contract has ${decimals}`);
      return `${decimals} decimals`;
    });
  }
}

// Every pool in the registry, described by the registry and then asked to
// describe itself. The two must agree: the interface takes trade direction from
// each pool's own token order, so a registry that disagreed would send trades
// the wrong way round while looking perfectly healthy.
if (factory) {
  console.log('\n── pools ──');
  let count = 0;
  try { count = Number(await view(factory, 'get_pool_count')); } catch { /* already reported */ }
  if (count === 0) console.log('  none yet');
  for (let start = 0; start < count; start += 64) {
    let rows = [];
    try {
      const packed = await view(factory, 'pool_list_packed', [start, Math.min(64, count - start)]);
      rows = packed.split(';').filter((r) => r.trim());
    } catch (e) {
      failures.push(`pool page at ${start}: ${e.message}`);
      console.log(`  FAIL  pool page at ${start}  ${e.message.slice(0, 100)}`);
      continue;
    }
    for (const row of rows) {
      const [address, token0, token1, fee] = row.split('|').map((s) => s.trim());
      await check(`${short(address)} fee ${fee}`, async () => {
        expect(asBool(await view(factory, 'get_is_pool', [address])), 'registry does not recognise its own pool');
        expect(asBool(await view(address, 'is_configured')), 'pool was never configured by the factory');
        expect(await view(address, 'get_factory') === factory, 'pool points at a different factory');

        const [t0, t1] = [await view(address, 'get_token0'), await view(address, 'get_token1')];
        expect(t0 === token0 && t1 === token1,
          `registry says ${short(token0)}/${short(token1)}, pool says ${short(t0)}/${short(t1)}`);
        // The pair keeps whatever order it was created with, so what has to hold
        // is that the registry answers with this pool from either side. A lookup
        // that resolved one way only would leave half the interface unable to
        // find a pool that plainly exists.
        expect(await view(factory, 'get_pool', [t0, t1, fee]) === address, 'get_pool misses in token0/token1 order');
        expect(await view(factory, 'get_pool', [t1, t0, fee]) === address, 'get_pool misses in token1/token0 order');

        const poolFee = Number(await view(address, 'get_fee'));
        expect(poolFee === Number(fee), `registry says fee ${fee}, pool says ${poolFee}`);
        const spacing = Number(await view(address, 'get_tick_spacing'));
        const intended = FEE_TIERS.find(([f]) => f === poolFee)?.[1];
        expect(spacing === intended, `spacing ${spacing}, expected ${intended} for fee ${poolFee}`);

        const fields = (await view(address, 'state_packed')).split('|');
        expect(fields.length === STATE_FIELDS,
          `state_packed has ${fields.length} fields, expected ${STATE_FIELDS}`);
        const [tick, liquidity, started] = [fields[5], fields[6], asBool(fields[13])];
        if (!started) return 'no opening price yet';
        expect(BigInt(fields[4]) > 0n, 'started but the price is zero');
        return `tick ${tick}, liquidity ${liquidity}`;
      });
    }
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
