# EverestSwap Security Audit — S1

**Date:** 2026-06-30
**Scope:** SwapPool.aml, SwapFactory.aml, WOCT.aml, Router.aml, OES.aml, Token.aml
**Auditor:** MiMoCode Automated Security Analysis
**Network:** Octra Devnet
**Audit Iteration:** Post V8 fixes

---

## Executive Summary

EverestSwap implements a Uniswap V2-style AMM on the Octra Network using AML (AppliedML) smart contracts. The codebase demonstrates strong security awareness with multiple audit fix iterations (V2 through V8). Overall risk is **MEDIUM** — no critical vulnerabilities enabling immediate fund theft, but several medium-severity issues require attention before mainnet.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Medium | 5 |
| Low | 6 |
| Informational | 5 |

---

## SwapPool.aml (903 lines)

### S1-SP-01: Fee-on-Transfer Token Incompatibility [HIGH]

**Lines:** 247-249 (add_liquidity proportional), swap functions

**Description:** The pool pulls `amount_a` / `amount_b` via `call(token, "pull", [caller, self_addr, amount])` but assumes the full amount arrives. Tokens with transfer fees (tax tokens, auto-burn tokens) deliver less than requested, causing reserve accounting drift.

**Impact:** Pool reserves slowly diverge from actual balances. LP providers lose value. Accumulated drift can be exploited by calling `sync()` to resync reserves.

**Proof of concept:** Deploy a token with 5% transfer tax. Add liquidity of 1000 tokens. Pool records 1000 but only holds 950. Over many swaps, the gap compounds. Owner calls `sync()` to resync, effectively stealing the difference.

**Recommendation:** Use balance-before/after pattern:
```aml
let bal_before = call(token_a, "balance_of", [self_addr])
require(call(token_a, "pull", [caller, self_addr, amount_a]), "pull failed")
let bal_after = call(token_a, "balance_of", [self_addr])
let actual = bal_after - bal_before
```

---

### S1-SP-02: Owner Can Set Arbitrary Initial Price [HIGH]

**Lines:** 133-223 (add_liquidity first)

**Description:** V8 restricts initial liquidity to the pool owner, but the owner can set an extremely skewed ratio. The equilibrium price guard only checks against existing pools via a hub token — if no hub path exists, it returns true.

**Impact:** Owner creates pool at 1:1000000 ratio, then front-runs traders who swap at the wrong price. The skewed reserves mean traders get terrible execution.

**Recommendation:** Add configurable initial price bounds, or require the initial ratio to be within a tolerance of the hub token price.

---

### S1-SP-03: No Fee-on-Transfer Awareness in Swap [MEDIUM]

**Lines:** swap_a_for_b / swap_b_for_a

**Description:** Same issue as S1-SP-01 but in swap functions. The swap pulls `amount_in` but the actual received amount may be less for fee-on-transfer tokens.

**Impact:** Reserve accounting becomes incorrect after each swap involving fee tokens.

**Recommendation:** Same balance-before/after pattern as S1-SP-01.

---

### S1-SP-04: Fee Parameter Centralization [MEDIUM]

**Lines:** set_fee_params() — owner only

**Description:** Owner can set fees from 0% to 100%. No upper bound enforced on the fee ratio.

**Impact:** Owner could set 99% fee, effectively trapping all LP funds.

**Recommendation:** Add `require(fee_numerator * 100 <= fee_denominator, "fee > 1%")`.

---

### S1-SP-05: sqrt Calculation Edge Case [LOW]

**Lines:** 149-160

**Description:** Newton's method sqrt for LP calculation. For very small products (amount_a * amount_b < 4), the loop may not converge properly.

**Impact:** Edge case for extremely small initial liquidity amounts.

**Recommendation:** Add explicit handling for product < 4.

---

### S1-SP-06: Position Linked List Complexity [LOW]

**Lines:** 198-211, remove_liquidity unlinking

**Description:** Manual doubly-linked list inlining (AML limitation). Complex but correctly invariant-checked.

**Impact:** Higher audit surface, no direct vulnerability.

**Recommendation:** Add `verify_linked_list(address)` view for off-chain monitoring.

---

### S1-SP-07: sync() Owner Trust [LOW]

**Lines:** sync() function

**Description:** Owner can resync reserves from actual balances. Useful recovery but could inflate reserves by sending tokens directly.

**Impact:** Owner can manipulate reserve accounting.

**Recommendation:** Restrict sync to only decrease reserves.

---

### S1-SP-08: No Emergency Token Rescue [INFORMATIONAL]

**Description:** Tokens sent directly to pool without going through AMM functions are permanently stuck.

**Recommendation:** Add `rescueTokens(token, amount, to)` callable by owner.

---

## SwapFactory.aml (470 lines)

### S1-SF-01: Permissionless Registration Risk [MEDIUM]

**Lines:** register_pool() 68-100

