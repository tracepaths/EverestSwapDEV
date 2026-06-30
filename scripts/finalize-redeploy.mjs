#!/usr/bin/env node
/**
 * finalize-redeploy.mjs
 *
 * Finalize a partially-completed redeploy. Use this AFTER the main
 * redeploy-pool-and-seed.mjs reports failure at add_liquidity but the
 * on-chain state confirms add_liquidity actually succeeded. This is a
 * one-shot helper: it (optionally) submits the trailing register_pool on
 * the SwapFactory, then patches everestswap-frontend/.env,
 * deployments.json, and writes env-update.json.
 *
 * It does NOT submit any deploy / set_tokens / set_factory / grant /
 * add_liquidity tx — those already happened in the previous run. Verify
 * the on-chain pool state before invoking this.
 *
 * Usage (matching the .env written during prior prep):
 *   MNEMONIC="..." RPC_URL="..." \
 *     node scripts/finalize-redeploy.mjs
 *
 * Optional CLI flags / env vars:
 *   --no-deposit        Skip the optional WOCT auto-deposit (unused by finalize)
 *   --skip-register     Skip the on-chain register_pool call entirely.
 *                       Useful when the factory already has the WOCT/OES pair
 *                       mapped (uniqueness guard) and re-registration would
 *                       just revert; the .env + deployments.json patches below
 *                       give you direct-address routing without factory update.
 *   --max-wait-ms N     Per-tx wait budget override (default 600_000 = 10 min).
 *   --rpc-timeout-ms N  Per-RPC fetch timeout override (default 15_000 = 15 s).
 *
 * Behavior:
 *   - If --skip-register is passed, the register_pool call is bypassed
 *     and the script proceeds directly to the file-patch phase.
 *   - Otherwise, register_pool is submitted. If the receipt shows
 *     success=false (common: the previous broken pool is still mapped to
 *     WOCT/OES in the factory and `register_pool` reverts on its
 *     uniqueness guard `require(self.pools_by_pair[...] == "")`), the
 *     script logs a warning and STILL proceeds to the file-patch phase
 *     so the frontend can route to the new pool by direct address. Use
 *     the factory's `update_pool` (caller == fee_to_setter) to actually
 *     swap the registry when ready.
 *
 * env-update.json factoryRegistration schema (consumed by downstream tooling):
 *   {
 *     attempted: boolean,             // did we submit register_pool?
 *     success?: boolean,              // if attempted: did it mine cleanly?
 *     skipped?: boolean,              // true when --skip-register was passed
 *     reason?: 'pair_conflict'        // substring matcher in [2/5] fired (AML
 *               | 'submit_rejected'   // RPC rejected our signature pre-mempool
 *               | 'no_tx_hash'        // submit returned no tx_hash
 *               | 'unknown_revert',    // chain wrapped AML error as opaque
 *     txHash?: string,                 // tx we submitted (if any)
 *     attempts?: number,               // receipt polls before mined (success path)
 *     receipt?: object,                // raw contract_receipt response (success)
 *     response?: object,               // raw octra_submit response (no_tx_hash)
 *     error?: string,                  // always a string: e.message | revertMsg
 *     conflictingWithFactoryPair?: boolean,  // [3/5] factory.get_pool returned
 *                                             //   an address other than NEW_POOL.
 *                                             //   Additive — preserved alongside
 *                                             //   any prior `reason` for debug.
 *   }
 *
 * When --skip-register is used, `reason` reflects SUBMISSION state (skipped)
 * while `conflictingWithFactoryPair` reflects FACTORY GROUND-TRUTH (regardless
 * of whether we tried to update the registry).
 *
 * Exit codes:
 *   0 = success, files patched (factory register optional/skipped)
 *   1 = missing MNEMONIC
 *   2 = deployer mismatch (refuses to run from wrong wallet)
 *   3 = pool not seeded (reserves = 0)
 *   4 = file patching failed (env / deployments.json / write error)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WOCT_ADDRESS,
  OES_ADDRESS,
  FACTORY_ADDRESS,
  ROUTER_ADDRESS,
  DEFAULT_TX_MAX_WAIT_MS,
  DEFAULT_RPC_CALL_TIMEOUT_MS,
  RECEIPT_POLL_MS,
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
const FRONTEND_ROOT = path.join(DEV_ROOT, '..', 'everestswap-frontend');

const MNEMONIC = process.env.MNEMONIC;
const NEW_POOL = process.env.EVERESTSWAP_DEVNET_NEW_POOL
  || 'octH8LDfDgQwZYumaSvu3fbdkm6uVNy3BAxJzqNHqsCGm4q';
const EXPECTED_DEPLOYER = 'octGXi34vZfYwi3idjSa6m34vLJCoJHNMNAGeHyqh7JVEvy';
const FEE_OU = '100000';
const SKIP_REGISTER = process.argv.includes('--skip-register');

// Per-tx budget: CLI > env > default. parsed via the shared strict ms
// validator so `--max-wait-ms=foo` warns + falls back instead of NaN.
const TX_MAX_WAIT_MS = parseMs(
  cliArg('max-wait-ms') ?? process.env.EVERESTSWAP_TX_MAX_WAIT_MS,
  DEFAULT_TX_MAX_WAIT_MS,
  'EVERESTSWAP_TX_MAX_WAIT_MS',
);
const RPC_CALL_TIMEOUT_MS = parseMs(
  cliArg('rpc-timeout-ms') ?? process.env.EVERESTSWAP_RPC_TIMEOUT_MS,
  DEFAULT_RPC_CALL_TIMEOUT_MS,
  'EVERESTSWAP_RPC_TIMEOUT_MS',
);

// Substring patterns the chain uses in its `register_pool` revert
// reasons. If we see ANY of these on the receipt, the factory's
// uniqueness guard fired — we proceed to file patches (the user's
// .env+deployments.json path works without factory registration).
const PAIR_CONFLICT_MARKERS = [
  'pool already exists for this pair',
  'pair already exists',
  'pool already registered',
];

function isPairConflictError(message) {
  if (!message) return false;
  const lc = String(message).toLowerCase();
  return PAIR_CONFLICT_MARKERS.some((m) => lc.includes(m.toLowerCase()));
}

// ── File patching (atomic-ish with .bak backup + CRLF-safe) ────────────
function patchFrontendEnv(newPoolAddress) {
  const envPath = path.join(FRONTEND_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(`${envPath}.created`, `EVERESTSWAP_DEVNET_POOL_ADDRESS=${newPoolAddress}\n`);
    console.log(`       ⚠️  .env not found — wrote ${envPath}.created instead`);
    return;
  }
  const isGitignored = fs.existsSync(path.join(FRONTEND_ROOT, '.gitignore'))
    && fs.readFileSync(path.join(FRONTEND_ROOT, '.gitignore'), 'utf-8').includes('.env');
  if (!isGitignored) {
    console.log('       ⚠️  .gitignore missing or doesn\'t list \'.env\' — SKIPPING .env patch to avoid secret leak.');
    console.log(`         Set EVERESTSWAP_DEVNET_POOL_ADDRESS=${newPoolAddress} manually.`);
    return;
  }
  const original = fs.readFileSync(envPath, 'utf-8');
  fs.writeFileSync(`${envPath}.bak`, original);
  const eol = /\r\n/.test(original) ? '\r\n' : '\n';
  const keyRe = /^EVERESTSWAP_DEVNET_POOL_ADDRESS=.*\r?$/m;
  let updated;
  if (keyRe.test(original)) {
    updated = original.replace(keyRe, `EVERESTSWAP_DEVNET_POOL_ADDRESS=${newPoolAddress}`);
  } else {
    const trailing = original.endsWith(eol) || original === '' ? '' : eol;
    updated = original + trailing +
      `# Added by finalize-redeploy.mjs (${new Date().toISOString()})${eol}` +
      `EVERESTSWAP_DEVNET_POOL_ADDRESS=${newPoolAddress}${eol}`;
  }
  fs.writeFileSync(envPath, updated);
  console.log(`       ✓ patched (backup at ${envPath}.bak)`);
}

function patchDeploymentsJson(newPoolAddress) {
  const p = path.join(DEV_ROOT, 'deployments.json');
  const doc = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  doc.SwapPool = newPoolAddress;
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
  console.log(`       ✓ ${p} updated`);
}

function writeEnvUpdate({ newPoolAddress, factoryRegisterStatus }) {
  const updatePath = path.join(DEV_ROOT, 'env-update.json');
  fs.writeFileSync(updatePath, JSON.stringify({
    SwapPool: newPoolAddress,
    WOCT: WOCT_ADDRESS,
    OES: OES_ADDRESS,
    Factory: FACTORY_ADDRESS,
    Router: ROUTER_ADDRESS,
    deployer: EXPECTED_DEPLOYER,
    initialLiquidity: { woct: '1000000', oes: '100000000' },
    seededAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    finishedBy: 'finalize-redeploy.mjs',
    factoryRegistration: factoryRegisterStatus,
  }, null, 2) + '\n');
  console.log(`       ✓ wrote ${updatePath}`);
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  if (!MNEMONIC) {
    console.error('ERROR: MNEMONIC env var not set.');
    console.error('Usage: MNEMONIC="..." RPC_URL="..." node scripts/finalize-redeploy.mjs [--skip-register]');
    process.exit(1);
  }
  console.log('═'.repeat(60));
  console.log(' SwapPool finalize-redeploy');
  console.log('═'.repeat(60));
  console.log(` Network:    ${getRpcUrl()}`);
  console.log(` Tx wait:    ${TX_MAX_WAIT_MS / 1000}s per tx  (override: --max-wait-ms N or EVERESTSWAP_TX_MAX_WAIT_MS)`);
  console.log(` RPC fetch:  ${RPC_CALL_TIMEOUT_MS / 1000}s per call (override: --rpc-timeout-ms N or EVERESTSWAP_RPC_TIMEOUT_MS)`);
  console.log(` Skip reg:   ${SKIP_REGISTER ? 'yes (--skip-register)' : 'no'}`);
  console.log('═'.repeat(60) + '\n');

  const deployer = getDeployer(MNEMONIC);
  process.env.MNEMONIC = '';
  if (deployer.address !== EXPECTED_DEPLOYER) {
    console.error(`Refusing to proceed: deployer ${deployer.address} != expected ${EXPECTED_DEPLOYER}`);
    process.exit(2);
  }

  // 1. Verify pool state
  console.log(`[1/5] Verifying pool state at ${NEW_POOL}...`);
  const poolInfo = await rpcCall('contract_call', [NEW_POOL, 'get_pool_info', []], RPC_CALL_TIMEOUT_MS);
  const storage = (poolInfo && poolInfo.storage) || poolInfo || {};
  console.log(`       reserve_a: ${storage.reserve_a ?? '?'}`);
  console.log(`       reserve_b: ${storage.reserve_b ?? '?'}`);
  console.log(`       total_lp:  ${storage.total_lp ?? '?'}`);
  console.log(`       active:    ${storage.active ?? '?'}`);
  const ra = String(storage.reserve_a || '0');
  const rb = String(storage.reserve_b || '0');
  if (ra === '0' || rb === '0') {
    console.error('Pool not seeded. Run redeploy-pool-and-seed.mjs first.');
    process.exit(3);
  }
  console.log('       ✓ Pool is deployed and seeded.\n');

  // 2. Submit register_pool (optional)
  let factoryRegisterStatus = { attempted: false };
  if (!SKIP_REGISTER) {
    console.log(`[2/5] Submitting register_pool(WOOT, OES, ${NEW_POOL.slice(0, 12)}…) on factory ${FACTORY_ADDRESS.slice(0, 12)}…`);
    const bal = await rpcCall('octra_balance', [deployer.address], RPC_CALL_TIMEOUT_MS);
    console.log(`       deployer nonce ${bal.nonce}, balance ${bal.balance} OCT`);
    const nonce = bal.nonce + 1;
    // Float (not Math.floor) so the timestamp byte-string round-trips through
    // the chain's f64 parser cleanly. Integer seconds get re-serialized to
    // "<n>.0" by some JSON libraries, breaking the signature.
    const ts = Date.now() / 1000;
    const tx = {
      from: deployer.address,
      to_: FACTORY_ADDRESS,
      amount: '0',
      nonce,
      ou: FEE_OU,
      timestamp: ts,
      op_type: 'call',
      encrypted_data: 'register_pool',
      message: JSON.stringify([WOCT_ADDRESS, OES_ADDRESS, NEW_POOL]),
    };
    signTx(tx, deployer.keypair.secretKey);
    let submitResult;
    try {
      submitResult = await rpcCall('octra_submit', [tx], RPC_CALL_TIMEOUT_MS);
    } catch (e) {
      console.log(`       ⚠️  submit rejected (${e.message}). Will proceed to file patches anyway.`);
      factoryRegisterStatus = { attempted: true, success: false, reason: 'submit_rejected', error: e.message };
    }
    if (submitResult) {
      const txHash = submitResult.tx_hash || submitResult.hash;
      if (!txHash) {
        console.log('       ⚠️  submit returned no tx_hash. Will proceed to file patches.');
        factoryRegisterStatus = { attempted: true, success: false, reason: 'no_tx_hash', response: submitResult };
      } else {
        console.log(`       submitted: ${txHash}`);
        try {
          const { receipt, attempts } = await waitReceipt(txHash, 'register_pool', {
            maxWaitMs: TX_MAX_WAIT_MS,
            rpcTimeoutMs: RPC_CALL_TIMEOUT_MS,
          });
          console.log(`       ✓ register_pool mined (${attempts} poll${attempts === 1 ? '' : 's'})`);
          factoryRegisterStatus = { attempted: true, success: true, txHash, attempts, receipt };
        } catch (e) {
          const revertMsg = e.message || String(e);
          if (isPairConflictError(revertMsg)) {
            console.log('       ⚠️  register_pool reverted: pair already exists in factory.');
            console.log('          Proceeding to file patches (frontend will route by direct pool address).');
            console.log('          Use the factory\'s update_pool (caller == fee_to_setter) to swap registry if needed.');
            factoryRegisterStatus = {
              attempted: true,
              success: false,
              reason: 'pair_conflict',
              txHash,
              error: revertMsg,
            };
          } else {
            console.log(`       ⚠️  register_pool failed: ${revertMsg.slice(0, 200)}`);
            console.log('          Proceeding to file patches so frontend can still route by direct address.');
            factoryRegisterStatus = {
              attempted: true,
              success: false,
              reason: 'unknown_revert',
              txHash,
              error: revertMsg,
            };
          }
        }
      }
    }
  } else {
    console.log(`[2/5] --skip-register set; not submitting register_pool.`);
    console.log('       Frontend will route to the new pool by direct address.');
    factoryRegisterStatus = { attempted: false, skipped: true };
  }
  console.log();

  // 3. Look up which pool the factory has registered for WOCT/OES RIGHT NOW
  //    (this also documents what the chain sees, even if --skip-register
  //    was passed so we don't actually submit register_pool).
  console.log(`[3/5] Looking up factory registration (factory.get_pool(WOOT, OES))...`);
  let factoryPoolAddr = null;
  let factoryLookupOk = false;
  try {
    const fp = await rpcCall('contract_call', [FACTORY_ADDRESS, 'get_pool', [WOCT_ADDRESS, OES_ADDRESS]], RPC_CALL_TIMEOUT_MS);
    if (typeof fp === 'string') factoryPoolAddr = fp;
    else if (fp && fp.storage && fp.storage.pool_address) factoryPoolAddr = fp.storage.pool_address;
    else if (fp && fp.result) factoryPoolAddr = fp.result;
    else if (fp && fp.pool_address) factoryPoolAddr = fp.pool_address;
    console.log(`       factory returned: ${JSON.stringify(fp).slice(0, 200)}`);
  } catch (e) {
    console.log(`       ⚠️  factory.get_pool reverted: ${e.message}`);
    console.log('          (often happens when no pool is registered for this pair yet)');
  }
  if (factoryPoolAddr === NEW_POOL) {
    console.log('       ✓ factory has the new pool.');
    factoryLookupOk = true;
  } else if (factoryPoolAddr && factoryPoolAddr !== NEW_POOL) {
    console.log(`       ⚠️  factory points to '${factoryPoolAddr}' (the OLD pool), NOT the new one.`);
    console.log('          To swap registry: from the factory\'s deployer key (fee_to_setter),');
    console.log(`          call: update_pool(WOOT, OES, ${NEW_POOL})`);
    // [V18] When the factory's WOCT/OES slot is occupied by a different pool,
    // we set `conflictingWithFactoryPair: true` ADDITIVELY (not overwriting
    // `reason`). This preserves prior failure info (`submit_rejected`,
    // `no_tx_hash`, `unknown_revert`, or even an earlier `pair_conflict` from
    // the substring matcher in [2/5]) so future debug can trace WHICH branch
    // fired first. Both branches can now fire on the same run; this field
    // remains unambiguous (the boolean means: factory.get_pool returned
    // something other than NEW_POOL right now).
    factoryRegisterStatus = {
      ...(factoryRegisterStatus ?? {}),
      conflictingWithFactoryPair: true,
    };
  } else {
    console.log(`       ⚠️  factory has no pool registered for WOCT/OES.`);
  }
  console.log();

  // 4. Patch frontend .env
  console.log(`[4/5] Patching everestswap-frontend/.env...`);
  try {
    patchFrontendEnv(NEW_POOL);
  } catch (e) {
    console.error(`File patch (.env) failed: ${e.message}`);
    process.exit(4);
  }
  console.log();

  // 5. Update deployments.json + write env-update.json
  console.log(`[5/5] Updating everestswap-dev/deployments.json + env-update.json...`);
  try {
    patchDeploymentsJson(NEW_POOL);
    writeEnvUpdate({ newPoolAddress: NEW_POOL, factoryRegisterStatus });
  } catch (e) {
    console.error(`File patch (deployments.json / env-update.json) failed: ${e.message}`);
    process.exit(4);
  }

  console.log('\n✅ FINALIZE DONE.');
  if (!factoryLookupOk) {
    console.log('   ⚠️  Factory registry still maps WOCT/OES to the OLD pool.');
    console.log('      To swap registry: from the factory\'s deployer key (fee_to_setter),');
    console.log(`      call: update_pool(WOOT, OES, ${NEW_POOL})`);
  }
  console.log('   Restart the frontend dev server to pick up the new pool address.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ finalize failed:', e.message || e);
  process.exit(4);
});
