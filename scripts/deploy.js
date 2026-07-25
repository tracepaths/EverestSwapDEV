const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// [V7-SECURITY] Load MNEMONIC from environment variable - NEVER hardcode in source!
const RPC_URL = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) {
  console.error('ERROR: MNEMONIC environment variable is not set.');
  console.error('Please set it with: export MNEMONIC="your mnemonic phrase"');
  process.exit(1);
}
const FEE_OU = '100000';
// [V7-DEPLOY] CLI flags
const FORCE = process.argv.includes('--force');
const OPTION = process.argv.find(a => a.startsWith('--option='))?.split('=')[1];
const OES_ADDRESS = 'octGURUy7hQhXHVcP9bovbJnpoXqCv2gpWBrk6fqtXqJ2sC';
const DEPLOYMENTS_PATH = path.join(__dirname, '..', 'deployments.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

// ── RPC Helpers ──────────────────────────────────────────────

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

// ── Deployer Identity ────────────────────────────────────────

function getDeployer() {
  const seed64 = crypto.pbkdf2Sync(MNEMONIC, 'mnemonic', 2048, 64, 'sha512');
  const hmac = crypto.createHmac('sha512', 'Octra seed');
  hmac.update(Buffer.from(seed64));
  const hdSeed32 = hmac.digest().slice(0, 32);
  const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(hdSeed32));
  const hash = crypto.createHash('sha256').update(Buffer.from(keypair.publicKey)).digest();
  let b58 = bs58.default.encode(hash);
  while (b58.length < 44) b58 = '1' + b58;
  const address = 'oct' + b58;
  return { keypair, address };
}

async function getNonce(addr) {
  const bal = await rpcCall('octra_balance', [addr]);
  return { nonce: bal.nonce, balance: bal.balance };
}

// ── Compile & Deploy ─────────────────────────────────────────

async function compile(contractName) {
  const filePath = path.join(__dirname, '..', 'contracts', `${contractName}.aml`);
  const src = fs.readFileSync(filePath, 'utf-8');
  const result = await rpcCall('octra_compileAml', [src]);
  console.log(`  ${contractName}: ${result.size}B, ${result.instructions} instr`);
  return result;
}

async function deploy(name, bytecode, deployerAddr, nonce, secretKey) {
  const addrResult = await rpcCall('octra_computeContractAddress', [bytecode, deployerAddr, nonce]);
  const addr = addrResult.address;
  console.log(`  Address: ${addr}`);
  const ts = Date.now() / 1000;
  await submitTx(deployerAddr, addr, '0', nonce, FEE_OU, ts, 'deploy', bytecode, null, secretKey);
  return addr;
}

async function callMethod(contractAddr, method, params, amount, deployerAddr, nonce, secretKey) {
  const ts = Date.now() / 1000;
  await submitTx(deployerAddr, contractAddr, amount || '0', nonce, FEE_OU, ts, 'call', method, JSON.stringify(params), secretKey);
}

