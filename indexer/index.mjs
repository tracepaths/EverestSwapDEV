// Price history for the exchange.
//
// Nothing here is required for the exchange to work: every balance, quote and
// position is read straight from the contracts by the interface. What a chain
// cannot answer is "what did this cost an hour ago", because a contract only
// holds the present. So this process samples each pool's price on a timer and
// keeps the series on disk, and the interface draws a chart when it is running
// and simply omits the chart when it is not.
//
// It discovers pools from the factory rather than being told about them, because
// anyone can create one and a chart that only knows the pools that existed when
// it started is worse than no chart. Each pool gets its own series, keyed by
// address — a pair traded at two fee tiers is two markets with two prices, and
// averaging them would describe neither.
//
// Reads are deliberately unhurried. A public node rate-limits bursts, and being
// slow to notice a new pool costs nothing while being throttled costs everything.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One instance only. Two would interleave writes to the same files and leave a
// series with the samples of both and the ordering of neither.
const PID_FILE = path.join(__dirname, 'data', 'indexer.pid');
try {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0);  // throws when the process is gone
        console.error(`[indexer] another instance is already running (pid ${oldPid}); exiting`);
        process.exit(1);
      } catch { /* that pid is dead, the file is stale */ }
    }
  }
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  const cleanup = () => { try { fs.unlinkSync(PID_FILE); } catch { /* noop */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  console.log(`[indexer] pid ${process.pid} registered in ${PID_FILE}`);
} catch (e) {
  console.error(`[indexer] could not write the pid file: ${e.message}`);
}

// ── configuration ────────────────────────────────────────────────────────

const network = process.env.NETWORK
  || process.argv.find((a) => a.startsWith('--network='))?.split('=')[1]
  || 'devnet';
const envFile = path.join(__dirname, `env.${network}`);

const envVars = {
  RPC_URL: '',
  FACTORY_ADDRESS: '',
  POSITION_MANAGER_ADDRESS: '',
  ROUTER_ADDRESS: '',
  TOKEN_LAUNCHER_ADDRESS: '',
  PORT: '3123',
};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in envVars) envVars[key] = trimmed.slice(eq + 1).trim();
  }
}
for (const key of Object.keys(envVars)) {
  if (process.env[key]) envVars[key] = process.env[key];
}

const RPC = envVars.RPC_URL || 'https://devnet.octrascan.io/rpc';
const FACTORY = envVars.FACTORY_ADDRESS;
const PORT = parseInt(envVars.PORT, 10) || 3123;

/** Contracts other than the pools whose events are worth keeping. */
const WATCHED = [
  ['factory', FACTORY],
  ['positionManager', envVars.POSITION_MANAGER_ADDRESS],
  ['router', envVars.ROUTER_ADDRESS],
  ['tokenLauncher', envVars.TOKEN_LAUNCHER_ADDRESS],
].filter(([, address]) => address);

if (!FACTORY) {
  console.error('[indexer] no FACTORY_ADDRESS configured; there is nothing to follow.');
  console.error(`[indexer] set it in ${envFile} or in the environment.`);
  process.exit(1);
}

// How often each thing is done, and how much of it at a time. A pool's price is
// read every cycle; the registry is re-read far less often because a pool being
// noticed a few minutes late costs a few minutes of one chart.
const PRICE_CYCLE_MS = 15_000;
const REGISTRY_CYCLE_MS = 5 * 60_000;
const EVENT_CYCLE_MS = 30_000;
/** Pause between two view calls, so a cycle never reads as a burst. */
const READ_GAP_MS = 150;
/** Samples kept per pool. At one every 15s this is about ten days. */
const MAX_POINTS = 60_000;
const MAX_EVENTS = 10_000;

// ── persisted state ──────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');
const SERIES_FILE = path.join(DATA_DIR, 'series.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const POOLS_FILE = path.join(DATA_DIR, 'pools.json');

/** pool address -> [{ time, price, tick, liquidity }] */
let series = {};
/** pool address -> { token0, token1, fee, decimals0, decimals1, symbol0, symbol1 } */
let pools = {};
let events = [];
let lastError = null;
let lastEventBlock = 0;
let eventsSupported = true;
let lastPriceCycle = 0;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const load = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
};
if (fs.existsSync(SERIES_FILE)) series = load(SERIES_FILE, {});
if (fs.existsSync(POOLS_FILE)) pools = load(POOLS_FILE, {});
if (fs.existsSync(EVENTS_FILE)) events = load(EVENTS_FILE, []);

