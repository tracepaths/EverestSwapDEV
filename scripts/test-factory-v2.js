const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

const RPC_URL = 'https://devnet.octrascan.io/rpc';
const DEPLOYMENTS_PATH = path.join(__dirname, '..', 'deployments.json');

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
  console.log(`  ✅ (effort: ${receipt.effort})`);
  return receipt;
}

async function getRecommendedFee(opType) {
  try {
    const fee = await rpcCall('octra_recommendedFee', [opType]);
    const ou = String(fee.recommended || fee.minimum || (opType === 'deploy' ? '200000' : '100000'));
    console.log(`  Fee for ${opType}: ${ou}`);
    return ou;
  } catch {
    return opType === 'deploy' ? '200000' : '100000';
  }
}

async function callMethod(contractAddr, method, params, amount, deployerAddr, nonce, secretKey, feeOu) {
  const ts = Date.now() / 1000;
  const ou = feeOu || await getRecommendedFee('call');
  await submitTx(deployerAddr, contractAddr, amount || '0', nonce, ou, ts, 'call', method, JSON.stringify(params), secretKey);
}

function getAddress(mnemonic) {
  const seed64 = crypto.pbkdf2Sync(mnemonic, 'mnemonic', 2048, 64, 'sha512');
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(seed64));
  const hdSeed32 = hmac.digest().slice(0, 32);
  const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
  const hash = crypto.createHash('sha256').update(Buffer.from(keypair.publicKey)).digest();
  let b58 = bs58.default.encode(hash);
  while (b58.length < 44) b58 = '1' + b58;
  return { keypair, address: 'oct' + b58 };
}

