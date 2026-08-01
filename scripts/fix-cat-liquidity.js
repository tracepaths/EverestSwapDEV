#!/usr/bin/env node

const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default;

const RPC_URL = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) { console.error('ERROR: MNEMONIC env var not set'); process.exit(1); }

const DEPLOYER_ADDR = 'octDLQFPawcje9rSTXxbaf8mihhMBb5QfXUpwthxmrH1Yia';
const CAT = 'octEw9XG14HA5f15mKLr3PYFbXyqMTLgDninhxrZUtyPvPe';
const POOL = 'octEuicdod5B7kfZa6JQsvEpu3yyTpKh9P6vhNRLotPyMz7';
const WOCT = 'oct4g33tzC2cJncL5RFr9TRiyk8yCNP1h2xaogiWJS5opNv';

const POS1_WOCT = '700000';
const POS1_CAT = '700000000';
const POS2_WOCT = '300000';
const POS2_CAT = '300000000';

function getDeployer(mnemonic) {
  const seed64 = crypto.pbkdf2Sync(mnemonic, 'mnemonic', 2048, 64, 'sha512');
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(seed64));
  const hdSeed32 = hmac.digest().slice(0, 32);
  const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
  const hash = crypto.createHash('sha256').update(Buffer.from(keypair.publicKey)).digest();
  let b58 = bs58.encode(hash);
  while (b58.length < 44) b58 = '1' + b58;
  return { keypair, address: 'oct' + b58 };
}

function jsonEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function signTx(tx, secretKey) {
  let s = `{"from":"${jsonEscape(tx.from)}","to_":"${jsonEscape(tx.to_)}","amount":"${jsonEscape(tx.amount)}","nonce":${tx.nonce},"ou":"${jsonEscape(tx.ou)}","timestamp":${tx.timestamp},"op_type":"${jsonEscape(tx.op_type)}"`;
  if (tx.encrypted_data) s += `,"encrypted_data":"${jsonEscape(tx.encrypted_data)}"`;
  if (tx.message) s += `,"message":"${jsonEscape(tx.message)}"`;
  s += '}';
  tx.signature = Buffer.from(nacl.sign.detached(Buffer.from(s, 'utf-8'), secretKey)).toString('base64');
  tx.public_key = Buffer.from(secretKey.slice(32, 64)).toString('base64');
}

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

