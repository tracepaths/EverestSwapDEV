const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

const RPC_URL = 'https://devnet.octrascan.io/rpc';
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

async function main() {
  // [SECURITY] Load MNEMONIC from environment variable - NOT from CLI args
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    console.error('Usage: MNEMONIC="your mnemonic phrase" node redeploy-factory.js');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       SwapFactoryV2 Redeploy                    ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const { keypair, address: deployerAddr } = getAddress(mnemonic);
  const deployments = loadDeployments();
  const bal = await rpcCall('octra_balance', [deployerAddr]);
  let nonce = bal.nonce;

  console.log(`Deployer: ${deployerAddr} | Balance: ${bal.balance} OCT | Nonce: ${nonce}\n`);

  const poolAddr = deployments.SwapPool;
  const woctAddr = deployments.WOCT;
  const oesAddr = deployments.OES;
  const routerAddr = deployments.Router;

  console.log(`Pool: ${poolAddr}`);
  console.log(`WOCT: ${woctAddr}`);
  console.log(`OES: ${oesAddr}`);
  console.log(`Router: ${routerAddr}\n`);

  // 1. Compile
  console.log('=== Compiling SwapFactoryV2 ===');
  const factory = await compile('SwapFactoryV2');

  // 2. Deploy
  console.log('\n=== Deploying SwapFactoryV2 ===');
  nonce++;
  const newFactoryAddr = await deploy('SwapFactoryV2', factory.bytecode, deployerAddr, nonce, keypair.secretKey);

  // 3. Register pool
  console.log('\n=== Registering Pool ===');
  nonce++;
  await callMethod(newFactoryAddr, 'register_pool', [woctAddr, oesAddr, poolAddr], null, deployerAddr, nonce, keypair.secretKey);

  // 4. Add trusted tokens
  console.log('\n=== Adding Trusted Tokens ===');
  nonce++;
  await callMethod(newFactoryAddr, 'add_trusted_token', [woctAddr], null, deployerAddr, nonce, keypair.secretKey);
  nonce++;
  await callMethod(newFactoryAddr, 'add_trusted_token', [oesAddr], null, deployerAddr, nonce, keypair.secretKey);

  // 5. Update Router
  console.log('\n=== Updating Router ===');
  nonce++;
  await callMethod(routerAddr, 'set_factory', [newFactoryAddr], null, deployerAddr, nonce, keypair.secretKey);

  // 6. Update deployments.json
  console.log('\n=== Updating deployments.json ===');
  deployments.SwapFactory = newFactoryAddr;
  saveDeployments(deployments);

  // 7. Verify
  console.log('\n=== Verifying ===');
  const feeTo = await rpcCall('contract_call', [newFactoryAddr, 'get_fee_to', [], deployerAddr]);
  console.log(`  fee_to: ${feeTo.result}`);
  const setter = await rpcCall('contract_call', [newFactoryAddr, 'get_fee_to_setter', [], deployerAddr]);
  console.log(`  fee_to_setter: ${setter.result}`);
  const poolCount = await rpcCall('contract_call', [newFactoryAddr, 'pools_length', [], deployerAddr]);
  console.log(`  pools: ${poolCount.result}`);
  const isTrustedWoct = await rpcCall('contract_call', [newFactoryAddr, 'is_trusted', [woctAddr], deployerAddr]);
  console.log(`  WOCT trusted: ${isTrustedWoct.result}`);
  const isTrustedOes = await rpcCall('contract_call', [newFactoryAddr, 'is_trusted', [oesAddr], deployerAddr]);
  console.log(`  OES trusted: ${isTrustedOes.result}`);

  const finalBal = await rpcCall('octra_balance', [deployerAddr]);
  console.log(`\nFinal balance: ${finalBal.balance} OCT (nonce: ${finalBal.nonce})`);
  console.log(`\n✅ Factory redeploy complete! New address: ${newFactoryAddr}`);
}

main().catch(err => { console.error('\nFailed:', err); process.exit(1); });