**Description:** Anyone can register a pool. While `get_token_a`/`get_token_b` are validated, a fake SwapPool contract could pass these checks.

**Impact:** Users could trade on malicious pools.

**Recommendation:** Require fee_to_setter approval or maintain a pool whitelist.

---

### S1-SF-02: update_pool Rug Vector [MEDIUM]

**Lines:** update_pool() — fee_to_setter only

**Description:** Fee_to_setter can replace pool mapping. Old pool with active liquidity becomes orphaned.

**Impact:** All LPs in old pool lose trading access. Centralization risk.

**Recommendation:** Add timelock or require old pool to be empty.

---

### S1-SF-03: Trusted Token List DoS [LOW]

**Lines:** add_trusted_token / get_trusted_tokens

**Description:** Linear iteration for get_trusted_tokens grows with list size.

**Recommendation:** Cap at 100 tokens.

---

### S1-SF-04: Setter Transfer No Timelock [LOW]

**Lines:** initiate_setter_transfer / accept_setter_transfer

**Description:** Two-step but no delay. Compromised account = immediate takeover.

**Recommendation:** Add 24h minimum delay.

---

### S1-SF-05: Price Tolerance BPS Not Enforced [INFORMATIONAL]

**Lines:** validate_initial_price

**Description:** price_tolerance_bps is read but the hub_token must be set for the guard to activate.

**Recommendation:** Document that hub_token must be configured for price protection.

---

## WOCT.aml (296 lines)

### S1-WOCT-01: rescue_native Centralization [LOW]

**Lines:** rescue_native() — owner only

**Description:** Owner can withdraw excess native OCT. Safety valve but gives drain path.

**Impact:** Cannot steal WOCT-collateralized funds, only unaccounted excess.

**Recommendation:** Add DAO governance for large rescues.

---

### S1-WOCT-02: max_deposit_per_tx Default Unlimited [LOW]

**Lines:** constructor — max_deposit_per_tx = 0

**Description:** No default limit. Whale can deposit large amounts in one tx.

**Recommendation:** Set reasonable default (e.g., 1M OCT).

---

### S1-WOCT-03: Pending Withdrawals DoS [LOW]

**Lines:** withdraw() — total_pending_withdrawals ceiling

**Description:** Single user could占 all pending withdrawal capacity.

**Recommendation:** Add per-user pending caps.

---

### S1-WOCT-04: claim_withdrawal Race Condition [INFORMATIONAL]

**Lines:** claim_withdrawal()

**Description:** Multiple pending withdrawals from same user are not tracked individually — only aggregate. A user with multiple withdraw() calls can only claim once.

**Recommendation:** Document this behavior clearly.

---

## Router.aml (411 lines)

### S1-RT-01: Factory/WOCT Address Change [MEDIUM]

**Lines:** set_factory(), set_woct() — owner only

**Description:** Owner can redirect all swaps to malicious pools by changing factory address.

**Impact:** Full fund theft if owner key compromised.

**Recommendation:** Add two-step change with timelock.

---

### S1-RT-02: Slippage Ceiling 30% [LOW]

**Lines:** set_max_slippage_bps — max 3000

**Description:** 30% max slippage is high for low-liquidity pools.

**Recommendation:** Consider 10% default max.

---

### S1-RT-03: Malicious Token Detection [INFORMATIONAL]

**Description:** Balance before/after check is well-implemented. Positive security feature.

---

### S1-RT-04: Multi-Hop Path Length [INFORMATIONAL]

**Lines:** swap_exact_tokens_for_tokens_path_3, _path_4

**Description:** Hardcoded 3-token and 4-token paths. Not extensible.

**Recommendation:** Consider dynamic path length for future-proofing.

---

## OES.aml / Token.aml

### S1-TKN-01: Rewards Vault Centralization [LOW]

**Description:** Owner controls rewards distribution vault.

### S1-TKN-02: Blacklist Abuse [LOW]

**Description:** Owner can freeze any address including LPs.

---

## Recommendations Summary

| Priority | Action | Contract |
|----------|--------|----------|
| HIGH | Balance-before/after for fee-on-transfer tokens | SwapPool |
| HIGH | Initial price bounds validation | SwapPool |
| MEDIUM | Fee cap enforcement (max 1%) | SwapPool |
| MEDIUM | Pool replacement timelock | SwapFactory |
| MEDIUM | Factory/woct address change timelock | Router |
| MEDIUM | Default max_deposit_per_tx | WOCT |
| LOW | Trusted token list cap | SwapFactory |
| LOW | Per-user pending withdrawal caps | WOCT |
| LOW | rescueTokens function | SwapPool |

---

## Conclusion

EverestSwap demonstrates strong security practices with multiple audit iterations. The reentrancy guards, CEI pattern, overflow checks, and deadline enforcement are well-implemented. Primary concerns are fee-on-transfer token incompatibility, centralization risks, and lack of emergency token rescue. Contracts are suitable for devnet; address medium-severity issues before mainnet.
