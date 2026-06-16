const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RPC_URL = 'https://devnet.octrascan.io/rpc';
const FEE_OU = '100000';
const DEPLOYMENTS_PATH = path.join(__dirname, '..', 'deployments.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

// ── RPC Helpers ──────────────────────────────────────────────

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
  console.log(`  ✅ (effort: ${receipt.effort})`);
  return receipt;
}

async function callMethod(contractAddr, method, params, amount, deployerAddr, nonce, secretKey) {
  const ts = Date.now() / 1000;
  await submitTx(deployerAddr, contractAddr, amount || '0', nonce, FEE_OU, ts, 'call', method, JSON.stringify(params), secretKey);
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
  await submitTx(deployerAddr, addr, '0', nonce, FEE_OU, ts, 'deploy', bytecode, null, secretKey);
  return addr;
}

function getAddress(mnemonic) {
  const seed64 = crypto.pbkdf2Sync(mnemonic, 'mnemonic', 2048, 64, 'sha512');
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(seed64));
  const hdSeed32 = hmac.digest().slice(0, 32);
  const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
  const hash = crypto.createHash('sha256').update(Buffer.from(keypair.publicKey)).digest();
  let b58 = bs58.default.encode(hash);
  while (b58.length < 44) b58 = '1' + b58;
  return { keypair, address: 'oct' + b58 };
}

function loadDeployments() {
  return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf-8'));
}

function saveDeployments(addresses) {
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(addresses, null, 2));
  console.log(`  Saved → ${DEPLOYMENTS_PATH}`);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  // [SECURITY] Load MNEMONIC from environment variable - NOT from CLI args
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    console.error('Usage: MNEMONIC="your mnemonic phrase" node redeploy-pool.js');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║        SwapPool Redeploy (with total_locked_lp) ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const { keypair, address: deployerAddr } = getAddress(mnemonic);
  const deployments = loadDeployments();
  const bal = await rpcCall('octra_balance', [deployerAddr]);
  let nonce = bal.nonce;

  console.log(`Deployer: ${deployerAddr} | Balance: ${bal.balance} OCT | Nonce: ${nonce}\n`);

  // 1. Get current pool info
  const oldPoolAddr = deployments.SwapPool;
  const oldTokenA = deployments.WOCT;
  const oldTokenB = deployments.OES;

  if (!oldPoolAddr || !oldTokenA || !oldTokenB) {
    throw new Error('Missing SwapPool/WOCT/OES in deployments.json');
  }

  console.log(`Old pool: ${oldPoolAddr}`);
  console.log(`Tokens: ${oldTokenA} / ${oldTokenB}\n`);

  // Get current pool state
  const poolInfo = await rpcCall('contract_call', [oldPoolAddr, 'get_pool_info', [], deployerAddr]);
  const storage = poolInfo.storage;
  const reserveA = storage.reserve_a;
  const reserveB = storage.reserve_b;
  const totalLP = storage.total_lp;
  const feeNum = storage.fee_numerator;
  const feeDenom = storage.fee_denominator;

  console.log('Current pool state:');
  console.log(`  Reserve A: ${reserveA}`);
  console.log(`  Reserve B: ${reserveB}`);
  console.log(`  Total LP: ${totalLP}`);
  console.log(`  Fee: ${feeNum}/${feeDenom}\n`);

  // 2. Compile new SwapPool
  console.log('=== Compiling SwapPool ===');
  const swapPool = await compile('SwapPool');

  // 3. Deploy new SwapPool
  console.log('\n=== Deploying New SwapPool ===');
  nonce++;
  const newPoolAddr = await deploy('SwapPool', swapPool.bytecode, deployerAddr, nonce, keypair.secretKey);

  // 4. Set tokens
  console.log('\n=== Setting Tokens ===');
  nonce++;
  await callMethod(newPoolAddr, 'set_tokens', [oldTokenA, oldTokenB], null, deployerAddr, nonce, keypair.secretKey);

  // 5. Set fee params
  console.log('\n=== Setting Fee Params ===');
  nonce++;
  await callMethod(newPoolAddr, 'set_fee_params', [parseInt(feeNum), parseInt(feeDenom)], null, deployerAddr, nonce, keypair.secretKey);

  // 6. Register with factory
  console.log('\n=== Registering with Factory ===');
  nonce++;
  await callMethod(deployments.SwapFactory, 'register_pool', [oldTokenA, oldTokenB, newPoolAddr], null, deployerAddr, nonce, keypair.secretKey);

  // 7. Grant + Add liquidity (if there was liquidity)
  if (BigInt(reserveA) > 0 && BigInt(reserveB) > 0 && BigInt(totalLP) > 0) {
    console.log('\n=== Migrating Liquidity ===');

    // Grant token A
    console.log(`  Granting ${oldTokenA}...`);
    nonce++;
    await callMethod(oldTokenA, 'grant', [newPoolAddr, parseInt(reserveA)], null, deployerAddr, nonce, keypair.secretKey);

    // Grant token B
    console.log(`  Granting ${oldTokenB}...`);
    nonce++;
    await callMethod(oldTokenB, 'grant', [newPoolAddr, parseInt(reserveB)], null, deployerAddr, nonce, keypair.secretKey);

    // Add initial liquidity with lock_duration=0 (unlocked)
    console.log('  Adding liquidity...');
    nonce++;
    await callMethod(newPoolAddr, 'add_liquidity', [parseInt(reserveA), parseInt(reserveB), 1, 0, 0], null, deployerAddr, nonce, keypair.secretKey);

    const newReserves = await rpcCall('contract_call', [newPoolAddr, 'get_reserves', [], deployerAddr]);
    console.log(`  New reserves: ${newReserves.result}`);
  }

  // 8. Update deployments.json
  console.log('\n=== Updating deployments.json ===');
  deployments.SwapPool = newPoolAddr;
  saveDeployments(deployments);

  // 9. Verify new pool
  console.log('\n=== Verifying New Pool ===');
  const newPoolInfo = await rpcCall('contract_call', [newPoolAddr, 'get_pool_info', [], deployerAddr]);
  console.log(`  Pool info: ${JSON.stringify(newPoolInfo.storage, null, 2)}`);

  // Check new view function
  try {
    const totalLocked = await rpcCall('contract_call', [newPoolAddr, 'get_total_locked_lp', [], deployerAddr]);
    console.log(`  Total locked LP: ${totalLocked.result}`);
  } catch (e) {
    console.log(`  get_total_locked_lp: ${e.message}`);
  }

  const finalBal = await rpcCall('octra_balance', [deployerAddr]);
  console.log(`\nFinal balance: ${finalBal.balance} OCT (nonce: ${finalBal.nonce})`);
  console.log('\n✅ SwapPool redeploy complete!');
}

main().catch(err => { console.error('\nFailed:', err); process.exit(1); });
