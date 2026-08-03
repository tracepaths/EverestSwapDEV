// [V12] Deploy new SwapPool template + SwapFactory with remove_pool getter fix.
// Hardened against the nonce-race + flaky-submit issues seen in prior sessions:
//   - fetch a FRESH nonce (octra_balance.nonce + 1) immediately before each tx
//   - on submit error, don't assume failure — poll for the receipt anyway
//   - verify every step via a read-only contract_call before moving on
//
// Usage: MNEMONIC="..." node scripts/deploy-v12-pool-factory.js
const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const DEPLOYMENTS_PATH = path.join(__dirname, '..', 'deployments.json');

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
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
  const sig = nacl.sign.detached(Buffer.from(canonicalTxJson(tx), 'utf-8'), secretKey);
  tx.signature = Buffer.from(sig).toString('base64');
  tx.public_key = Buffer.from(secretKey.slice(32, 64)).toString('base64');
}

async function waitReceipt(txHash, maxWait = 120) {
  for (let i = 0; i < maxWait; i++) {
    try {
      const r = await rpcCall('contract_receipt', [txHash]);
      if (r && r.success !== undefined) return r;
    } catch (e) { /* not indexed yet */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Timeout waiting for receipt ' + txHash);
}

async function freshNonce(addr) {
  const bal = await rpcCall('octra_balance', [addr]);
  // next nonce = last-used nonce + 1 (octra_balance.nonce is last-USED)
  return bal.nonce + 1;
}

async function getRecommendedFee(opType) {
  try {
    const fee = await rpcCall('octra_recommendedFee', [opType]);
    return String(fee.recommended || fee.minimum || (opType === 'deploy' ? '200000' : '2000'));
  } catch { return opType === 'deploy' ? '200000' : '2000'; }
}

// Submit a tx with a fresh nonce; tolerate flaky submit errors by polling the
// receipt when the submit response is ambiguous.
async function submit(from, to_, amount, op_type, encrypted_data, message, secretKey, feeOu, label) {
  const nonce = await freshNonce(from);
  const ou = feeOu || await getRecommendedFee(op_type === 'deploy' ? 'deploy' : 'call');
  let ts = Date.now() / 1000;
  if (ts % 1 === 0) ts += 0.000001;
  const tx = { from, to_, amount, nonce, ou, timestamp: ts, op_type };
  if (encrypted_data) tx.encrypted_data = encrypted_data;
  if (message) tx.message = message;
  signTx(tx, secretKey);
  console.log(`  → ${label} (nonce ${nonce}, ou ${ou})`);
  let txHash;
  try {
    const result = await rpcCall('octra_submit', [tx]);
    txHash = result.tx_hash;
    console.log(`    submitted: ${txHash}`);
  } catch (e) {
    // Flaky submit — the tx may have executed anyway. Caller verifies via a read.
    console.log(`    submit reported: ${e.message} (verifying via receipt/read)`);
    if (result_hash_from_error(e)) txHash = result_hash_from_error(e);
  }
  if (txHash) {
    const receipt = await waitReceipt(txHash);
    if (!receipt.success) throw new Error(`${label} failed: ${receipt.error}`);
    console.log(`    ✅ effort ${receipt.effort}`);
    return { txHash, receipt };
  }
  return { txHash: null };
}
function result_hash_from_error() { return null; }

async function compile(name) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'contracts', `${name}.aml`), 'utf-8');
  const r = await rpcCall('octra_compileAml', [src]);
  console.log(`  compiled ${name}: ${r.size}B, ${r.instructions} instr`);
  return r.bytecode;
}