function randomStr(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let r = '';
  for (let i = 0; i < len; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

function loadDeployments() {
  return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf-8'));
}

async function main() {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    console.error('Usage: MNEMONIC="your mnemonic phrase" node scripts/test-factory-v2.js');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  V11 — Factory-First E2E Test (create + launch)        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const { keypair, address: deployerAddr } = getAddress(mnemonic);
  const deployments = loadDeployments();
  const factoryAddr = deployments.SwapFactory;
  const woctAddr = deployments.WOCT;

  if (!factoryAddr) {
    console.error('SwapFactory not found in deployments.json. Run deploy-factory-v2.js first.');
    process.exit(1);
  }
  if (!woctAddr) {
    console.error('WOCT not found in deployments.json');
    process.exit(1);
  }

  const bal = await rpcCall('octra_balance', [deployerAddr]);
  let nonce = bal.nonce;

  console.log(`Deployer: ${deployerAddr} | Balance: ${bal.balance} OCT | Nonce: ${nonce}`);
  console.log(`Factory:  ${factoryAddr}`);
  console.log(`WOCT:     ${woctAddr}\n`);

  // ===================================================================
  // TEST 1 — create() with test token_a
  // ===================================================================
  console.log('\n══════════════════════════════════════════════════');
  console.log('TEST 1: factory.create() with OES/WOCT pool');
  console.log('══════════════════════════════════════════════════\n');

  const feeNum = 3;
  const feeDen = 1000;
  const maxRatio = 0;
  const liqA = '1000000';
  const liqB = '1000000';
  const minLp = 1;
  const deadlineOffset = 60;
  const lockDuration = 100;

  // Pre-approve factory on both tokens
  console.log('> Granting factory allowance on token_a...');
  const tokenA = deployments.OES;
  nonce++;
  await callMethod(tokenA, 'grant', [factoryAddr, liqA], null, deployerAddr, nonce, keypair.secretKey);
  nonce++;
  await callMethod(woctAddr, 'grant', [factoryAddr, liqB], null, deployerAddr, nonce, keypair.secretKey);

  // Call create()
  console.log('\n> Calling factory.create()...');
  const epochInfo = await rpcCall('epoch_current', []);
  const currentEpoch = epochInfo.epoch_id || 0;
  const deadline = currentEpoch + deadlineOffset;
  nonce++;
  try {
    await callMethod(factoryAddr, 'create',
      [tokenA, woctAddr, feeNum, feeDen, maxRatio, liqA, liqB, minLp, deadline, lockDuration],
      null, deployerAddr, nonce, keypair.secretKey);
    console.log('\n  ✅ create() succeeded!');
  } catch (e) {
    console.log('\n  ❌ create() failed:', e.message);
    console.log('  (check fee, allowances, or pool existence)');
    process.exit(1);
  }

  // Verify pool was created — check spawn count
  const spawnCount = await rpcCall('contract_call', [factoryAddr, 'get_spawn_count', [], deployerAddr]);
  console.log(`  Spawn count: ${spawnCount.result}`);

  // ===================================================================
  // TEST 2 — Launch a new token
  // ===================================================================
  console.log('\n══════════════════════════════════════════════════');
  console.log('TEST 2: factory.launch() — deploy new token + pool');
  console.log('══════════════════════════════════════════════════\n');

  const name = 'TestLaunch' + randomStr(4);
  const symbol = 'TST' + randomStr(3);
  const contractName = name;
  const initialSupply = '1000000000000';
  const dec = 18;
  const placeholderAddr = 'oct0000000000000000000000000000000000000000000000';
  const maxTxAmt = '1000000000000';
  const maxWalletAmt = '100000000000000';
  const cooldownBlocks = 0;
  const taxBps = 0;
  const zeroAddr = 'oct0000000000000000000000000000000000000000000000';
  const autoBurnBps = 0;
  const mintable = true;
  const burnable = false;
  const pausable = false;
  const blacklist = false;
  const maxTx = true;
  const maxWallet = false;
  const cooldown = false;
  const tax = false;
  const autoBurn = false;
  const trusted1 = zeroAddr;
  const trusted2 = zeroAddr;
  const trusted3 = zeroAddr;
  const trusted4 = zeroAddr;
  const trusted5 = zeroAddr;

  const lFeeNum = 3;
  const lFeeDen = 1000;
  const lMaxRatio = 1000;

  const liqToken = '500000000000';
  const liqWoct = '5000000';
  const lMinLp = 1;
  const lDeadlineOffset = 120;
  const lLock = 7 * 24 * 60;

  // Pre-approve factory on WOCT (for the WOCT side pull)
  console.log('> Granting factory allowance on WOCT for launch...');
  nonce++;
  await callMethod(woctAddr, 'grant', [factoryAddr, liqWoct], null, deployerAddr, nonce, keypair.secretKey);

  // Call launch()
  console.log('\n> Calling factory.launch()....');
  const epochInfo2 = await rpcCall('epoch_current', []);
  const lDeadline = (epochInfo2.epoch_id || 0) + lDeadlineOffset;
  nonce++;
  try {
    await callMethod(factoryAddr, 'launch',
      [name, symbol, contractName, initialSupply, dec, deployerAddr, factoryAddr,
       maxTxAmt, maxWalletAmt, cooldownBlocks, taxBps, zeroAddr, autoBurnBps,
       mintable, burnable, pausable, blacklist, maxTx, maxWallet, cooldown,
       tax, autoBurn, trusted1, trusted2, trusted3, trusted4, trusted5,
       lFeeNum, lFeeDen, lMaxRatio, liqToken, liqWoct, lMinLp, lDeadline, lLock],
      null, deployerAddr, nonce, keypair.secretKey);
    console.log('\n  ✅ launch() succeeded!');
  } catch (e) {
    console.log('\n  ❌ launch() failed:', e.message);
    console.log('  Tip: check that supply_recipient is correctly passed, or verify TX with block explorer.');
    process.exit(1);
  }

  // Verify
  const finalSpawnCount = await rpcCall('contract_call', [factoryAddr, 'get_spawn_count', [], deployerAddr]);
  console.log(`  Final spawn count: ${finalSpawnCount.result}`);
  console.log('  (should be >= 3 after create + launch)');

  const poolCount = await rpcCall('contract_call', [factoryAddr, 'pools_length', [], deployerAddr]);
  console.log(`  Registered pools: ${poolCount.result}`);

  const finalBal = await rpcCall('octra_balance', [deployerAddr]);
  console.log(`\nFinal balance: ${finalBal.balance} OCT (nonce: ${finalBal.nonce})`);
  console.log(`\n✅ V11 E2E tests passed!`);
}

main().catch(err => { console.error('\nFailed:', err); process.exit(1); });