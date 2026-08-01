#!/usr/bin/env node

const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default;
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) { console.error('ERROR: MNEMONIC env var not set'); process.exit(1); }

const DRY_RUN = process.argv.includes('--dry-run');
const DEPLOYER_ADDR = 'octDLQFPawcje9rSTXxbaf8mihhMBb5QfXUpwthxmrH1Yia';

const WOCT = 'oct4g33tzC2cJncL5RFr9TRiyk8yCNP1h2xaogiWJS5opNv';
const FACTORY = 'octJbkjXrAqvZdg2JZVZTyQqpYB52HYkBPDmGMmEQBMgSFE';
const ROUTER = 'octEtQJQDFC85tXtGpERHX69rNoo1GJA7EVUaLezANQxC8K';
const DEPLOYMENTS_PATH = path.join(__dirname, '..', 'deployments.json');

const LIQ_WOCT = '1000000';
const LIQ_CAT = '1000000000';
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

const feeCache = {};
async function getFeeOu(opType) {
  if (feeCache[opType]) return feeCache[opType];
  try {
    const fee = await rpc('octra_recommendedFee', [opType]);
    const ou = String(fee.recommended || fee.minimum || '100000');
    feeCache[opType] = ou;
    console.log(`  Fee for ${opType}: ${ou}`);
    return ou;
  } catch {
    return opType === 'deploy' ? '200000' : '1000';
  }
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

async function deployContract(deployer, nonceRef, name, bytecode, constructorArgs, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      nonceRef.value++;
      const addrResult = await rpc('octra_computeContractAddress', [bytecode, deployer.address, nonceRef.value]);
      const addr = addrResult.address;
      console.log(`  Address: ${addr}`);
      if (DRY_RUN) return addr;
      const ts = Date.now() / 1000;
      const tx = {
        from: deployer.address, to_: addr, amount: '0',
        nonce: nonceRef.value, ou: await getFeeOu('deploy'), timestamp: ts, op_type: 'deploy',
        encrypted_data: bytecode
      };
      if (constructorArgs) tx.message = constructorArgs;
      signTx(tx, deployer.keypair.secretKey);
      const result = await rpc('octra_submit', [tx]);
      console.log(`  Tx: ${result.tx_hash}`);
      const receipt = await waitReceipt(result.tx_hash);
      console.log(`  Deployed ${name} (effort: ${receipt.effort})`);
      return addr;
    } catch (e) {
      if (attempt < maxRetries) {
        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 8000);
        console.log(`  Retry ${attempt}/${maxRetries} for ${name} deploy after ${delay}ms: ${e.message.slice(0, 80)}`);
        await new Promise(r => setTimeout(r, delay));
        await syncNonce(deployer.address, nonceRef);
      } else {
        throw new Error(`Deploy ${name} failed: ${e.message}`);
      }
    }
  }
}

async function compile(name) {
  const filePath = path.join(__dirname, '..', 'contracts', `${name}.aml`);
  const src = fs.readFileSync(filePath, 'utf-8');
  const result = await rpc('octra_compileAml', [src]);
  console.log(`  ${name}: ${result.size}B, ${result.instructions} instr`);
  return result;
}

function loadDeployments() {
  try { return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf-8')); } catch { return {}; }
}

function saveDeployments(data) {
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`  Saved ${DEPLOYMENTS_PATH}`);
}

