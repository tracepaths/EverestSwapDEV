#!/usr/bin/env node
/**
 * [V8] redeploy-pool-and-seed.mjs
 *
 * One-shot redeploy helper for the WOCT/OES pool. Reads MNEMONIC strictly from
 * the `MNEMONIC` environment variable (do NOT pass via argv — it leaks to `ps`).
 *
 * What it does (in order):
 *   1. Compile SwapPool.aml (with the V8-SECURITY owner-only initial-add gate)
 *   2. Compute + deploy new SwapPool (deployer becomes pool owner)
 *   3. set_tokens(WOCT, OES) and set_factory(real_factory) on the new pool
 *   4. register_pool(WOCT, OES, new_pool) on the SwapFactory
 *   5. Auto-deposit 5 OCT → WOCT (skip-on-fail in case WOCT has no `deposit`)
 *   6. Best-effort: set_trusted / set_tax_exempt for the new pool on WOCT and OES
 *      so the pool can pull tokens through aml gates (skipped silently if the
 *      deployer is not the token owner).
 *   7. grant WOCT 1_000_000 raw + grant OES 100_000_000 raw to the new pool
 *   8. add_liquidity(1_000_000, 100_000_000, 0, deadline, 0) — owner-checked,
 *      so it can only be called by the deployer (= pool owner). Deadline is
 *      fetched from `epoch_current` immediately before the call to avoid the
 *      1-300 epoch window expiring during earlier grant/receipt waits.
 *   9. Auto-patch `everestswap/everestswap-frontend/.env` (with .bak backup),
 *      update `deployments.json`, and write a one-line `env-update.json` for
 *      downstream tooling.
 *
 * Usage:
 *   MNEMONIC="word1 word2 ... word12" node scripts/redeploy-pool-and-seed.mjs
 *
 * Options:
 *   --dry-run       Stop before submitting any tx. Print computed pool address.
 *   --skip-env      Do not patch .env (only write env-update.json).
 *   --no-deposit    Skip the 5 OCT → WOCT auto-deposit step.
 *   --max-wait-ms N       Per-tx wait budget in ms (default 600_000 = 10 min).
 *                         Can also be set via env EVERESTSWAP_TX_MAX_WAIT_MS.
 *   --rpc-timeout-ms N    Per-RPC fetch deadline in ms (default 15_000 = 15 s).
 *                         Can also be set via env EVERESTSWAP_RPC_TIMEOUT_MS.
 *
 * Security notes:
 *   - The mnemonic is NEVER logged, echoed, or written to disk. It lives only
 *     in this process's environment for the duration of the script. The
 *     derived keypair is kept in memory and used only to sign transactions
 *     before being garbage-collected.
 *   - Any error aborts the script BEFORE touching .env or deployments.json.
 */

// [V17] Imports come from ./lib/octra-tx.mjs — single source of truth so the
// same helper lives in only one place. (Previously each script had its own
// copies; this caused the Math.floor vs Date.now()/1000 bug we hit once.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WOCT_ADDRESS,
  OES_ADDRESS,
  FACTORY_ADDRESS,
  DEFAULT_TX_MAX_WAIT_MS,
  DEFAULT_RPC_CALL_TIMEOUT_MS,
  RECEIPT_POLL_MS,
  getRpcUrl,
  getDeployer,
  signTx,
  jsonEscape,
  rpcCall,
  waitReceipt,
  parseMs,
  cliArg,
} from './lib/octra-tx.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = path.join(__dirname, '..');
const FRONTEND_ROOT = path.join(DEV_ROOT, '..', 'everestswap-frontend');

// Local alias — keeps existing RPC_URL references in console.log / curl hints
// working without touching every call site.
const RPC_URL = getRpcUrl();
const MNEMONIC = process.env.MNEMONIC;
// [SECURITY-1] Verify the derived deployer against the address the user
// expects. Without this guard, a typo'd/old mnemonic would silently redeploy
// from a wallet that isn't the canonical `octGXi34v…JVEvy`, leaving orphan
// pools and breaking the WOCT/OES AML `tax_exempt`/`trusted_address` whitelist
// (since only the canonical deployer is the token owner).
const EXPECTED_DEPLOYER = process.env.EVERESTSWAP_DEVNET_DEPLOYER_ADDRESS
  || 'octGXi34vZfYwi3idjSa6m34vLJCoJHNMNAGeHyqh7JVEvy';
const FEE_OU = '100000';

