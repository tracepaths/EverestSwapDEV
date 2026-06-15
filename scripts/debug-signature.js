const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');

// [V7-SECURITY] Load MNEMONIC from environment variable - NEVER hardcode in source!
const RPC_URL = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) {
  console.error('ERROR: MNEMONIC environment variable is not set.');
  console.error('Please set it with: export MNEMONIC="your mnemonic phrase"');
  process.exit(1);
}

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

async function main() {
  // Get deployer key
  const seed64 = crypto.pbkdf2Sync(MNEMONIC, 'mnemonic', 2048, 64, 'sha512');
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(seed64));
  const hdSeed32 = hmac.digest().slice(0, 32);
  const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
  const pubKey = Buffer.from(keypair.publicKey);
  const deployerAddr = (() => {
    const hash = crypto.createHash('sha256').update(pubKey).digest();
    let b58 = bs58.default.encode(hash);
    while (b58.length < 44) b58 = '1' + b58;
    return 'oct' + b58;
  })();

  console.log('Deployer address:', deployerAddr);
  console.log('Public key (hex):', pubKey.toString('hex'));
  console.log('Public key (b64):', Buffer.from(keypair.secretKey.slice(32, 64)).toString('base64'));

  // Test 1: Verify that deploy signing works by recreating what deploy.js does
  console.log('\n--- Test 1: Deploy-like signing ---');
  const deployTx = {
    from: deployerAddr,
    to_: 'octEXsVBKK182zNf58Q26R6jKKA4NMQeMoMLUF37Mk94BBu',
    amount: '0',
    nonce: 99,
    ou: '100000',
    timestamp: Date.now() / 1000,
    op_type: 'deploy',
    encrypted_data: '0102030405060708090a0b0c0d0e0f'
  };
  const deployJson = canonicalTxJson(deployTx);
  console.log('Canonical JSON:', deployJson);
  const deploySig = nacl.sign.detached(Buffer.from(deployJson, 'utf-8'), keypair.secretKey);
  console.log('Signature (b64):', Buffer.from(deploySig).toString('base64'));

  // Test 2: Contract call signing
  console.log('\n--- Test 2: Contract call signing ---');
  const callTx = {
    from: deployerAddr,
    to_: 'octEXsVBKK182zNf58Q26R6jKKA4NMQeMoMLUF37Mk94BBu',
    amount: '0',
    nonce: 100,
    ou: '100000',
    timestamp: Date.now() / 1000,
    op_type: 'call',
    encrypted_data: 'set_tokens',
    message: JSON.stringify(['oct00000000000000000000000000000000000000000000', 'oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD'])
  };
  const callJson = canonicalTxJson(callTx);
  console.log('Canonical JSON:', callJson);
  const callSig = nacl.sign.detached(Buffer.from(callJson, 'utf-8'), keypair.secretKey);
  console.log('Signature (b64):', Buffer.from(callSig).toString('base64'));

  // Test 3: Submit a simple call to verify
  console.log('\n--- Test 3: Submit a get_reserves view call ---');
  try {
    const viewResult = await rpcCall('contract_call', ['octEXsVBKK182zNf58Q26R6jKKA4NMQeMoMLUF37Mk94BBu', 'get_reserves', [], deployerAddr]);
    console.log('View call result:', viewResult);
  } catch (e) {
    console.log('View call error:', e.message);
  }

  // Test 4: Try submitting a simple contract call (no message with quotes)
  console.log('\n--- Test 4: Submit simple contract call ---');
  const bal = await rpcCall('octra_balance', [deployerAddr]);
  let nonce = bal.nonce;
  console.log('Current nonce:', nonce);

  const simpleTx = {
    from: deployerAddr,
    to_: 'octEXsVBKK182zNf58Q26R6jKKA4NMQeMoMLUF37Mk94BBu',
    amount: '0',
    nonce: nonce + 1,
    ou: '100000',
    timestamp: Date.now() / 1000,
    op_type: 'call',
    encrypted_data: 'set_tokens',
    message: JSON.stringify(['oct00000000000000000000000000000000000000000000', 'oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD'])
  };
  const simpleJson = canonicalTxJson(simpleTx);
  console.log('Canonical JSON:', simpleJson);
  const simpleSig = nacl.sign.detached(Buffer.from(simpleJson, 'utf-8'), keypair.secretKey);
  simpleTx.signature = Buffer.from(simpleSig).toString('base64');
  simpleTx.public_key = Buffer.from(keypair.secretKey.slice(32, 64)).toString('base64');
  console.log('Full tx:', JSON.stringify(simpleTx, null, 2));

  try {
    const result = await rpcCall('octra_submit', [simpleTx]);
    console.log('Submit result:', result);
    if (result.tx_hash) {
      console.log('Tx submitted! Hash:', result.tx_hash);
    }
  } catch (e) {
    console.log('Submit error:', e.message);
  }
}

main().catch(err => console.error('Error:', err));
