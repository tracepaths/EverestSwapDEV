const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

const RPC_URL = 'https://devnet.octrascan.io/rpc';
const FEE_OU = '100000';
const DEPLOYMENTS_PATH = path.join(__dirname, '..', 'deployments.json');

// ── RPC Helpers ──────────────────────────────────────────────

async function rpcCall(method, params) {
  // [V7-FIX] Add 30s timeout to avoid hanging on RPC issues
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal
    });
    const data = await res.json();
    if (data.error) throw new Error('RPC error: ' + data.error.message);
    return data.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function contractView(addr, method, params = [], caller = '') {
  try {
    const result = await rpcCall('contract_call', [addr, method, params, caller || addr]);
    return result.result !== undefined ? result.result : result;
  } catch {
    return null;
  }
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

async function callMethod(contractAddr, method, params, amount, deployerAddr, nonce, secretKey) {
  const ts = Date.now() / 1000;
  await submitTx(deployerAddr, contractAddr, amount || '0', nonce, FEE_OU, ts, 'call', method, JSON.stringify(params), secretKey);
}

// ── Identity ─────────────────────────────────────────────────

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

// ── Contract Map ─────────────────────────────────────────────

const CONTRACT_MAP = {
  pool: 'SwapPool',
  factory: 'SwapFactory',
  router: 'Router',
  woct: 'WOCT',
  oes: 'OES',
};

const PAUSABLE = ['factory', 'router'];
const TWO_STEP_OWNERSHIP = ['pool', 'woct'];
const TWO_STEP_SETTER = ['factory'];

function resolveContract(name) {
  const key = name.toLowerCase();
  if (!CONTRACT_MAP[key]) {
    throw new Error(`Unknown contract: ${name}. Valid: ${Object.keys(CONTRACT_MAP).join(', ')}`);
  }
  const deployments = loadDeployments();
  const addr = deployments[CONTRACT_MAP[key]];
  if (!addr) throw new Error(`No address found for ${CONTRACT_MAP[key]} in deployments.json`);
  return { key, name: CONTRACT_MAP[key], address: addr };
}

function shortAddr(addr) {
  return addr ? `${addr.slice(0, 8)}...${addr.slice(-6)}` : 'N/A';
}

// ── Commands ─────────────────────────────────────────────────

async function cmdView() {
  const d = loadDeployments();
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║           EverestSwap Admin — View              ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // SwapPool
  if (d.SwapPool) {
    console.log(`SwapPool (${shortAddr(d.SwapPool)}):`);
    const poolInfo = await rpcCall('contract_call', [d.SwapPool, 'get_pool_info', [], d.SwapPool]);
    if (poolInfo && poolInfo.storage) {
      const s = poolInfo.storage;
      console.log(`  Owner: ${s.owner || 'N/A'}`);
      console.log(`  Pending Owner: ${s.pending_owner || 'N/A'}`);
      console.log(`  Active: ${s.active || 'N/A'}`);
      console.log(`  Fee: ${s.fee_numerator || '?'}/${s.fee_denominator || '?'} (${((Number(s.fee_numerator || 0) / Number(s.fee_denominator || 1)) * 100).toFixed(2)}%)`);
      console.log(`  Fee Reserve A: ${s.fee_reserve_a || '0'}`);
      console.log(`  Fee Reserve B: ${s.fee_reserve_b || '0'}`);
      console.log(`  Reserve A: ${s.reserve_a || '0'}`);
      console.log(`  Reserve B: ${s.reserve_b || '0'}`);
      console.log(`  Token A: ${s.token_a || 'N/A'}`);
      console.log(`  Token B: ${s.token_b || 'N/A'}`);
      console.log(`  Total LP: ${s.total_lp || '0'}`);
    }
    console.log('');
  }

  // SwapFactoryV2
  if (d.SwapFactory) {
    console.log(`SwapFactory (${shortAddr(d.SwapFactory)}):`);
    const feeTo = await contractView(d.SwapFactory, 'get_fee_to', []);
    const feeToSetter = await contractView(d.SwapFactory, 'get_fee_to_setter', []);
    console.log(`  Fee To: ${feeTo || 'N/A'}`);
    console.log(`  Fee To Setter: ${feeToSetter || 'N/A'}`);
    console.log('');
  }

  // Router
  if (d.Router) {
    console.log(`Router (${shortAddr(d.Router)}):`);
    const owner = await contractView(d.Router, 'get_owner', []);
    console.log(`  Owner: ${owner || 'N/A'}`);
    console.log('');
  }

  // WOCT
  if (d.WOCT) {
    console.log(`WOCT (${shortAddr(d.WOCT)}):`);
    const totalSupply = await contractView(d.WOCT, 'get_total_supply', []);
    const pendingOwner = await contractView(d.WOCT, 'get_pending_owner', []);
    console.log(`  Pending Owner: ${pendingOwner || 'N/A'}`);
    console.log(`  Total Supply: ${totalSupply || 'N/A'}`);
    console.log('');
  }

  // OES
  if (d.OES) {
    console.log(`OES (${shortAddr(d.OES)}):`);
    try {
      const rewardsInfo = await rpcCall('contract_call', [d.OES, 'get_rewards_info', [], d.OES]);
      if (rewardsInfo && rewardsInfo.storage) {
        const s = rewardsInfo.storage;
        console.log(`  Owner: ${s.owner || 'N/A'}`);
        console.log(`  Rewards Vault: ${s.rewards_vault || 'N/A'}`);
        console.log(`  Rewards Per Epoch: ${s.rewards_per_epoch || 'N/A'}`);
        console.log(`  Max Rewards Per Epoch: ${s.max_rewards_per_epoch || 'N/A'}`);
      }
    } catch {
      console.log(`  (Could not read state)`);
    }
    console.log('');
  }

  console.log('─'.repeat(50));
}

async function cmdSetFee(mnemonic, numStr, denomStr) {
  // [SECURITY] M-3: Strict integer parsing — reject decimals, non-digits
  if (!/^\d+$/.test(String(numStr).trim()) || !/^\d+$/.test(String(denomStr).trim())) {
    throw new Error('Fee must be positive integers (no decimals). Example: 3 1000 = 0.3%');
  }
  const num = parseInt(numStr, 10);
  const denom = parseInt(denomStr, 10);
  if (num <= 0 || denom <= 0) {
    throw new Error('Fee must be positive integers. Example: 3 1000 = 0.3%');
  }
  if (num >= denom) throw new Error('numerator must be less than denominator');
  // [SECURITY] M-3: Match the contract's 1% cap exactly to avoid silent override
  if (num * 1000 > denom * 10) throw new Error('Fee cannot exceed 1% (10/1000)');
  // [SECURITY] M-3: Enforce minimum floor (matches contract's 0.03% floor)
  if (num * 10000 < denom * 3) throw new Error('Fee too low (min 0.03%)');

  const d = loadDeployments();
  const { keypair, address } = getAddress(mnemonic);
  const bal = await rpcCall('octra_balance', [address]);
  let nonce = bal.nonce;

  console.log(`Setting fee to ${num}/${denom} (${(num / denom * 100).toFixed(2)}%)...`);
  nonce++;
  await callMethod(d.SwapPool, 'set_fee_params', [num, denom], null, address, nonce, keypair.secretKey);
  console.log(`Done. Fee is now ${num}/${denom}.`);
}

async function cmdClaimFees(mnemonic, recipient) {
  if (!recipient || !recipient.startsWith('oct')) {
    throw new Error('Invalid recipient address. Must start with "oct"');
  }

  const d = loadDeployments();
  const { keypair, address } = getAddress(mnemonic);
  const bal = await rpcCall('octra_balance', [address]);
  let nonce = bal.nonce;

  console.log(`Claiming fees to ${recipient}...`);
  nonce++;
  await callMethod(d.SwapPool, 'claim_fees', [recipient], null, address, nonce, keypair.secretKey);
  console.log('Done.');
}

async function cmdSetFeeTo(mnemonic, newFeeTo) {
  if (!newFeeTo || !newFeeTo.startsWith('oct')) {
    throw new Error('Invalid address. Must start with "oct"');
  }

  const d = loadDeployments();
  const { keypair, address } = getAddress(mnemonic);
  const bal = await rpcCall('octra_balance', [address]);
  let nonce = bal.nonce;

  console.log(`Setting fee_to to ${newFeeTo}...`);
  nonce++;
  await callMethod(d.SwapFactory, 'set_fee_to', [newFeeTo], null, address, nonce, keypair.secretKey);
  console.log('Done.');
}

async function cmdTransferOwnership(mnemonic, contractName, newOwner) {
  if (!newOwner || !newOwner.startsWith('oct')) {
    throw new Error('Invalid address. Must start with "oct"');
  }

  const { key, name, address } = resolveContract(contractName);
  const { keypair, address: deployerAddr } = getAddress(mnemonic);
  const bal = await rpcCall('octra_balance', [deployerAddr]);
  let nonce = bal.nonce;

  if (TWO_STEP_OWNERSHIP.includes(key)) {
    console.log(`Initiating ownership transfer for ${name} → ${newOwner}...`);
    nonce++;
    await callMethod(address, 'transfer_ownership', [newOwner], null, deployerAddr, nonce, keypair.secretKey);
    console.log(`Done. New owner must call: MNEMONIC="..." node admin.js accept-ownership ${contractName}`);
  } else if (TWO_STEP_SETTER.includes(key)) {
    console.log(`Initiating setter transfer for ${name} → ${newOwner}...`);
    nonce++;
    await callMethod(address, 'initiate_setter_transfer', [newOwner], null, deployerAddr, nonce, keypair.secretKey);
    console.log(`Done. New setter must call: MNEMONIC="..." node admin.js accept-ownership ${contractName}`);
  } else {
    console.log(`Transferring ownership of ${name} → ${newOwner}...`);
    nonce++;
    await callMethod(address, 'transfer_ownership', [newOwner], null, deployerAddr, nonce, keypair.secretKey);
    console.log('Done.');
  }
}

async function cmdAcceptOwnership(mnemonic, contractName) {
  const { key, name, address } = resolveContract(contractName);
  const { keypair, address: deployerAddr } = getAddress(mnemonic);
  const bal = await rpcCall('octra_balance', [deployerAddr]);
  let nonce = bal.nonce;

  if (TWO_STEP_OWNERSHIP.includes(key)) {
    console.log(`Accepting ownership of ${name}...`);
    nonce++;
    await callMethod(address, 'accept_ownership', [], null, deployerAddr, nonce, keypair.secretKey);
    console.log('Done.');
  } else if (TWO_STEP_SETTER.includes(key)) {
    console.log(`Accepting setter transfer for ${name}...`);
    nonce++;
    await callMethod(address, 'accept_setter_transfer', [], null, deployerAddr, nonce, keypair.secretKey);
    console.log('Done.');
  } else {
    throw new Error(`${name} uses one-step ownership transfer. Use "transfer-ownership" instead.`);
  }
}

async function cmdPause(mnemonic, contractName) {
  if (!PAUSABLE.includes(contractName.toLowerCase())) {
    throw new Error(`${contractName} is not pausable. Pausable: ${PAUSABLE.join(', ')}`);
  }

  const { name, address } = resolveContract(contractName);
  const { keypair, address: deployerAddr } = getAddress(mnemonic);
  const bal = await rpcCall('octra_balance', [deployerAddr]);
  let nonce = bal.nonce;

  const method = contractName.toLowerCase() === 'pool' ? 'set_active' : 'set_paused';
  const arg = contractName.toLowerCase() === 'pool' ? false : true;

  console.log(`Pausing ${name}...`);
  nonce++;
  await callMethod(address, method, [arg], null, deployerAddr, nonce, keypair.secretKey);
  console.log('Done.');
}

async function cmdUnpause(mnemonic, contractName) {
  if (!PAUSABLE.includes(contractName.toLowerCase())) {
    throw new Error(`${contractName} is not pausable. Pausable: ${PAUSABLE.join(', ')}`);
  }

  const { name, address } = resolveContract(contractName);
  const { keypair, address: deployerAddr } = getAddress(mnemonic);
  const bal = await rpcCall('octra_balance', [deployerAddr]);
  let nonce = bal.nonce;

  const method = contractName.toLowerCase() === 'pool' ? 'set_active' : 'set_paused';
  const arg = contractName.toLowerCase() === 'pool' ? true : false;

  console.log(`Unpausing ${name}...`);
  nonce++;
  await callMethod(address, method, [arg], null, deployerAddr, nonce, keypair.secretKey);
  console.log('Done.');
}

// ── CLI ──────────────────────────────────────────────────────

function usage() {
  console.log(`
EverestSwap Admin CLI

Usage: MNEMONIC="your mnemonic phrase" node admin.js <command> [args]

Commands:
  view                                                       Show all contract settings
  set-fee <numerator> <denominator>                          Set swap fee (e.g. 3 1000 = 0.3%)
  claim-fees <recipient>                                     Withdraw accumulated fees to recipient
  set-fee-to <address>                                       Set protocol fee recipient (factory)
  transfer-ownership <contract> <newOwner>                   Initiate ownership transfer
  accept-ownership <contract>                                Accept pending ownership transfer
  pause <contract>                                           Pause contract
  unpause <contract>                                         Unpause contract

Contracts:
  pool, factory, router, woct, oes

Examples:
  MNEMONIC="word1 word2 ..." node admin.js view
  MNEMONIC="word1 word2 ..." node admin.js set-fee 5 1000
  MNEMONIC="word1 word2 ..." node admin.js claim-fees octABC...xyz
  MNEMONIC="word1 word2 ..." node admin.js set-fee-to octABC...xyz
  MNEMONIC="word1 word2 ..." node admin.js transfer-ownership pool octABC...xyz
  MNEMONIC="word1 word2 ..." node admin.js pause factory
  `);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  // [SECURITY] Load MNEMONIC from environment variable - NOT from CLI args
  const mnemonic = process.env.MNEMONIC;
  // [SECURITY] M-4: Case-insensitive filter — reject --MNEMONIC, --Mnemonic, etc.
  const filteredArgs = args.filter(a => !/^--mnemonic=/i.test(a) && a.toLowerCase() !== '--mnemonic');

  const command = filteredArgs[0];

  if (!command) {
    console.error('Error: No command specified.');
    usage();
    process.exit(1);
  }

  if (command !== 'view' && !mnemonic) {
    console.error('Error: MNEMONIC environment variable is not set.');
    console.error('Please set: export MNEMONIC="your mnemonic phrase"');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'view':
        await cmdView();
        break;
      case 'set-fee':
        if (!mnemonic) { console.error('Error: MNEMONIC environment variable is not set'); process.exit(1); }
        if (!filteredArgs[1] || !filteredArgs[2]) { console.error('Usage: set-fee <numerator> <denominator>'); process.exit(1); }
        await cmdSetFee(mnemonic, filteredArgs[1], filteredArgs[2]);
        break;
      case 'claim-fees':
        if (!mnemonic) { console.error('Error: MNEMONIC environment variable is not set'); process.exit(1); }
        if (!filteredArgs[1]) { console.error('Usage: claim-fees <recipient>'); process.exit(1); }
        await cmdClaimFees(mnemonic, filteredArgs[1]);
        break;
      case 'set-fee-to':
        if (!mnemonic) { console.error('Error: MNEMONIC environment variable is not set'); process.exit(1); }
        if (!filteredArgs[1]) { console.error('Usage: set-fee-to <address>'); process.exit(1); }
        await cmdSetFeeTo(mnemonic, filteredArgs[1]);
        break;
      case 'transfer-ownership':
        if (!mnemonic) { console.error('Error: MNEMONIC environment variable is not set'); process.exit(1); }
        if (!filteredArgs[1] || !filteredArgs[2]) { console.error('Usage: transfer-ownership <contract> <newOwner>'); process.exit(1); }
        await cmdTransferOwnership(mnemonic, filteredArgs[1], filteredArgs[2]);
        break;
      case 'accept-ownership':
        if (!mnemonic) { console.error('Error: MNEMONIC environment variable is not set'); process.exit(1); }
        if (!filteredArgs[1]) { console.error('Usage: accept-ownership <contract>'); process.exit(1); }
        await cmdAcceptOwnership(mnemonic, filteredArgs[1]);
        break;
      case 'pause':
        if (!mnemonic) { console.error('Error: MNEMONIC environment variable is not set'); process.exit(1); }
        if (!filteredArgs[1]) { console.error('Usage: pause <contract>'); process.exit(1); }
        await cmdPause(mnemonic, filteredArgs[1]);
        break;
      case 'unpause':
        if (!mnemonic) { console.error('Error: MNEMONIC environment variable is not set'); process.exit(1); }
        if (!filteredArgs[1]) { console.error('Usage: unpause <contract>'); process.exit(1); }
        await cmdUnpause(mnemonic, filteredArgs[1]);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        usage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
