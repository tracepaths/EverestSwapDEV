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
const FEE_OU = '100000';

const POOL = 'oct7NFoitzUc5xYE4YRPwqVHigmFiBHYSfQEJ1eLg3jCTjU';
const OES = 'oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD';

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
  console.log(`  ✅ success (effort: ${receipt.effort})`);
  if (receipt.events) {
    for (const e of receipt.events) {
      if (e.event !== 'Require') console.log(`  Event: ${e.event} = ${e.values.join(', ')}`);
    }
  }
  return receipt;
}

async function main() {
  // Derive key
  const seed64 = crypto.pbkdf2Sync(MNEMONIC, 'mnemonic', 2048, 64, 'sha512');
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(seed64));
  const hdSeed32 = hmac.digest().slice(0, 32);
  const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
  const deployerAddr = (() => {
    const hash = crypto.createHash('sha256').update(Buffer.from(keypair.publicKey)).digest();
    let b58 = bs58.default.encode(hash);
    while (b58.length < 44) b58 = '1' + b58;
    return 'oct' + b58;
  })();

  const bal = await rpcCall('octra_balance', [deployerAddr]);
  let nonce = bal.nonce;
  console.log(`Deployer: ${deployerAddr} | Nonce: ${nonce} | Balance: ${bal.balance} OCT\n`);

  // === TEST 1: Swap OCT → OES ===
  console.log('=== Test 1: Swap 1 OCT → OES ===');
  const reserves1 = await rpcCall('contract_call', [POOL, 'get_reserves', [], deployerAddr]);
  console.log(`  Reserves before: ${reserves1.result}`);

  // 1 OCT = 1000000 ou, min_out = 0 (accept any)
  nonce++;
  const ts = Date.now() / 1000;
  const receipt1 = await submitTx(deployerAddr, POOL, '1000000', nonce, FEE_OU, ts,
    'call', 'swap_oct_to_token', JSON.stringify([1000000, 0]), keypair.secretKey);

  // Get output from receipt (Swap event)
  if (receipt1.events) {
    for (const e of receipt1.events) {
      if (e.event === 'Swap') {
        console.log(`  Swap event - in: ${e.values[2]}, out: ${e.values[3]}`);
      }
    }
  }

  const reserves2 = await rpcCall('contract_call', [POOL, 'get_reserves', [], deployerAddr]);
  console.log(`  Reserves after: ${reserves2.result}`);

  // === TEST 2: Swap OES → OCT ===
  console.log('\n=== Test 2: Swap 1000 OES → OCT ===');

  // Step 2a: Grant pool allowance on OES
  console.log('  2a. Granting pool allowance...');
  nonce++;
  await submitTx(deployerAddr, OES, '0', nonce, FEE_OU, Date.now() / 1000,
    'call', 'grant', JSON.stringify([POOL, 1000000000]), keypair.secretKey);

  // Check allowance
  const allowance = await rpcCall('contract_call', [OES, 'allowance', [deployerAddr, POOL], deployerAddr]);
  console.log(`  Allowance: ${allowance.result}`);

  // Step 2b: Swap 1000 OES → OCT
  console.log('  2b. Swapping OES → OCT...');
  nonce++;
  await submitTx(deployerAddr, POOL, '0', nonce, FEE_OU, Date.now() / 1000,
    'call', 'swap_token_to_oct', JSON.stringify([1000000000, 0]), keypair.secretKey);

  const reserves3 = await rpcCall('contract_call', [POOL, 'get_reserves', [], deployerAddr]);
  console.log(`  Reserves after OES→OCT: ${reserves3.result}`);

  // === Final state ===
  console.log('\n=== Final State ===');
  const finalBal = await rpcCall('octra_balance', [deployerAddr]);
  const oesBal = await rpcCall('contract_call', [OES, 'balance_of', [deployerAddr], deployerAddr]);
  const poolOes = await rpcCall('contract_call', [OES, 'balance_of', [POOL], deployerAddr]);
  console.log(`Deployer OCT: ${finalBal.balance}`);
  console.log(`Deployer OES: ${oesBal.result}`);
  console.log(`Pool OES: ${poolOes.result}`);
  console.log(`\n✅ Swap tests complete!`);
}

main().catch(err => { console.error('\nFailed:', err); process.exit(1); });
