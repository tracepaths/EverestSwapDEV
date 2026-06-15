const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');

const RPC_URL = 'https://devnet.octrascan.io/rpc';
const MNEMONIC = 'pumpkin divert spend later token student spot faint collect visual carbon matter';
const FEE_OU = '100000';

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

async function main() {
  console.log('=== EverestSwap Liquidity Setup ===\n');

  // Derive deployer key
  const seed64 = mnemonicToSeed(MNEMONIC);
  const hdSeed32 = deriveHdSeed(seed64);
  const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
  const deployerAddr = deriveAddress(Buffer.from(keypair.publicKey));
  console.log(`Deployer: ${deployerAddr}`);

  const balanceInfo = await rpcCall('octra_balance', [deployerAddr]);
  console.log(`Balance: ${balanceInfo.balance} OCT (nonce: ${balanceInfo.nonce})`);

  const OES = 'oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD';
  const OCT_PLACEHOLDER = 'oct00000000000000000000000000000000000000000000';

  // Step 1: Compile new SwapPool
  console.log('\n=== Compiling SwapPool ===');
  const swapPoolSource = fs.readFileSync('/home/dev/everestswap/contracts/SwapPool.aml', 'utf-8');
  const compileResult = await rpcCall('octra_compileAml', [swapPoolSource]);
  console.log(`Size: ${compileResult.size}B, ${compileResult.instructions} instr`);

  // Step 2: Compute address
  const nonce = balanceInfo.nonce;
  const deployNonce = nonce + 1;
  const addrResult = await rpcCall('octra_computeContractAddress', [compileResult.bytecode, deployerAddr, deployNonce]);
  const newPoolAddr = addrResult.address;
  console.log(`New SwapPool address: ${newPoolAddr}`);

  // Step 3: Deploy new SwapPool
  console.log('\n=== Deploying SwapPool ===');
  const deployTx = {
    from: deployerAddr, to_: newPoolAddr, amount: '0',
    nonce: deployNonce, ou: FEE_OU,
    timestamp: Date.now() / 1000,
    op_type: 'deploy', encrypted_data: compileResult.bytecode
  };
  signTx(deployTx, keypair.secretKey);
  const deployResult = await rpcCall('octra_submit', [deployTx]);
  console.log(`Tx: ${deployResult.tx_hash}`);
  const deployReceipt = await waitReceipt(deployResult.tx_hash);
  if (!deployReceipt.success) {
    console.log(`Deploy failed: ${deployReceipt.error}`);
    process.exit(1);
  }
  console.log('✅ SwapPool deployed!');

  // Update deployments.json
  const deploymentsPath = '/home/dev/everestswap/deployments.json';
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf-8'));
  deployments.SwapPool = newPoolAddr;
  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log(`Updated deployments.json`);

  // Step 4: Call set_tokens on pool
  console.log('\n=== Setting tokens on pool ===');
  let currentNonce = deployNonce + 1;
  const setTokensTx = {
    from: deployerAddr, to_: newPoolAddr, amount: '0',
    nonce: currentNonce, ou: FEE_OU,
    timestamp: Date.now() / 1000,
    op_type: 'call',
    encrypted_data: 'set_tokens',
    message: JSON.stringify([OCT_PLACEHOLDER, OES])
  };
  signTx(setTokensTx, keypair.secretKey);
  const setTokensResult = await rpcCall('octra_submit', [setTokensTx]);
  console.log(`Tx: ${setTokensResult.tx_hash}`);
  const setTokensReceipt = await waitReceipt(setTokensResult.tx_hash);
  if (!setTokensReceipt.success) {
    console.log(`set_tokens failed: ${setTokensReceipt.error}`);
    process.exit(1);
  }
  console.log('✅ Tokens set!');

  // Step 5: Transfer OES to pool
  console.log('\n=== Transferring OES to pool ===');
  currentNonce++;
  // Transfer 200000 OES (200000 * 10^6 = 200000000000)
  const oesAmount = '200000000000';
  const transferOesTx = {
    from: deployerAddr, to_: OES, amount: '0',
    nonce: currentNonce, ou: FEE_OU,
    timestamp: Date.now() / 1000,
    op_type: 'call',
    encrypted_data: 'transfer',
    message: JSON.stringify([newPoolAddr, parseInt(oesAmount)])
  };
  signTx(transferOesTx, keypair.secretKey);
  const transferResult = await rpcCall('octra_submit', [transferOesTx]);
  console.log(`Tx: ${transferResult.tx_hash}`);
  const transferReceipt = await waitReceipt(transferResult.tx_hash);
  if (!transferReceipt.success) {
    console.log(`OES transfer failed: ${transferReceipt.error}`);
    process.exit(1);
  }
  console.log('✅ OES transferred to pool!');

  // Verify OES balance of pool
  const poolOesBal = await rpcCall('contract_call', [OES, 'balance_of', [newPoolAddr], deployerAddr]);
  console.log(`Pool OES balance: ${poolOesBal.result}`);

  // Step 6: Init pool with OCT + OES liquidity
  console.log('\n=== Initializing pool with liquidity ===');
  currentNonce++;
  // 10 OCT = 10000000 ou, 200000 OES = 200000000000 units
  const octAmount = '10000000';
  const initTx = {
    from: deployerAddr, to_: newPoolAddr, amount: octAmount,
    nonce: currentNonce, ou: FEE_OU,
    timestamp: Date.now() / 1000,
    op_type: 'call',
    encrypted_data: 'init',
    message: JSON.stringify([parseInt(octAmount), parseInt(oesAmount), deployerAddr])
  };
  signTx(initTx, keypair.secretKey);
  const initResult = await rpcCall('octra_submit', [initTx]);
  console.log(`Tx: ${initResult.tx_hash}`);
  const initReceipt = await waitReceipt(initResult.tx_hash);
  if (!initReceipt.success) {
    console.log(`init failed: ${initReceipt.error}`);
    process.exit(1);
  }
  console.log('✅ Pool initialized!');

  // Verify pool state
  const reserves = await rpcCall('contract_call', [newPoolAddr, 'get_reserves', [], deployerAddr]);
  console.log(`Reserves: ${reserves.result}`);

  const poolInfo = await rpcCall('contract_call', [newPoolAddr, 'get_pool_info', [], deployerAddr]);
  console.log(`Pool info:`, poolInfo.storage || poolInfo.result);

  console.log('\n=== Liquidity setup complete! ===');
  console.log(`Pool: ${newPoolAddr}`);
  console.log(`OES: ${OES}`);
  console.log(`Initial: ${octAmount} OCT / ${oesAmount} OES`);
}

main().catch(err => { console.error('\nFailed:', err); process.exit(1); });