// Writes are debounced: a cycle touches every pool, and one file write per cycle
// is enough. Without this a busy registry would rewrite the same file per pool.
const pendingWrites = new Map();
function saveLater(file, getValue) {
  if (pendingWrites.has(file)) return;
  pendingWrites.set(file, setTimeout(() => {
    pendingWrites.delete(file);
    fs.promises.writeFile(file, JSON.stringify(getValue()))
      .catch((e) => { lastError = `write failed: ${e.message}`; });
  }, 1000));
}

// ── talking to the node ──────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'rpc error');
  return data.result;
}

/**
 * A `view fn`, which the node runs for free. The result arrives under one of
 * three names depending on the node's version, so all three are tried before
 * giving up.
 */
async function view(contract, method, params = []) {
  const r = await rpc('contract_call', [{
    contract,
    method,
    params: params.map(String),
    caller: 'oct1111111111111111111111111111111111111111111',
  }]);
  if (r && (r.status === 'failed' || r.success === false)) throw new Error(`${method} reverted`);
  const value = r?.result ?? r?.return_value ?? r?.value;
  if (value === undefined || value === null) throw new Error(`${method} returned nothing`);
  return String(value);
}

// ── prices ───────────────────────────────────────────────────────────────

const Q192 = 2n ** 192n;
/**
 * A pool's stored price as a human one. The stored form is the square root of
 * token1-per-token0 in base units, scaled by 2^96, so squaring it and undoing
 * the scale gives the ratio — and then the decimals of both sides shift it into
 * the units a person reads.
 *
 * The fixed-point work is done in integers before anything becomes a float: the
 * representable range spans about seventy-eight orders of magnitude, and doing
 * it in floating point loses the ends of that range entirely.
 */
const PRICE_SCALE = 10n ** 60n;
function priceFromSqrtRatio(sqrtPriceX96, decimals0, decimals1) {
  if (sqrtPriceX96 <= 0n) return 0;
  const scaled = (sqrtPriceX96 * sqrtPriceX96 * PRICE_SCALE) / Q192;
  const ratio = Number(scaled) / 1e60;
  const price = ratio * 10 ** (decimals0 - decimals1);
  return Number.isFinite(price) ? price : 0;
}

/** Token facts that never change, read once and kept. */
const tokenMeta = new Map();
async function readTokenMeta(address) {
  if (tokenMeta.has(address)) return tokenMeta.get(address);
  const meta = { decimals: 18, symbol: address.slice(0, 8) };
  try { meta.decimals = parseInt(await view(address, 'decimals', []), 10) || 18; } catch { /* keep 18 */ }
  await sleep(READ_GAP_MS);
  try { meta.symbol = (await view(address, 'get_symbol', [])).trim() || meta.symbol; } catch { /* keep the stub */ }
  tokenMeta.set(address, meta);
  return meta;
}

// ── the pool registry ────────────────────────────────────────────────────

let refreshingRegistry = false;
/**
 * Re-reads which pools the factory has. New ones are described in full — tokens,
 * fee, and both sides' decimals — because a price cannot be turned into a human
 * figure without them. Pools already known are left alone.
 */
async function refreshRegistry() {
  if (refreshingRegistry) return;
  refreshingRegistry = true;
  try {
    const count = parseInt(await view(FACTORY, 'get_pool_count', []), 10) || 0;
    let discovered = 0;
    for (let start = 0; start < count; start += 64) {
      await sleep(READ_GAP_MS);
      const packed = await view(FACTORY, 'pool_list_packed', [start, Math.min(64, count - start)]);
      for (const row of packed.split(';')) {
        if (!row.trim()) continue;
        const [address, token0, token1, fee] = row.split('|').map((s) => s.trim());
        if (!address || pools[address]) continue;
        const meta0 = await readTokenMeta(token0);
        const meta1 = await readTokenMeta(token1);
        pools[address] = {
          token0, token1, fee: parseInt(fee, 10) || 0,
          decimals0: meta0.decimals, decimals1: meta1.decimals,
          symbol0: meta0.symbol, symbol1: meta1.symbol,
        };
        discovered++;
      }
    }
    if (discovered > 0) {
      console.log(`[indexer] following ${Object.keys(pools).length} pool(s), ${discovered} new`);
      saveLater(POOLS_FILE, () => pools);
    }
    lastError = null;
  } catch (e) {
    lastError = `registry: ${e.message}`;
  } finally {
    refreshingRegistry = false;
  }
}

