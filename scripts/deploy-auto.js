const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) {
  console.error('ERROR: Set MNEMONIC env var');
  process.exit(1);
}

const OES_ADDRESS = 'oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD';
const DEPLOYMENTS_PATH = path.join(__dirname, '..', 'deployments.json');

// Gas fee strategy: start low, increase on failure
const FEE_LEVELS = ['50000', '100000', '200000', '500000'];
let feeIndex = 0;
let currentFee = FEE_LEVELS[0];

// ── RPC Helpers ──
async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const data = await res.json();
  if (data.error) throw new Error('RPC error: ' + data.error.message);
  return data.result;
}

function jsonEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function canonicalTxJson(tx) {
  let s = `{"from":"${jsonEscape(tx.from)}"`;
  s += `,"to_":"${jsonEscape(tx.to_)}"`;
  s += `,"amount":"${jsonEscape(tx.amount)}"`;
  s += `,"nonce":${tx.nonce}`;
  s += `,"ou":"${jsonEscape(tx.ou)}"`;
  s += `,"timestamp":${tx.timestamp}`;
  s += `,"op_type":"${jsonEscape(tx.op_type)}"`;
  if (tx.encrypted_data) s += `,"encrypted_data":"${jsonEscape(tx.encrypted_data)}"`;
  if (tx.message) s += `,"message":"${jsonEscape(tx.message)}"`;
  s += '}';
  return s;
}

function signTx(tx, secretKey) {
  const msg = canonicalTxJson(tx);
  const sig = nacl.sign.detached(Buffer.from(msg, 'utf-8'), secretKey);
  tx.signature = Buffer.from(sig).toString('base64');
  tx.public_key = Buffer.from(secretKey.slice(32, 64)).toString('base64');
}

