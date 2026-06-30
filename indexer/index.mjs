import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// [V7-PASS10] HIGH-5: PID file to prevent multi-instance corruption
const PID_FILE = path.join(__dirname, 'data', 'indexer.pid');
try {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0);  // throws if process is dead
        console.error(`[indexer] Another instance is already running (pid ${oldPid}). Exiting.`);
        process.exit(1);
      } catch {
        // old PID is dead, safe to overwrite
      }
    }
  }
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  // Clean up on exit
  const cleanup = () => {
    try { fs.unlinkSync(PID_FILE); } catch { /* noop */ }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  console.log(`[indexer] PID ${process.pid} registered in ${PID_FILE}`);
} catch (e) {
  console.error(`[indexer] Failed to write PID file: ${e.message}`);
}

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
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');

let prices = [];
let events = [];  // [V7-PASS9] M-14: cached events (capped 10k)
let lastError = null;
let lastEventBlock = 0;  // last block we've processed events from

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(PRICES_FILE)) {
  try { prices = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf-8')); } catch {}
}
if (fs.existsSync(EVENTS_FILE)) {
  try { events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf-8')); } catch {}
}

// [V7-PASS9] M-14: Token events we track (Transfer, Mint, Burn, etc.)
const TRACKED_EVENTS = [
  'Transfer', 'Approval', 'Grant',
  'Mint', 'Burn',
  'Paused', 'BlacklistUpdated',
  'MaxTxUpdated', 'MaxWalletUpdated', 'CooldownUpdated',
  'TaxUpdated', 'AutoBurnUpdated',
  'OwnershipTransferInitiated', 'OwnershipTransferred',
  'TrustedUpdated',
];

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
    if (prices.length > 10000) prices.splice(0, prices.length - 10000);
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

// [V7-PASS9] M-14: poll events from the pool contract (and Token contracts later)
let isPollingEvents = false;
async function pollEvents() {
  if (isPollingEvents) return;
  isPollingEvents = true;
  try {
    // Get current block height
    const head = await rpc('get_block_height', []).catch(() => null);
    const currentBlock = Number(head?.block_height || head?.height || 0);
    if (!currentBlock || currentBlock <= lastEventBlock) {
      // First run, or no new blocks — try to fetch a small initial window
      if (lastEventBlock === 0) {
        lastEventBlock = Math.max(1, currentBlock - 100);
      } else {
        return;
      }
    }
    const fromBlock = lastEventBlock + 1;
    const toBlock = currentBlock;
    if (fromBlock > toBlock) return;
    // Fetch logs for the pool contract (Token events when extended)
    const logs = await rpc('get_logs', [{
      from_block: fromBlock,
      to_block: toBlock,
      contract: POOL,
    }]).catch(() => []);
    if (Array.isArray(logs)) {
      for (const log of logs) {
        const eventName = log.event || log.type || 'Unknown';
        if (!TRACKED_EVENTS.includes(eventName)) continue;
        const event = {
          block: log.block_height || log.block || 0,
          time: Date.now() / 1000,
          contract: log.contract || POOL,
          event: eventName,
          data: log.data || log,
        };
        events.push(event);
      }
      if (events.length > 10000) events.splice(0, events.length - 10000);
      fs.promises.writeFile(EVENTS_FILE, JSON.stringify(events)).catch((e) => {
        lastError = 'events write failed: ' + e.message;
      });
    }
    lastEventBlock = toBlock;
  } catch (e) {
    // Silently ignore — get_logs may not be available on all RPCs
  } finally {
    isPollingEvents = false;
  }
}

// [V7-PASS9] M-14: poll events every 10s (less frequent than prices to reduce load)
setInterval(pollEvents, 10000);
pollEvents();

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

// [V7-PASS9] M-14: events endpoint
app.get('/api/events', (_req, res) => {
  if (!Array.isArray(events)) {
    return res.status(500).json({ error: 'invalid events data' });
  }
  const limit = Math.min(parseInt(_req.query.limit, 10) || 100, 1000);
  const offset = parseInt(_req.query.offset, 10) || 0;
  const eventFilter = _req.query.event;
  const contractFilter = _req.query.contract;
  let filtered = events;
  if (eventFilter) filtered = filtered.filter(e => e.event === eventFilter);
  if (contractFilter) filtered = filtered.filter(e => e.contract === contractFilter);
  const sliced = filtered.slice(Math.max(0, filtered.length - limit - offset), filtered.length - offset);
  res.json({
    total: filtered.length,
    lastBlock: lastEventBlock,
    events: sliced,
  });
});

app.listen(PORT, () => console.log(`Indexer [${network}] running on http://localhost:${PORT}`));
