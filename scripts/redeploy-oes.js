const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const MNEMONIC = 'bike prevent space wisdom lava box better orbit impulse creek around marriage';
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

function getDeployer() {
  const seed64 = crypto.pbkdf2Sync(MNEMONIC, 'mnemonic', 2048, 64, 'sha512');
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(seed64));
  const hdSeed32 = hmac.digest().slice(0, 32);
  const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
  const hash = crypto.createHash('sha256').update(Buffer.from(keypair.publicKey)).digest();
  let b58 = bs58.default.encode(hash);
  while (b58.length < 44) b58 = '1' + b58;
  const address = 'oct' + b58;
  return { keypair, address };
}

async function getNonce(addr) {
  const bal = await rpcCall('octra_balance', [addr]);
  return { nonce: bal.nonce, balance: bal.balance };
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

function loadDeployments() {
  try {
    return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveDeployments(addresses) {
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(addresses, null, 2));
  console.log(`  Saved → ${DEPLOYMENTS_PATH}`);
}

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║     OES Token Redeploy (Devnet)        ║');
  console.log('╚════════════════════════════════════════╝\n');

  const deployer = getDeployer();
  const { nonce, balance } = await getNonce(deployer.address);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${balance} OCT | Nonce: ${nonce}\n`);

  if (deployer.address !== 'oct2mhQQYM3MmDwMxbcpvTCMgSVPxh47YUdZGn3aR1r13PK') {
    console.error('ERROR: Derived address does not match expected owner!');
    console.error(`Expected: oct2mhQQYM3MmDwMxbcpvTCMgSVPxh47YUdZGn3aR1r13PK`);
    console.error(`Got:      ${deployer.address}`);
    process.exit(1);
  }

  const balNum = parseFloat(balance);
  if (balNum < 0.5) {
    throw new Error(`Insufficient balance: ${balance} OCT (need at least 0.5 OCT)`);
  }

  console.log('Compiling OES.aml...');
  const oes = await compile('OES');

  console.log('\nDeploying OES token...');
  const newNonce = nonce + 1;
  const oesAddr = await deploy('OES', oes.bytecode, deployer.address, newNonce, deployer.keypair.secretKey);

  const addresses = loadDeployments();
  const oldOes = addresses.OES;
  addresses.OES = oesAddr;
  saveDeployments(addresses);

  console.log('\n=== Deployment Complete ===');
  console.log(`  Old OES: ${oldOes || '(none)'}`);
  console.log(`  New OES: ${oesAddr}`);
  console.log(`  Owner:   ${deployer.address}`);
  console.log(`  Supply:  666,000,000 OES (100% to deployer)`);

  const finalBal = await rpcCall('octra_balance', [deployer.address]);
  console.log(`\nFinal balance: ${finalBal.balance} OCT (nonce: ${finalBal.nonce})`);
  console.log('Done.\n');
}

main().catch(err => {
  console.error('\nFailed:', err);
  process.exit(1);
});
