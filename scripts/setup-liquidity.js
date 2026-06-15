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

async function submitContractCall(contractAddr, method, params, amount, secretKey, addr, nonce) {
  const tx = {
    from: addr, to_: contractAddr,
    amount: amount || '0',
    nonce, ou: FEE_OU,
    timestamp: Math.floor(Date.now() / 1000),
    op_type: 'call',
    encrypted_data: method,
    message: JSON.stringify(params)
  };
  signTx(tx, secretKey);
  const result = await rpcCall('octra_submit', [tx]);
  console.log(`  Tx: ${result.tx_hash}`);
  const receipt = await waitReceipt(result.tx_hash);
  if (!receipt.success) throw new Error(`${method} failed: ${receipt.error}`);
  console.log(`  ✅ ${method} success`);
  return receipt;
}

async function main() {
  // Derive deployer key
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

  const POOL = 'octEXsVBKK182zNf58Q26R6jKKA4NMQeMoMLUF37Mk94BBu';
  const OES = 'oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD';
  const OCT_PLACEHOLDER = 'oct00000000000000000000000000000000000000000000';
  const OES_AMOUNT = '200000000000'; // 200000 OES
  const OCT_AMOUNT = '10000000'; // 10 OCT

  // Check pool state
  const poolInfo = await rpcCall('contract_call', [POOL, 'get_pool_info', [], deployerAddr]);
  console.log('Pool info before:', JSON.stringify(poolInfo.storage || poolInfo.result));

  // Get fresh nonce
  const bal = await rpcCall('octra_balance', [deployerAddr]);
  let nonce = bal.nonce;
  console.log(`Deployer: ${deployerAddr} | Nonce: ${nonce} | Balance: ${bal.balance} OCT`);

  // Step 1: set_tokens
  console.log('\n1. Setting tokens on pool...');
  nonce++;
  await submitContractCall(POOL, 'set_tokens', [OCT_PLACEHOLDER, OES], '0', keypair.secretKey, deployerAddr, nonce);

  // Step 2: transfer OES to pool
  console.log('\n2. Transferring OES to pool...');
  nonce++;
  await submitContractCall(OES, 'transfer', [POOL, parseInt(OES_AMOUNT)], '0', keypair.secretKey, deployerAddr, nonce);

  // Verify OES balance
  const poolOes = await rpcCall('contract_call', [OES, 'balance_of', [POOL], deployerAddr]);
  console.log(`   Pool OES balance: ${poolOes.result}`);

  // Step 3: init pool with OCT + OES
  console.log('\n3. Initializing pool...');
  nonce++;
  await submitContractCall(POOL, 'init', [parseInt(OCT_AMOUNT), parseInt(OES_AMOUNT), deployerAddr], OCT_AMOUNT, keypair.secretKey, deployerAddr, nonce);

  // Verify pool state
  const reserves = await rpcCall('contract_call', [POOL, 'get_reserves', [], deployerAddr]);
  console.log(`\nReserves: ${reserves.result}`);

  const info = await rpcCall('contract_call', [POOL, 'get_pool_info', [], deployerAddr]);
  console.log('Pool info:', JSON.stringify(info.storage || info.result, null, 2));

  console.log('\n✅ Liquidity setup complete!');
}

main().catch(err => { console.error('\nFailed:', err); process.exit(1); });
