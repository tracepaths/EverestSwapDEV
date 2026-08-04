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

## Contract Addresses (V12.1 — Devnet, Redeployed 2026-08-04)

- OES: `octGURUy7hQhXHVcP9bovbJnpoXqCv2gpWBrk6fqtXqJ2sC` (redeployed 2026-07-25, owner: oct2mhQQYM3MmDwMxbcpvTCMgSVPxh47YUdZGn3aR1r13PK)
- WOCT: `oct4g33tzC2cJncL5RFr9TRiyk8yCNP1h2xaogiWJS5opNv`
- SwapPool (template): `oct9SgrzmX3tyaRMoTHEfEVJLLdhsQ2kSo7ba7iFUq2S1Rh`
- SwapFactory: `octCSV1rFyXj3wWRvLuDZRTNNtnkv24v5FQ34xuAywVKqXu`
- Router: `octEtQJQDFC85tXtGpERHX69rNoo1GJA7EVUaLezANQxC8K` (still points at the OLD factory — repointing needs propose_factory + 24h timelock)
- RewardPool: `octCfD5XbQwiPUH1CYcQZPJuSuNEbPTtix7LfJAepeGzSr3`

### V12 changes (why this redeploy exists)

- **SwapPool**: added scalar getters `get_owner`, `is_active`, `get_reserve_a`,
  `get_reserve_b`, `get_fee_numerator`, `get_fee_denominator`,
  `get_total_liquidity`. `remove_pool` used to call `owner`/`reserve_a`/
  `reserve_b`/`total_lp` which are bare STORAGE FIELDS, not callable functions —
  every call reverted with "method not found", so pool removal never worked.
- **SwapFactory `remove_pool`**: now gates on `get_total_liquidity() == 0`
  instead of `reserves == 0 && total_lp == 0`. The old gate was unreachable:
  `minimum_liquidity` (1000) is burned permanently on the first add_liquidity, so
  `total_lp` and the backing dust reserves never return to 0.
- **SwapFactory `create()` / `launch()`**: added the missing
  `token.grant(pool, amount)` calls before `add_liquidity_for`. Both functions
  pull the user's tokens into the FACTORY, then have the POOL pull from the
  factory — without the grant the inner `pull()` reverted ("token_a pull
  failed"), which silently killed every create/launch.

### Devnet node behaviour worth remembering

- A **reverted call leaves NO receipt and does NOT consume the nonce**. A failing
  tx therefore looks exactly like one the node dropped. Don't assume "dropped".
- Because a revert consumes no nonce, resubmitting with a nonce re-read from
  `octra_balance` reuses the SAME nonce and the node rejects it with
  `malformed transaction / duplicate nonce (fee rate bump < 10%)`. Retries must
  raise `ou` by >=10% (the scripts here bump 25%) or they will loop forever.
  This was the cause of every "transient" failure seen while verifying V12.
- Receipt polling can outrun indexing: a call may report NO RECEIPT and still
  have succeeded. Confirm against contract state before concluding it failed.
- The node reports `ou_cost` as the base call fee (1000) but still executes
  high-effort txs (create measured at effort 27174). `ou` is not the blocker.
- `deploy()` from inside a call (SPAWN) works fine — verified with
  `contracts/SpawnProbe.aml` (effort 10621–12580, state committed).

## CAT Token (Deployed 2026-07-27)

- CAT: `octEw9XG14HA5f15mKLr3PYFbXyqMTLgDninhxrZUtyPvPe` (100B supply, 6 decimals, deployer: octDLQFPawcje9rSTXxbaf8mihhMBb5QfXUpwthxmrH1Yia)
- CAT_Pool: `octEuicdod5B7kfZa6JQsvEpu3yyTpKh9P6vhNRLotPyMz7` (WOCT/CAT, 1 OCT : 1000 CAT, max_initial_price_ratio=1000, registered on factory)
- Liquidity: 70% position retained (~700,032 WOCT : ~700,031,737 CAT), 30% position removed
- Scripts: `scripts/deploy-cat.js` (full deploy), `scripts/fix-cat-liquidity.js` (split-position liquidity fix)
- NOTE: `remove_liquidity(position_id, ...)` removes the ENTIRE position — no partial-amount parameter. For "remove sebagian", add liquidity as multiple positions and remove one.
- NOTE: Devnet fees are dynamic — fetch via `octra_recommendedFee(opType)` (deploy ≈ 200000, call ≈ 1000). Old hardcoded `FEE_OU='100000'` fails with "fee too low".

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
- **RewardPool.aml** — [V9] Extended AMM with custom rewards. Same x*y=k as SwapPool + linear reward distribution. `set_reward_config()` (one-shot, immutable), `claim_reward()`, `emergency_withdraw()` (7-day cooldown after reward end). Reward token must be OCS01-compatible. Creator LP locked min 7 days.

## Reward Pool Flow

### Creating a Reward Pool

1. Deploy `RewardPool.aml` — same compile/deploy flow as SwapPool
2. Call `set_tokens(tokenA, tokenB)` on pool
3. Call `set_reward_config(rewardToken, amount, startEpoch, endEpoch)` — **one-shot, immutable**
4. Call `register_reward_pool(tokenA, tokenB, rewardToken, poolAddr)` on factory
5. Call `rewardToken.grant(poolAddr, amount)` to fund rewards
6. Optional: `add_liquidity()` with initial liquidity

### Claiming Rewards

```
to_: "<pool>", amount: "0",
encrypted_data: "claim_reward", message: "[]"
```

Pool calculates: `per_epoch × elapsed × user_lp / total_lp` and transfers reward tokens.

### Emergency Withdraw (Anti-Rugpull)

Available only after `reward_end` + 7-day cooldown (100800 epochs). Creator can withdraw remaining unfunded rewards.

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
