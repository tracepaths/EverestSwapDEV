// ---------------------------------------------------------------------------
// Integer helpers
//
// Two facts about this VM shape everything below:
//   * `int` is arbitrary precision, so a 256-bit-wide intermediate needs no
//     multi-limb emulation and mul_div is literally `a * b / d`.
//   * `/` and `%` truncate toward zero rather than flooring, so anything that
//     indexes on a signed tick has to spell floor semantics out. Bare `/` there
//     is an off-by-one for every price below 1.0.
// There are no bitwise operators, so bit work goes through pow/`/`/`%`.
// ---------------------------------------------------------------------------

view fn floor_mod(a: int, b: int): int {
  require(b != 0, "mod by zero")
  let m = a % b
  if m < 0 {
    m = m + b
  }
  return m
}

view fn floor_div(a: int, b: int): int {
  require(b != 0, "div by zero")
  let q = a / b
  if a % b != 0 {
    if a < 0 {
      if b > 0 {
        q = q - 1
      }
    }
    if a > 0 {
      if b < 0 {
        q = q - 1
      }
    }
  }
  return q
}

view fn mul_div(a: int, b: int, d: int): int {
  require(d != 0, "div by zero")
  return a * b / d
}

view fn mul_div_up(a: int, b: int, d: int): int {
  require(d != 0, "div by zero")
  let p = a * b
  let q = p / d
  if p % d != 0 {
    q = q + 1
  }
  return q
}

view fn div_up(a: int, b: int): int {
  require(b != 0, "div by zero")
  let q = a / b
  if a % b != 0 {
    q = q + 1
  }
  return q
}

// Index of the most significant set bit, by unrolled binary search. Stands in
// for the shift-and-compare scan the reference log2 routine uses.
view fn msb(x: int): int {
  require(x > 0, "msb of zero")
  let r = 0
  let v = x
  if v >= 340282366920938463463374607431768211456 {
    v = v / 340282366920938463463374607431768211456
    r = r + 128
  }
  if v >= 18446744073709551616 {
    v = v / 18446744073709551616
    r = r + 64
  }
  if v >= 4294967296 {
    v = v / 4294967296
    r = r + 32
  }
  if v >= 65536 {
    v = v / 65536
    r = r + 16
  }
  if v >= 256 {
    v = v / 256
    r = r + 8
  }
  if v >= 16 {
    v = v / 16
    r = r + 4
  }
  if v >= 4 {
    v = v / 4
    r = r + 2
  }
  if v >= 2 {
    r = r + 1
  }
  return r
}

// Index of the least significant set bit. `x & -x` is unavailable, so this
// binary-searches on "are the low k bits all zero" via modulo.
view fn lsb(x: int): int {
  require(x > 0, "lsb of zero")
  let r = 0
  let v = x
  if v % 340282366920938463463374607431768211456 == 0 {
    v = v / 340282366920938463463374607431768211456
    r = r + 128
  }
  if v % 18446744073709551616 == 0 {
    v = v / 18446744073709551616
    r = r + 64
  }
  if v % 4294967296 == 0 {
    v = v / 4294967296
    r = r + 32
  }
  if v % 65536 == 0 {
    v = v / 65536
    r = r + 16
  }
  if v % 256 == 0 {
    v = v / 256
    r = r + 8
  }
  if v % 16 == 0 {
    v = v / 16
    r = r + 4
  }
  if v % 4 == 0 {
    v = v / 4
    r = r + 2
  }
  if v % 2 == 0 {
    r = r + 1
  }
  return r
}

// 2^128 — the fixed-point denominator for every fee-growth accumulator.
// Written as a literal because `pow(2, 128)` re-derives it on every call and
// fee growth is touched on each tick crossing.
view fn q128(): int {
  return 340282366920938463463374607431768211456
}

// The largest value a 128-bit liquidity figure can hold. Liquidity is
// arbitrary-precision here, so this is a policy cap rather than a hardware
// one: it keeps per-tick liquidity inside the range the price/amount math was
// validated over.
view fn liquidity_max(): int {
  return 340282366920938463463374607431768211455
}
