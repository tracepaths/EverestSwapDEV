# Working notes on the contract language

Everything below was measured on a node, not read in a specification. Each entry
cost a deploy and a probe to establish, and several of them contradict what the
syntax implies — which is why they are written down rather than left to be
rediscovered. The code in this directory already accounts for all of them; this
file explains *why* it is shaped the way it is, so that a later change does not
undo a workaround that looks redundant.

## Arithmetic

**Integers are arbitrary precision.** There is no wraparound and no 64-bit
ceiling, so an overflow guard is dead code. Do not add one, and do not trust one
found in older sources: `require(a + b >= a, "overflow")` can never fail here.
This is what makes 128-bit fee accumulators and Q64.96 prices safe to hold
directly, with no split-word arithmetic.

**Division truncates toward zero, not toward negative infinity.** So `-7 / 2` is
`-3`, not `-4`, and `-7 % 2` is `-1`, not `1`. Tick arithmetic is signed and
needs floor semantics throughout — a position aligned with truncating division
lands one tick off on the negative side of the price scale, which is a one
basis point error in someone's money. `floor_div` and `floor_mod` in
`EverestPool.aml` exist for this reason and every signed tick calculation goes
through them.

**No bitwise operators.** No `&`, `|`, `^` or shifts. The tick bitmap is
therefore built on `%` and `/` against powers of two, and `msb`/`lsb` binary
search on "are the low k bits zero" instead of masking. `x & -x` has no
translation; use `lsb`.

## Control flow

**`for` loops do not work.** Use `while` with an explicit counter.

**No `break` and no `continue`.** Loops carry a sentinel condition instead, which
is why several loops here read as `while i < n && !done`.

**63 registers per function.** A long function fails to compile with no useful
message. The fix is always to split it, which is why the swap loop is spread
across `step_*` helpers rather than written inline.

**About 98 functions per contract.** Past that the node rejects the bytecode with
`invalid_bytecode: duplicate JDEST` — a label-space exhaustion, not a size limit,
so it cannot be worked around by shortening code. `EverestPool.aml` is the one to
watch: it currently sits at 87 functions, leaving roughly eleven. `preflight.mjs`
reports the count before a deploy, and `lib/jdest.mjs` recognises the failure so
it is not mistaken for a network problem.

## The type system

**No structs.** Related fields are either parallel maps keyed the same way, or a
single `string` with `|`-delimited fields. The `*_packed` views are the second
approach, and they exist as much to keep the caller's request count down as to
work around the missing type.

**A `list` cannot live inside a `map`.** This is the constraint that shapes the
position registry: "the positions this address holds" wants to be
`map[address]list[int]` and cannot be. It is stored as
`map[address]map[int]int` — owner to slot to id — with a separate id-to-slot map
so that removal is a swap-and-pop rather than a scan.

**`len()` returns 1 for any state list, always.** It is not a length. Keep an
explicit counter beside every list; `push` and index reads are both fine, so the
list itself is trustworthy and only its length is not.

**An unset address reads back as the string `"0"`.** Not `""`, which is what the
obvious `== ""` check looks for — so a one-time setter guarded that way can never
be set, and one guarded the other way can be set twice. Every contract here has
an `unset(a)` helper that accepts both spellings, and every address guard uses
it.

## Calls and context

**`origin` is not the transaction originator.** In a nested call it takes the
value of `caller`, so it identifies the immediate caller and nothing more. Never
authorize a user by `origin`; it would authorize any contract that happens to be
between them.

**A `bool` argument passed through `call()` arrives as `true`.** Both `true` and
`false` do. Cross-contract flags are therefore ints — `1` and `0` — everywhere in
this codebase, and the direction argument to a pool's `quote` is an int for
exactly this reason. The same mangling appears over RPC, where the *string*
`"false"` is truthy: a boolean parameter sent from an interface has to be a real
JSON boolean, not the string form.

**A `view fn` may call another contract.** Free cross-contract reads work, which
is what lets the router quote a route and the manager read a pool's fee growth
without a transaction.

**`balance_of` is intercepted over RPC.** The node answers it from its own token
accounting rather than running the contract, so a non-token contract that
defines `balance_of` reads back `0` no matter what it returns. Name such a view
something else — the position manager's holder count is `position_count`, not
`balance_of`, for this reason.

## The chain

**An epoch is not a second.** It is about 12.86 seconds. Any duration expressed
in epochs must be derived rather than assumed, or a "24 hour" timelock becomes
about two and a half hours. The interface routes every duration through
`src/config/epochs.ts`; contracts state the conversion where they use it.

**A missing receipt is not a timeout.** `octra_transaction` reports why a
transaction was rejected, including the revert reason, so a call that produced no
receipt should be asked about rather than retried blindly. `lib/octra-chain.mjs`
does this, which is why its failures name the failing `require` instead of saying
the network was slow.

**The public devnet node rate-limits bursts** and answers 429 with an HTML body
that is not JSON. Every multi-read loop in the tooling and the interface is
sequential and paced on purpose; making one concurrent to "speed it up" trades a
slow read for an unparseable error.
