/// java.util.Random, as far as the edge finder uses it (CardEdges.swift): Android's finder
/// (android/.../CardEdges.kt) picks its two-point trials with it from a fixed seed, and the iPhone's must pick
/// the same pairs to answer the same corners. The 48-bit generator of the Java documentation; nextDouble is used
/// nowhere and is not here.
public struct JavaRandom {
  private static let mask: UInt64 = (1 << 48) - 1
  private var seed: UInt64

  public init(seed: Int64) {
    self.seed = (UInt64(bitPattern: seed) ^ 0x5_DEEC_E66D) & Self.mask
  }

  private mutating func next(_ bits: Int) -> Int32 {
    seed = (seed &* 0x5_DEEC_E66D &+ 0xB) & Self.mask
    return Int32(truncatingIfNeeded: seed >> UInt64(48 - bits))
  }

  /// A number from 0 up to, not including, bound. Both of Java's branches: a bound that is a power of two, and
  /// the loop for any other, which throws a number away when keeping it would favour the small ones. Java finds
  /// that out by letting a 32-bit sum overflow, so the sum here wraps too.
  public mutating func nextInt(_ bound: Int32) -> Int32 {
    precondition(bound > 0, "bound must be positive")
    var r = next(31)
    let m = bound - 1
    if bound & m == 0 { return Int32(truncatingIfNeeded: (Int64(bound) * Int64(r)) >> 31) }
    var u = r
    while true {
      r = u % bound
      if u &- r &+ m >= 0 { return r }
      u = next(31)
    }
  }
}

/// Kotlin's roundToInt (Java's Math.round): the nearest whole number, a half going upward whatever the sign
/// (0.5 to 1, -0.5 to 0). Swift's rounded() sends a half away from zero.
func roundToInt(_ x: Double) -> Int {
  let floor = x.rounded(.down)
  return Int(x - floor >= 0.5 ? floor + 1 : floor)
}
