#!/usr/bin/env node
/**
 * deploy-reward-pool.mjs
 *
 * Deploys a NEW RewardPool (from the audit-fixed RewardPool.aml) and wires it
 * into a usable reward pool: set_tokens → set_factory → set_reward_config →
 * register_reward_pool on the SwapFactory.
 *
 * Why parameterized (not a fixed "redeploy"):
 *   The RewardPool address in deployments.json / devnet.ts (rewardPoolTemplate)
 *   is a BARE, UNCONFIGURED placeholder on-chain — token_a/token_b/factory all
 *   still equal the deployer (constructor `origin`), reward_configured=false,
 *   total_lp=0, holds no funds, and is NOT in the factory's reward list. There
 *   is nothing to migrate. A real reward pool needs per-pool parameters (the
 *   pair, the reward token, the reward amount, and the epoch window), so those
 *   are supplied via env vars below.
 *
 * The audit fixes baked into the deployed bytecode:
 *   [HIGH-1] rescue_tokens can no longer drain reward_remaining (LP-owned).
 *   [MED-1]  creator LP lock (creator_lock_end) is enforced in remove_liquidity
 *            and close_position.
 *
 * Reads MNEMONIC strictly from the env var (never argv). Base addresses
 * (SwapFactory, and default TOKEN_A=WOCT) come from deployments.json.
 *
 * Required env vars:
 *   MNEMONIC        deployer mnemonic (also becomes pool owner + reward creator)
 *   TOKEN_B         second pair token (OCS01 address). TOKEN_A defaults to WOCT.
 *   REWARD_TOKEN    OCS01 reward token address (MUST differ from TOKEN_A/TOKEN_B)
 *   REWARD_AMOUNT   raw reward amount to distribute (integer string, > 0)
 *
 * Optional env vars:
 *   TOKEN_A            override the pair's first token (default: deployments.WOCT)
 *   REWARD_START       start epoch (default: current epoch + REWARD_START_DELAY)
 *   REWARD_START_DELAY epochs to add to current epoch for start (default: 10)
 *   REWARD_END         end epoch (default: REWARD_START + REWARD_DURATION)
 *   REWARD_DURATION    epochs the reward runs over (default: 100800 ≈ 7 days)
 *
 * Options:
 *   --dry-run          Compile + compute address + print the plan, submit nothing.
 *   --no-register      Skip the factory register_reward_pool step.
 *   --no-fund          Skip granting REWARD_AMOUNT of REWARD_TOKEN to the pool.
 *   --max-wait-ms N    Per-tx wait budget (default 600000). Env: EVERESTSWAP_TX_MAX_WAIT_MS
 *   --rpc-timeout-ms N Per-RPC deadline (default 15000). Env: EVERESTSWAP_RPC_TIMEOUT_MS
 *
 * NOTE on registration: SwapFactory.register_reward_pool rejects a pair that
 * already has ANY pool registered (pools_by_pair check). If TOKEN_A/TOKEN_B is
 * already registered, the register step will revert — use a fresh pair or run
 * with --no-register and register manually.
 *
 * Usage:
 *   MNEMONIC="..." TOKEN_B=oct... REWARD_TOKEN=oct... REWARD_AMOUNT=1000000000 \
 *     node scripts/deploy-reward-pool.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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
const DEPLOYMENTS_PATH = path.join(DEV_ROOT, 'deployments.json');
const RPC_URL = getRpcUrl();
const MNEMONIC = process.env.MNEMONIC;
const FEE_OU = '100000';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_REGISTER = args.includes('--no-register');
const NO_FUND = args.includes('--no-fund');

const TX_MAX_WAIT_MS = parseMs(
  cliArg('max-wait-ms') ?? process.env.EVERESTSWAP_TX_MAX_WAIT_MS,
  DEFAULT_TX_MAX_WAIT_MS, 'EVERESTSWAP_TX_MAX_WAIT_MS',
);
const RPC_CALL_TIMEOUT_MS = parseMs(
  cliArg('rpc-timeout-ms') ?? process.env.EVERESTSWAP_RPC_TIMEOUT_MS,
  DEFAULT_RPC_CALL_TIMEOUT_MS, 'EVERESTSWAP_RPC_TIMEOUT_MS',
);

function requireIntStr(name, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error(`Missing required env var ${name}`);
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) throw new Error(`${name} must be a non-negative integer string, got: ${s}`);
  return s;
}

function requireAddr(name, raw) {
  if (!raw || !String(raw).startsWith('oct')) {
    throw new Error(`Missing/invalid ${name} (must be an oct... address), got: ${raw ?? '(unset)'}`);
  }
  return String(raw).trim();
}

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

// Confirm bytecode actually materialized on-chain before spending more fees
// wiring a contract that may not exist (guards the "RPC hands back a tx_hash
// but the node silently rejected the deploy" failure mode).
async function verifyBytecode(addr) {
  const deadline = Date.now() + TX_MAX_WAIT_MS;
  const perIterMaxMs = RPC_CALL_TIMEOUT_MS + RECEIPT_POLL_MS;
  let lastErr;
  while (Date.now() < deadline) {
    if (Date.now() + perIterMaxMs >= deadline) break;
    try {
      const r = await rpcCall('contract_call', [addr, 'total_lp_supply', []]);
      if (r && (r.storage || r.result !== undefined)) {
        console.log(`  ✓ bytecode confirmed at ${addr}`);
        return;
      }
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, RECEIPT_POLL_MS));
  }
  throw new Error(
    `Deploy bytecode never materialized at ${addr}. Last RPC error: ${lastErr?.message || 'unknown'}.\n` +
    `Likely the chain rejected the deploy tx (nonce/canonical-JSON mismatch). Check the tx on the explorer and re-run with a fresh nonce.`
  );
}

async function main() {
  if (!MNEMONIC) {
    console.error('ERROR: MNEMONIC env var not set.');
    console.error('Usage: MNEMONIC="..." TOKEN_B=oct... REWARD_TOKEN=oct... REWARD_AMOUNT=... node scripts/deploy-reward-pool.mjs [--dry-run]');
    console.error('SECURITY: do NOT pass the mnemonic via argv (leaks to process listings).');
    process.exit(1);
  }

  const deployments = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf-8'));
  const FACTORY = requireAddr('deployments.SwapFactory', deployments.SwapFactory);
  const TOKEN_A = requireAddr('TOKEN_A', process.env.TOKEN_A || deployments.WOCT);
  const TOKEN_B = requireAddr('TOKEN_B', process.env.TOKEN_B);
  const REWARD_TOKEN = requireAddr('REWARD_TOKEN', process.env.REWARD_TOKEN);
  const REWARD_AMOUNT = requireIntStr('REWARD_AMOUNT', process.env.REWARD_AMOUNT);
  if (REWARD_AMOUNT === '0') throw new Error('REWARD_AMOUNT must be > 0');
  if (TOKEN_A === TOKEN_B) throw new Error('TOKEN_A and TOKEN_B must differ');
  if (REWARD_TOKEN === TOKEN_A || REWARD_TOKEN === TOKEN_B) {
    throw new Error('REWARD_TOKEN must differ from both pair tokens (contract rejects otherwise)');
  }

  const deployer = getDeployer(MNEMONIC);
  process.env.MNEMONIC = '';
  const bal = await rpcCall('octra_balance', [deployer.address]);

  // Resolve the epoch window. set_reward_config requires start >= current epoch
  // and 0 < end-start <= 5256000 (365 days).
  const epochInfo = await rpcCall('epoch_current', []);
  if (!epochInfo || typeof epochInfo.epoch_id !== 'number' || epochInfo.epoch_id <= 0) {
    throw new Error('Could not fetch current epoch — try again in a few seconds');
  }
  const nowEpoch = epochInfo.epoch_id;
  const startDelay = parseInt(process.env.REWARD_START_DELAY || '10', 10);
  const duration = parseInt(process.env.REWARD_DURATION || '100800', 10); // ~7 days
  const start = process.env.REWARD_START ? parseInt(process.env.REWARD_START, 10) : nowEpoch + startDelay;
  const end = process.env.REWARD_END ? parseInt(process.env.REWARD_END, 10) : start + duration;
  if (!(start >= nowEpoch)) throw new Error(`REWARD_START (${start}) must be >= current epoch (${nowEpoch})`);
  if (!(end > start)) throw new Error(`REWARD_END (${end}) must be > REWARD_START (${start})`);
  if (end - start > 5256000) throw new Error(`reward duration ${end - start} epochs exceeds max 5256000 (365 days)`);

  console.log('=== RewardPool Deploy + Wire ===');
  console.log(`Deployer:     ${deployer.address}`);
  console.log(`Balance:      ${bal.balance} OCT (nonce ${bal.nonce})`);
  console.log(`Network:      ${RPC_URL}`);
  console.log(`Factory:      ${FACTORY}`);
  console.log(`Pair:         A=${TOKEN_A}  B=${TOKEN_B}`);
  console.log(`Reward token: ${REWARD_TOKEN}`);
  console.log(`Reward amt:   ${REWARD_AMOUNT} (raw)`);
  console.log(`Epoch window: start=${start} end=${end} (current=${nowEpoch}, duration=${end - start})`);
  console.log(`Register:     ${NO_REGISTER ? 'NO (--no-register)' : 'yes'}`);
  console.log(`Fund pool:    ${NO_FUND ? 'NO (--no-fund)' : `yes (grant ${REWARD_AMOUNT})`}`);
  if (parseFloat(bal.balance) < 1.0) {
    throw new Error(`Insufficient balance: ${bal.balance} OCT (need >= 1 OCT for deploy + wiring)`);
  }

  const src = fs.readFileSync(path.join(DEV_ROOT, 'contracts', 'RewardPool.aml'), 'utf-8');
  const compiled = await rpcCall('octra_compileAml', [src]);
  console.log(`\nCompiled RewardPool: ${compiled.size}B, ${compiled.instructions} instr`);

  const nonceRef = { value: bal.nonce };
  const deployNonce = nonceRef.value + 1; // submitTx does value++ first
  const computed = await rpcCall('octra_computeContractAddress', [
    compiled.bytecode, deployer.address, deployNonce,
  ]);
  const poolAddr = computed.address;
  console.log(`New RewardPool will deploy at: ${poolAddr}`);

  if (DRY_RUN) {
    console.log('\n(dry-run — no transactions submitted)');
    return;
  }

  console.log('\n[1] Deploying RewardPool...');
  await submitTx(deployer, nonceRef, poolAddr, '0', 'deploy', compiled.bytecode, null);
  await verifyBytecode(poolAddr);
  await new Promise(r => setTimeout(r, 1000));

  console.log('[2] set_tokens(A, B)...');
  await submitTx(deployer, nonceRef, poolAddr, '0', 'call', 'set_tokens',
    JSON.stringify([TOKEN_A, TOKEN_B]));
  await new Promise(r => setTimeout(r, 1000));

  console.log('[3] set_factory(factory)...');
  await submitTx(deployer, nonceRef, poolAddr, '0', 'call', 'set_factory',
    JSON.stringify([FACTORY]));
  await new Promise(r => setTimeout(r, 1000));

  console.log('[4] set_reward_config(token, amount, start, end)...');
  await submitTx(deployer, nonceRef, poolAddr, '0', 'call', 'set_reward_config',
    JSON.stringify([REWARD_TOKEN, REWARD_AMOUNT, String(start), String(end)]));
  await new Promise(r => setTimeout(r, 1000));

  if (!NO_FUND) {
    console.log('[5] Granting reward tokens to the pool...');
    await submitTx(deployer, nonceRef, REWARD_TOKEN, '0', 'call', 'grant',
      JSON.stringify([poolAddr, REWARD_AMOUNT]));
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!NO_REGISTER) {
    console.log('[6] register_reward_pool on factory...');
    await submitTx(deployer, nonceRef, FACTORY, '0', 'call', 'register_reward_pool',
      JSON.stringify([TOKEN_A, TOKEN_B, REWARD_TOKEN, poolAddr]));
    await new Promise(r => setTimeout(r, 1000));
  }

  const prev = deployments.RewardPool;
  deployments.RewardPool = poolAddr;
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(deployments, null, 2) + '\n');
  console.log(`\n✓ Updated deployments.json (RewardPool: ${prev} → ${poolAddr})`);

  const finalBal = await rpcCall('octra_balance', [deployer.address]);
  console.log('\n=== RewardPool Deploy Complete ===');
  console.log(`New RewardPool: ${poolAddr}`);
  console.log(`Cost: ~${(parseFloat(bal.balance) - parseFloat(finalBal.balance)).toFixed(4)} OCT`);
  console.log('\nNotes:');
  console.log('  - devnet.ts `rewardPoolTemplate` is dead config (never read); the');
  console.log('    frontend discovers reward pools via factory.get_reward_pools().');
  console.log('    Update it only if you want deployments.json + config to stay in sync.');
  if (NO_FUND) console.log('  - You skipped funding: grant REWARD_AMOUNT of the reward token to the pool before rewards can be claimed.');
  if (NO_REGISTER) console.log('  - You skipped registration: call factory.register_reward_pool to make it discoverable.');
}

main().catch((e) => {
  console.error('\n❌ reward-pool deploy failed:', e.message || e);
  console.error('  → deployments.json was NOT modified.');
  process.exit(1);
});

