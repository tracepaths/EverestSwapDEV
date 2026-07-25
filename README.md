# EverestSwap Backend

Smart contracts, deployment scripts, and tooling for EverestSwap DEX on Octra Network.

## Features

- **Swap** — Constant-product AMM (x*y=k) with 0.3% fee
- **Liquidity** — Add/remove liquidity, earn LP tokens
- **Pool Creation** — Permissionless pool registration via factory
- **Token Standard** — OCS01 ERC20-compatible tokens
- **[V9] Reward Pools** — Custom reward distribution with any OCS01 token, linear distribution, anti-rugpull protection

## Repos

| Repo | Description |
|------|-------------|
| [tracepaths/EverestSwap](https://github.com/tracepaths/EverestSwap) | Frontend — React + Vite + TypeScript |
| [tracepaths/EverestSwapDEV](https://github.com/tracepaths/EverestSwapDEV) | Backend (this repo) — contracts, scripts, deployment |

## Contracts (Devnet — V6)

| Contract | Address |
|---|---|
| OES Token | `octGURUy7hQhXHVcP9bovbJnpoXqCv2gpWBrk6fqtXqJ2sC` |
| WOCT | `oct3taQXSQetRSmq21hfLmc1ormx7svm112cUB5uEze3oVe` |
| SwapPool | `octFh3NNUj2JmAorPcrLfcy4bzf5tdk88qDCdFnmjHt12X3` |
| SwapFactory | `octFmVqADVjj8v1WSr4ex6EJd2TPRf1JjUVHb3tK29YTXTV` |
| Router | `oct8FKHqsXXE8z11AwKQ7jhEeU7tXefeY4tTRZEnoWK5S3r` |

## Project Structure

```
contracts/       AML smart contracts (*.aml)
scripts/         deploy.js, liquidity.js, test-swap.js, etc.
indexer/         Price indexer
```

## Setup

```bash
npm install
node scripts/deploy.js              # Deploy all V6 contracts
node scripts/setup-liquidity.js     # Seed liquidity
node scripts/test-swap.js           # Test swap flow
```

## RPC

- **Devnet**: `https://devnet.octrascan.io/rpc`
- **Mainnet**: `https://octra.network/rpc`

## License

MIT
