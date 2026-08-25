# Price history

The exchange itself does not need this process. Every balance, quote and position
the interface shows is read straight from the contracts. What a contract cannot
answer is what something cost an hour ago, because it only holds the present — so
this samples each pool's price on a timer and keeps the series on disk.

If it is not running, the interface omits the price chart and everything else
works unchanged.

## Running it

Point it at a factory and start it:

```
# indexer/env.devnet
RPC_URL=https://devnet.octrascan.io/rpc
FACTORY_ADDRESS=oct...
POSITION_MANAGER_ADDRESS=oct...    # optional, for its events
ROUTER_ADDRESS=oct...              # optional
TOKEN_LAUNCHER_ADDRESS=oct...      # optional
PORT=3123
```

```
npm install
npm run start:devnet
```

Anything in the file can be overridden by an environment variable of the same
name. Only `FACTORY_ADDRESS` is required — the pools are discovered from it, so a
pool someone creates later is picked up within a few minutes without a restart.

The interface finds it at `http://localhost:3123` when both are running locally.
For anything else it must be served over HTTPS: the interface refuses a plain-HTTP
indexer on a public host, because a chart is worth less than the ability to
tamper with one.

## What it serves

| | |
|---|---|
| `GET /health` | whether it is working, how many pools it follows, when it last sampled |
| `GET /api/pools` | every pool it knows, with its latest price, tick and liquidity |
| `GET /api/prices?pool=<address>` | that pool's price history, oldest first. `limit` and `offset` page it. Without `pool`, the busiest one |
| `GET /api/events?event=&contract=` | recent contract events, when the node offers a log query. `supported: false` when it does not |

A pair traded at two fee tiers is two markets with two prices, so each pool has
its own series and `pool` is how a caller picks one. Averaging them would
describe neither.

## Notes

Reads are deliberately unhurried — one at a time with a pause between, a price
cycle every fifteen seconds, the registry every five minutes. A public node
rate-limits bursts, and being slow to notice a new pool costs one chart a few
minutes while being throttled costs every chart everything.

`data/` holds the series, the pool descriptions and the events, and is safe to
delete: it refills from the chain, minus the history that was in it.

Only one instance can run per directory. A second would interleave writes into
the same files and leave a series with the samples of both and the ordering of
neither, so it checks for a live pid and exits.
