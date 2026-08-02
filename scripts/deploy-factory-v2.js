const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

const RPC_URL = 'https://devnet.octrascan.io/rpc';
const DEPLOYMENTS_PATH = path.join(__dirname, '..', 'deployments.json');
const POOL_FACTORY_ADDR = '';

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

async function compile(contractName) {
  const filePath = path.join(__dirname, '..', 'contracts', `${contractName}.aml`);
  const src = fs.readFileSync(filePath, 'utf-8');
  const result = await rpcCall('octra_compileAml', [src]);
  console.log(`  ${contractName}: ${result.size}B, ${result.instructions} instr`);
  return result;
}

async function deployContract(name, bytecode, deployerAddr, nonce, secretKey) {
  const ou = await getRecommendedFee('deploy');
  console.log(`  Fee: ${ou}`);
  const addrResult = await rpcCall('octra_computeContractAddress', [bytecode, deployerAddr, nonce]);
  const addr = addrResult.address;
  console.log(`  Address: ${addr}`);
  const ts = Date.now() / 1000;
  await submitTx(deployerAddr, addr, '0', nonce, ou, ts, 'deploy', bytecode, null, secretKey);
  return addr;
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

function loadDeployments() {
  return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf-8'));
}

function saveDeployments(addresses) {
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(addresses, null, 2));
  console.log(`  Saved → ${DEPLOYMENTS_PATH}`);
}

async function main() {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    console.error('Usage: MNEMONIC="your mnemonic phrase" node scripts/deploy-factory-v2.js');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  V11 — Factory-First Deploy (SwapPool + SwapFactory)   ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const { keypair, address: deployerAddr } = getAddress(mnemonic);
  const deployments = loadDeployments();
  const bal = await rpcCall('octra_balance', [deployerAddr]);
  let nonce = bal.nonce;

  console.log(`Deployer: ${deployerAddr} | Balance: ${bal.balance} OCT | Nonce: ${nonce}\n`);

  const woctAddr = deployments.WOCT;

  // ===================================================================
  // STEP 1 — Compile all contracts
  // ===================================================================
  console.log('=== Compiling Contracts ===');
  const poolBytecode = (await compile('SwapPool')).bytecode;
  const factoryBytecode = (await compile('SwapFactory')).bytecode;
  const tokenBytecode = (await compile('Token')).bytecode;

  // ===================================================================
  // STEP 2 — Deploy New SwapPool
  // ===================================================================
  console.log('\n=== Deploying New SwapPool (V11) ===');
  nonce++;
  const newPoolAddr = await deployContract('SwapPool', poolBytecode, deployerAddr, nonce, keypair.secretKey);

  // ===================================================================
  // STEP 3 — Deploy New SwapFactory (with SwapPool as template)
  // ===================================================================
  console.log('\n=== Deploying New SwapFactory (V11) ===');
  nonce++;
  const newFactoryAddr = await deployContract('SwapFactory', factoryBytecode, deployerAddr, nonce, keypair.secretKey);

  // ===================================================================
  // STEP 4 — Set pool_template (SwapPool bytecode), token_template, woct_token
  // ===================================================================
  console.log('\n=== Setting Templates ===');
  nonce++;
  await callMethod(newFactoryAddr, 'set_pool_template', [poolBytecode], null, deployerAddr, nonce, keypair.secretKey);

  // Check factory state
  let check = await rpcCall('contract_call', [newFactoryAddr, 'get_pool_template', [], deployerAddr]);
  let templateStr = check.result;
  if (templateStr === '' || templateStr === '0') {
    // Might return empty — try reading raw storage
    const raw = await rpcCall('contract_call', [newFactoryAddr, 'get_pool_template', [], deployerAddr]);
    templateStr = raw.result;
  }
  console.log(`  pool_template set: ${templateStr ? 'yes' : 'FAILED'}`);

  nonce++;
  await callMethod(newFactoryAddr, 'set_token_template', [tokenBytecode], null, deployerAddr, nonce, keypair.secretKey);

  check = await rpcCall('contract_call', [newFactoryAddr, 'get_token_template', [], deployerAddr]);
  console.log(`  token_template set: ${check.result ? 'yes' : 'FAILED'}`);

  nonce++;
  await callMethod(newFactoryAddr, 'set_woct_token', [woctAddr], null, deployerAddr, nonce, keypair.secretKey);

  check = await rpcCall('contract_call', [newFactoryAddr, 'get_woct_token', [], deployerAddr]);
  console.log(`  woct_token: ${check.result}`);

  // ===================================================================
  // STEP 5 — Re-register existing pools on the new factory
  // ===================================================================
  console.log('\n=== Re-registering Existing Pools ===');
  const poolAddrs = [deployments.SwapPool, deployments.CAT_Pool].filter(Boolean);
  if (poolAddrs.length > 0) {
    for (const poolAddr of poolAddrs) {
      console.log(`  Pool: ${poolAddr}`);
      // Read token_a and token_b from the old pool
      const tokenA = await rpcCall('contract_call', [poolAddr, 'get_token_a', [], deployerAddr]);
      const tokenB = await rpcCall('contract_call', [poolAddr, 'get_token_b', [], deployerAddr]);
      console.log(`    token_a: ${tokenA.result}, token_b: ${tokenB.result}`);
      nonce++;
      await callMethod(newFactoryAddr, 'register_pool', [tokenA.result, tokenB.result, poolAddr], null, deployerAddr, nonce, keypair.secretKey);
      console.log(`    ✅ Registered`);
    }
  } else {
    console.log('  No existing pools to re-register');
  }

  // Add trusted tokens
  console.log('\n=== Adding Trusted Tokens ===');
  const trustedTokens = [woctAddr, deployments.OES].filter(Boolean);
  for (const token of trustedTokens) {
    nonce++;
    await callMethod(newFactoryAddr, 'add_trusted_token', [token], null, deployerAddr, nonce, keypair.secretKey);
    console.log(`  Trusted: ${token}`);
  }

  // ===================================================================
  // STEP 6 — Update deployments.json
  // ===================================================================
  console.log('\n=== Updating deployments.json ===');
  deployments.SwapPool = newPoolAddr;
  deployments.SwapFactory = newFactoryAddr;
  saveDeployments(deployments);

  // ===================================================================
  // STEP 7 — Verify
  // ===================================================================
  console.log('\n=== Verifying ===');
  const poolCount = await rpcCall('contract_call', [newFactoryAddr, 'pools_length', [], deployerAddr]);
  console.log(`  Pools: ${poolCount.result}`);

  const spawnCount = await rpcCall('contract_call', [newFactoryAddr, 'get_spawn_count', [], deployerAddr]);
  console.log(`  Spawn count: ${spawnCount.result}`);

  const finalBal = await rpcCall('octra_balance', [deployerAddr]);
  console.log(`\nFinal balance: ${finalBal.balance} OCT (nonce: ${finalBal.nonce})`);
  console.log(`\n✅ V11 deploy complete!`);
  console.log(`  SwapPool:    ${newPoolAddr}`);
  console.log(`  SwapFactory: ${newFactoryAddr}`);
}

main().catch(err => { console.error('\nFailed:', err); process.exit(1); });
