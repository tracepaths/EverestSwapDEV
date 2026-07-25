import crypto from 'crypto';
import nacl from 'tweetnacl';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';

// [SECURITY] Load addresses from deployments.json; fall back to canonical OES only
const deployments = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments.json'), 'utf-8'));
const WOCT = deployments.WOCT;
const POOL = deployments.SwapPool;
const OES = deployments.OES || 'octGURUy7hQhXHVcP9bovbJnpoXqCv2gpWBrk6fqtXqJ2sC';
if (!WOCT || !POOL) {
  throw new Error('Required addresses missing in deployments.json (SwapPool, WOCT)');
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

function getDeployerKey() {
  const MNEMONIC = process.env.MNEMONIC;
  if (!MNEMONIC) {
    throw new Error('MNEMONIC environment variable is not set');
  }
  const seed64 = crypto.pbkdf2Sync(MNEMONIC, 'mnemonic', 2048, 64, 'sha512');
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(seed64));
  const hdSeed32 = hmac.digest().slice(0, 32);
  return nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
}

function jsonEscape(s) {
  let r = '';
  for (const c of s) {
    switch (c) {
      case '"': r += '\\"'; break;
      case '\\': r += '\\\\'; break;
      case '\b': r += '\\b'; break;
      case '\f': r += '\\f'; break;
      case '\n': r += '\\n'; break;
      case '\r': r += '\\r'; break;
      case '\t': r += '\\t'; break;
      default: r += c;
    }
  }
  return r;
}

function buildCanonical(from, to_, amount, nonce, ou, timestamp, op_type, encrypted_data, message) {
  let s = '{"from":"' + jsonEscape(from) + '"'
    + ',"to_":"' + jsonEscape(to_) + '"'
    + ',"amount":"' + jsonEscape(amount) + '"'
    + ',"nonce":' + String(nonce)
    + ',"ou":"' + jsonEscape(ou) + '"'
    + ',"timestamp":' + JSON.stringify(timestamp)
    + ',"op_type":"' + jsonEscape(op_type) + '"';
  if (encrypted_data != null)
    s += ',"encrypted_data":"' + jsonEscape(encrypted_data) + '"';
  if (message != null)
    s += ',"message":"' + jsonEscape(message) + '"';
  s += '}';
  return s;
}

async function submitCall(from, to_, amount, nonce, ou, method, args, keypair, pubKeyB64) {
  const ts = Date.now() / 1000;
  const params = JSON.stringify(args);
  const canonical = buildCanonical(from, to_, amount, nonce, ou, ts, 'call', method, params);
  const sig = nacl.sign.detached(Buffer.from(canonical, 'utf-8'), keypair.secretKey);
  const tx = {
    from, to_, amount, nonce, ou,
    timestamp: ts, op_type: 'call',
    encrypted_data: method,
    message: params,
    public_key: pubKeyB64,
    signature: Buffer.from(sig).toString('base64')
  };
  return rpc('octra_submit', [tx]);
}

const keypair = getDeployerKey();
const pubKeyB64 = Buffer.from(keypair.secretKey.slice(32, 64)).toString('base64');

// [SECURITY] Derive deployer address from keypair (not hardcoded)
const bs58 = (await import('bs58')).default;
const seed64 = crypto.pbkdf2Sync(process.env.MNEMONIC, 'mnemonic', 2048, 64, 'sha512');
const hmac = crypto.createHmac('sha512', 'Octra seed');
hmac.update(Buffer.from(seed64));
const hdSeed32 = hmac.digest().slice(0, 32);
const derivedKeypair = nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
const hash = crypto.createHash('sha256').update(Buffer.from(derivedKeypair.publicKey)).digest();
let b58 = bs58.encode(hash);
while (b58.length < 44) b58 = '1' + b58;
const DEPLOYER = 'oct' + b58;
console.log('Deployer:', DEPLOYER);

// Get current nonce
const bal = await rpc('octra_balance', [DEPLOYER]);
let nonce = bal.nonce + 1;
console.log('Deployer:', bal.balance, 'OCT, nonce:', bal.nonce, 'next:', nonce);

// Check pre-swap state
console.log('\n=== Pre-swap State ===');
const poolState = await rpc('contract_call', [POOL, 'get_reserves', [], DEPLOYER]);
console.log('Pool reserves:', JSON.stringify(poolState.storage || poolState));