function loadDeployments() {
  try {
    return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveDeployments(addresses) {
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(addresses, null, 2));
  console.log(`  Saved → ${DEPLOYMENTS_PATH}`);
}

// ── Menu Options ─────────────────────────────────────────────

async function fullFreshDeploy(deployer, nonce) {
  console.log('\n=== Full Fresh Deploy ===\n');

  // [SECURITY] S-2: Balance check before starting
  const balInfo = await rpcCall('octra_balance', [deployer.address]);
  const deployerBal = parseFloat(balInfo.balance);
  if (deployerBal < 0.5) {
    throw new Error(`Insufficient balance: ${balInfo.balance} OCT (need at least 0.5 OCT for 13+ txs)`);
  }
  console.log(`Deployer balance: ${balInfo.balance} OCT`);

  // [SECURITY] S-3: Idempotency check — refuse to overwrite existing deployments
  const existing = loadDeployments();
  if (existing && existing.SwapFactory && existing.WOCT && existing.SwapPool && existing.Router) {
    if (!FORCE) {
      throw new Error('Contracts already deployed. Use option 2 (Factory Fix) or 3 (Init Only) instead of option 1.');
    }
    console.log('  ⚠️ --force: Bypassing S-3 idempotency check, overwriting existing deployments');
  }

  console.log('Compiling contracts...');
  const swapFactory = await compile('SwapFactory');
  const woct = await compile('WOCT');
  const swapPool = await compile('SwapPool');
  const router = await compile('Router');

  const addresses = { OES: OES_ADDRESS };

  console.log('\n1. Deploying SwapFactory...');
  nonce++;
  addresses.SwapFactory = await deploy('SwapFactory', swapFactory.bytecode, deployer.address, nonce, deployer.keypair.secretKey);
  saveDeployments(addresses);  // [SECURITY] S-1: Save after each step

  console.log('\n2. Deploying WOCT...');
  nonce++;
  addresses.WOCT = await deploy('WOCT', woct.bytecode, deployer.address, nonce, deployer.keypair.secretKey);
  saveDeployments(addresses);

  console.log('\n3. Deploying SwapPool...');
  nonce++;
  addresses.SwapPool = await deploy('SwapPool', swapPool.bytecode, deployer.address, nonce, deployer.keypair.secretKey);
  saveDeployments(addresses);

  console.log('\n4. Deploying Router...');
  nonce++;
  addresses.Router = await deploy('Router', router.bytecode, deployer.address, nonce, deployer.keypair.secretKey);
  saveDeployments(addresses);

  return { addresses, nonce };
}

async function initContracts(addresses, deployer, nonce) {
  console.log('\n=== Initializing Contracts ===\n');

  // [V7-FIX] Each step is wrapped in try/catch so init can resume from partial state
  const safeCall = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      console.log(`  ⚠️ ${name} skipped (likely already done): ${e.message.slice(0, 100)}`);
    }
  };

  console.log('7. Setting tokens on SwapPool...');
  await safeCall('set_tokens', async () => {
    nonce++;
    await callMethod(addresses.SwapPool, 'set_tokens', [addresses.WOCT, OES_ADDRESS], null, deployer.address, nonce, deployer.keypair.secretKey);
  });

  console.log('\n8. Depositing 5 OCT → WOCT...');
  await safeCall('deposit', async () => {
    nonce++;
    await callMethod(addresses.WOCT, 'deposit', [], '5000000', deployer.address, nonce, deployer.keypair.secretKey);
  });

  const woctBal = await rpcCall('contract_call', [addresses.WOCT, 'balance_of', [deployer.address], deployer.address]);
  console.log(`  WOCT balance: ${woctBal.result}`);

  console.log('\n9. Granting SwapPool allowance on WOCT...');
  await safeCall('grant_woct', async () => {
    nonce++;
    const liquidOct = '4000000';
    await callMethod(addresses.WOCT, 'grant', [addresses.SwapPool, parseInt(liquidOct)], null, deployer.address, nonce, deployer.keypair.secretKey);
  });

  console.log('\n10. Granting SwapPool allowance on OES...');
  await safeCall('grant_oes', async () => {
    nonce++;
    const liquidOes = '80000000000';
    await callMethod(OES_ADDRESS, 'grant', [addresses.SwapPool, parseInt(liquidOes)], null, deployer.address, nonce, deployer.keypair.secretKey);
  });

  console.log('\n11. Adding liquidity...');
  await safeCall('add_liquidity', async () => {
    nonce++;
    const liquidOct = 4000000;
    const liquidOes = 80000000000;
    // [V7-FIX] Use current chain epoch + 300 (NOT unix timestamp) — epoch in AML is the chain block counter
    const epochInfo = await rpcCall('epoch_current', []);
    const addLiqDeadline = epochInfo.epoch_id + 300;
    await callMethod(addresses.SwapPool, 'add_liquidity', [liquidOct, liquidOes, 0, addLiqDeadline, 0], null, deployer.address, nonce, deployer.keypair.secretKey);
  });

  const reserves = await rpcCall('contract_call', [addresses.SwapPool, 'get_reserves', [], deployer.address]);
  console.log(`  Reserves: ${reserves.result}`);

  console.log('\n12. Registering pool with factory...');
  await safeCall('register_pool', async () => {
    nonce++;
    await callMethod(addresses.SwapFactory, 'register_pool', [addresses.WOCT, OES_ADDRESS, addresses.SwapPool], null, deployer.address, nonce, deployer.keypair.secretKey);
  });

  console.log('\n13. Setting factory on Router...');
  await safeCall('set_factory', async () => {
    nonce++;
    await callMethod(addresses.Router, 'set_factory', [addresses.SwapFactory], null, deployer.address, nonce, deployer.keypair.secretKey);
  });
  await safeCall('set_woct', async () => {
    nonce++;
    await callMethod(addresses.Router, 'set_woct', [addresses.WOCT], null, deployer.address, nonce, deployer.keypair.secretKey);
  });

  return nonce;
}

