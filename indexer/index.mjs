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

// [SECURITY] H-1: Serial poll — prevent concurrent pollPrice calls from corrupting prices array
let isPolling = false;
async function pollPrice() {
  if (isPolling) return;
  isPolling = true;
  try {
    const raw = await rpc('contract_call', [POOL, 'get_reserves', []]);
    const storage = raw && typeof raw === 'object' ? raw.storage || raw : {};
    const reserveA = Number(storage.reserve_a || 0);
    const reserveB = Number(storage.reserve_b || 0);
    const price = reserveA > 0 ? reserveB / reserveA : 0;
    // [SECURITY] M-4: Validate response shape before recording
    if (!Number.isFinite(reserveA) || !Number.isFinite(reserveB) || !Number.isFinite(price)) {
      lastError = 'invalid price data from RPC';
      return;
    }
    const entry = { time: Date.now() / 1000, price };
    prices.push(entry);
    if (prices.length > 100000) prices.splice(0, prices.length - 100000);
    // [SECURITY] M-4: Use async file write to avoid blocking the event loop
    fs.promises.writeFile(PRICES_FILE, JSON.stringify(prices)).catch((e) => {
      lastError = 'write failed: ' + e.message;
    });
    lastError = null;
  } catch (e) {
    lastError = e.message;
  } finally {
    isPolling = false;
  }
}

setInterval(pollPrice, 5000);
pollPrice();

const app = express();

// [SECURITY] Basic rate limit: max 60 requests/minute per IP
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 60;
// [SECURITY] M-3: Periodically clean up expired rate limit entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt + RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000); // every 5 minutes

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'rate limit exceeded' });
  }
  next();
}

// [SECURITY] CORS: only allow same-origin (dev) or configured origins
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:4173', 'http://localhost:3000'];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  next();
});

app.use(rateLimit);

app.get('/health', (_req, res) => {
  // [SECURITY] M-4: Sanitize error response — don't leak internal details
  res.json({
    status: lastError ? 'error' : 'ok',
    points: prices.length,
    pool: POOL,
    network,
    errorCode: lastError ? 'rpc_error' : null,
  });
});

app.get('/api/prices', (_req, res) => {
  // [SECURITY] Validate response shape before sending
  if (!Array.isArray(prices)) {
    return res.status(500).json({ error: 'invalid price data' });
  }
  // [SECURITY] Cap response to last 1000 points to prevent memory/bandwidth abuse
  const limit = Math.min(parseInt(_req.query.limit, 10) || 1000, 10000);
  const offset = parseInt(_req.query.offset, 10) || 0;
  const sliced = prices.slice(Math.max(0, prices.length - limit - offset), prices.length - offset);
  res.json(sliced);
});

app.listen(PORT, () => console.log(`Indexer [${network}] running on http://localhost:${PORT}`));
