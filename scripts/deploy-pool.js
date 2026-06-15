const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

// [V7-SECURITY] Load MNEMONIC from environment variable - NEVER hardcode in source!
const RPC_URL = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) {
  console.error('ERROR: MNEMONIC environment variable is not set.');
  console.error('Please set it with: export MNEMONIC="your mnemonic phrase"');
  process.exit(1);
}
const FEE_OU = '100000';
const DEPLOYMENTS_PATH = path.join(__dirname, '..', 'deployments.json');

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
  if (!receipt.success) throw new Error(`Failed: ${receipt.error}`);
  console.log(`  ✅ (effort: ${receipt.effort})`);
  return { receipt, tx_hash: result.tx_hash };
}

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

function loadDeployments() {
  try { return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf-8')); } catch { return {}; }
}

function saveDeployments(d) {
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(d, null, 2));
  console.log(`  Saved → ${DEPLOYMENTS_PATH}`);
}

async function main() {
  const deployer = getDeployer();
  const { nonce, balance } = await rpcCall('octra_balance', [deployer.address]);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance: ${balance} OCT | Nonce: ${nonce}\n`);

  const addresses = loadDeployments();
  let currentNonce = nonce;
  const OES = 'oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD';

  // 1. Compile and deploy new SwapFactoryV2 with update_pool
  console.log('1. Compiling SwapFactoryV2...');
  const factorySrc = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'SwapFactoryV2.aml'), 'utf-8');
  const factoryCompiled = await rpcCall('octra_compileAml', [factorySrc]);
  console.log(`   ${factoryCompiled.size}B, ${factoryCompiled.instructions} instr`);

  currentNonce++;
  const factoryAddr = await rpcCall('octra_computeContractAddress', [factoryCompiled.bytecode, deployer.address, currentNonce]);
  console.log(`   Predicted: ${factoryAddr.address}`);

  console.log('\n2. Deploying SwapFactoryV2...');
  await submitTx(deployer.address, factoryAddr.address, '0', currentNonce, FEE_OU, Date.now() / 1000,
    'deploy', factoryCompiled.bytecode, null, deployer.keypair.secretKey);
  addresses.SwapFactory = factoryAddr.address;

  // 2. Add trusted tokens on new factory
  console.log('\n3. Adding trusted tokens...');
  currentNonce++;
  await submitTx(deployer.address, factoryAddr.address, '0', currentNonce, FEE_OU, Date.now() / 1000,
    'call', 'add_trusted_token', JSON.stringify([addresses.WOCT]), deployer.keypair.secretKey);
  currentNonce++;
  await submitTx(deployer.address, factoryAddr.address, '0', currentNonce, FEE_OU, Date.now() / 1000,
    'call', 'add_trusted_token', JSON.stringify([OES]), deployer.keypair.secretKey);

  // 3. Register pool
  console.log('\n4. Registering pool...');
  currentNonce++;
  await submitTx(deployer.address, factoryAddr.address, '0', currentNonce, FEE_OU, Date.now() / 1000,
    'call', 'register_pool', JSON.stringify([addresses.WOCT, OES, addresses.SwapPool]), deployer.keypair.secretKey);

  // 4. Set factory on router
  console.log('\n5. Setting factory on Router...');
  currentNonce++;
  await submitTx(deployer.address, addresses.Router, '0', currentNonce, FEE_OU, Date.now() / 1000,
    'call', 'set_factory', JSON.stringify([factoryAddr.address]), deployer.keypair.secretKey);

  // 5. Set WOCT on router (ensure)
  currentNonce++;
  await submitTx(deployer.address, addresses.Router, '0', currentNonce, FEE_OU, Date.now() / 1000,
    'call', 'set_woct', JSON.stringify([addresses.WOCT]), deployer.keypair.secretKey);

  saveDeployments(addresses);

  // 6. Verify
  console.log('\n--- Verification ---');
  const pool = await rpcCall('contract_call', [factoryAddr.address, 'get_pool', [addresses.WOCT, OES], deployer.address]);
  console.log(`Factory pool for WOCT/OES: ${JSON.stringify(pool.result)}`);

  const poolInfo = await rpcCall('contract_call', [addresses.SwapPool, 'get_pool_info', [], deployer.address]);
  console.log(`Pool info: ${JSON.stringify(poolInfo.result)}`);

  const finalBal = await rpcCall('octra_balance', [deployer.address]);
  console.log(`\nFinal balance: ${finalBal.balance} OCT (nonce: ${finalBal.nonce})`);
  console.log(`\n✅ Done!`);
}

main().catch(err => {
  console.error('\nFailed:', err);
  process.exit(1);
});