async function runTests(addresses, deployer, nonce) {
  console.log('\n=== Running Tests ===\n');

  try {
    console.log('Test 1: Swap WOCT → OES...');
    nonce++;
    await callMethod(addresses.WOCT, 'grant', [addresses.SwapPool, 1000000], null, deployer.address, nonce, deployer.keypair.secretKey);
    nonce++;
    // [V7-FIX] Use chain epoch (not unix timestamp) for deadline
    const epochInfo = await rpcCall('epoch_current', []);
    const swapDeadline = epochInfo.epoch_id + 300;
    const swapResult = await submitTx(deployer.address, addresses.SwapPool, '0', nonce, FEE_OU, Date.now() / 1000,
      'call', 'swap_a_for_b', JSON.stringify([1000000, 0, swapDeadline]), deployer.keypair.secretKey);
    if (swapResult.events) {
      for (const e of swapResult.events) {
        if (e.event === 'Swap') console.log(`  Swap: in=${e.values[2]}, out=${e.values[3]}`);
      }
    }
  } catch (err) {
    console.log(`  ⚠️ Swap test failed: ${err.message}`);
  }

  try {
    console.log('\nTest 2: Withdraw WOCT → OCT...');
    nonce++;
    const withdrawBal = await rpcCall('contract_call', [addresses.WOCT, 'balance_of', [deployer.address], deployer.address]);
    const withdrawAmt = Math.min(1000000, parseInt(withdrawBal.result)).toString();
    if (parseInt(withdrawAmt) > 0) {
      await callMethod(addresses.WOCT, 'withdraw', [parseInt(withdrawAmt)], null, deployer.address, nonce, deployer.keypair.secretKey);
      console.log(`  Withdrew ${withdrawAmt} WOCT → OCT`);
    }
  } catch (err) {
    console.log(`  ⚠️ Withdraw test failed: ${err.message}`);
  }

  return nonce;
}

function printSummary(addresses) {
  console.log('\n========================================');
  console.log('=== Deployment Summary ===');
  console.log('========================================');
  for (const [name, addr] of Object.entries(addresses)) {
    console.log(`  ${name}: ${addr}`);
  }
}

