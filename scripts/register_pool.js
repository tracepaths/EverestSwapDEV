const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const path = require('path');

// [V7-SECURITY] Load MNEMONIC from environment variable - NEVER hardcode in source!
const RPC_URL = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) {
  console.error('ERROR: MNEMONIC environment variable is not set.');
  console.error('Please set it with: export MNEMONIC="your mnemonic phrase"');
  process.exit(1);
}
const CALL_FEE_OU = '1500';

const FACTORY_V2 = 'octEwgKA8zRxriLdvdrTuKNeimvHTSLqt6sX6KBCUTyQfxs';
const USER_POOL = 'octjp1XhWGYr94ZyRRBN4ZMy76ZpZoKbWBdHtRZtw4UEjQ5';
const WOCT = 'oct3taQXSQetRSmq21hfLmc1ormx7svm112cUB5uEze3oVe';
const OES = 'oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD';

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${data.error.message}`);
  return data.result;
}

function mnemonicToSeed(mnemonic) {
  return crypto.pbkdf2Sync(mnemonic, 'mnemonic', 2048, 64, 'sha512');
}

function deriveHdSeed(masterSeed64) {
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(masterSeed64));
  return hmac.digest().slice(0, 32);
}

function deriveAddress(pubkey) {
  const hash = crypto.createHash('sha256').update(pubkey).digest();
  let b58 = bs58.default.encode(hash);
  while (b58.length < 44) b58 = '1' + b58;
  return 'oct' + b58;
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
      if (receipt && receipt.success !== undefined) {
        if (!receipt.success) throw new Error(`Tx failed: ${receipt.error || 'unknown'}`);
        return receipt;
      }
      if (receipt && receipt.status && receipt.status !== 'pending') {
        if (receipt.status === 'failed') throw new Error(`Tx failed: ${receipt.error || 'unknown'}`);
        return receipt;
      }
    } catch (e) {
      if (e.message && e.message.includes('not found')) {} else { throw e; }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Timeout waiting for receipt');
}

async function main() {
  console.log('=== Register Pool on V2 Factory ===\n');
  
  // ---- Step 1: Check pool info ----
  console.log('--- Checking pool info ---');
  const poolInfo = await rpcCall('contract_call', [USER_POOL, 'get_pool_info', []]);
  console.log('Pool info raw:', JSON.stringify(poolInfo, null, 2));

  // ---- Step 2: Check factory pool list ----
  console.log('\n--- Checking factory pools ---');
  const allPools = await rpcCall('contract_call', [FACTORY_V2, 'all_pools', []]);
  console.log('All pools:', JSON.stringify(allPools, null, 2));

  // ---- Step 3: Check if already registered ----
  const existing = await rpcCall('contract_call', [FACTORY_V2, 'get_pool', [WOCT, OES]]);
  const existingAddr = typeof existing === 'object' && existing.result ? String(existing.result) : String(existing || '');
  console.log(`\nget_pool(WOCT, OES): ${existingAddr}`);
  
  if (existingAddr === USER_POOL) {
    console.log('✅ Pool already registered!');
    return;
  }

  // ---- Step 4: Register the pool ----
  console.log('\n--- Registering pool on factory ---');
  const seed64 = mnemonicToSeed(MNEMONIC);
  const hdSeed32 = deriveHdSeed(seed64);
  const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
  const deployerAddr = deriveAddress(Buffer.from(keypair.publicKey));
  const pubKeyB64 = Buffer.from(keypair.publicKey).toString('base64');

  const bal = await rpcCall('octra_balance', [deployerAddr]);
  const nonce = bal.nonce + 1;
  const timestamp = Date.now() / 1000;

  const tx = {
    from: deployerAddr,
    to_: FACTORY_V2,
    amount: '0',
    nonce,
    ou: CALL_FEE_OU,
    timestamp,
    op_type: 'call',
    encrypted_data: 'register_pool',
    message: JSON.stringify([WOCT, OES, USER_POOL]),
  };

  signTx(tx, keypair.secretKey);
  tx.public_key = pubKeyB64;

  const result = await rpcCall('octra_submit', [tx]);
  console.log(`Tx: ${result.tx_hash}`);

  await waitReceipt(result.tx_hash);
  console.log('✅ Pool registered successfully!');

  // ---- Step 5: Verify ----
  const verify = await rpcCall('contract_call', [FACTORY_V2, 'get_pool', [WOCT, OES]]);
  const verifyAddr = typeof verify === 'object' && verify.result ? String(verify.result) : String(verify || '');
  console.log(`\nVerified - get_pool(WOCT, OES): ${verifyAddr}`);
  console.log(`Matches user pool: ${verifyAddr === USER_POOL ? '✅' : '❌'}`);
}

main().catch(err => { console.error('\n❌ Failed:', err); process.exit(1); });
