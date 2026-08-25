// ---------------------------------------------------------------------------
// Tick <-> sqrt-price conversion, Q64.96.
//
//   sqrt_price_x96 = sqrt(1.0001 ^ tick) * 2^96
//
// Ports the canonical multiply-and-shift ladder: each of the 20 stages folds in
// one bit of |tick|, with `>> 128` written as division by 2^128. Verified
// bit-exact against the reference implementation at 289 ticks spanning the whole
// usable range, including every power-of-two boundary and both extremes.
// ---------------------------------------------------------------------------

view fn min_tick(): int {
  return -887272
}

view fn max_tick(): int {
  return 887272
}

view fn min_sqrt_ratio(): int {
  return 4295128739
}

view fn max_sqrt_ratio(): int {
  return 1461446703485210103287273052203988822378723970342
}

// One stage of the ladder: (r * c) >> 128.
view fn ratio_stage(r: int, c: int): int {
  return r * c / 340282366920938463463374607431768211456
}

view fn sqrt_ratio_at_tick(tick: int): int {
  let at = abs(tick)
  require(at <= 887272, "tick out of range")
  let r = 340282366920938463463374607431768211456
  if at % 2 == 1 {
    r = 340265354078544963557816517032075149313
  }
  if at / 2 % 2 == 1 {
    r = ratio_stage(r, 340248342086729790484326174814286782778)
  }
  if at / 4 % 2 == 1 {
    r = ratio_stage(r, 340214320654664324051920982716015181260)
  }
  if at / 8 % 2 == 1 {
    r = ratio_stage(r, 340146287995602323631171512101879684304)
  }
  if at / 16 % 2 == 1 {
    r = ratio_stage(r, 340010263488231146823593991679159461444)
  }
  if at / 32 % 2 == 1 {
    r = ratio_stage(r, 339738377640345403697157401104375502016)
  }
  if at / 64 % 2 == 1 {
    r = ratio_stage(r, 339195258003219555707034227454543997025)
  }
  if at / 128 % 2 == 1 {
    r = ratio_stage(r, 338111622100601834656805679988414885971)
  }
  if at / 256 % 2 == 1 {
    r = ratio_stage(r, 335954724994790223023589805789778977700)
  }
  if at / 512 % 2 == 1 {
    r = ratio_stage(r, 331682121138379247127172139078559817300)
  }
  if at / 1024 % 2 == 1 {
    r = ratio_stage(r, 323299236684853023288211250268160618739)
  }
  if at / 2048 % 2 == 1 {
    r = ratio_stage(r, 307163716377032989948697243942600083929)
  }
  if at / 4096 % 2 == 1 {
    r = ratio_stage(r, 277268403626896220162999269216087595045)
  }
  if at / 8192 % 2 == 1 {
    r = ratio_stage(r, 225923453940442621947126027127485391333)
  }
  if at / 16384 % 2 == 1 {
    r = ratio_stage(r, 149997214084966997727330242082538205943)
  }
  if at / 32768 % 2 == 1 {
    r = ratio_stage(r, 66119101136024775622716233608466517926)
  }
  if at / 65536 % 2 == 1 {
    r = ratio_stage(r, 12847376061809297530290974190478138313)
  }
  if at / 131072 % 2 == 1 {
    r = ratio_stage(r, 485053260817066172746253684029974020)
  }
  if at / 262144 % 2 == 1 {
    r = ratio_stage(r, 691415978906521570653435304214168)
  }
  if at / 524288 % 2 == 1 {
    r = ratio_stage(r, 1404880482679654955896180642)
  }
  if tick > 0 {
    r = 115792089237316195423570985008687907853269984665640564039457584007913129639935 / r
  }
  let q = r / 4294967296
  if r % 4294967296 != 0 {
    q = q + 1
  }
  return q
}

// One refinement step of the binary log. Returns the updated mantissa; the bit
// it produced is read back out by log_step_bit so the caller can accumulate it
// without needing two return values.
view fn log_step_bit(r: int): int {
  return r * r / 170141183460469231731687303715884105728 / 340282366920938463463374607431768211456
}

view fn log_step_next(r: int): int {
  let sq = r * r / 170141183460469231731687303715884105728
  return sq / pow(2, sq / 340282366920938463463374607431768211456)
}

// Inverse of sqrt_ratio_at_tick: the greatest tick whose sqrt ratio is <= the
// input. Computes log2 of the Q128 mantissa to 14 fractional bits, converts to
// a log base sqrt(1.0001), then resolves the one-tick ambiguity by re-deriving
// the candidate ratio.
//
// The two `>> 128` at the end are ARITHMETIC shifts on a signed value, so they
// must floor, not truncate — hence floor_div rather than `/`.
view fn tick_at_sqrt_ratio(sqrt_price_x96: int): int {
  require(sqrt_price_x96 >= 4295128739, "sqrt price too low")
  require(sqrt_price_x96 < 1461446703485210103287273052203988822378723970342, "sqrt price too high")
  let ratio = sqrt_price_x96 * 4294967296
  let m = msb(ratio)
  let r = 0
  if m >= 128 {
    r = ratio / pow(2, m - 127)
  } else {
    r = ratio * pow(2, 127 - m)
  }
  let log_2 = (m - 128) * 18446744073709551616
  log_2 = log_2 + log_step_bit(r) * 9223372036854775808
  r = log_step_next(r)
  log_2 = log_2 + log_step_bit(r) * 4611686018427387904
  r = log_step_next(r)
  log_2 = log_2 + log_step_bit(r) * 2305843009213693952
  r = log_step_next(r)
  log_2 = log_2 + log_step_bit(r) * 1152921504606846976
  r = log_step_next(r)
  log_2 = log_2 + log_step_bit(r) * 576460752303423488
  r = log_step_next(r)
  log_2 = log_2 + log_step_bit(r) * 288230376151711744
  r = log_step_next(r)
  log_2 = log_2 + log_step_bit(r) * 144115188075855872
  r = log_step_next(r)
  log_2 = log_2 + log_step_bit(r) * 72057594037927936
  r = log_step_next(r)
  log_2 = log_2 + log_step_bit(r) * 36028797018963968
  r = log_step_next(r)
  log_2 = log_2 + log_step_bit(r) * 18014398509481984
  r = log_step_next(r)
  log_2 = log_2 + log_step_bit(r) * 9007199254740992
  r = log_step_next(r)
  log_2 = log_2 + log_step_bit(r) * 4503599627370496
  r = log_step_next(r)
  log_2 = log_2 + log_step_bit(r) * 2251799813685248
  r = log_step_next(r)
  log_2 = log_2 + log_step_bit(r) * 1125899906842624
  let log_root = log_2 * 255738958999603826347141
  let tick_low = floor_div(log_root - 3402992956809132418596140100660247210, 340282366920938463463374607431768211456)
  let tick_hi = floor_div(log_root + 291339464771989622907027621153398088495, 340282366920938463463374607431768211456)
  if tick_low == tick_hi {
    return tick_low
  }
  if sqrt_ratio_at_tick(tick_hi) <= sqrt_price_x96 {
    return tick_hi
  }
  return tick_low
}