// ── Main Menu ────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║     EverestSwap Unified Deployer     ║');
  console.log('╚══════════════════════════════════════╝\n');

  const deployer = getDeployer();
  const { nonce, balance } = await getNonce(deployer.address);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${balance} OCT | Nonce: ${nonce}\n`);

  console.log('Options:');
  console.log('  1. Full Fresh Deploy       — Compile + Deploy + Init + Test');
  console.log('  2. Factory Fix             — Recompile + redeploy SwapFactory only');
  console.log('  3. Init Only               — Initialize existing contracts (skip deploy)');
  console.log('  4. Test Only               — Run swap/withdraw tests');
  console.log('  5. Print Addresses         — Show current deployments.json');
  console.log('  6. Factory + Router Redeploy — Redeploy both Factory & Router (permissionless AMM)\n');

  let choice = OPTION;
  if (!choice) {
    choice = await ask('Select option [1-6]: ');
  } else {
    console.log(`Selected option: ${choice} (via --option)`);
  }
  console.log('');

  let currentNonce = nonce;
  let addresses = loadDeployments();

  switch (choice.trim()) {
    case '1': {
      const result = await fullFreshDeploy(deployer, currentNonce);
      currentNonce = result.nonce;
      addresses = result.addresses;
      currentNonce = await initContracts(addresses, deployer, currentNonce);
      currentNonce = await runTests(addresses, deployer, currentNonce);
      break;
    }
    case '2': {
      console.log('=== Factory Fix ===\n');
      if (!addresses.SwapFactory) {
        console.log('⚠️  No existing SwapFactory in deployments.json. Run option 1 first.');
        break;
      }
      console.log('Recompiling SwapFactory...');
      const swapFactory = await compile('SwapFactory');
      console.log('\nRedeploying SwapFactory...');
      currentNonce++;
      addresses.SwapFactory = await deploy('SwapFactory', swapFactory.bytecode, deployer.address, currentNonce, deployer.keypair.secretKey);
      saveDeployments(addresses);

      const ans = await ask('Re-initialize router with new factory? [y/N]: ');
      if (ans.trim().toLowerCase() === 'y') {
        currentNonce++;
        await callMethod(addresses.Router, 'set_factory', [addresses.SwapFactory], null, deployer.address, currentNonce, deployer.keypair.secretKey);
      }
      break;
    }
    case '3': {
      if (!addresses.SwapPool || !addresses.WOCT) {
        console.log('⚠️  Missing contracts. Run option 1 first.');
        break;
      }
      currentNonce = await initContracts(addresses, deployer, currentNonce);
      break;
    }
    case '4': {
      if (!addresses.SwapPool || !addresses.WOCT) {
        console.log('⚠️  Missing contracts. Run option 1 first.');
        break;
      }
      currentNonce = await runTests(addresses, deployer, currentNonce);
      break;
    }
    case '5': {
      if (Object.keys(addresses).length === 0) {
        console.log('No deployments found.');
      } else {
        printSummary(addresses);
      }
      break;
    }
    case '6': {
      console.log('=== Factory + Router Redeploy (Permissionless AMM) ===\n');
      console.log('Redeploys Factory (permissionless register_pool) and Router');
      console.log('from current wallet, then re-registers existing WOCT/OES pool.\n');

      console.log('Recompiling SwapFactory + Router...');
      const swapFactory = await compile('SwapFactory');
      const router = await compile('Router');

      console.log('\nDeploying SwapFactory...');
      currentNonce++;
      addresses.SwapFactory = await deploy('SwapFactory', swapFactory.bytecode, deployer.address, currentNonce, deployer.keypair.secretKey);
      saveDeployments(addresses);

      console.log('\nDeploying Router...');
      currentNonce++;
      addresses.Router = await deploy('Router', router.bytecode, deployer.address, currentNonce, deployer.keypair.secretKey);
      saveDeployments(addresses);

      console.log('\nSetting factory on Router...');
      currentNonce++;
      await callMethod(addresses.Router, 'set_factory', [addresses.SwapFactory], null, deployer.address, currentNonce, deployer.keypair.secretKey);

      console.log('Setting WOCT on Router...');
      currentNonce++;
      await callMethod(addresses.Router, 'set_woct', [addresses.WOCT], null, deployer.address, currentNonce, deployer.keypair.secretKey);

      // Re-register existing WOCT/OES pool in new factory (permissionless)
      if (addresses.SwapPool) {
        console.log('\nRe-registering existing WOCT/OES pool in new factory...');
        currentNonce++;
        await callMethod(addresses.SwapFactory, 'register_pool', [addresses.WOCT, OES_ADDRESS, addresses.SwapPool], null, deployer.address, currentNonce, deployer.keypair.secretKey);
      }

      console.log('\nDone. New addresses:');
      printSummary(addresses);
      break;
    }
    default:
      console.log('Invalid option.');
  }

  const finalBal = await rpcCall('octra_balance', [deployer.address]);
  console.log(`\nFinal balance: ${finalBal.balance} OCT (nonce: ${finalBal.nonce})`);
  console.log('Done.\n');
  rl.close();
}

main().catch(err => {
  console.error('\nFailed:', err);
  rl.close();
  process.exit(1);
});
