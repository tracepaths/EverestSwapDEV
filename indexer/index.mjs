import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const network = process.env.NETWORK || process.argv.find(a => a.startsWith('--network='))?.split('=')[1] || 'devnet';
const envFile = path.join(__dirname, `env.${network}`);

let envVars = { RPC_URL: '', POOL_ADDRESS: '', PORT: '3123' };
if (fs.existsSync(envFile)) {
  const content = fs.readFileSync(envFile, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key in envVars) envVars[key] = val;
  }
}

const RPC = envVars.RPC_URL || 'https://devnet.octrascan.io/rpc';
const POOL = envVars.POOL_ADDRESS || 'oct7t3dFk1AyysnoVRwvcwqMLzgkTt8Sw78Lnuv32EtUx7r';
const PORT = parseInt(envVars.PORT, 10) || 3123;

const DATA_DIR = path.join(__dirname, 'data');
const PRICES_FILE = path.join(DATA_DIR, 'prices.json');

let prices = [];
let lastError = null;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(PRICES_FILE)) {
  try { prices = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf-8')); } catch {}
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

async function pollPrice() {
  try {
    const raw = await rpc('contract_call', [POOL, 'get_reserves', []]);
    const storage = raw && typeof raw === 'object' ? raw.storage || raw : {};
    const reserveA = Number(storage.reserve_a || 0);
    const reserveB = Number(storage.reserve_b || 0);
    const price = reserveA > 0 ? reserveB / reserveA : 0;
    const entry = { time: Date.now() / 1000, price };
    prices.push(entry);
    if (prices.length > 100000) prices.splice(0, prices.length - 100000);
    fs.writeFileSync(PRICES_FILE, JSON.stringify(prices));
    lastError = null;
  } catch (e) {
    lastError = e.message;
  }
}

setInterval(pollPrice, 5000);
pollPrice();

const app = express();

app.get('/health', (_req, res) => {
  res.json({ status: lastError ? 'error' : 'ok', points: prices.length, pool: POOL, network, error: lastError });
});

app.get('/api/prices', (_req, res) => {
  res.json(prices);
});

app.listen(PORT, () => console.log(`Indexer [${network}] running on http://localhost:${PORT}`));