const woctDeployer = await rpc('contract_call', [WOCT, 'balance_of', [DEPLOYER], DEPLOYER]);
const woctPool = await rpc('contract_call', [WOCT, 'balance_of', [POOL], DEPLOYER]);
const oesDeployer = await rpc('contract_call', [OES, 'balance_of', [DEPLOYER], DEPLOYER]);
const oesPool = await rpc('contract_call', [OES, 'balance_of', [POOL], DEPLOYER]);
console.log('WOCT deployer:', woctDeployer.result || woctDeployer);
console.log('WOCT pool:', woctPool.result || woctPool);
console.log('OES deployer:', oesDeployer.result || oesDeployer);
console.log('OES pool:', oesPool.result || oesPool);

// Check WOCT grant allowance
const allowance = await rpc('contract_call', [WOCT, 'allowance', [DEPLOYER, POOL], DEPLOYER]);
console.log('WOCT allowance to pool:', allowance.result || allowance);

// Step 0: Grant WOCT allowance to pool (required for pool to pull tokens)
console.log('\n=== Step 0: Grant WOCT allowance to pool ===');
const swapAmount = '500000'; // 0.5 WOCT
const grantResult = await submitCall(DEPLOYER, WOCT, '0', nonce++, '100000', 'grant', [POOL, parseInt(swapAmount)], keypair, pubKeyB64);
console.log('Grant submitted:', grantResult.tx_hash);
// Wait for grant receipt
for (let i = 0; i < 15; i++) {
  await new Promise(r => setTimeout(r, 2000));
  try {
    const receipt = await rpc('contract_receipt', [grantResult.tx_hash]);
    if (receipt && receipt.status !== 'pending') {
      if (receipt.success) console.log('  Grant confirmed');
      else console.log('  Grant failed:', receipt.error);
      break;
    }
  } catch (e) {}
}

// Step 1: Execute SWAP - 0.5 WOCT → OES
// [V7-FIX] Use chain epoch for deadline (not unix timestamp)
console.log('\n=== Step 1: Swap 0.5 WOCT for OES ===');
const minOut = '1'; // minimum OES to receive
const epochInfoSwap = await rpc('epoch_current', []);
const swapDeadline = (epochInfoSwap?.epoch_id || 0) + 300;
const swapResult = await submitCall(DEPLOYER, POOL, '0', nonce++, '100000', 'swap_a_for_b', [swapAmount, minOut, String(swapDeadline)], keypair, pubKeyB64);
console.log('Swap submitted:', JSON.stringify(swapResult));
const swapHash = swapResult.tx_hash;

// Wait for receipt
console.log('\n=== Waiting for receipt ===');
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  try {
    const receipt = await rpc('contract_receipt', [swapHash]);
    console.log('Receipt:', JSON.stringify(receipt));
    if (receipt && receipt.status && receipt.status !== 'pending') {
      if (receipt.success) console.log('✓ SWAP SUCCESSFUL!');
      else console.log('✗ SWAP FAILED:', receipt.error);
      break;
    }
  } catch (e) {
    if (!e.message.includes('not found')) console.log('Receipt error:', e.message);
  }
}

// Final state
console.log('\n=== Final State ===');
const poolState2 = await rpc('contract_call', [POOL, 'get_reserves', [], DEPLOYER]);
console.log('Pool reserves:', JSON.stringify(poolState2.storage || poolState2));

const woctDeployer2 = await rpc('contract_call', [WOCT, 'balance_of', [DEPLOYER], DEPLOYER]);
const woctPool2 = await rpc('contract_call', [WOCT, 'balance_of', [POOL], DEPLOYER]);
const oesDeployer2 = await rpc('contract_call', [OES, 'balance_of', [DEPLOYER], DEPLOYER]);
const oesPool2 = await rpc('contract_call', [OES, 'balance_of', [POOL], DEPLOYER]);
console.log('WOCT deployer:', woctDeployer2.result || woctDeployer2, '(was', woctDeployer.result || woctDeployer, ')');
console.log('WOCT pool:', woctPool2.result || woctPool2, '(was', woctPool.result || woctPool, ')');
console.log('OES deployer:', oesDeployer2.result || oesDeployer2, '(was', oesDeployer.result || oesDeployer, ')');
console.log('OES pool:', oesPool2.result || oesPool2, '(was', oesPool.result || oesPool, ')');
