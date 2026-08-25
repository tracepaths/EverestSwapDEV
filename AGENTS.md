# EverestSwap contracts — orientation

This is the contract and tooling half of EverestSwap. The interface lives beside
it in `everestswap-frontend`.

The exchange is a concentrated-liquidity automated market maker: instead of one
pool holding a single price curve across all prices, liquidity is placed by its
provider into a chosen price range, and the pool tracks which ranges are active
as the price moves. A provider who expects a pair to trade between 0.9 and 1.1
puts their capital there and earns the fees on that band, rather than spreading
it from zero to infinity. The cost of that efficiency is that a position can fall
out of range and stop earning, and that positions are individual rather than
interchangeable.

## Layout

```
contracts/            the deployed AML (built, do not edit by hand)
  src/*.aml.in        the sources; build.mjs expands these
  lib/*.aml.inc       shared math (tickmath, bitmap, swapmath), inlined into the pool
  LANGUAGE-NOTES.md   measured behaviour of the language — read this first
scripts/              deploy, verify, end-to-end exercises
  lib/                signing, RPC, compile helpers
indexer/              optional price-history service (the chart; nothing depends on it)
```

`build.mjs` expands `contracts/src/*.aml.in` into `contracts/*.aml` by resolving
`// @include lib/<file>` and then type-checks each result over RPC. Edit the
`.aml.in`, never the generated `.aml` — a change to the output is erased by the
next build.

