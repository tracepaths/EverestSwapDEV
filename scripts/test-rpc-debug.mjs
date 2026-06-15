import crypto from 'crypto';
import nacl from 'tweetnacl';

const RPC = 'https://devnet.octrascan.io/rpc';
const DEPLOYER = 'octGXi34vZfYwi3idjSa6m34vLJCoJHNMNAGeHyqh7JVEvy';
const WOCT = 'oct3taQXSQetRSmq21hfLmc1ormx7svm112cUB5uEze3oVe';
const POOL = 'oct7t3dFk1AyysnoVRwvcwqMLzgkTt8Sw78Lnuv32EtUx7r';

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
  const MNEMONIC = 'pumpkin divert spend later token student spot faint collect visual carbon matter';
  const seed64 = crypto.pbkdf2Sync(MNEMONIC, 'mnemonic', 2048, 64, 'sha512');
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(seed64));
  const hdSeed32 = hmac.digest().slice(0, 32);
  return nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
}

const keypair = getDeployerKey();
const pubKeyB64 = Buffer.from(keypair.secretKey.slice(32, 64)).toString('base64');
const bal = await rpc('octra_balance', [DEPLOYER]);
const nonce = bal.nonce;

// CRITICAL TEST: Sign only from, to_, amount, nonce, ou, timestamp (no op_type, no encrypted_data, no message)
// Submit with op_type: 'call', encrypted_data, message but DON'T include them in the signed message
console.log('=== KEY TEST: call with canonical JSON = base fields ONLY ===');
const ts = Math.floor(Date.now() / 1000);
const canonical = `{"from":"${DEPLOYER}","to_":"${WOCT}","amount":"0","nonce":${nonce},"ou":"1500","timestamp":${ts}}`;
const sig = nacl.sign.detached(Buffer.from(canonical, 'utf-8'), keypair.secretKey);
const v = nacl.sign.detached.verify(Buffer.from(canonical, 'utf-8'), sig, keypair.publicKey);
console.log('Local verify:', v);
console.log('Signed msg:', canonical);

const tx = {
  from: DEPLOYER, to_: WOCT, amount: '0', nonce, ou: '1500',
  timestamp: ts, op_type: 'call',
  encrypted_data: 'deposit',  // method
  message: JSON.stringify([]),  // empty args
  public_key: pubKeyB64,
  signature: Buffer.from(sig).toString('base64')
};
try {
  const r = await rpc('octra_submit', [tx]);
  console.log('SUCCESS:', JSON.stringify(r));
} catch (e) { console.log('ERROR:', e.message); }

// Also test withdraw
console.log('\n=== KEY TEST 2: call withdraw, base fields ONLY ===');
const ts2 = Math.floor(Date.now() / 1000);
const canonical2 = `{"from":"${DEPLOYER}","to_":"${WOCT}","amount":"0","nonce":${nonce},"ou":"1500","timestamp":${ts2}}`;
const sig2 = nacl.sign.detached(Buffer.from(canonical2, 'utf-8'), keypair.secretKey);
const tx2 = {
  from: DEPLOYER, to_: WOCT, amount: '0', nonce, ou: '1500',
  timestamp: ts2, op_type: 'call',
  encrypted_data: 'withdraw',
  message: JSON.stringify(['100000']),
  public_key: pubKeyB64,
  signature: Buffer.from(sig2).toString('base64')
};
try {
  const r = await rpc('octra_submit', [tx2]);
  console.log('SUCCESS:', JSON.stringify(r));
} catch (e) { console.log('ERROR:', e.message); }

// Test with pool/grant
console.log('\n=== KEY TEST 3: grant POOL, base fields ONLY ===');
const ts3 = Math.floor(Date.now() / 1000);
const canonical3 = `{"from":"${DEPLOYER}","to_":"${POOL}","amount":"0","nonce":${nonce},"ou":"100000","timestamp":${ts3}}`;
const sig3 = nacl.sign.detached(Buffer.from(canonical3, 'utf-8'), keypair.secretKey);
const tx3 = {
  from: DEPLOYER, to_: POOL, amount: '0', nonce, ou: '100000',
  timestamp: ts3, op_type: 'call',
  encrypted_data: 'swap_a_for_b',
  message: JSON.stringify([500000, 0]),  // 0.5 WOCT, min_out=0
  public_key: pubKeyB64,
  signature: Buffer.from(sig3).toString('base64')
};
try {
  const r = await rpc('octra_submit', [tx3]);
  console.log('SUCCESS:', JSON.stringify(r));
} catch (e) { console.log('ERROR:', e.message); }