async function waitReceipt(txHash, maxWait = 120) {
  for (let i = 0; i < maxWait; i++) {
    try {
      const receipt = await rpcCall('contract_receipt', [txHash]);
      if (receipt && receipt.success !== undefined) return receipt;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Timeout waiting for receipt');
}

async function submitTx(from, to_, amount, nonce, ou, ts, op_type, encrypted_data, message, secretKey) {
  const tx = { from, to_, amount, nonce, ou, timestamp: ts, op_type };
  if (encrypted_data) tx.encrypted_data = encrypted_data;
  if (message) tx.message = message;
  signTx(tx, secretKey);
  const result = await rpcCall('octra_submit', [tx]);
  console.log(`  Tx: ${result.tx_hash}`);
  const receipt = await waitReceipt(result.tx_hash);
  if (!receipt.success) throw new Error(`${encrypted_data || op_type} failed: ${receipt.error}`);
  console.log(`  ✅ (effort: ${receipt.effort}, fee: ${ou})`);
  return receipt;
}

// ── Deployer ──
function getDeployer() {
  const seed64 = crypto.pbkdf2Sync(MNEMONIC, 'mnemonic', 2048, 64, 'sha512');
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(seed64));
  const hdSeed32 = hmac.digest().slice(0, 32);
  const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
  const hash = crypto.createHash('sha256').update(Buffer.from(keypair.publicKey)).digest();
  let b58 = bs58.default.encode(hash);
  while (b58.length < 44) b58 = '1' + b58;
  return { keypair, address: 'oct' + b58 };
}

async function compile(contractName) {
  const filePath = path.join(__dirname, '..', 'contracts', `${contractName}.aml`);
  const src = fs.readFileSync(filePath, 'utf-8');
  const result = await rpcCall('octra_compileAml', [src]);
  console.log(`  ${contractName}: ${result.size}B, ${result.instructions} instr`);
  return result;
}

async function deploy(name, bytecode, deployerAddr, nonce, secretKey) {
  const addrResult = await rpcCall('octra_computeContractAddress', [bytecode, deployerAddr, nonce]);
  const addr = addrResult.address;
  console.log(`  Address: ${addr}`);
  const ts = Date.now() / 1000;
  
  // Try with increasing fees
  for (let i = feeIndex; i < FEE_LEVELS.length; i++) {
    try {
      await submitTx(deployerAddr, addr, '0', nonce, FEE_LEVELS[i], ts, 'deploy', bytecode, null, secretKey);
      feeIndex = Math.max(0, i - 1); // Next time try lower fee again
      currentFee = FEE_LEVELS[feeIndex];
      return addr;
    } catch (e) {
      if (e.message.includes('fee') || e.message.includes('insufficient') || e.message.includes('low')) {
        console.log(`  ⚠️ Fee ${FEE_LEVELS[i]} too low, trying ${FEE_LEVELS[i + 1] || FEE_LEVELS[i]}...`);
        feeIndex = i + 1;
        currentFee = FEE_LEVELS[Math.min(i + 1, FEE_LEVELS.length - 1)];
        continue;
      }
      throw e;
    }
  }
  throw new Error('All fee levels failed');
}

async function callMethod(contractAddr, method, params, deployerAddr, nonce, secretKey) {
  return callMethodWithValue(contractAddr, method, params, '0', deployerAddr, nonce, secretKey);
}

async function callMethodWithValue(contractAddr, method, params, amount, deployerAddr, nonce, secretKey) {
  const ts = Date.now() / 1000;
  
  for (let i = feeIndex; i < FEE_LEVELS.length; i++) {
    try {
      await submitTx(deployerAddr, contractAddr, amount, nonce, FEE_LEVELS[i], ts, 'call', method, JSON.stringify(params), secretKey);
      feeIndex = Math.max(0, i - 1);
      currentFee = FEE_LEVELS[feeIndex];
      return;
    } catch (e) {
      if (e.message.includes('fee') || e.message.includes('insufficient') || e.message.includes('low')) {
        console.log(`  ⚠️ Fee ${FEE_LEVELS[i]} too low, trying ${FEE_LEVELS[i + 1] || FEE_LEVELS[i]}...`);
        feeIndex = i + 1;
        currentFee = FEE_LEVELS[Math.min(i + 1, FEE_LEVELS.length - 1)];
        continue;
      }
      throw e;
    }
  }
  throw new Error('All fee levels failed');
}

function loadDeployments() {
  try { return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf-8')); } catch { return {}; }
}

function saveDeployments(addresses) {
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(addresses, null, 2));
  console.log(`  Saved → ${DEPLOYMENTS_PATH}`);
}

// ── Main ──
async function main() {
  console.log('=== EverestSwap Devnet Deployment ===\n');
  
  const deployer = getDeployer();
  console.log(`Deployer: ${deployer.address}`);
  
  const bal = await rpcCall('octra_balance', [deployer.address]);
  console.log(`Balance: ${bal.balance} OCT (nonce: ${bal.nonce})`);
  console.log(`Gas strategy: start ${FEE_LEVELS[0]}, auto-increase on failure\n`);
  
  if (parseFloat(bal.balance) < 1) {
    console.error('⚠️ Low balance! Need at least 1 OCT for deployment');
  }

  let nonce = bal.nonce;
  const addresses = { OES: OES_ADDRESS };

  // ── Step 1: Compile ──
  console.log('1. Compiling contracts...');
  const swapFactory = await compile('SwapFactory');
  const woct = await compile('WOCT');
  const swapPool = await compile('SwapPool');
  const router = await compile('Router');
  let rewardPool;
  try {
    rewardPool = await compile('RewardPool');
  } catch {
    console.log('  ⚠️ RewardPool not compiled (will skip)');
  }

  // ── Step 2: Deploy SwapFactory ──
  console.log('\n2. Deploying SwapFactory...');
  nonce++;
  addresses.SwapFactory = await deploy('SwapFactory', swapFactory.bytecode, deployer.address, nonce, deployer.keypair.secretKey);
  saveDeployments(addresses);

  // ── Step 3: Deploy WOCT ──
  console.log('\n3. Deploying WOCT...');
  nonce++;
  addresses.WOCT = await deploy('WOCT', woct.bytecode, deployer.address, nonce, deployer.keypair.secretKey);
  saveDeployments(addresses);

  // ── Step 4: Deploy SwapPool ──
  console.log('\n4. Deploying SwapPool...');
  nonce++;
  addresses.SwapPool = await deploy('SwapPool', swapPool.bytecode, deployer.address, nonce, deployer.keypair.secretKey);
  saveDeployments(addresses);

  // ── Step 5: Deploy Router ──
  console.log('\n5. Deploying Router...');
  nonce++;
  addresses.Router = await deploy('Router', router.bytecode, deployer.address, nonce, deployer.keypair.secretKey);
  saveDeployments(addresses);

  // ── Step 6: Deploy RewardPool (template) ──
  if (rewardPool) {
    console.log('\n6. Deploying RewardPool (template)...');
    nonce++;
    addresses.RewardPool = await deploy('RewardPool', rewardPool.bytecode, deployer.address, nonce, deployer.keypair.secretKey);
    saveDeployments(addresses);
  }

  // ── Step 7: Init SwapPool tokens ──
  console.log('\n7. Setting tokens on SwapPool...');
  nonce++;
  await callMethod(addresses.SwapPool, 'set_tokens', [addresses.WOCT, OES_ADDRESS], deployer.address, nonce, deployer.keypair.secretKey);

  // ── Step 7b: Set factory on SwapPool (BEFORE add_liquidity!) ──
  console.log('\n7b. Setting factory on SwapPool...');
  nonce++;
  await callMethod(addresses.SwapPool, 'set_factory', [addresses.SwapFactory], deployer.address, nonce, deployer.keypair.secretKey);

  // ── Step 7c: Increase max_initial_price_ratio for WOCT/OES decimal mismatch ──
  console.log('\n7c. Setting max_initial_price_ratio to 1000000...');
  nonce++;
  await callMethod(addresses.SwapPool, 'set_max_initial_price_ratio', [1000000], deployer.address, nonce, deployer.keypair.secretKey);

  // ── Step 8: Deposit OCT → WOCT ──
  console.log('\n8. Depositing 2 OCT → WOCT...');
  nonce++;
  await callMethodWithValue(addresses.WOCT, 'deposit', [], '2000000', deployer.address, nonce, deployer.keypair.secretKey);

  // ── Step 9: Grant WOCT to SwapPool ──
  console.log('\n9. Granting SwapPool allowance on WOCT...');
  nonce++;
  await callMethod(addresses.WOCT, 'grant', [addresses.SwapPool, 1500000], deployer.address, nonce, deployer.keypair.secretKey);

  // ── Step 10: Grant OES to SwapPool ──
  console.log('\n10. Granting SwapPool allowance on OES...');
  nonce++;
  await callMethod(OES_ADDRESS, 'grant', [addresses.SwapPool, 5000000], deployer.address, nonce, deployer.keypair.secretKey);

  // ── Step 11: Add liquidity ──
  console.log('\n11. Adding liquidity...');
  nonce++;
  const epochInfo = await rpcCall('epoch_current', []);
  const addLiqDeadline = epochInfo.epoch_id + 300;
  await callMethod(addresses.SwapPool, 'add_liquidity', [1500000, 5000000, 0, addLiqDeadline, 0], deployer.address, nonce, deployer.keypair.secretKey);

  // ── Step 12: Register pool ──
  console.log('\n12. Registering pool with factory...');
  nonce++;
  await callMethod(addresses.SwapFactory, 'register_pool', [addresses.WOCT, OES_ADDRESS, addresses.SwapPool], deployer.address, nonce, deployer.keypair.secretKey);

  // ── Step 13: Init Router (factory + WOCT in one call) ──
  console.log('\n13. Initializing Router (factory + WOCT)...');
  nonce++;
  await callMethod(addresses.Router, 'init', [addresses.SwapFactory, addresses.WOCT], deployer.address, nonce, deployer.keypair.secretKey);

  // ── Summary ──
  console.log('\n=== Deployment Complete ===\n');
  console.log('Contract Addresses:');
  console.log(`  OES:         ${addresses.OES}`);
  console.log(`  WOCT:        ${addresses.WOCT}`);
  console.log(`  SwapPool:    ${addresses.SwapPool}`);
  console.log(`  SwapFactory: ${addresses.SwapFactory}`);
  console.log(`  Router:      ${addresses.Router}`);
  if (addresses.RewardPool) {
    console.log(`  RewardPool:  ${addresses.RewardPool}`);
  }
  
  const finalBal = await rpcCall('octra_balance', [deployer.address]);
  console.log(`\nFinal balance: ${finalBal.balance} OCT (nonce: ${finalBal.nonce})`);
  console.log(`Gas used: ~${(15 - (finalBal.nonce - nonce))} transactions`);
  console.log('Done.');
}

main().catch(e => {
  console.error('\n❌ Deployment failed:', e.message);
  process.exit(1);
});