let polling = false;
/**
 * One sample per pool. Reads run one after another with a gap: a cycle that
 * fired every request at once would be throttled, and a throttled cycle records
 * nothing for any pool rather than something for most of them.
 *
 * A pool that has not been given an opening price yet is skipped — it has no
 * price to record, and writing zero would put a false floor in its chart.
 */
async function pollPrices() {
  if (polling) return;
  polling = true;
  const failures = [];
  try {
    for (const [address, pool] of Object.entries(pools)) {
      await sleep(READ_GAP_MS);
      try {
        const packed = await view(address, 'state_packed', []);
        const f = packed.split('|');
        if (f.length < 14) throw new Error('short state');
        const started = f[13].trim().toLowerCase() === 'true';
        if (!started) continue;
        const sqrtPriceX96 = BigInt(f[4].trim() || '0');
        const price = priceFromSqrtRatio(sqrtPriceX96, pool.decimals0, pool.decimals1);
        if (!(price > 0)) continue;
        const point = {
          time: Math.floor(Date.now() / 1000),
          price,
          tick: parseInt(f[5].trim(), 10) || 0,
          liquidity: f[6].trim() || '0',
        };
        const points = series[address] || (series[address] = []);
        points.push(point);
        if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);
      } catch (e) {
        failures.push(`${address.slice(0, 10)}: ${e.message}`);
      }
    }
    saveLater(SERIES_FILE, () => series);
    lastPriceCycle = Date.now();
    // One pool being unreadable is normal; every pool failing is the node.
    lastError = failures.length && failures.length === Object.keys(pools).length
      ? `prices: ${failures[0]}`
      : null;
  } finally {
    polling = false;
  }
}

// ── events ───────────────────────────────────────────────────────────────

/**
 * Events worth keeping, by the contract that emits them. Anything else a
 * contract emits is dropped here rather than filling the file with noise.
 */
const TRACKED_EVENTS = new Set([
  // pools
  'Initialize', 'Mint', 'Burn', 'Collect', 'Swap', 'Flash', 'SetFeeProtocol', 'CollectProtocol',
  // factory
  'PoolCreated', 'FeeTierEnabled',
  // position manager
  'PositionMinted', 'LiquidityIncreased', 'LiquidityDecreased', 'FeesCollected', 'PositionBurned',
  'Transfer', 'Approval', 'ApprovalForAll',
  // router
  'Routed',
  // token launcher
  'TokenLaunched',
  // ownership and pausing, wherever they come from
  'OwnerTransferProposed', 'OwnerTransferred', 'PausedSet',
]);

let pollingEvents = false;
/**
 * Events since the last block this saw, from the factory, the manager, the
 * router, the launcher and every pool.
 *
 * Not every node exposes a log query. When one does not, this gives up after the
 * first attempt and says so on /health, rather than retrying a call that will
 * never work — the interface reads its live state from the contracts anyway, so
 * the only thing lost is the recent-activity list.
 */
async function pollEvents() {
  if (pollingEvents || !eventsSupported) return;
  pollingEvents = true;
  try {
    const head = await rpc('get_block_height', []).catch(() => null);
    const currentBlock = Number(head?.block_height ?? head?.height ?? 0);
    if (!currentBlock) { eventsSupported = false; return; }
    if (lastEventBlock === 0) lastEventBlock = Math.max(0, currentBlock - 100);
    if (currentBlock <= lastEventBlock) return;

    const fromBlock = lastEventBlock + 1;
    const sources = [...WATCHED, ...Object.keys(pools).map((p) => ['pool', p])];
    let added = 0;
    for (const [kind, contract] of sources) {
      await sleep(READ_GAP_MS);
      let logs;
      try {
        logs = await rpc('get_logs', [{ from_block: fromBlock, to_block: currentBlock, contract }]);
      } catch {
        // The first source failing this way means the method is absent.
        if (added === 0 && kind === 'factory') { eventsSupported = false; return; }
        continue;
      }
      if (!Array.isArray(logs)) continue;
      for (const log of logs) {
        const name = log.event || log.type || 'Unknown';
        if (!TRACKED_EVENTS.has(name)) continue;
        events.push({
          block: log.block_height ?? log.block ?? currentBlock,
          time: Math.floor(Date.now() / 1000),
          source: kind,
          contract: log.contract || contract,
          event: name,
          data: log.data ?? log,
        });
        added++;
      }
    }
    if (added > 0) {
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
      saveLater(EVENTS_FILE, () => events);
    }
    lastEventBlock = currentBlock;
  } finally {
    pollingEvents = false;
  }
}

