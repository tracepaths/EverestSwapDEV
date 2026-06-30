#!/usr/bin/env node
/**
 * deploy-dogo.js — Deploy DOGO token + SwapPool + seed liquidity (1 OCT : 10000 DOGO)
 *
 * Usage:
 *   MNEMONIC="..." node scripts/deploy-dogo.js [--dry-run]
 */

const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default;
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) { console.error('ERROR: MNEMONIC env var not set'); process.exit(1); }

const DRY_RUN = process.argv.includes('--dry-run');
const FEE_OU = '100000';
const DEPLOYER_ADDR = 'octGXi34vZfYwi3idjSa6m34vLJCoJHNMNAGeHyqh7JVEvy';
const WOCT = 'octLtzi5z7Ls6BFdrBgdGQKiqBKxDPojpfHLpWhHfbDbF8c';
const FACTORY = 'octF2kc1Spgxo6BsUazFrg4gCYUMLffEPbcReg6SmmApa2F';
const ROUTER = 'octAAy94fnLmCavamhcL3LVHB7pa2amxv9By53UqNGMLDgr';
const DEPLOYMENTS_PATH = path.join(__dirname, '..', 'deployments.json');

// DOGO params
const LIQ_WOCT = '1000000';                        // 1 WOCT (6 decimals)
const LIQ_DOGO = '10000000000000000000000';        // 10000 DOGO (18 decimals)

// ── Helpers ───────────────────────────────────────────────────

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

async function submitAndWait(deployer, nonceRef, to, amount, method, params, label) {
  nonceRef.value++;
  const ts = Date.now() / 1000;
  const tx = {
    from: deployer.address, to_: to, amount: amount || '0',
    nonce: nonceRef.value, ou: FEE_OU, timestamp: ts, op_type: 'call',
    encrypted_data: method, message: JSON.stringify(params)
  };
  signTx(tx, deployer.keypair.secretKey);
  const result = await rpc('octra_submit', [tx]);
  console.log(`  Tx: ${result.tx_hash}`);
  const receipt = await waitReceipt(result.tx_hash);
  console.log(`  OK (${label}, effort: ${receipt.effort})`);
  return receipt;
}

