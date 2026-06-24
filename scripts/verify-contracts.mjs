#!/usr/bin/env node
/**
 * verify-contracts.mjs — Read-only contract verification via Octra devnet RPC.
 * No MNEMONIC needed. Uses contract_call (view) to confirm the live deployed
 * contracts match the addresses in config and respond to expected view fns.
 *
 * Run: node scripts/verify-contracts.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';

// Addresses from deployments.json (source of truth for live contracts)
const deployments = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'deployments.json'), 'utf-8')
);

const WOCT = deployments.WOCT;
const OES = deployments.OES;
const POOL = deployments.SwapPool;
const FACTORY = deployments.SwapFactory;
const ROUTER = deployments.Router;

let passed = 0;
let failed = 0;
const failures = [];

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${method}: ${data.error.message}`);
  return data.result;
}

async function viewCall(contract, method, params = []) {
  const result = await rpc('contract_call', [contract, method, params]);
  return result.result;
}

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name} ${detail}`);
  }
}

async function main() {
  console.log('=== EverestSwap Contract Verification (read-only) ===\n');

  // 1. OES token
  try {
    const name = await viewCall(OES, 'get_name');
    check('OES get_name', name === 'Octra Everest Swap', `got "${name}"`);
  } catch (e) { failed++; failures.push(`OES get_name: ${e.message}`); }

  // 2. WOCT token
  try {
    const name = await viewCall(WOCT, 'get_name');
    check('WOCT get_name', name === 'Wrapped OCT', `got "${name}"`);
  } catch (e) { failed++; failures.push(`WOCT get_name: ${e.message}`); }

  // 3. SwapPool tokens
  try {
    const tokenA = await viewCall(POOL, 'get_token_a');
    const tokenB = await viewCall(POOL, 'get_token_b');
    check('Pool token_a set', tokenA !== '' && tokenA.startsWith('oct'), `got "${tokenA}"`);
    check('Pool token_b set', tokenB !== '' && tokenB.startsWith('oct'), `got "${tokenB}"`);
    check('Pool tokens differ', tokenA !== tokenB);
  } catch (e) { failed++; failures.push(`Pool tokens: ${e.message}`); }

  // 4. SwapPool reserves
  try {
    const raw = await viewCall(POOL, 'get_reserves');
    // Octra RPC returns tuples as #-delimited string: "7#<valA>#<valB>"
    const parts = String(raw).split('#');
    const resA = parts.length >= 3 ? parts[1] : raw;
    const resB = parts.length >= 3 ? parts[2] : '';
    check('Pool reserves > 0', Number(resA) > 0 && Number(resB) > 0, `a=${resA} b=${resB}`);
  } catch (e) { failed++; failures.push(`Pool reserves: ${e.message}`); }

  // 5. Factory
  try {
    const poolCount = await viewCall(FACTORY, 'pools_length');
    check('Factory has pools', Number(poolCount) > 0, `count=${poolCount}`);
    const factoryPool = await viewCall(FACTORY, 'get_pool', [WOCT, OES]);
    check('Factory resolves WOCT/OES pool', factoryPool !== '' && factoryPool.startsWith('oct'));
  } catch (e) { failed++; failures.push(`Factory: ${e.message}`); }

  // 6. Router
  try {
    const routerFactory = await viewCall(ROUTER, 'get_factory');
    check('Router factory matches', routerFactory === FACTORY, `got "${routerFactory}"`);
  } catch (e) { failed++; failures.push(`Router: ${e.message}`); }

  // 7. WOCT pending withdrawals (H-2 relevant)
  try {
    const pending = await viewCall(WOCT, 'get_total_pending_withdrawals');
    check('WOCT pending withdrawals queryable', typeof pending !== 'undefined');
    console.log(`  WOCT total_pending_withdrawals: ${pending}`);
  } catch (e) { failed++; failures.push(`WOCT pending: ${e.message}`); }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  ✗ ${f}`));
    process.exit(1);
  }
  console.log('All checks passed.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
