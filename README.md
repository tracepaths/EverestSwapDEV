# EverestSwap — contracts and tooling

The concentrated-liquidity exchange that EverestSwap runs on Octra: the smart
contracts, the scripts that deploy and check them, and an optional price indexer.
The interface is a separate repo (`everestswap-frontend`).

Start with **[AGENTS.md](AGENTS.md)** for how the pieces fit together, and
**[contracts/LANGUAGE-NOTES.md](contracts/LANGUAGE-NOTES.md)** before editing any
contract — it records how the contract language actually behaves, as measured on a
node, which is not always what the syntax implies.

## What it does

Liquidity is placed into a chosen price range rather than spread across every
price at once, so a provider earns fees where they expect a pair to trade and
commits far less capital to do it. Prices are tracked as a Q64.96 square root and
the pool moves tick by tick as it fills a trade.

- **Ranged liquidity** — each position is a price band with its own fees.
- **Fee tiers** — 0.01% / 0.05% / 0.30% / 1.00%, each with its own tick spacing.
- **Transferable positions** — a position is a non-fungible object held by the
  position manager and can be moved or sold without being withdrawn.
- **Multi-hop routing** — the router trades across up to three pools in one
  transaction, exact-input or exact-output.
- **Token launcher** — an optional factory for spawning OCS01 tokens.

## Contracts

The addresses live in **`deployments-cl.json`**, written by the deployer, so this
file does not repeat them — a copied address block is how documentation ends up
pointing at a retired deployment. To see what is live:

```bash
node scripts/verify-contracts.mjs
```

The five that make up the exchange:

| Contract | Role |
|---|---|
| `EverestFactory` | registry; spawns and prices pools, owns the fee-tier table |
| `EverestPool` | one pair at one fee tier — price, ticks, liquidity, fee growth, oracle |
| `EverestPositionManager` | wraps a range as a transferable position with an id |
| `EverestRouter` | routes trades across one to three pools |
| `EverestTokenLauncher` | optional OCS01 token factory |

`WOCT` (wrapped native coin), `OES`, the launcher's `Token` template and the
`IOCS01` token interface are deployed independently and predate the exchange.

## Layout

```
contracts/            built AML — do not edit by hand
  src/*.aml.in        the sources; build.mjs expands these
  lib/*.aml.inc       shared math, inlined into the pool
  LANGUAGE-NOTES.md   measured behaviour of the language
scripts/              deploy, verify, end-to-end exercises
  lib/                signing, RPC, compile helpers
indexer/              optional price-history service (nothing depends on it)
```

## Setup

```bash
npm install
node build.mjs                    # expand sources and type-check over RPC
node scripts/preflight.mjs        # size / instruction / function-count budget
node scripts/deploy-cl.mjs        # deploy — resumable, writes deployments-cl.json
node scripts/verify-contracts.mjs # read-only check of what is deployed
node scripts/e2e-cl.mjs           # mint, swap, collect, burn against devnet
node scripts/e2e-route.mjs        # multi-hop routing against devnet
bash scripts/run-tests.sh         # lint, types, tests, audit, deployed contracts
```

`deploy-cl.mjs` records each step and skips what is already done, so an
interrupted run continues rather than starting over. Nothing under `scripts/`
hardcodes an address; the RPC endpoint comes from `RPC_URL` in `.env` and
defaults to devnet.

## RPC

- **Devnet**: `https://devnet.octrascan.io/rpc`
- **Mainnet**: `https://octra.network/rpc`

## License

MIT