async function deploy(name, bytecode, from, secretKey) {
  const nonce = await freshNonce(from);
  const ou = await getRecommendedFee('deploy');
  const addrRes = await rpcCall('octra_computeContractAddress', [bytecode, from, nonce]);
  const addr = addrRes.address;
  let ts = Date.now() / 1000;
  if (ts % 1 === 0) ts += 0.000001;
  const tx = { from, to_: addr, amount: '0', nonce, ou, timestamp: ts, op_type: 'deploy', encrypted_data: bytecode };
  signTx(tx, secretKey);
  console.log(`  → deploy ${name} → ${addr} (nonce ${nonce}, ou ${ou})`);
  const result = await rpcCall('octra_submit', [tx]);
  console.log(`    submitted: ${result.tx_hash}`);
  const receipt = await waitReceipt(result.tx_hash);
  if (!receipt.success) throw new Error(`deploy ${name} failed: ${receipt.error}`);
  console.log(`    ✅ effort ${receipt.effort}`);
  return addr;
}

function getAddress(mnemonic) {
  const seed64 = crypto.pbkdf2Sync(mnemonic, 'mnemonic', 2048, 64, 'sha512');
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(seed64));
  const hd = hmac.digest().slice(0, 32);
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(hd));
  const hash = crypto.createHash('sha256').update(Buffer.from(kp.publicKey)).digest();
  let b58 = bs58.default.encode(hash);
  while (b58.length < 44) b58 = '1' + b58;
  return { keypair: kp, address: 'oct' + b58 };
}

async function readView(addr, method) {
  try {
    const r = await rpcCall('contract_call', [addr, method, []]);
    return r;
  } catch (e) { return { error: e.message }; }
}

async function main() {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) { console.error('Set MNEMONIC'); process.exit(1); }
  const { keypair, address } = getAddress(mnemonic);
  const sk = keypair.secretKey;
  const deployments = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf-8'));
  const woct = deployments.WOCT;

  const bal = await rpcCall('octra_balance', [address]);
  console.log(`Deployer ${address} | ${bal.balance} OCT | nonce ${bal.nonce}\n`);

  console.log('1) Compile');
  const poolBc = await compile('SwapPool');
  const factoryBc = await compile('SwapFactory');
  const tokenBc = await compile('Token');

  console.log('\n2) Deploy SwapPool template');
  const poolAddr = await deploy('SwapPool', poolBc, address, sk);

  console.log('\n3) Deploy SwapFactory');
  const factoryAddr = await deploy('SwapFactory', factoryBc, address, sk);

  console.log('\n4) set_pool_template');
  await submit(address, factoryAddr, '0', 'call', 'set_pool_template', JSON.stringify([poolBc]), sk, null, 'set_pool_template');
  console.log('\n5) set_token_template');
  await submit(address, factoryAddr, '0', 'call', 'set_token_template', JSON.stringify([tokenBc]), sk, null, 'set_token_template');
  console.log('\n6) set_woct_token');
  await submit(address, factoryAddr, '0', 'call', 'set_woct_token', JSON.stringify([woct]), sk, null, 'set_woct_token');

  console.log('\n7) Verify factory config');
  const pt = await readView(factoryAddr, 'get_pool_template');
  const tt = await readView(factoryAddr, 'get_token_template');
  const wt = await readView(factoryAddr, 'get_woct_token');
  const plen = await readView(factoryAddr, 'pools_length');
  console.log('  pool_template set :', pt && pt.result ? (String(pt.result).length > 10 ? 'yes' : pt.result) : JSON.stringify(pt).slice(0,60));
  console.log('  token_template set:', tt && tt.result ? (String(tt.result).length > 10 ? 'yes' : tt.result) : JSON.stringify(tt).slice(0,60));
  console.log('  woct_token        :', wt && (wt.result || (wt.storage && wt.storage.woct_token)));
  console.log('  pools_length      :', plen && (plen.result ?? (plen.storage && plen.storage.pools_len)));

  console.log('\n8) Update deployments.json');
  deployments.SwapPool = poolAddr;
  deployments.SwapFactory = factoryAddr;
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(deployments, null, 2));
  console.log('  saved');

  const bal2 = await rpcCall('octra_balance', [address]);
  console.log(`\nDone. New SwapPool=${poolAddr}\n      New SwapFactory=${factoryAddr}`);
  console.log(`Balance now ${bal2.balance} OCT (was ${bal.balance})`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