// [V17] WOCT_ADDRESS, OES_ADDRESS, FACTORY_ADDRESS are imported from
// ./lib/octra-tx.mjs (single source of truth). Keeping these as local
// redeploy-specific settings — change here if the seed ratio should shift.
const MIN_OCT_BALANCE = 2.0;
const LIQ_WOCT_RAW = '1000000';       // 1 WOCT (6 decimals)
const LIQ_OES_RAW = '100000000';      // 100 OES (6 decimals)

// [V12-V15] Per-tx budget, per-RPC deadline, parseMs/parseInt validation —
// all imported from ./lib/octra-tx.mjs. The locals below just compose
// the env/CLI lookups into resolved integers.
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

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_ENV = args.includes('--skip-env');
const NO_DEPOSIT = args.includes('--no-deposit');

// ── Wallet / RPC helpers ───────────────────────────────────────────────────
// [V17] getDeployer / signTx / jsonEscape / rpcCall / waitReceipt / cliArg /
// parseMs are imported from ./lib/octra-tx.mjs. Removes ~150 lines of
// duplicated logic between this script and finalize-redeploy.mjs.

async function submitTxBrief(deployer, nonceRef, to, amountJson, opType, encryptedData, message) {
  const ts = Date.now() / 1000;
  nonceRef.value++;
  const tx = {
    from: deployer.address,
    to_: to,
    amount: amountJson || '0',
    nonce: nonceRef.value,
    ou: FEE_OU,
    timestamp: ts,
    op_type: opType,
  };
  if (encryptedData) tx.encrypted_data = encryptedData;
  if (message) tx.message = message;
  signTx(tx, deployer.keypair.secretKey);

  // [SECURITY] Don't log the signed tx (contains signature+pubkey).
  const result = await rpcCall('octra_submit', [tx]);
  const txHash = result.tx_hash;
  if (!txHash) throw new Error(`submit ${opType} returned no tx_hash`);
  // [V17] Propagate the new lib waitReceipt return shape ({receipt, attempts})
  // so the success log is symmetric with finalize-redeploy.mjs.
  const { attempts } = await waitReceipt(txHash, opType, {
    maxWaitMs: TX_MAX_WAIT_MS,
    rpcTimeoutMs: RPC_CALL_TIMEOUT_MS,
  });
  // eslint-disable-next-line no-console
  console.log(`  ✓ ${opType}  (nonce ${nonceRef.value}, took ${attempts} poll${attempts === 1 ? '' : 's'})  → ${txHash}`);
  return txHash;
}

// [V9] Belt-and-suspenders: confirm the chain actually deployed bytecode at the
// computed pool address. Catches "RPC returns a tx_hash from local signing, but
// the node silently rejected the tx for nonce/`to_` mismatch" class of bugs
// before we burn 8 more tx fees on set_tokens/factory against a non-existent
// contract. Polls for up to ~30s (15 × 2s).
async function verifyPoolBytecode(addr) {
  // [V10] Same 30s budget as waitReceipt — use the shared cap for consistency.
  let lastErr;
  const deadline = Date.now() + TX_MAX_WAIT_MS;
  // Same pre-iteration budget check as waitReceipt — don't initiate an RPC
  // that would complete after the deadline.
  const perIterMaxMs = RPC_CALL_TIMEOUT_MS + RECEIPT_POLL_MS;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    if (Date.now() + perIterMaxMs >= deadline) break;
    try {
      const r = await rpcCall('contract_call', [addr, 'get_pool_info', []]);
      if (r && r.storage) {
        // [SECURITY] Don't log the storage dump (might leak token addresses).
        // eslint-disable-next-line no-console
        console.log(`  ✓ bytecode confirmed at ${addr} after ~${(attempts - 1) * RECEIPT_POLL_MS / 1000}s (${attempts} polls)`);
        return;
      }
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, RECEIPT_POLL_MS));
  }
  throw new Error(
    `Deploy bytecode never materialized at ${addr} after ${TX_MAX_WAIT_MS / 1000}s / ${attempts} polls.\n` +
    `Last RPC error: ${lastErr?.message || 'unknown'}.\n` +
    `Likely cause: chain silently rejected the deploy tx (nonce mismatch / bad canonical JSON / chain stuck). Check the deploy tx hash on the explorer, then re-run with a fresh nonce after a few seconds.`
  );
}

// ── .env / deployments.json patch helpers ─────────────────────────────────

