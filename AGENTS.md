# EverestSwap — Agent Guide

## Project Structure

```
everestswap/
  contracts/       AML smart contracts (*.aml)
  frontend/src/    React + Vite + TypeScript + Tailwind v4
    pages/         SwapPage, LiquidityPage, LimitOrderPage, DCAPage, DashboardPage, PoolPage
    components/    Layout, WalletConnector
    services/      octraRpc, swapService, walletService
    contexts/      AppContext (wallet, network, RPC)
    types/         index.ts (contract addresses, token definitions)
  scripts/         deploy.js, liquidity.js, test-swap.js
  docs/            Documentation
```

## Contract Addresses (V2 — all deployed)

- OES: `oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD`
- WOCT: `oct3taQXSQetRSmq21hfLmc1ormx7svm112cUB5uEze3oVe`
- SwapPool: `oct7t3dFk1AyysnoVRwvcwqMLzgkTt8Sw78Lnuv32EtUx7r`
- SwapFactory: `octEwgKA8zRxriLdvdrTuKNeimvHTSLqt6sX6KBCUTyQfxs`
- Router: `oct53wqh6cng95sjLTeLGdSWfNNtfnxy8W3A7H4NK9XmQzY`
- LimitOrder: `octFiKogaf4ipLu2HJVJiVLwp3Vf64nC9RBHr8oLzQTqctx`
- DCA: `octJ3TsZTGBjdeLkikzrfCkDx4ptVrZfcdcn7zt6KoiEseY`
- Deployer: `octGXi34vZfYwi3idjSa6m34vLJCoJHNMNAGeHyqh7JVEvy`
- Deployer mnemonic: `pumpkin divert spend later token student spot faint collect visual carbon matter`

## RPC Endpoints

- Devnet: `https://devnet.octrascan.io/rpc`
- Mainnet: `https://octra.network/rpc`

## RPC Methods

- `octra_compileAml(source)` — compile AML source
- `octra_computeContractAddress(bytecode, deployer, nonce)` — predict address
- `octra_submit(tx)` — submit signed transaction
- `contract_call(contract, method, params, caller)` — view call
- `contract_receipt(txHash)` — get tx receipt
- `octra_balance(address)` — get OCT balance + nonce

## Transaction Format

Canonical JSON (field order matters):
```
{"from":"...","to_":"...","amount":"...","nonce":N,"ou":"...","timestamp":TS,"op_type":"..."}
```

Then signed with Ed25519 (detached), signature base64. String values must be JSON-escaped (`"` → `\"`, `\` → `\\`).

### op_type values:
- `deploy` — contract deployment (encrypted_data = bytecode hex)
- `call` — contract call (encrypted_data = method name, message = JSON params array)

## Inter-Contract Calls

AML supports the `call()` builtin for calling other contracts:
```
call(addr, "method", [params])
```

Returns the result value from the called method. Works for both state-changing calls and view functions.

## Contract Call Flows

### WOCT Deposit (OCT → WOCT)
```
to_: "<WOCT>", amount: "<oct_amount>",
encrypted_data: "deposit", message: "[]"
```

### WOCT Withdraw (WOCT → OCT)
```
to_: "<WOCT>", amount: "0",
encrypted_data: "withdraw", message: "[<woct_amount>]"
```
WOCT contract burns WOCT and sends native OCT via `transfer()`.

### Token Swap (WOCT ↔ OES via Pool)

Step 1 — grant pool allowance on the source token:
```
to_: "<source_token>", amount: "0",
encrypted_data: "grant", message: "[\"<pool>\", <amount>]"
```

Step 2 — swap via pool (token_a → token_b):
```
to_: "<pool>", amount: "0",
encrypted_data: "swap_a_for_b", message: "[<amount_in>, <min_out>]"
```

For token_b → token_a, use `swap_b_for_a`.

### Token Swap via Router

Step 1 — grant router allowance on source token:
```
to_: "<source_token>", amount: "0",
encrypted_data: "grant", message: "[\"<router>\", <amount>]"
```

Step 2 — execute swap through router:
```
to_: "<router>", amount: "0",
encrypted_data: "swap_exact_tokens_for_tokens",
message: "[<amount_in>, <min_out>, \"<recipient>\"]"
```

## Key Derivation

```
mnemonic → PBKDF2-HMAC-SHA512(2048, "mnemonic") → 64-byte seed
HMAC-SHA512("Octra seed", seed) → first 32 bytes → Ed25519 seed
Ed25519 keypair → SHA256(pubkey) → Base58 → "oct"+b58 (47 chars)
```

## Contracts Summary

- **OES.aml** — ERC20-like token (OCS01 standard). 666M supply. `transfer`, `grant`, `pull`, `balance_of`, `allowance`.
- **WOCT.aml** — Wrapped OCT. `deposit()` (payable, mints WOCT 1:1), `withdraw(amt)` (burns WOCT, sends OCT via `transfer()`), plus full IOCS01 interface.
- **SwapPool.aml** — AMM with x*y=k, 0.3% fee. Uses `call()` for token pulls. No native OCT handling.
- **SwapFactory.aml** — Pool registry. `register_pool(addr)` by deployer, `get_pool()` for address lookup.
- **Router.aml** — `swap_exact_tokens_for_tokens(amountIn, minOut, recipient)` — pulls tokens from caller, looks up pool via factory, executes swap.
- **LimitOrder.aml** — `create_order/fill_order/cancel_order` — uses `call()` for token pulls/transfers.
- **DCA.aml** — `create_dca/execute_dca/cancel_dca` — uses `call()` for token pulls/transfers. No payable methods.

## Token Grant/Pull Pattern

User must always `grant()` allowance to a contract before that contract can `pull()` tokens from the user:
1. User calls `token.grant(contract, amount)` — signs tx
2. Contract internally calls `token.pull(user, contract, amount)` — moves tokens

## Useful Commands

```bash
cd frontend && npm run build        # Build frontend
npm install --prefix .              # Install script deps (bs58, tweetnacl)
node scripts/deploy.js              # Deploy all V2 contracts
node scripts/setup-liquidity.js     # Seed liquidity
node scripts/test-swap.js           # Test swap flow
```

## Safety Notes

- All string values in canonical JSON must be escaped (`"` → `\"`, `\` → `\\`)
- Nonce must increment by 1 for each transaction, including failed ones
- `ou` is max fee; actual cost may be lower (effort * gas price)
- Pool reserves: WOCT = 10,000,000 (10 WOCT), OES = 200,000,000,000 (200,000 OES). Ratio ~1 WOCT = 18,132 OES
- Frontend uses token addresses from `types/index.ts` — update when redeploying