async function deployContract(deployer, nonceRef, name, bytecode, constructorArgs) {
  nonceRef.value++;
  const addrResult = await rpc('octra_computeContractAddress', [bytecode, deployer.address, nonceRef.value]);
  const addr = addrResult.address;
  console.log(`  Address: ${addr}`);
  if (DRY_RUN) return addr;
  const ts = Date.now() / 1000;
  const tx = {
    from: deployer.address, to_: addr, amount: '0',
    nonce: nonceRef.value, ou: FEE_OU, timestamp: ts, op_type: 'deploy',
    encrypted_data: bytecode
  };
  if (constructorArgs) tx.message = constructorArgs;
  signTx(tx, deployer.keypair.secretKey);
  const result = await rpc('octra_submit', [tx]);
  console.log(`  Tx: ${result.tx_hash}`);
  const receipt = await waitReceipt(result.tx_hash);
  console.log(`  Deployed ${name} (effort: ${receipt.effort})`);
  return addr;
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

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   DOGO Token + Pool Deployment       ║');
  console.log('╚══════════════════════════════════════╝\n');

  const deployer = getDeployer(MNEMONIC);
  if (deployer.address !== DEPLOYER_ADDR) {
    throw new Error(`Deployer mismatch: ${deployer.address} != ${DEPLOYER_ADDR}`);
  }

  const bal = await rpc('octra_balance', [deployer.address]);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${bal.balance} OCT (nonce ${bal.nonce})\n`);
  const nonceRef = { value: bal.nonce };

  // 1. Compile
  console.log('[1] Compiling contracts...');
  const tokenCompiled = await compile('Token');
  const poolCompiled = await compile('SwapPool');

  // 2. Deploy DOGO Token with constructor args
  // Token constructor: name, symbol, contract_name, initial_supply, decimals,
  //   initial_owner, supply_recipient, max_tx_amount, max_wallet_amount,
  //   cooldown_blocks, tax_bps, tax_recipient, auto_burn_bps,
  //   mintable, burnable, pausable, blacklist,
  //   max_tx_flag, max_wallet_flag, cooldown_flag, tax_flag, auto_burn_flag,
  //   trusted_1..5
  console.log('\n[2] Deploying DOGO token...');
  const supplyRaw = BigInt('10000000000') * (BigInt(10) ** BigInt(18)); // 10B * 10^18
  const dogoConstructorArgs = JSON.stringify([
    'DOGO',                         // name
    'DOGO',                         // symbol
    'DOGO Token',                   // contract_name
    supplyRaw.toString(),           // initial_supply (10B * 10^18)
    '18',                           // decimals
    deployer.address,               // initial_owner
    deployer.address,               // supply_recipient
    '0',                            // max_tx_amount (no limit)
    '0',                            // max_wallet_amount (no limit)
    '0',                            // cooldown_blocks (no cooldown)
    '0',                            // tax_bps (no tax)
    deployer.address,               // tax_recipient
    '0',                            // auto_burn_bps (no auto-burn)
    true,                           // mintable_flag
    true,                           // burnable_flag
    true,                           // pausable_flag
    true,                           // blacklist_flag
    false,                          // max_tx_flag
    false,                          // max_wallet_flag
    false,                          // cooldown_flag
    false,                          // tax_flag
    false,                          // auto_burn_flag
    ROUTER,                         // trusted_1 (router)
    '',                             // trusted_2
    '',                             // trusted_3
    '',                             // trusted_4
    '',                             // trusted_5
  ]);
  const dogoAddr = await deployContract(deployer, nonceRef, 'DOGO', tokenCompiled.bytecode, dogoConstructorArgs);
  await new Promise(r => setTimeout(r, 1000));

  // 3. Deploy SwapPool (no constructor args — uses set_tokens/set_factory)
  console.log('\n[3] Deploying SwapPool...');
  const poolAddr = await deployContract(deployer, nonceRef, 'SwapPool', poolCompiled.bytecode);
  await new Promise(r => setTimeout(r, 1000));

  // 4. Configure pool
  console.log('\n[4] Configuring pool...');
  if (!DRY_RUN) {
    await submitAndWait(deployer, nonceRef, poolAddr, '0', 'set_tokens', [WOCT, dogoAddr], 'set_tokens');
    await new Promise(r => setTimeout(r, 1000));
    await submitAndWait(deployer, nonceRef, poolAddr, '0', 'set_factory', [FACTORY], 'set_factory');
    await new Promise(r => setTimeout(r, 1000));
  }

  // 5. Trust pool on DOGO (function is set_trusted, not set_trusted_address)
  // Note: not required when max_wallet_flag=false, but good practice for pool operation
  console.log('\n[5] Trusting pool on DOGO...');
  if (!DRY_RUN) {
    try {
      await submitAndWait(deployer, nonceRef, dogoAddr, '0', 'set_trusted', [poolAddr, true], 'trust_pool');
    } catch(e) {
      console.log(`  Skipped: ${e.message.slice(0, 80)}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // 6. Deposit OCT → WOCT
  console.log('\n[6] Depositing 5 OCT → WOCT...');
  if (!DRY_RUN) {
    try {
      await submitAndWait(deployer, nonceRef, WOCT, '5000000', 'deposit', [], 'deposit');
    } catch(e) {
      console.log(`  Skipped: ${e.message.slice(0, 80)}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // 7. Grant + Add Liquidity (1 WOCT : 10000 DOGO)
  console.log('\n[7] Granting tokens to pool...');
  if (!DRY_RUN) {
    await submitAndWait(deployer, nonceRef, WOCT, '0', 'grant', [poolAddr, parseInt(LIQ_WOCT)], 'grant_woct');
    await new Promise(r => setTimeout(r, 1000));
    await submitAndWait(deployer, nonceRef, dogoAddr, '0', 'grant', [poolAddr, LIQ_DOGO], 'grant_dogo');
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n[8] Adding liquidity (1 WOCT : 10000 DOGO)...');
  if (!DRY_RUN) {
    const epochInfo = await rpc('epoch_current', []);
    if (!epochInfo || typeof epochInfo.epoch_id !== 'number') {
      throw new Error('Could not fetch current epoch');
    }
    const deadline = epochInfo.epoch_id + 300;
    await submitAndWait(deployer, nonceRef, poolAddr, '0', 'add_liquidity',
      [LIQ_WOCT, LIQ_DOGO, '0', String(deadline), '0'], 'add_liquidity');
    await new Promise(r => setTimeout(r, 1000));
  }

  // 8. Register pool on factory
  console.log('\n[9] Registering pool on factory...');
  if (!DRY_RUN) {
    await submitAndWait(deployer, nonceRef, FACTORY, '0', 'register_pool',
      [WOCT, dogoAddr, poolAddr], 'register_pool');
    await new Promise(r => setTimeout(r, 1000));
  }

  // 9. Save addresses
  console.log('\n[10] Saving addresses...');
  const deployments = loadDeployments();
  deployments.DOGO = dogoAddr;
  deployments.DOGO_Pool = poolAddr;
  saveDeployments(deployments);

  // 10. Verify
  console.log('\n[11] Verifying...');
  if (!DRY_RUN) {
    const dogoName = await rpc('contract_call', [dogoAddr, 'get_name', []]);
    console.log(`  DOGO name: ${dogoName.result}`);
    const dogoSymbol = await rpc('contract_call', [dogoAddr, 'get_symbol', []]);
    console.log(`  DOGO symbol: ${dogoSymbol.result}`);
    const dogoSupply = await rpc('contract_call', [dogoAddr, 'get_total_supply', []]);
    console.log(`  DOGO supply: ${dogoSupply.result}`);
    const dogoDecimals = await rpc('contract_call', [dogoAddr, 'decimals', []]);
    console.log(`  DOGO decimals: ${dogoDecimals.result}`);
    const reserves = await rpc('contract_call', [poolAddr, 'get_reserves', []]);
    console.log(`  Pool reserves: ${reserves.result}`);
    const poolInfo = await rpc('contract_call', [poolAddr, 'get_pool_info', []]);
    console.log(`  Pool info: ${JSON.stringify(poolInfo.storage || poolInfo).slice(0, 200)}`);
  }

  console.log('\n========================================');
  console.log('=== Deployment Summary ===');
  console.log('========================================');
  console.log(`  DOGO:      ${dogoAddr}`);
  console.log(`  DOGO_Pool: ${poolAddr}`);
  console.log(`  WOCT:      ${WOCT}`);
  console.log(`  Factory:   ${FACTORY}`);
  console.log(`  Router:    ${ROUTER}`);
  console.log('\nDone.');
}

main().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
