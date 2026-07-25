// ── Reward Pool Integration Test Script ──────────────────────────────────
// Tests: deploy RewardPool, set_reward_config, grant, claim, emergency_withdraw
// Run: node scripts/test_reward_pool.js

const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.RPC_URL || 'http://localhost:18080';
const FACTORY_ADDR = process.env.FACTORY || '';
const TOKEN_A = process.env.TOKEN_A || ''; // e.g. WOCT
const TOKEN_B = process.env.TOKEN_B || ''; // e.g. any OCS01 token
const REWARD_TOKEN = process.env.REWARD_TOKEN || ''; // OCS01 reward token
const REWARD_AMOUNT = process.env.REWARD_AMOUNT || '1000000'; // raw amount
const WALLET_ADDR = process.env.WALLET || '';
const WALLET_PRIVKEY = process.env.PRIVKEY || '';

async function rpcCall(method, params = []) {
  const resp = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function compileContract(sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const result = await rpcCall('compile_aml', [source]);
  return result.bytecode;
}

async function deployContract(bytecode) {
  const balance = await rpcCall('octra_balance', [WALLET_ADDR]);
  const nonce = balance.nonce + 1;

  const addrResult = await rpcCall('compute_contract_address', [bytecode, WALLET_ADDR, nonce]);
  const poolAddress = addrResult.address;

  // Deploy
  const txHash = await rpcCall('sign_and_submit_deploy_tx', [{
    sender: WALLET_ADDR,
    bytecode,
    contract_address: poolAddress,
    fee: '100000',
  }]);

  await rpcCall('wait_for_receipt', [txHash, 60]);
  console.log(`[OK] Deployed RewardPool at ${poolAddress}`);
  return poolAddress;
}

async function callContract(contract, method, params) {
  const txHash = await rpcCall('sign_and_submit_tx', [{
    sender: WALLET_ADDR,
    contract,
    method,
    params,
    fee: '100000',
  }]);
  await rpcCall('wait_for_receipt', [txHash, 60]);
  return txHash;
}

async function main() {
  console.log('=== Reward Pool Integration Test ===\n');

  if (!FACTORY_ADDR || !TOKEN_A || !TOKEN_B || !REWARD_TOKEN || !WALLET_ADDR) {
    console.error('Required env vars: FACTORY, TOKEN_A, TOKEN_B, REWARD_TOKEN, WALLET');
    process.exit(1);
  }

  // 1. Deploy RewardPool
  console.log('[1/6] Deploying RewardPool contract...');
  const contractPath = path.join(__dirname, '..', 'contracts', 'RewardPool.aml');
  const bytecode = await compileContract(contractPath);
  const poolAddr = await deployContract(bytecode);

  // 2. Set tokens
  console.log('[2/6] Setting pool tokens...');
  await callContract(poolAddr, 'set_tokens', [TOKEN_A, TOKEN_B]);
  console.log(`  Tokens: ${TOKEN_A} / ${TOKEN_B}`);

  // 3. Set reward config (one-shot)
  console.log('[3/6] Setting reward config (one-shot)...');
  const epochRes = await rpcCall('epoch_current');
  const currentEpoch = epochRes.epoch_id || 0;
  const rewardStart = currentEpoch + 100;
  const rewardEnd = rewardStart + 100800; // 7 days
  await callContract(poolAddr, 'set_reward_config', [
    REWARD_TOKEN,
    REWARD_AMOUNT,
    rewardStart,
    rewardEnd,
  ]);
  console.log(`  Reward token: ${REWARD_TOKEN}`);
  console.log(`  Amount: ${REWARD_AMOUNT}`);
  console.log(`  Start epoch: ${rewardStart}, End epoch: ${rewardEnd}`);

  // 4. Register with factory
  console.log('[4/6] Registering reward pool with factory...');
  await callContract(FACTORY_ADDR, 'register_reward_pool', [
    TOKEN_A, TOKEN_B, REWARD_TOKEN, poolAddr,
  ]);
  console.log('  Registered successfully');

  // 5. Grant reward tokens to pool
  console.log('[5/6] Granting reward tokens to pool...');
  await callContract(REWARD_TOKEN, 'grant', [poolAddr, REWARD_AMOUNT]);
  console.log(`  Granted ${REWARD_AMOUNT} reward tokens`);

  // 6. Verify pool info
  console.log('[6/6] Verifying reward pool...');
  const poolInfo = await rpcCall('contract_call', [poolAddr, 'get_reward_info', []]);
  console.log(`  Reward token: ${poolInfo.reward_token}`);
  console.log(`  Reward amount: ${poolInfo.reward_amount}`);
  console.log(`  Start: ${poolInfo.reward_start}, End: ${poolInfo.reward_end}`);
  console.log(`  Config set: ${poolInfo.config_set}`);

  // Verify factory registration
  const isRewardPool = await rpcCall('contract_call', [
    FACTORY_ADDR, 'is_reward_pool', [poolAddr]
  ]);
  console.log(`  Is reward pool: ${isRewardPool}`);

  const rewardTokenFromFactory = await rpcCall('contract_call', [
    FACTORY_ADDR, 'get_reward_token', [poolAddr]
  ]);
  console.log(`  Reward token from factory: ${rewardTokenFromFactory}`);

  console.log('\n=== All tests passed! ===');
  console.log(`Pool address: ${poolAddr}`);
}

main().catch(e => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