// ── the loops ────────────────────────────────────────────────────────────

// The registry comes first, because there is nothing to sample until it is known
// what exists. It runs in the background rather than being awaited: discovering a
// large registry takes a couple of reads per token, and the chart of whatever was
// already on disk should be servable while that happens.
void refreshRegistry().then(() => { void pollPrices(); void pollEvents(); });
setInterval(() => { void refreshRegistry(); }, REGISTRY_CYCLE_MS);
setInterval(() => { void pollPrices(); }, PRICE_CYCLE_MS);
setInterval(() => { void pollEvents(); }, EVENT_CYCLE_MS);

// ── the http surface ─────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', true);

// A modest per-address limit. This serves one chart per page, so a caller asking
// more than once a second is not drawing a chart.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const rateLimits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt + RATE_WINDOW_MS) rateLimits.delete(ip);
  }
}, 5 * 60_000);

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimits.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_WINDOW_MS; }
  entry.count++;
  rateLimits.set(ip, entry);
  if (entry.count > RATE_MAX) { res.status(429).json({ error: 'rate limit exceeded' }); return; }
  next();
});

// Only the origins that are meant to read this. Anything else gets the data
// without the header, which the browser then refuses to hand to the page.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
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

const clamp = (raw, fallback, max) => Math.min(Math.max(parseInt(raw, 10) || fallback, 0), max);

/** The pool with the most samples, for a caller that has not named one. */
function busiestPool() {
  let best = null;
  let bestPoints = -1;
  for (const [address, points] of Object.entries(series)) {
    if (points.length > bestPoints) { best = address; bestPoints = points.length; }
  }
  return best;
}

app.get('/health', (_req, res) => {
  res.json({
    status: lastError ? 'error' : 'ok',
    network,
    factory: FACTORY,
    pools: Object.keys(pools).length,
    points: Object.values(series).reduce((n, points) => n + points.length, 0),
    lastSample: lastPriceCycle ? Math.floor(lastPriceCycle / 1000) : null,
    events: eventsSupported ? events.length : null,
    // The reason stays here; a caller does not need the node's wording.
    errorCode: lastError ? 'rpc_error' : null,
  });
});

app.get('/api/pools', (_req, res) => {
  res.json(Object.entries(pools).map(([address, pool]) => {
    const points = series[address] || [];
    const last = points[points.length - 1];
    return {
      address, ...pool,
      points: points.length,
      price: last ? last.price : null,
      tick: last ? last.tick : null,
      liquidity: last ? last.liquidity : null,
      updated: last ? last.time : null,
    };
  }));
});

/**
 * A pool's price history, oldest first, in the shape a chart consumes.
 *
 * `pool` names the market. Without it the busiest one is served, so an
 * unparameterised request still draws something.
 */
app.get('/api/prices', (req, res) => {
  const requested = typeof req.query.pool === 'string' ? req.query.pool.trim() : '';
  const address = requested || busiestPool();
  if (!address) { res.json([]); return; }
  if (requested && !series[requested]) {
    // Not an error: a pool created a minute ago has nothing to show yet.
    res.json([]);
    return;
  }
  const points = series[address] || [];
  const limit = clamp(req.query.limit, 1000, MAX_POINTS);
  const offset = clamp(req.query.offset, 0, MAX_POINTS);
  const end = points.length - offset;
  res.json(points.slice(Math.max(0, end - limit), Math.max(0, end)).map((p) => ({
    time: p.time, price: p.price,
  })));
});

app.get('/api/events', (req, res) => {
  if (!eventsSupported) {
    res.json({ total: 0, lastBlock: 0, supported: false, events: [] });
    return;
  }
  let filtered = events;
  const byEvent = typeof req.query.event === 'string' ? req.query.event : '';
  const byContract = typeof req.query.contract === 'string' ? req.query.contract : '';
  if (byEvent) filtered = filtered.filter((e) => e.event === byEvent);
  if (byContract) filtered = filtered.filter((e) => e.contract === byContract);
  const limit = clamp(req.query.limit, 100, 1000);
  const offset = clamp(req.query.offset, 0, MAX_EVENTS);
  const end = filtered.length - offset;
  res.json({
    total: filtered.length,
    lastBlock: lastEventBlock,
    supported: true,
    events: filtered.slice(Math.max(0, end - limit), Math.max(0, end)),
  });
});

app.listen(PORT, () => {
  console.log(`[indexer] ${network} on http://localhost:${PORT}, following ${FACTORY}`);
});
