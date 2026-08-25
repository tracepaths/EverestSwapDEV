// ---------------------------------------------------------------------------
// Swap and liquidity math, Q64.96.
//
// Rounding direction is the whole game here: every amount the pool RECEIVES
// rounds up and every amount it PAYS OUT rounds down, so truncation can only
// ever accrue to the pool and never to the trader. Getting one of these
// backwards leaks value out of the reserves one wei at a time.
//
// The reference implementation carries overflow branches that exist only to
// cope with 256-bit wraparound. Integers here are arbitrary precision, so those
// branches are unreachable and are omitted rather than left as dead weight.
// ---------------------------------------------------------------------------

view fn q96(): int {
  return 79228162514264337593543950336
}

// token0 delta between two prices: liquidity / sqrt(lower) - liquidity / sqrt(upper)
view fn amount0_delta(sqrt_a: int, sqrt_b: int, liq: int, round_up: bool): int {
  let lo = min(sqrt_a, sqrt_b)
  let hi = max(sqrt_a, sqrt_b)
  require(lo > 0, "sqrt price zero")
  let num1 = liq * 79228162514264337593543950336
  let num2 = hi - lo
  if round_up {
    return div_up(mul_div_up(num1, num2, hi), lo)
  }
  return mul_div(num1, num2, hi) / lo
}

// token1 delta between two prices: liquidity * (sqrt(upper) - sqrt(lower))
view fn amount1_delta(sqrt_a: int, sqrt_b: int, liq: int, round_up: bool): int {
  let lo = min(sqrt_a, sqrt_b)
  let hi = max(sqrt_a, sqrt_b)
  if round_up {
    return mul_div_up(liq, hi - lo, 79228162514264337593543950336)
  }
  return mul_div(liq, hi - lo, 79228162514264337593543950336)
}

// Signed variants, used when crossing a tick applies liquidity_net.
view fn amount0_delta_signed(sqrt_a: int, sqrt_b: int, liq: int): int {
  if liq < 0 {
    return 0 - amount0_delta(sqrt_a, sqrt_b, 0 - liq, false)
  }
  return amount0_delta(sqrt_a, sqrt_b, liq, true)
}

view fn amount1_delta_signed(sqrt_a: int, sqrt_b: int, liq: int): int {
  if liq < 0 {
    return 0 - amount1_delta(sqrt_a, sqrt_b, 0 - liq, false)
  }
  return amount1_delta(sqrt_a, sqrt_b, liq, true)
}

view fn next_sqrt_from_amount0_up(sqrt_p: int, liq: int, amount: int, add: bool): int {
  if amount == 0 {
    return sqrt_p
  }
  let num1 = liq * 79228162514264337593543950336
  if add {
    return mul_div_up(num1, sqrt_p, num1 + amount * sqrt_p)
  }
  let product = amount * sqrt_p
  require(num1 > product, "amount0 exceeds range")
  return mul_div_up(num1, sqrt_p, num1 - product)
}

view fn next_sqrt_from_amount1_down(sqrt_p: int, liq: int, amount: int, add: bool): int {
  if add {
    return sqrt_p + mul_div(amount, 79228162514264337593543950336, liq)
  }
  let q = mul_div_up(amount, 79228162514264337593543950336, liq)
  require(sqrt_p > q, "amount1 exceeds range")
  return sqrt_p - q
}

view fn next_sqrt_from_input(sqrt_p: int, liq: int, amount_in: int, zero_for_one: bool): int {
  require(sqrt_p > 0, "zero price")
  require(liq > 0, "zero liquidity")
  if zero_for_one {
    return next_sqrt_from_amount0_up(sqrt_p, liq, amount_in, true)
  }
  return next_sqrt_from_amount1_down(sqrt_p, liq, amount_in, true)
}

view fn next_sqrt_from_output(sqrt_p: int, liq: int, amount_out: int, zero_for_one: bool): int {
  require(sqrt_p > 0, "zero price")
  require(liq > 0, "zero liquidity")
  if zero_for_one {
    return next_sqrt_from_amount1_down(sqrt_p, liq, amount_out, false)
  }
  return next_sqrt_from_amount0_up(sqrt_p, liq, amount_out, false)
}

