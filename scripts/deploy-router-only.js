const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) { console.error('Set MNEMONIC env var'); process.exit(1); }
const FEE_OU = '100000';
const DEPLOYMENTS_PATH = path.join(__dirname, '..', 'deployments.json');

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const data = await res.json();
  if (data.error) throw new Error('RPC error: ' + data.error.message);
  return data.result;
}

function jsonEscape(s) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
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
    try { const r = await rpcCall('contract_receipt', [txHash]); if (r && r.success !== undefined) return r; } catch {}
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
  console.log(`  OK (effort: ${receipt.effort})`);
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
  return { keypair, address: 'oct' + b58 };
}

async function main() {
  const deployer = getDeployer();
  const bal = await rpcCall('octra_balance', [deployer.address]);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${bal.balance} OCT | Nonce: ${bal.nonce}`);

  const deployments = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf-8'));
  console.log(`Factory: ${deployments.SwapFactory}`);
  console.log(`WOCT:    ${deployments.WOCT}`);

  console.log('\n1. Compiling Router...');
  const src = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'Router.aml'), 'utf-8');
  const compiled = await rpcCall('octra_compileAml', [src]);
  console.log(`  Router: ${compiled.size}B, ${compiled.instructions} instr`);

  let nonce = bal.nonce;

  console.log('\n2. Deploying Router...');
  nonce++;
  const addrResult = await rpcCall('octra_computeContractAddress', [compiled.bytecode, deployer.address, nonce]);
  console.log(`  Address: ${addrResult.address}`);
  await submitTx(deployer.address, addrResult.address, '0', nonce, FEE_OU, Date.now() / 1000, 'deploy', compiled.bytecode, null, deployer.keypair.secretKey);
  deployments.Router = addrResult.address;

  console.log('\n3. Setting factory on Router...');
  nonce++;
  await submitTx(deployer.address, deployments.Router, '0', nonce, FEE_OU, Date.now() / 1000, 'call', 'set_factory', JSON.stringify([deployments.SwapFactory]), deployer.keypair.secretKey);

  console.log('\n4. Setting WOCT on Router...');
  nonce++;
  await submitTx(deployer.address, deployments.Router, '0', nonce, FEE_OU, Date.now() / 1000, 'call', 'set_woct', JSON.stringify([deployments.WOCT]), deployer.keypair.secretKey);

  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(deployments, null, 2));
  console.log(`\nSaved deployments.json`);

  const finalBal = await rpcCall('octra_balance', [deployer.address]);
  console.log(`\n=== Router Redeploy Complete ===`);
  console.log(`New Router: ${deployments.Router}`);
  console.log(`Cost: ~${(parseFloat(bal.balance) - parseFloat(finalBal.balance)).toFixed(4)} OCT`);
  console.log(`Remaining: ${finalBal.balance} OCT`);
}

main().catch(err => { console.error('\nFailed:', err); process.exit(1); });