function patchFrontendEnv(newPoolAddress) {
  const envPath = path.join(FRONTEND_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(`${envPath}.created`, `EVERESTSWAP_DEVNET_POOL_ADDRESS=${newPoolAddress}\n`);
    // eslint-disable-next-line no-console
    console.log(`  ⚠️  .env not found — wrote ${envPath}.created instead`);
    return;
  }
  const isGitignored = fs.existsSync(path.join(FRONTEND_ROOT, '.gitignore'))
    && fs.readFileSync(path.join(FRONTEND_ROOT, '.gitignore'), 'utf-8').includes('.env');
  if (!isGitignored) {
    // [SECURITY-2] Don't write/update .env if it isn't gitignored — backup might leak.
    // eslint-disable-next-line no-console
    console.log(`  ⚠️  .gitignore missing or doesn't list '.env' — SKIPPING .env patch to avoid secret leak.`);
    // eslint-disable-next-line no-console
    console.log(`     Set EVERESTSWAP_DEVNET_POOL_ADDRESS=${newPoolAddress} manually.`);
    return;
  }
  const original = fs.readFileSync(envPath, 'utf-8');
  fs.writeFileSync(`${envPath}.bak`, original);
  // [FIX] Handle CRLF line endings: match optional \r before \n.
  const eol = /\r\n/.test(original) ? '\r\n' : '\n';
  const keyRe = /^EVERESTSWAP_DEVNET_POOL_ADDRESS=.*\r?$/m;
  let updated;
  let wasPresent = false;
  if (keyRe.test(original)) {
    updated = original.replace(
      keyRe,
      `EVERESTSWAP_DEVNET_POOL_ADDRESS=${newPoolAddress}`,
    );
    wasPresent = true;
  } else {
    // [FIX] Append when the key isn't present, instead of silently doing nothing.
    const trailing = original.endsWith(eol) || original === '' ? '' : eol;
    updated = original + trailing + `# Added by redeploy-pool-and-seed.mjs (${new Date().toISOString()})${eol}` +
      `EVERESTSWAP_DEVNET_POOL_ADDRESS=${newPoolAddress}${eol}`;
  }
  fs.writeFileSync(envPath, updated);
  // eslint-disable-next-line no-console
  console.log(`  ✓ ${wasPresent ? 'Replaced' : 'Appended'} EVERESTSWAP_DEVNET_POOL_ADDRESS in ${envPath} (backup at ${envPath}.bak)`);
}

function patchDeploymentsJson(newPoolAddress) {
  const p = path.join(DEV_ROOT, 'deployments.json');
  const doc = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  doc.SwapPool = newPoolAddress;
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(`  ✓ Updated ${p}`);
}

// ── Token-aml helpers (best-effort) ───────────────────────────────────────

async function tryTokenAmlSetup(deployer, nonceRef, tokenAddress, newPool) {
  // Try set_trusted_address and set_tax_exempt on the token contract so that
  // the pool won't be subject to max_wallet / tax during pull. If the deployer
  // is not the token owner, the calls revert and we silently skip.
  for (const fn of ['set_trusted_address', 'set_tax_exempt']) {
    try {
      await submitTxBrief(deployer, nonceRef, tokenAddress, '0', 'call', fn,
        JSON.stringify([newPool, true]));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`  ~ skipped ${fn} on ${tokenAddress.slice(0, 10)}… (deployer likely not token owner)`);
    }
  }
}

// ── Main flow ─────────────────────────────────────────────────────────────

