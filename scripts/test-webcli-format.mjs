import crypto from 'crypto';
import nacl from 'tweetnacl';

const RPC = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const DEPLOYER = process.env.DEPLOYER_ADDRESS || '';
const WOCT = process.env.WOCT_ADDRESS || '';
const POOL = process.env.POOL_ADDRESS || '';
const OES = process.env.OES_ADDRESS || '';

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

const keypair = getDeployerKey();
const pubKeyB64 = Buffer.from(keypair.secretKey.slice(32, 64)).toString('base64');

// Get fresh balance
const bal = await rpc('octra_balance', [DEPLOYER]);
console.log('Balance:', JSON.stringify(bal));
const nonce = bal.nonce;
console.log('Nonce from API:', nonce);

// Try nonce+1 in case nonce is last-used not next
const tryNonce = nonce + 1;
console.log('Trying nonce:', tryNonce);

// 1. Grant WOCT to Pool
console.log('\n=== 1. Grant WOCT to Pool ===');
{
  const ts = Date.now() / 1000;
  const params2 = JSON.stringify([POOL, "500000"]);
  const canonical = buildCanonical(DEPLOYER, WOCT, '0', tryNonce, '100000', ts, 'call', 'grant', params2);
  console.log('Canonical:', canonical);
  const sig = nacl.sign.detached(Buffer.from(canonical, 'utf-8'), keypair.secretKey);
  const tx = {
    from: DEPLOYER, to_: WOCT, amount: '0', nonce: tryNonce, ou: '100000',
    timestamp: ts, op_type: 'call',
    encrypted_data: 'grant',
    message: params2,
    public_key: pubKeyB64,
    signature: Buffer.from(sig).toString('base64')
  };
  try {
    const r = await rpc('octra_submit', [tx]);
    console.log('SUCCESS:', JSON.stringify(r));
  } catch (e) { console.log('ERROR:', e.message); }
}

// 2. Pull WOCT from deployer to Pool (so Pool has WOCT)
console.log('\n=== 2. Just test existing pool balance ===');
// Let's check WOCT balance of Pool and Pool state
try {
  const r = await rpc('contract_call', [WOCT, 'balance_of', [POOL], DEPLOYER]);
  console.log('Pool WOCT balance:', JSON.stringify(r));
} catch (e) { console.log('ERROR:', e.message); }

try {
  const r = await rpc('contract_call', [WOCT, 'balance_of', [DEPLOYER], DEPLOYER]);
  console.log('Deployer WOCT balance:', JSON.stringify(r));
} catch (e) { console.log('ERROR:', e.message); }
