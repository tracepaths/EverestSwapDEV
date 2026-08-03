#!/usr/bin/env node
/**
 * redeploy-router.mjs
 *
 * Redeploys Router.aml and wires it to the CURRENT SwapFactory + WOCT via the
 * one-time `init(factory, woct)` path (NOT the old set_factory/set_woct, which
 * no longer exist on Router.aml).
 *
 * Why redeploy:
 *   - [AUDIT-FIX MED-2] swap_exact_tokens_for_tokens now grants the pool an
 *     allowance to pull token_in from the router before dispatching the swap.
 *   - The live Router's factory binding is STALE (points at an old factory).
 *     A fresh deploy + init() re-binds it to deployments.json's SwapFactory.
 *
 * Reads MNEMONIC strictly from the env var (never argv — leaks to `ps`).
 * Addresses come from deployments.json (the lib's hardcoded constants are
 * stale and intentionally NOT used here).
 *
 * Usage:
 *   MNEMONIC="word1 ... word12" node scripts/redeploy-router.mjs [--dry-run]
 *
 * Options:
 *   --dry-run          Compile + compute address, submit nothing.
 *   --max-wait-ms N    Per-tx wait budget (default 600000). Env: EVERESTSWAP_TX_MAX_WAIT_MS
 *   --rpc-timeout-ms N Per-RPC deadline (default 15000). Env: EVERESTSWAP_RPC_TIMEOUT_MS
 *
 * Safety: any error aborts BEFORE deployments.json is touched. The mnemonic is
 * never logged or written to disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TX_MAX_WAIT_MS,
  DEFAULT_RPC_CALL_TIMEOUT_MS,
  getRpcUrl,
  getDeployer,
  signTx,
  rpcCall,
  waitReceipt,
  parseMs,
  cliArg,
} from './lib/octra-tx.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = path.join(__dirname, '..');
const DEPLOYMENTS_PATH = path.join(DEV_ROOT, 'deployments.json');
const RPC_URL = getRpcUrl();
const MNEMONIC = process.env.MNEMONIC;
const FEE_OU = '100000';

const TX_MAX_WAIT_MS = parseMs(
  cliArg('max-wait-ms') ?? process.env.EVERESTSWAP_TX_MAX_WAIT_MS,
  DEFAULT_TX_MAX_WAIT_MS, 'EVERESTSWAP_TX_MAX_WAIT_MS',
);
const RPC_CALL_TIMEOUT_MS = parseMs(
  cliArg('rpc-timeout-ms') ?? process.env.EVERESTSWAP_RPC_TIMEOUT_MS,
  DEFAULT_RPC_CALL_TIMEOUT_MS, 'EVERESTSWAP_RPC_TIMEOUT_MS',
);
const DRY_RUN = process.argv.slice(2).includes('--dry-run');

async function submitTx(deployer, nonceRef, to, amount, opType, encryptedData, message) {
  nonceRef.value++;
  const tx = {
    from: deployer.address, to_: to, amount: amount || '0',
    nonce: nonceRef.value, ou: FEE_OU, timestamp: Date.now() / 1000, op_type: opType,
  };
  if (encryptedData) tx.encrypted_data = encryptedData;
  if (message) tx.message = message;
  signTx(tx, deployer.keypair.secretKey);
  const result = await rpcCall('octra_submit', [tx]);
  const txHash = result.tx_hash;
  if (!txHash) throw new Error(`submit ${opType} returned no tx_hash`);
  const { attempts } = await waitReceipt(txHash, encryptedData || opType, {
    maxWaitMs: TX_MAX_WAIT_MS, rpcTimeoutMs: RPC_CALL_TIMEOUT_MS,
  });
  console.log(`  ✓ ${encryptedData || opType} (nonce ${nonceRef.value}, ${attempts} poll${attempts === 1 ? '' : 's'}) → ${txHash}`);
  return txHash;
}

async function main() {
  if (!MNEMONIC) {
    console.error('ERROR: MNEMONIC env var not set.');
    console.error('Usage: MNEMONIC="word1 ... word12" node scripts/redeploy-router.mjs [--dry-run]');
    console.error('SECURITY: do NOT pass the mnemonic via argv (leaks to process listings).');
    process.exit(1);
  }

  const deployments = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf-8'));
  const FACTORY = deployments.SwapFactory;
  const WOCT = deployments.WOCT;
  if (!FACTORY || !WOCT) throw new Error('deployments.json missing SwapFactory or WOCT');

  const deployer = getDeployer(MNEMONIC);
  process.env.MNEMONIC = '';
  const bal = await rpcCall('octra_balance', [deployer.address]);

  console.log('=== Router Redeploy (init flow) ===');
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${bal.balance} OCT (nonce ${bal.nonce})`);
  console.log(`Network:  ${RPC_URL}`);
  console.log(`Factory:  ${FACTORY}`);
  console.log(`WOCT:     ${WOCT}`);
  if (parseFloat(bal.balance) < 1.0) {
    throw new Error(`Insufficient balance: ${bal.balance} OCT (need >= 1 OCT for deploy + init)`);
  }

  const src = fs.readFileSync(path.join(DEV_ROOT, 'contracts', 'Router.aml'), 'utf-8');
  const compiled = await rpcCall('octra_compileAml', [src]);
  console.log(`\nCompiled Router: ${compiled.size}B, ${compiled.instructions} instr`);

  const nonceRef = { value: bal.nonce };
  // submitTx does nonceRef.value++ first, so the deploy nonce is value+1.
  const deployNonce = nonceRef.value + 1;
  const computed = await rpcCall('octra_computeContractAddress', [
    compiled.bytecode, deployer.address, deployNonce,
  ]);
  const routerAddr = computed.address;
  console.log(`New Router will deploy at: ${routerAddr}`);

  if (DRY_RUN) {
    console.log('\n(dry-run — no transactions submitted)');
    return;
  }

  console.log('\n[1] Deploying Router...');
  await submitTx(deployer, nonceRef, routerAddr, '0', 'deploy', compiled.bytecode, null);
  await new Promise(r => setTimeout(r, 1000));

  // init(factory, woct): one-time, requires caller == owner (deployer) and
  // self.factory == origin (fresh deploy). Re-binds to the CURRENT factory.
  console.log('[2] init(factory, woct)...');
  await submitTx(deployer, nonceRef, routerAddr, '0', 'call', 'init',
    JSON.stringify([FACTORY, WOCT]));

  const prevRouter = deployments.Router;
  deployments.Router = routerAddr;
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(deployments, null, 2) + '\n');
  console.log(`\n✓ Updated deployments.json (Router: ${prevRouter} → ${routerAddr})`);

  const finalBal = await rpcCall('octra_balance', [deployer.address]);
  console.log('\n=== Router Redeploy Complete ===');
  console.log(`New Router: ${routerAddr}`);
  console.log(`Cost: ~${(parseFloat(bal.balance) - parseFloat(finalBal.balance)).toFixed(4)} OCT`);
  console.log('\nNext: update the frontend Router address env var');
  console.log(`  EVERESTSWAP_DEVNET_ROUTER_ADDRESS=${routerAddr}`);
}

main().catch((e) => {
  console.error('\n❌ router redeploy failed:', e.message || e);
  console.error('  → deployments.json was NOT modified.');
  process.exit(1);
});