// One step of a swap, split across four pure functions because a single
// function cannot hand back four values and a state-scratch version would be
// unreachable from a read-only quote. The caller computes the price once and
// derives the amounts from it, so nothing is recomputed twice.
//
// `remaining` >= 0 means exact-input; < 0 means exact-output.
view fn step_next_sqrt(sqrt_cur: int, sqrt_tgt: int, liq: int, remaining: int, fee_pips: int): int {
  let z4o = sqrt_cur >= sqrt_tgt
  if remaining >= 0 {
    let less_fee = mul_div(remaining, 1000000 - fee_pips, 1000000)
    let amt_in = 0
    if z4o {
      amt_in = amount0_delta(sqrt_tgt, sqrt_cur, liq, true)
    } else {
      amt_in = amount1_delta(sqrt_cur, sqrt_tgt, liq, true)
    }
    if less_fee >= amt_in {
      return sqrt_tgt
    }
    return next_sqrt_from_input(sqrt_cur, liq, less_fee, z4o)
  }
  let amt_out = 0
  if z4o {
    amt_out = amount1_delta(sqrt_tgt, sqrt_cur, liq, false)
  } else {
    amt_out = amount0_delta(sqrt_cur, sqrt_tgt, liq, false)
  }
  if 0 - remaining >= amt_out {
    return sqrt_tgt
  }
  return next_sqrt_from_output(sqrt_cur, liq, 0 - remaining, z4o)
}

view fn step_amount_in(sqrt_cur: int, sqrt_next: int, liq: int, z4o: bool): int {
  if z4o {
    return amount0_delta(sqrt_next, sqrt_cur, liq, true)
  }
  return amount1_delta(sqrt_cur, sqrt_next, liq, true)
}

view fn step_amount_out(sqrt_cur: int, sqrt_next: int, liq: int, z4o: bool): int {
  if z4o {
    return amount1_delta(sqrt_next, sqrt_cur, liq, false)
  }
  return amount0_delta(sqrt_cur, sqrt_next, liq, false)
}

// When exact-input stops short of the target the entire unused remainder is the
// fee, which is how the reference avoids leaving dust behind. Otherwise the fee
// is charged on top of the amount actually swapped in.
view fn step_fee(remaining: int, amt_in: int, sqrt_next: int, sqrt_tgt: int, fee_pips: int): int {
  if remaining >= 0 {
    if sqrt_next != sqrt_tgt {
      return remaining - amt_in
    }
  }
  return mul_div_up(amt_in, fee_pips, 1000000 - fee_pips)
}

// ── Liquidity from token amounts ──────────────────────────────────────
//
// The inverse of the amount deltas above: given how much of each token a
// provider is willing to deposit, how much liquidity does that buy across the
// range. Rounding is downward throughout, so a deposit never claims more
// liquidity than it actually funds.

view fn liquidity_for_amount0(sqrt_a: int, sqrt_b: int, amount0: int): int {
  let lo = min(sqrt_a, sqrt_b)
  let hi = max(sqrt_a, sqrt_b)
  require(hi > lo, "empty range")
  return amount0 * (lo * hi / q96()) / (hi - lo)
}

view fn liquidity_for_amount1(sqrt_a: int, sqrt_b: int, amount1: int): int {
  let lo = min(sqrt_a, sqrt_b)
  let hi = max(sqrt_a, sqrt_b)
  require(hi > lo, "empty range")
  return amount1 * q96() / (hi - lo)
}

// Below the range only token0 is needed, above it only token1, and inside it
// both — where the binding side is whichever funds less liquidity.
view fn liquidity_for_amounts_at(sqrt_p: int, sqrt_a: int, sqrt_b: int, amount0: int, amount1: int): int {
  let lo = min(sqrt_a, sqrt_b)
  let hi = max(sqrt_a, sqrt_b)
  if sqrt_p <= lo {
    return liquidity_for_amount0(lo, hi, amount0)
  }
  if sqrt_p < hi {
    return min(liquidity_for_amount0(sqrt_p, hi, amount0), liquidity_for_amount1(lo, sqrt_p, amount1))
  }
  return liquidity_for_amount1(lo, hi, amount1)
}