async function main() {
  if (!MNEMONIC) {
    console.error('ERROR: MNEMONIC env var not set.');
    console.error('Usage: MNEMONIC="word1 ... word12" node scripts/redeploy-pool-and-seed.mjs [--dry-run] [--skip-env] [--no-deposit]');
    console.error('SECURITY: do NOT pass mnemonic via argv (leaks to process listings).');
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('╔════════════════════════════════════════════════════════╗');
  // eslint-disable-next-line no-console
  console.log('║   SwapPool Redeploy + 1 WOCT : 100 OES Seed            ║');
  // eslint-disable-next-line no-console
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const deployer = getDeployer(MNEMONIC);
  // Zero-out the original string from memory as best we can (V8 may keep it).
  process.env.MNEMONIC = '';

  const bal = await rpcCall('octra_balance', [deployer.address]);
  // eslint-disable-next-line no-console
  console.log(`Deployer:   ${deployer.address}`);
  if (deployer.address !== EXPECTED_DEPLOYER) {
    // [SECURITY-1] Refuse to redeploy from a non-canonical address — see
    // header doc block for why this matters.
    throw new Error(
      `Refusing to proceed: derived deployer ${deployer.address} does not match the\n` +
      `canonical EVERESTSWAP_DEVNET_DEPLOYER_ADDRESS ${EXPECTED_DEPLOYER}.\n` +
      `Set EVERESTSWAP_DEVNET_DEPLOYER_ADDRESS explicitly to override, or use the\n` +
      `correct mnemonic. (This check prevents orphan pools from wrong-owner wallets.)`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`Balance:    ${bal.balance} OCT (nonce ${bal.nonce})`);
  // eslint-disable-next-line no-console
  console.log(`Network:    ${RPC_URL}`);
  // eslint-disable-next-line no-console
  console.log(`Tx wait:    ${TX_MAX_WAIT_MS / 1000}s per tx  (override: --max-wait-ms N or EVERESTSWAP_TX_MAX_WAIT_MS)`);
  // eslint-disable-next-line no-console
  console.log(`RPC fetch:  ${RPC_CALL_TIMEOUT_MS / 1000}s per call (override: --rpc-timeout-ms N or EVERESTSWAP_RPC_TIMEOUT_MS)\n`);

  if (parseFloat(bal.balance) < MIN_OCT_BALANCE) {
    throw new Error(`Insufficient native balance: ${bal.balance} OCT (need >= ${MIN_OCT_BALANCE} OCT for ~10 txs + retries)`);
  }

  const nonceRef = { value: bal.nonce };

  // 1. Compile SwapPool.aml (with the V8-SECURITY owner-only first-add gate)
  const src = fs.readFileSync(path.join(DEV_ROOT, 'contracts', 'SwapPool.aml'), 'utf-8');
  const compiled = await rpcCall('octra_compileAml', [src]);
  // eslint-disable-next-line no-console
  console.log(`Compiled SwapPool: ${compiled.size}B, ${compiled.instructions} instr`);

  // 2. Compute new pool address. submitTxBrief() below unconditionally does
  //    `nonceRef.value++`, so the actual deploy nonce will be `nonceRef.value + 1`.
  //    We MUST ask computeContractAddress for that SAME nonce — otherwise the
  //    on-chain expected deploy address (derived from `to_` + nonce) won't
  //    match the locally-signed `to_` field and the node silently rejects
  //    the deploy, leaving us with no bytecode at the predicted address and a
  //    waitReceipt timeout. (Caught this bug after the first live attempt.)
  const nextNonce = nonceRef.value + 1;
  const computed = await rpcCall('octra_computeContractAddress', [
    compiled.bytecode, deployer.address, nextNonce,
  ]);
  const newPoolAddress = computed.address;
  // eslint-disable-next-line no-console
  console.log(`\nNew pool will deploy at: ${newPoolAddress}`);

  if (DRY_RUN) {
    // eslint-disable-next-line no-console
    console.log('\n(dry-run mode — no transactions submitted)');
    return;
  }

  // 3. Deploy
  await submitTxBrief(deployer, nonceRef, newPoolAddress, '0', 'deploy', compiled.bytecode, null);
  // [V9] Confirm bytecode is actually on-chain before proceeding. Cheap defense
  // against the "tx is rejected in mempool, RPC hands back local tx_hash" bug.
  await verifyPoolBytecode(newPoolAddress);
  // eslint-disable-next-line no-console
  console.log(`\n[1] Pool deployed: ${newPoolAddress}`);
  await new Promise(r => setTimeout(r, 1000));

  // 4. set_tokens(WOCT, OES)
  await submitTxBrief(deployer, nonceRef, newPoolAddress, '0', 'call', 'set_tokens',
    JSON.stringify([WOCT_ADDRESS, OES_ADDRESS]));
  // eslint-disable-next-line no-console
  console.log('[2] set_tokens done');
  await new Promise(r => setTimeout(r, 1000));

  // 5. set_factory(real_factory)
  await submitTxBrief(deployer, nonceRef, newPoolAddress, '0', 'call', 'set_factory',
    JSON.stringify([FACTORY_ADDRESS]));
  // eslint-disable-next-line no-console
  console.log('[3] set_factory done');
  await new Promise(r => setTimeout(r, 1000));

  // [REVIEWER-FIX] Register with the factory ONLY AFTER add_liquidity succeeds,
  // so a failed seed step can never orphan a phantom pool in the factory listing.
  await new Promise(r => setTimeout(r, 1000));

  // 7. Optional: 5 OCT → WOCT (skip if user not on native WOCT, or --no-deposit)
  if (!NO_DEPOSIT) {
    try {
      // 5_000_000 raw = 5 OCT (the WOCT `deposit` reads the tx `amount` field)
      await submitTxBrief(deployer, nonceRef, WOCT_ADDRESS, '5000000', 'call', 'deposit', '[]');
      // eslint-disable-next-line no-console
      console.log('[5] Deposited 5 OCT → WOCT');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[5] ~ skipped WOCT deposit: ${e.message.slice(0, 80)}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // 8. Best-effort AML whitelist on both tokens
  await tryTokenAmlSetup(deployer, nonceRef, WOCT_ADDRESS, newPoolAddress);
  await new Promise(r => setTimeout(r, 1000));
  await tryTokenAmlSetup(deployer, nonceRef, OES_ADDRESS, newPoolAddress);
  await new Promise(r => setTimeout(r, 1000));

  // 9. Grant + add_liquidity(1 WOCT : 100 OES)
  await submitTxBrief(deployer, nonceRef, WOCT_ADDRESS, '0', 'call', 'grant',
    JSON.stringify([newPoolAddress, LIQ_WOCT_RAW]));
  // eslint-disable-next-line no-console
  console.log('[6] Granted 1 WOCT to pool');
  await new Promise(r => setTimeout(r, 1000));

  await submitTxBrief(deployer, nonceRef, OES_ADDRESS, '0', 'call', 'grant',
    JSON.stringify([newPoolAddress, LIQ_OES_RAW]));
  // eslint-disable-next-line no-console
  console.log('[7] Granted 100 OES to pool');
  await new Promise(r => setTimeout(r, 1000));

  // Re-fetch deadline right before add_liquidity to avoid the 1-300 epoch
  // window expiring during the previous txs (this mirrors the race-fix in
  // everestswap-frontend/src/pages/LiquidityPage.tsx).
  const epochInfo = await rpcCall('epoch_current', []);
  // [FIX] Guard against malformed epoch responses (frontend has the same fix).
  if (!epochInfo || typeof epochInfo.epoch_id !== 'number' || epochInfo.epoch_id <= 0) {
    throw new Error('Could not fetch current epoch — try again in a few seconds');
  }
  const deadline = epochInfo.epoch_id + 300;

  await submitTxBrief(deployer, nonceRef, newPoolAddress, '0', 'call', 'add_liquidity',
    JSON.stringify([LIQ_WOCT_RAW, LIQ_OES_RAW, '0', String(deadline), '0']));
  // eslint-disable-next-line no-console
  console.log(`[8] add_liquidity done (deadline epoch +300 from ${epochInfo.epoch_id})`);
  await new Promise(r => setTimeout(r, 1000));

  // 9. NOW register_pool on the factory (only after successful seed) — see [REVIEWER-FIX] above.
  await submitTxBrief(deployer, nonceRef, FACTORY_ADDRESS, '0', 'call', 'register_pool',
    JSON.stringify([WOCT_ADDRESS, OES_ADDRESS, newPoolAddress]));
  // eslint-disable-next-line no-console
  console.log('[9] register_pool done');
  await new Promise(r => setTimeout(r, 1000));

  // 10. Patch outputs
  patchDeploymentsJson(newPoolAddress);
  if (!SKIP_ENV) patchFrontendEnv(newPoolAddress);

  const updatePath = path.join(DEV_ROOT, 'env-update.json');
  fs.writeFileSync(updatePath, JSON.stringify({
    SwapPool: newPoolAddress,
    WOCT: WOCT_ADDRESS,
    OES: OES_ADDRESS,
    Factory: FACTORY_ADDRESS,
    seededAt: new Date().toISOString(),
    deployer: deployer.address,
    initialLiquidity: { woct: LIQ_WOCT_RAW, oes: LIQ_OES_RAW },
  }, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(`\n✓ Wrote ${updatePath}`);

  // eslint-disable-next-line no-console
  console.log('\n✅ Done. Next steps:');
  // eslint-disable-next-line no-console
  console.log('  - Reload your browser on the Liquidity page to verify the warning banner is gone.');
  // eslint-disable-next-line no-console
  console.log('  - Verify reserves via:');
  // eslint-disable-next-line no-console
  console.log(`      curl -s "${RPC_URL}" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"contract_call","params":["${newPoolAddress}","get_reserves",[]],"id":1}'`);
}

main().catch((e) => {
  console.error('\n❌ redeploy failed:', e.message || e);
  console.error('  → .env and deployments.json were NOT modified.');
  process.exit(1);
});