Four contracts have no source to expand and are edited directly: `WOCT.aml` (the
wrapped native coin), `OES.aml`, `Token.aml` (the launcher's template) and
`IOCS01.aml` (the token interface the others call through). They are deployed
independently of the exchange and predate it.

**Read `contracts/LANGUAGE-NOTES.md` before changing a contract.** It records
what the language actually does as measured on a node, including several things
the syntax implies but does not deliver. Most of the odd-looking code here is
there because of one of those entries.

## The five contracts

**EverestFactory** — the registry. Holds the pool template and spawns pools with
`create_pool(token_a, token_b, fee, sqrt_price)`, which configures and prices the
new pool in the same transaction so nobody can set the opening price in between.
Owns the fee-tier table (`enable_fee_tier`) and proxies the protocol fee switch so
pools have a single administrator. Token order is whatever the creator passed —
the registry indexes both directions, and the pool's own `get_token0` is the
canonical answer.

**EverestPool** — one pair at one fee tier. Holds the price as a Q64.96 square
root, the current tick, the active liquidity, the per-tick liquidity and its
bitmap, the two fee-growth accumulators, and a ring-buffer price oracle. The
entry points are `mint`, `burn`, `collect`, `poke`, `swap` and `flash`; ranges are
addressed by `(owner, lower, upper)`, so the pool itself has no notion of a
position id. This is the largest contract and the one closest to the language's
function-count ceiling — see the note in LANGUAGE-NOTES.md before adding to it.

**EverestPositionManager** — turns a range into a transferable object. It holds
the pool's positions in its own name and issues an id per position, with a
minimal non-fungible registry (`owner_of`, `approve`, `set_approval_for_all`,
`transfer_from`) so a range can be sold or moved without withdrawing it.
`mint`, `increase_liquidity`, `decrease_liquidity`, `collect` and `burn` are the
lifecycle; `settle` brings a position's owed fees up to date.

**EverestRouter** — trades across one, two or three pools in a single
transaction, exact-input or exact-output (`exact_input_single`,
`exact_input_two`, `exact_input_three`, and the three `exact_output_*` mirrors).
It holds no state worth stealing and sweeps itself clean at the end of every
trade. `quote_*` views price a route without spending anything, which is what the
interface uses for every quote it shows.

**EverestTokenLauncher** — spawns `Token.aml` for anyone who wants one. Entirely
optional: the interface hides token creation when this is not deployed.

## Addresses

`deployments-cl.json` is the record; `scripts/deploy-cl.mjs` writes it as it
goes. Nothing in `scripts/` hardcodes an address, and nothing should — a constant
in a library is how a script ends up quietly operating on a retired deployment.
The interface reads the same addresses from its own `.env`; after a redeploy,
copy them across or the two halves will disagree.

`node scripts/verify-contracts.mjs` reads that file and checks the deployment
against itself: that the manager and router point at the factory the registry
belongs to, that every fee tier carries its intended spacing, that each pool's
own account of itself matches the registry's, and that every token the interface
expects has the symbol and decimal count the interface believes. It is read-only
and free, so run it after every deploy and first whenever something looks wrong.

## Flows

Amounts are always integers in the token's own smallest unit. Every
liquidity-changing call takes a `deadline` in epochs and a slippage bound, and
every one of them reverts rather than partially filling.

**Opening a range.** Grant both tokens to the manager, then call
`mint(pool, lower, upper, amount0_desired, amount1_desired, amount0_min, amount1_min, recipient, deadline)`.
The ticks must be multiples of the pool's spacing. It returns the new position id.
A range entirely above or below the current price is single-sided and takes only
one of the two tokens — that is a legitimate way to place a resting order, not an
error.

**Adjusting one.** `increase_liquidity(token_id, …)` adds on the same range;
`decrease_liquidity(token_id, liq, …)` removes part or all of it, which credits
the withdrawn tokens and any earned fees as owed rather than transferring them.
`collect(token_id, recipient, amount0_max, amount1_max)` is what actually pays
out. `burn(token_id)` retires an empty position and its id.

**Trading.** Grant the input token to the router, then call the `exact_input_*`
or `exact_output_*` function matching the number of pools in the route. Each hop
takes the pool and a direction as an int: **`1` sells token0 for token1, `0` sells
token1 for token0.** The direction is read against that pool's own token order,
not the order the caller has in mind — and it is an int rather than a bool because
a bool through `call()` arrives as `true` regardless of what was sent. Price the route with the `quote_*` views first;
they are views, so they cost nothing.

**Wrapping.** The native coin cannot be held by a pool, so trades involving it go
through the wrapped token. `deposit()` is payable and mints 1:1. Unwrapping is two
calls, not one: `withdraw(amount)` burns the wrapped balance and records what is
owed, then `claim_withdrawal()` pays out the native coin. An interface that stops
after `withdraw` leaves the user's coin sitting claimable and looks like a loss.

**Granting.** A contract can never take tokens it was not given. Every flow above
starts with the user calling `grant(contract, amount)` on the token; the contract
then calls `pull` inside its own transaction. A missing grant is the most common
cause of a reverted first attempt.

## Transactions

Canonical JSON, and the field order matters:

```
{"from":"…","to_":"…","amount":"…","nonce":N,"ou":"…","timestamp":TS,"op_type":"…"}
```

Signed Ed25519 detached, signature base64, string values JSON-escaped. `op_type`
is `deploy` (bytecode hex in `encrypted_data`) or `call` (method name in
`encrypted_data`, JSON params array in `message`).

**Timestamps must be floats.** An integer timestamp produces "invalid signature"
with no hint that the timestamp is what was wrong.

Key derivation:

```
mnemonic → PBKDF2-HMAC-SHA512(2048, "mnemonic") → 64-byte seed
HMAC-SHA512("Octra seed", seed) → first 32 bytes → Ed25519 seed
Ed25519 keypair → SHA256(pubkey) → Base58 → "oct" + b58
```

`ou` is a ceiling, not a price; the node charges by measured effort. What the
scripts use: `200000` to deploy, `400000` for a call that spawns a contract,
`20000` for a swap or a position change, `1000` for anything else.

## Node behaviour that will otherwise cost you an afternoon

**A reverted call leaves no receipt and consumes no nonce.** So a failure looks
exactly like a dropped transaction, and re-reading the nonce from
`octra_balance` hands back the same one — which the node then rejects as a
duplicate unless the fee is raised by at least 10%. The helpers in
`scripts/lib/` bump 25% on retry. If a retry loop never converges, this is why.

**Ask why, rather than assuming.** `octra_transaction` reports the rejection
reason including the failing `require`, so a missing receipt is a question to ask
the node, not a timeout to wait out.

**Receipt polling can outrun indexing.** A call may report no receipt and still
have succeeded. Confirm against contract state before concluding it failed.

**The public node rate-limits bursts** and answers 429 with an HTML body that is
not JSON. Every multi-read loop in this repo is sequential on purpose.

## Commands

```bash
npm install                       # script dependencies
node build.mjs                    # expand sources and type-check over RPC
node build.mjs EverestPool        # just one
node scripts/preflight.mjs        # size, instruction and function-count budget
node scripts/deploy-cl.mjs        # deploy, resumable, writes deployments-cl.json
node scripts/verify-contracts.mjs # read-only check of what is deployed
node scripts/e2e-cl.mjs           # mint, swap, collect, burn against devnet
node scripts/e2e-route.mjs        # multi-hop routing against devnet
bash scripts/run-tests.sh         # every gate: lint, types, tests, audit, contracts
```

`deploy-cl.mjs` records each step in `deployments-cl.json` and skips what is
already done, so an interrupted run continues rather than redeploying.

## Safety

- Never commit a mnemonic or private key. The deployer's lives in `.env`, which is
  gitignored — and no env file belongs in the interface repo under a prefix the
  browser can read.
- After a redeploy, update the interface's `.env` in the same sitting. A build
  pointing at a retired factory fails in a way that looks like a broken node.
- Ownership transfer on the factory and the launcher is two-step
  (`propose_owner` then `accept_owner` by the proposed address), so a typo cannot
  strand the contract.
- The peripheral contracts have owner powers the exchange contracts do not:
  `WOCT.rescue_native` can take native coin that reached the contract without
  going through `deposit`, and `OES`/`Token` can freeze an address and control a
  rewards vault. None of them can touch a pool or a position, but they are trust
  assumptions a listed token inherits.
- Pools assume a token moves exactly the amount asked for. A token that skims a
  fee on transfer, or rebases, will leave a pool quietly short against its own
  accounting — do not list one. The only place a balance is measured rather than
  trusted is the flash-loan repayment check.
