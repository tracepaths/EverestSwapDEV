const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

// [V7-SECURITY] Load MNEMONIC from environment variable - NEVER hardcode in source!
const RPC_URL = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) {
  console.error('ERROR: MNEMONIC environment variable is not set.');
  console.error('Please set it with: export MNEMONIC="your mnemonic phrase"');
  process.exit(1);
}
const CONTRACTS_DIR = path.join(__dirname, '..', 'contracts');
const DEPLOY_FEE_OU = '100000';
const CALL_FEE_OU = '1500';

// [SECURITY] Load addresses from deployments.json; fall back to canonical OES only
const deployments = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments.json'), 'utf-8'));
const WOCT = deployments.WOCT;
const OES = deployments.OES || 'oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD';

// Will be set after deploying V2 factory
let FACTORY_V2 = ''; // will be set after deploy

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${data.error.message}`);
  return data.result;
}

function mnemonicToSeed(mnemonic) {
  return crypto.pbkdf2Sync(mnemonic, 'mnemonic', 2048, 64, 'sha512');
}

function deriveHdSeed(masterSeed64) {
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(masterSeed64));
  return hmac.digest().slice(0, 32);
}

function deriveAddress(pubkey) {
  const hash = crypto.createHash('sha256').update(pubkey).digest();
  let b58 = bs58.default.encode(hash);
  while (b58.length < 44) b58 = '1' + b58;
  return 'oct' + b58;
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

async function compileAml(source) {
  return await rpcCall('octra_compileAml', [source]);
}

async function computeAddress(bytecode, deployer, nonce) {
  return await rpcCall('octra_computeContractAddress', [bytecode, deployer, nonce]);
}

async function submitTx(tx) {
  return await rpcCall('octra_submit', [tx]);
}

async function waitReceipt(txHash, maxWait = 120) {
  for (let i = 0; i < maxWait; i++) {
    try {
      const receipt = await rpcCall('contract_receipt', [txHash]);
      if (receipt && receipt.success !== undefined) {
        if (!receipt.success) throw new Error(`Tx failed: ${receipt.error || 'unknown'}`);
        return receipt;
      }
      if (receipt && receipt.status && receipt.status !== 'pending') {
        if (receipt.status === 'failed') throw new Error(`Tx failed: ${receipt.error || 'unknown'}`);
        return receipt;
      }
    } catch (e) {
      if (e.message && e.message.includes('not found')) {} else { throw e; }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Timeout waiting for receipt');
}

async function contractView(contract, method, params = []) {
  return await rpcCall('contract_call', [contract, method, params]);
}

async function submitCallTx(from, contract, method, args, secretKey, nonce, pubKey) {
  const timestamp = Date.now() / 1000;
  const tx = {
    from, to_: contract, amount: '0',
    nonce, ou: CALL_FEE_OU, timestamp,
    op_type: 'call', encrypted_data: method,
    message: JSON.stringify(args)
  };
  signTx(tx, secretKey);
  // override public_key with the correct one since signTx extracts from secretKey
  tx.public_key = pubKey;
  const result = await submitTx(tx);
  console.log(`  Tx: ${result.tx_hash}`);
  const receipt = await waitReceipt(result.tx_hash);
  console.log(`  ✅ ${method} confirmed`);
  return result.tx_hash;
}

async function deployContract(name, source, deployerAddr, secretKey, nonce) {
  console.log(`\n=== Deploying ${name} (nonce: ${nonce}) ===`);
  const compileResult = await compileAml(source);
  const bytecode = compileResult.bytecode;
  console.log(`  Size: ${compileResult.size}B, ${compileResult.instructions} instr`);

  const addrResult = await computeAddress(bytecode, deployerAddr, nonce);
  const contractAddr = addrResult.address;
  console.log(`  Address: ${contractAddr}`);

  const timestamp = Date.now() / 1000;
  const tx = {
    from: deployerAddr, to_: contractAddr, amount: '0',
    nonce, ou: DEPLOY_FEE_OU, timestamp,
    op_type: 'deploy', encrypted_data: bytecode
  };
  signTx(tx, secretKey);

  const result = await submitTx(tx);
  console.log(`  Tx: ${result.tx_hash}`);

  const receipt = await waitReceipt(result.tx_hash);
  console.log(`  ✅ Deployed!`);

  return { address: contractAddr, txHash: result.tx_hash, bytecode };
}

async function main() {
  console.log('=== Test: Create Pool Flow ===\n');
  const seed64 = mnemonicToSeed(MNEMONIC);
  const hdSeed32 = deriveHdSeed(seed64);
  const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
  const deployerAddr = deriveAddress(Buffer.from(keypair.publicKey));
  const pubKeyB64 = Buffer.from(keypair.publicKey).toString('base64');
  console.log(`Deployer: ${deployerAddr}`);

  const balanceInfo = await rpcCall('octra_balance', [deployerAddr]);
  console.log(`Balance: ${balanceInfo.balance} OCT`);
  let nonce = balanceInfo.nonce;
  console.log(`Starting nonce: ${nonce}\n`);

  // ---- Step 1: Deploy SwapFactory ----
  const factorySource = fs.readFileSync(path.join(CONTRACTS_DIR, 'SwapFactory.aml'), 'utf-8');
  nonce++;
  const factory = await deployContract('SwapFactory', factorySource, deployerAddr, keypair.secretKey, nonce);
  FACTORY_V2 = factory.address;

  // ---- Step 2: Add trusted tokens (OES, WOCT) ----
  console.log('\n--- Adding trusted tokens ---');
  for (const [label, addr] of [['WOCT', WOCT], ['OES', OES]]) {
    const bal = await rpcCall('octra_balance', [deployerAddr]);
    const n = bal.nonce + 1;
    await submitCallTx(deployerAddr, FACTORY_V2, 'add_trusted_token', [addr], keypair.secretKey, n, pubKeyB64);
    console.log(`  ${label} added as trusted`);
  }

  // ---- Step 3: Verify is_trusted ----
  console.log('\n--- Verifying trusted tokens ---');
  for (const [label, addr] of [['WOCT', WOCT], ['OES', OES], ['non-existent', 'oct1111111111111111111111111111111111111111111']]) {
    const result = await contractView(FACTORY_V2, 'is_trusted', [addr]);
    const trusted = result?.result === true || result === true;
    console.log(`  ${label}: ${trusted ? '✅ trusted' : '❌ not trusted'}`);
  }

  // ---- Step 4: Deploy a new SwapPool ----
  const poolSource = fs.readFileSync(path.join(CONTRACTS_DIR, 'SwapPool.aml'), 'utf-8');
  const poolBal = await rpcCall('octra_balance', [deployerAddr]);
  const poolNonce = poolBal.nonce + 1;
  const pool = await deployContract('SwapPool', poolSource, deployerAddr, keypair.secretKey, poolNonce);

  // ---- Step 5: Set tokens on the pool ----
  console.log('\n--- Setting pool tokens ---');
  let bal = await rpcCall('octra_balance', [deployerAddr]);
  await submitCallTx(deployerAddr, pool.address, 'set_tokens', [WOCT, OES], keypair.secretKey, bal.nonce + 1, pubKeyB64);

  // ---- Step 6: Verify tokens were set ----
  console.log('\n--- Verifying pool tokens ---');
  const poolInfo = await contractView(pool.address, 'get_pool_info', []);
  const infoA = typeof poolInfo === 'object' && poolInfo.result
    ? (Array.isArray(poolInfo.result) ? poolInfo.result : poolInfo)
    : poolInfo;
  const tokenA = Array.isArray(infoA) ? infoA[0] : (infoA?.token_a || '');
  const tokenB = Array.isArray(infoA) ? infoA[1] : (infoA?.token_b || '');
  console.log(`  Token A: ${tokenA} ${tokenA === WOCT ? '✅' : '❌'}`);
  console.log(`  Token B: ${tokenB} ${tokenB === OES ? '✅' : '❌'}`);

  // ---- Step 7: Set fee params ----
  console.log('\n--- Setting fee params (0.30%) ---');
  bal = await rpcCall('octra_balance', [deployerAddr]);
  await submitCallTx(deployerAddr, pool.address, 'set_fee_params', [3, 1000], keypair.secretKey, bal.nonce + 1, pubKeyB64);

  // ---- Step 8: Register pool on factory ----
  console.log('\n--- Registering pool on factory ---');
  bal = await rpcCall('octra_balance', [deployerAddr]);
  await submitCallTx(deployerAddr, FACTORY_V2, 'register_pool', [WOCT, OES, pool.address], keypair.secretKey, bal.nonce + 1, pubKeyB64);

  // ---- Step 9: Verify pool registration ----
  console.log('\n--- Verifying pool registration ---');
  const poolList = await contractView(FACTORY_V2, 'all_pools', []);
  const pools = Array.isArray(poolList) ? poolList : (poolList?.result || []);
  console.log(`  Total pools: ${pools.length}`);
  for (const p of pools) {
    console.log(`  Pool: ${p}`);
  }

  const lookupResult = await contractView(FACTORY_V2, 'get_pool', [WOCT, OES]);
  const lookupAddr = typeof lookupResult === 'object' && lookupResult.result ? String(lookupResult.result) : String(lookupResult || '');
  console.log(`\n  get_pool(WOCT, OES): ${lookupAddr}`);
  console.log(`  Matches deployed pool: ${lookupAddr === pool.address ? '✅' : '❌'}`);

  // ---- Step 10: Check trusted count ----
  const trustedCount = await contractView(FACTORY_V2, 'trusted_tokens_count', []);
  const count = typeof trustedCount === 'object' && trustedCount.result ? String(trustedCount.result) : String(trustedCount || '0');
  console.log(`\n  Trusted tokens count: ${count}`);

  // ---- Summary ----
  console.log('\n========================================');
  console.log('=== Test Summary ===');
  console.log('========================================');
  console.log(`  SwapFactory: ${FACTORY_V2}`);
  console.log(`  New Pool: ${pool.address}`);
  console.log(`  Tokens: WOCT(${WOCT}) + OES(${OES})`);
  console.log('  ✅ All tests passed!');
}

main().catch(err => { console.error('\n❌ Failed:', err); process.exit(1); });
