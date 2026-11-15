/// Bytes as lower-case hex and back, as the module's calls carry a card's commands, keys and signatures.
public enum Hex {
  private static let digits = Array("0123456789abcdef".utf8)

  public static func encode<Bytes: Sequence>(_ bytes: Bytes) -> String where Bytes.Element == UInt8 {
    var out = [UInt8]()
    for b in bytes {
      out.append(digits[Int(b >> 4)])
      out.append(digits[Int(b & 0x0f)])
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// nil for anything that is not an even number of hex digits, either case.
  public static func decode(_ s: String) -> [UInt8]? {
    let chars = Array(s.utf8)
    guard chars.count % 2 == 0 else { return nil }
    var out = [UInt8]()
    out.reserveCapacity(chars.count / 2)
    for i in stride(from: 0, to: chars.count, by: 2) {
      guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else { return nil }
      out.append(hi << 4 | lo)
    }
    return out
  }

  private static func nibble(_ c: UInt8) -> UInt8? {
    switch c {
    case UInt8(ascii: "0")...UInt8(ascii: "9"): return c - UInt8(ascii: "0")
    case UInt8(ascii: "a")...UInt8(ascii: "f"): return c - UInt8(ascii: "a") + 10
    case UInt8(ascii: "A")...UInt8(ascii: "F"): return c - UInt8(ascii: "A") + 10
    default: return nil
    }
  }
}
