// ---------------------------------------------------------------------------
// Tick index: a bitmap of initialized ticks.
//
// Requires the host contract to declare  tick_bitmap: map[int]int  where each
// entry is a 256-bit word covering 256 consecutive spaced ticks.
//
// With no bitwise operators, the three primitives are rebuilt arithmetically:
//   test bit b   ->  word / 2^b % 2 == 1
//   set  bit b   ->  word + 2^b
//   clear bit b  ->  word - 2^b
//   low mask     ->  word & (2^(b+1) - 1)  ==  word % 2^(b+1)
//   high mask    ->  word & ~(2^b - 1)     ==  word / 2^b * 2^b
// Word and bit indices use floor semantics so negative ticks land correctly.
// ---------------------------------------------------------------------------

view fn tick_word(compressed: int): int {
  return floor_div(compressed, 256)
}

view fn tick_bit(compressed: int): int {
  return floor_mod(compressed, 256)
}

view fn is_tick_initialized(tick: int, spacing: int): bool {
  let c = floor_div(tick, spacing)
  return self.tick_bitmap[tick_word(c)] / pow(2, tick_bit(c)) % 2 == 1
}

fn flip_tick(tick: int, spacing: int): bool {
  require(floor_mod(tick, spacing) == 0, "tick not on spacing")
  let c = floor_div(tick, spacing)
  let w = tick_word(c)
  let mask = pow(2, tick_bit(c))
  let word = self.tick_bitmap[w]
  if word / mask % 2 == 1 {
    self.tick_bitmap[w] = word - mask
  } else {
    self.tick_bitmap[w] = word + mask
  }
  return true
}

// Nearest initialized tick in the same word, searching down (lte) or up.
// When the word holds nothing in range this returns the word boundary, which is
// how the swap loop makes progress across sparse regions. Callers detect that
// case with is_tick_initialized on the result — the boundary bit is provably
// clear whenever the masked word came back empty, so the two agree.
view fn next_tick_in_word(tick: int, spacing: int, lte: bool): int {
  let c = floor_div(tick, spacing)
  if lte {
    let b = tick_bit(c)
    let masked = self.tick_bitmap[tick_word(c)] % pow(2, b + 1)
    if masked == 0 {
      return (c - b) * spacing
    }
    return (c - (b - msb(masked))) * spacing
  }
  let c1 = c + 1
  let b = tick_bit(c1)
  let p = pow(2, b)
  let masked = self.tick_bitmap[tick_word(c1)] / p * p
  if masked == 0 {
    return (c1 + (255 - b)) * spacing
  }
  return (c1 + (lsb(masked) - b)) * spacing
}
