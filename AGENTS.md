# EverestSwap Backend — Agent Guide

## Project Structure

```
everestswapdev/
  contracts/       AML smart contracts (*.aml)
  scripts/         deploy.js, liquidity.js, test-swap.js, etc.
  indexer/         Price indexer
```

## Repos

- **Frontend**: `tracepaths/EverestSwap` (React + Vite app)
- **Backend**: `tracepaths/EverestSwapDEV` (this repo — contracts, scripts, deployment)

## Contract Addresses (V7 — Devnet, Redeployed 2026-06-30)

- OES: `oct9LgGSpkrqbpWPQpYervyryzDtbGYph2hHvcBi9ZppNvD` (unchanged)
- WOCT: `oct4pAKouypxmP7Uk79uGzEpkkidsNAK3fQhxy1HDUmBRLE`
- SwapPool: `octHzDX3aUCvFVRifUQoPdsaXqSvRLozGqJu3wzSDk2AZ25`
- SwapFactory: `oct6QAJuPwbfHQUb1uQBsuceQgATK5AqStqwQPhPv29BmQx`
- Router: `oct27w262B5fscy8mRRdAtTTYrRgpR2sseJyp2HMGWYGaWW`

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
- **SwapPool.aml** — AMM with x*y=k, 0.3% fee (max 1%). Fee-on-transfer safe (balance-before/after). Initial price ratio capped at 100:1. Position-based LP tracking.
- **SwapFactory.aml** — Pool registry. `register_pool(addr)` is **permissionless**. Setter transfer has 24h timelock. Trusted token list capped at 100.
- **Router.aml** — `swap_exact_tokens_for_tokens(amountIn, minOut, recipient)` — max slippage 10%. Factory/WOCT address changes have 24h timelock.

## Token Grant/Pull Pattern

User must always `grant()` allowance to a contract before that contract can `pull()` tokens from the user:
1. User calls `token.grant(contract, amount)` — signs tx
2. Contract internally calls `token.pull(user, contract, amount)` — moves tokens

## Useful Commands

```bash
npm install --prefix .              # Install script deps (bs58, tweetnacl)
node scripts/deploy.js              # Deploy all V2 contracts
node scripts/setup-liquidity.js     # Seed liquidity
node scripts/test-swap.js           # Test swap flow
```

## Safety Notes

- All string values in canonical JSON must be escaped (`"` → `\"`, `\` → `\\`)
- Nonce must increment by 1 for each transaction, including failed ones
- `ou` is max fee; actual cost may be lower (effort * gas price)
- Frontend uses token addresses from `types/index.ts` — update when redeploying
- NEVER commit deployer mnemonics or private keys to git
- **Timestamps MUST be floats** — integer timestamps cause "invalid signature" errors
- **Fee-on-transfer tokens** are safe — pool uses balance-before/after pattern
- **Max slippage** is 10% (1000 bps) on Router
- **Setter transfer** on Factory has 24h timelock