async function waitReceipt(txHash, maxWait = 120) {
  for (let i = 0; i < maxWait; i++) {
    try {
      const r = await rpc('contract_receipt', [txHash]);
      if (r && (r.success === true || r.status === 'success' || r.status === 'ok')) return r;
      if (r && (r.success === false || r.status === 'failed' || r.status === 'reverted'))
        throw new Error('TX failed: ' + (r.error || JSON.stringify(r)));
    } catch(e) { if (e.message.startsWith('TX failed')) throw e; }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Timeout waiting for receipt');
}

const feeCache = {};
async function getFeeOu(opType) {
  if (feeCache[opType]) return feeCache[opType];
  try {
    const fee = await rpc('octra_recommendedFee', [opType]);
    const ou = String(fee.recommended || fee.minimum || '1000');
    feeCache[opType] = ou;
    return ou;
  } catch {
    return opType === 'deploy' ? '200000' : '1000';
  }
}

async function submitAndWait(deployer, nonceRef, to, amount, method, params, label) {
  nonceRef.value++;
  const ts = Date.now() / 1000;
  const tx = {
    from: deployer.address, to_: to, amount: amount || '0',
    nonce: nonceRef.value, ou: await getFeeOu('call'), timestamp: ts, op_type: 'call',
    encrypted_data: method, message: JSON.stringify(params)
  };
  signTx(tx, deployer.keypair.secretKey);
  const result = await rpc('octra_submit', [tx]);
  console.log(`  Tx: ${result.tx_hash}`);
  const receipt = await waitReceipt(result.tx_hash);
  console.log(`  OK (${label}, effort: ${receipt.effort})`);
  return receipt;
}

async function syncNonce(address, nonceRef) {
  try {
    const bal = await rpc('octra_balance', [address]);
    nonceRef.value = bal.nonce;
  } catch {}
}

async function submitAndWaitRetry(deployer, nonceRef, to, amount, method, params, label, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await submitAndWait(deployer, nonceRef, to, amount, method, params, label);
    } catch (e) {
      if (attempt < maxRetries) {
        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 8000);
        console.log(`  Retry ${attempt}/${maxRetries} for ${label} after ${delay}ms: ${e.message.slice(0, 80)}`);
        await new Promise(r => setTimeout(r, delay));
        await syncNonce(deployer.address, nonceRef);
      } else {
        console.log(`  FAILED ${label} after ${maxRetries} attempts: ${e.message.slice(0, 120)}`);
        return null;
      }
    }
  }
}

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   CAT Pool Liquidity Fix             ║');
  console.log('╚══════════════════════════════════════╝\n');

  const deployer = getDeployer(MNEMONIC);
  if (deployer.address !== DEPLOYER_ADDR) {
    throw new Error(`Deployer mismatch: ${deployer.address} != ${DEPLOYER_ADDR}`);
  }

  const bal = await rpc('octra_balance', [deployer.address]);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${bal.balance} OCT (nonce ${bal.nonce})\n`);
  const nonceRef = { value: bal.nonce };

  const woctBal = await rpc('contract_call', [WOCT, 'balance_of', [deployer.address]]);
  const catBal = await rpc('contract_call', [CAT, 'balance_of', [deployer.address]]);
  console.log(`WOCT balance: ${woctBal.result}`);
  console.log(`CAT balance:  ${catBal.result}\n`);

  console.log('[1] Granting allowances (position 1 + position 2)...');
  await submitAndWaitRetry(deployer, nonceRef, WOCT, '0', 'grant', [POOL, 1000000], 'grant_woct');
  await new Promise(r => setTimeout(r, 800));
  await submitAndWaitRetry(deployer, nonceRef, CAT, '0', 'grant', [POOL, '1000000000'], 'grant_cat');
  await new Promise(r => setTimeout(r, 800));

  console.log('\n[2] Adding liquidity position 1 (70%: 0.7 WOCT : 700 CAT)...');
  const epochInfo = await rpc('epoch_current', []);
  const deadline = epochInfo.epoch_id + 300;
  let pos1 = null;
  const r1 = await submitAndWaitRetry(deployer, nonceRef, POOL, '0', 'add_liquidity',
    [POS1_WOCT, POS1_CAT, '0', String(deadline), '0'], 'add_liquidity_pos1');
  if (r1 && r1.events) {
    for (const ev of r1.events) {
      if (ev.event === 'PositionAdded') {
        pos1 = ev.values[0];
        console.log(`  Position 1 ID: ${pos1}, LP: ${ev.values[2]}`);
      }
    }
  }
  await new Promise(r => setTimeout(r, 800));

  console.log('\n[3] Adding liquidity position 2 (30%: 0.3 WOCT : 300 CAT)...');
  const epochInfo2 = await rpc('epoch_current', []);
  const deadline2 = epochInfo2.epoch_id + 300;
  let pos2 = null;
  const r2 = await submitAndWaitRetry(deployer, nonceRef, POOL, '0', 'add_liquidity',
    [POS2_WOCT, POS2_CAT, '0', String(deadline2), '0'], 'add_liquidity_pos2');
  if (r2 && r2.events) {
    for (const ev of r2.events) {
      if (ev.event === 'PositionAdded') {
        pos2 = ev.values[0];
        console.log(`  Position 2 ID: ${pos2}, LP: ${ev.values[2]}`);
      }
    }
  }
  await new Promise(r => setTimeout(r, 800));

  console.log('\n[4] Removing 30% position (partial removal)...');
  const epochInfo3 = await rpc('epoch_current', []);
  const deadline3 = epochInfo3.epoch_id + 300;
  if (pos2) {
    await submitAndWaitRetry(deployer, nonceRef, POOL, '0', 'remove_liquidity',
      [pos2, '0', '0', String(deadline3)], 'remove_liquidity_pos2');
  } else {
    console.log('  Position 2 ID not found, using head position...');
    const head = await rpc('contract_call', [POOL, 'user_head_position', [deployer.address]]);
    if (parseInt(head.result) > 0) {
      await submitAndWaitRetry(deployer, nonceRef, POOL, '0', 'remove_liquidity',
        [parseInt(head.result), '0', '0', String(deadline3)], 'remove_liquidity');
    }
  }

  console.log('\n[5] Verifying final pool state...');
  const poolInfo = await rpc('contract_call', [POOL, 'get_pool_info', []]);
  console.log(`  Pool info: ${JSON.stringify(poolInfo.storage || poolInfo).slice(0, 400)}`);

  console.log('\nDone.');
}

main().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
