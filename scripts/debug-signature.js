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
  // [V7-SECURITY-FIX CRIT-3] Pure off-chain signature-format debugging tool.
  // This script MUST NOT submit any transaction. It only computes and prints
  // signatures so the developer can compare with their wallet's signed payload.

  // Derive deployer key
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
    message: JSON.stringify(['oct00000000000000000000000000000000000000000000', 'octGURUy7hQhXHVcP9bovbJnpoXqCv2gpWBrk6fqtXqJ2sC'])
  };
  const callJson = canonicalTxJson(callTx);
  console.log('Canonical JSON:', callJson);
  const callSig = nacl.sign.detached(Buffer.from(callJson, 'utf-8'), keypair.secretKey);
  console.log('Signature (b64):', Buffer.from(callSig).toString('base64'));

  // [SECURITY] Test 3 (live contract view call) and Test 4 (live tx submission) intentionally
  // removed to prevent accidental on-chain side effects during debugging.
  // To inspect on-chain state, use contract_view() from walletService.ts or a read-only
  // explorer. To sign and submit, use deploy.js or PoolPage.tsx.
  console.log('\n[SECURITY] No on-chain calls performed. This is a pure signature debugger.');
}

main().catch(err => console.error('Error:', err));
