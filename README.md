# EverestSwap Backend

Smart contracts, deployment scripts, and tooling for EverestSwap DEX on Octra Network.

## Features

- **Swap** — Constant-product AMM (x*y=k) with 0.3% fee
- **Liquidity** — Add/remove liquidity, earn LP tokens
- **Pool Creation** — Permissionless pool registration via factory
- **Token Standard** — OCS01 ERC20-compatible tokens

## Repos

| Repo | Description |
|------|-------------|
| [tracepaths/EverestSwap](https://github.com/tracepaths/EverestSwap) | Frontend — React + Vite + TypeScript |
| [tracepaths/EverestSwapDEV](https://github.com/tracepaths/EverestSwapDEV) | Backend (this repo) — contracts, scripts, deployment |

## Contracts (Devnet — V6)

| Contract | Address |
|---|---|
| OES Token | `oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD` |
| WOCT | `oct3taQXSQetRSmq21hfLmc1ormx7svm112cUB5uEze3oVe` |
| SwapPool | `octSM8utNG3MLv4Fk2oY1SA2XR99o2i22QUSLbr7Te2tSM4` |
| SwapFactory | `oct6znV2kFvbNnVpQRWKUq3Hw2mhPEW5Yi5NCJfAVPhQrsE` |
| Router | `oct53wqh6cng95sjLTeLGdSWfNNtfnxy8W3A7H4NK9XmQzY` |

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
