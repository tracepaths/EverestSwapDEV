# EverestSwap

A decentralized exchange (DEX) on Octra Network (Devnet) built with AppliedML (AML).

## Features

- **Swap** — Constant-product AMM (x\*y=k) with 0.3% fee
- **Liquidity** — Add/remove liquidity, earn LP tokens
- **Limit Orders** — Place and fill limit orders
- **DCA** — Dollar-cost averaging strategies

## Contracts (Devnet)

| Contract | Address |
|---|---|
| OES Token | `oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD` |
| SwapPool | `oct7NFoitzUc5xYE4YRPwqVHigmFiBHYSfQEJ1eLg3jCTjU` |
| SwapFactory | `oct53kXW7VFzPh9At6VfzecThJNc5riHoeBG63hEUZZtjm7` |
| Router | `octAT2biFkboZGvtNUeQSaemYjHFjPFaiRqq7A22YDzJup3` |
| LimitOrder | `oct4AjSxvKqcxJ6WAcR1DhphdtJkDxcZG5HYPi4qqwrL9qz` |
| DCA | `oct3wZHLn3JCQqtmtWt6rimkbrxvH9txiktdUAbFuXaJ42f` |

## Pool Status

- **Liquidity**: 10 OCT / 200,000 OES
- **LP minted**: 2,000,000,000,000,000,000 LP
- **Fee**: 0.3%

## Setup

```bash
npm install
cd frontend && npm install && npm run dev
```

## Development

- `contracts/` — AML smart contracts
- `frontend/` — React + Vite + TypeScript + Tailwind CSS v4
- `scripts/` — Deployment and interaction scripts

## RPC

- Devnet: `https://devnet.octrascan.io/rpc`
- Mainnet: `https://octra.network/rpc`

## Deployer

Wallet: `octGXi34vZfYwi3idjSa6m34vLJCoJHNMNAGeHyqh7JVEvy`