async function safeCallRetry(deployer, nonceRef, to, amount, method, params, label) {
  if (DRY_RUN) return;
  try {
    const result = await submitAndWaitRetry(deployer, nonceRef, to, amount, method, params, label);
    return result;
  } catch (e) {
    console.log(`  Skipped ${label}: ${e.message.slice(0, 100)}`);
    return null;
  }
}

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   CAT Token + Pool Deployment        ║');
  console.log('╚══════════════════════════════════════╝\n');

  const deployer = getDeployer(MNEMONIC);
  if (deployer.address !== DEPLOYER_ADDR) {
    throw new Error(`Deployer mismatch: ${deployer.address} != ${DEPLOYER_ADDR}`);
  }

  const bal = await rpc('octra_balance', [deployer.address]);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${bal.balance} OCT (nonce ${bal.nonce})\n`);
  const nonceRef = { value: bal.nonce };

  console.log('[1] Compiling contracts...');
  const tokenCompiled = await compile('Token');
  const poolCompiled = await compile('SwapPool');

  const supplyRaw = (BigInt(100000000000) * (BigInt(10) ** BigInt(6))).toString();
  console.log(`\n[2] Deploying CAT token (supply: ${supplyRaw} raw)...`);
  const catConstructorArgs = JSON.stringify([
    'CAT',
    'CAT',
    'CAT Token',
    supplyRaw,
    '6',
    deployer.address,
    deployer.address,
    '0',
    '0',
    '0',
    '0',
    deployer.address,
    '0',
    true,
    true,
    true,
    true,
    false,
    false,
    false,
    false,
    false,
    ROUTER,
    '',
    '',
    '',
    '',
  ]);
  const catAddr = await deployContract(deployer, nonceRef, 'CAT', tokenCompiled.bytecode, catConstructorArgs);
  await new Promise(r => setTimeout(r, 1000));

  console.log('\n[3] Deploying SwapPool...');
  const poolAddr = await deployContract(deployer, nonceRef, 'SwapPool', poolCompiled.bytecode);
  await new Promise(r => setTimeout(r, 1000));

  console.log('\n[4] Configuring pool...');
  await safeCallRetry(deployer, nonceRef, poolAddr, '0', 'set_tokens', [WOCT, catAddr], 'set_tokens');
  await new Promise(r => setTimeout(r, 1000));
  await safeCallRetry(deployer, nonceRef, poolAddr, '0', 'set_factory', [FACTORY], 'set_factory');
  await new Promise(r => setTimeout(r, 1000));
  await safeCallRetry(deployer, nonceRef, poolAddr, '0', 'set_max_initial_price_ratio', [1000], 'set_max_initial_price_ratio');
  await new Promise(r => setTimeout(r, 1000));

  console.log('\n[5] Trusting pool on CAT...');
  await safeCallRetry(deployer, nonceRef, catAddr, '0', 'set_trusted', [poolAddr, true], 'trust_pool');
  await new Promise(r => setTimeout(r, 500));
  await safeCallRetry(deployer, nonceRef, catAddr, '0', 'set_tax_exempt', [poolAddr, true], 'tax_exempt_pool');
  await new Promise(r => setTimeout(r, 1000));

  console.log('\n[6] Depositing 2 OCT → WOCT...');
  await safeCallRetry(deployer, nonceRef, WOCT, '2000000', 'deposit', [], 'deposit');
  await new Promise(r => setTimeout(r, 1000));

  console.log('\n[7] Granting tokens to pool...');
  await safeCallRetry(deployer, nonceRef, WOCT, '0', 'grant', [poolAddr, parseInt(LIQ_WOCT)], 'grant_woct');
  await new Promise(r => setTimeout(r, 1000));
  await safeCallRetry(deployer, nonceRef, catAddr, '0', 'grant', [poolAddr, LIQ_CAT], 'grant_cat');
  await new Promise(r => setTimeout(r, 1000));

  console.log('\n[8] Adding liquidity in 2 positions (1 WOCT : 1000 CAT, 70% + 30%)...');
  let pos1Id = null;
  let pos2Id = null;
  if (!DRY_RUN) {
    try {
      const epochInfo = await rpc('epoch_current', []);
      if (!epochInfo || typeof epochInfo.epoch_id !== 'number') {
        throw new Error('Could not fetch current epoch');
      }
      const deadline = epochInfo.epoch_id + 300;
      const liqResult1 = await submitAndWaitRetry(deployer, nonceRef, poolAddr, '0', 'add_liquidity',
        [POS1_WOCT, POS1_CAT, '0', String(deadline), '0'], 'add_liquidity_pos1');
      if (liqResult1 && liqResult1.events) {
        for (const ev of liqResult1.events) {
          if (ev.event === 'PositionAdded') {
            pos1Id = ev.values[0];
            console.log(`  Position 1 ID: ${pos1Id}, LP: ${ev.values[2]}`);
          }
        }
      }
      await new Promise(r => setTimeout(r, 1000));
      const epochInfo2 = await rpc('epoch_current', []);
      const deadline2 = epochInfo2.epoch_id + 300;
      const liqResult2 = await submitAndWaitRetry(deployer, nonceRef, poolAddr, '0', 'add_liquidity',
        [POS2_WOCT, POS2_CAT, '0', String(deadline2), '0'], 'add_liquidity_pos2');
      if (liqResult2 && liqResult2.events) {
        for (const ev of liqResult2.events) {
          if (ev.event === 'PositionAdded') {
            pos2Id = ev.values[0];
            console.log(`  Position 2 ID: ${pos2Id}, LP: ${ev.values[2]}`);
          }
        }
      }
    } catch(e) {
      console.log(`  Failed: ${e.message.slice(0, 100)}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n[9] Registering pool on factory...');
  await safeCallRetry(deployer, nonceRef, FACTORY, '0', 'register_pool',
    [WOCT, catAddr, poolAddr], 'register_pool');
  await new Promise(r => setTimeout(r, 1000));

  console.log('\n[10] Removing 30% position (partial removal)...');
  if (!DRY_RUN) {
    if (pos2Id) {
      try {
        const epochInfo = await rpc('epoch_current', []);
        const deadline = epochInfo.epoch_id + 300;
        await submitAndWaitRetry(deployer, nonceRef, poolAddr, '0', 'remove_liquidity',
          [pos2Id, '0', '0', String(deadline)], 'remove_liquidity_pos2');
        await new Promise(r => setTimeout(r, 1000));
      } catch(e) {
        console.log(`  Failed: ${e.message.slice(0, 100)}`);
      }
    } else {
      console.log('  Position 2 ID not found, keeping both positions (no removal)');
    }
  }

  console.log('\n[11] Saving addresses...');
  const deployments = loadDeployments();
  deployments.CAT = catAddr;
  deployments.CAT_Pool = poolAddr;
  saveDeployments(deployments);

  console.log('\n[12] Verifying...');
  if (!DRY_RUN) {
    try {
      const catName = await rpc('contract_call', [catAddr, 'get_name', []]);
      console.log(`  CAT name: ${catName.result}`);
      const catSymbol = await rpc('contract_call', [catAddr, 'get_symbol', []]);
      console.log(`  CAT symbol: ${catSymbol.result}`);
      const catSupply = await rpc('contract_call', [catAddr, 'get_total_supply', []]);
      console.log(`  CAT supply: ${catSupply.result}`);
      const catDecimals = await rpc('contract_call', [catAddr, 'decimals', []]);
      console.log(`  CAT decimals: ${catDecimals.result}`);
      const reserves = await rpc('contract_call', [poolAddr, 'get_reserves', []]);
      console.log(`  Pool reserves: ${reserves.result}`);
    } catch(e) {
      console.log(`  Verify skipped: ${e.message.slice(0, 80)}`);
    }
  }

  console.log('\n========================================');
  console.log('=== Deployment Summary ===');
  console.log('========================================');
  console.log(`  CAT:       ${catAddr}`);
  console.log(`  CAT_Pool:  ${poolAddr}`);
  console.log(`  WOCT:      ${WOCT}`);
  console.log(`  Factory:   ${FACTORY}`);
  console.log(`  Router:    ${ROUTER}`);
  console.log('\nDone.');
}

main().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
