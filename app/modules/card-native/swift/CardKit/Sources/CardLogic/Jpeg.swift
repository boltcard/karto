/// A JPEG's marker segments, read without decoding the picture:
/// its metadata taken off, and its size.
/// The server keeps a card's photo only without EXIF (server/internal/cards hasEXIF), and the app checks the
/// same before it sends one (src/cardphoto/jpeg.ts); Android's encoder writes none, Apple's does.
public enum Jpeg {
  /// A piece of the file before the picture itself: a segment with its marker, or a fill byte (marker 0xFF).
  private struct Piece {
    let marker: UInt8
    let range: Range<Int>
  }

  /// The pieces from the start of the file up to the start of scan, and where that is; nil for what is not a
  /// JPEG, or has no picture, or is cut short.
  private static func walk(_ b: [UInt8]) -> (pieces: [Piece], scan: Int)? {
    guard b.count >= 4, b[0] == 0xFF, b[1] == 0xD8 else { return nil }
    var pieces = [Piece]()
    var i = 2
    while i + 1 < b.count {
      guard b[i] == 0xFF else { return nil }
      let marker = b[i + 1]
      if marker == 0xFF {
        pieces.append(Piece(marker: 0xFF, range: i..<(i + 1)))
        i += 1
      } else if marker == 0xDA {
        return (pieces, i)  // start of scan: the picture data follows
      } else if marker == 0x01 || (0xD0...0xD9).contains(marker) {
        pieces.append(Piece(marker: marker, range: i..<(i + 2)))
        i += 2
      } else {
        guard i + 3 < b.count else { return nil }
        let length = Int(b[i + 2]) << 8 | Int(b[i + 3])
        guard length >= 2, i + 2 + length <= b.count else { return nil }
        pieces.append(Piece(marker: marker, range: i..<(i + 2 + length)))
        i += 2 + length
      }
    }
    return nil
  }

  /// The same JPEG without its APP1 (EXIF, XMP) and APP13 (IPTC) segments: every other segment in its place
  /// (a colour profile, APP2, stays), the picture untouched. nil for what is not a JPEG.
  public static func withoutMetadata(_ b: [UInt8]) -> [UInt8]? {
    guard let (pieces, scan) = walk(b) else { return nil }
    var out = [UInt8]()
    out.reserveCapacity(b.count)
    out.append(contentsOf: b[0..<2])
    for p in pieces where p.marker != 0xE1 && p.marker != 0xED { out.append(contentsOf: b[p.range]) }
    out.append(contentsOf: b[scan...])
    return out
  }

  /// Whether a JPEG has an APP1 segment, which is what the server refuses.
  public static func hasApp1(_ b: [UInt8]) -> Bool {
    walk(b)?.pieces.contains { $0.marker == 0xE1 } ?? false
  }

  /// The size in a frame header (SOF0–SOF15 but DHT, JPG and DAC); nil without one.
  public static func size(_ b: [UInt8]) -> (width: Int, height: Int)? {
    guard let (pieces, _) = walk(b) else { return nil }
    guard let sof = pieces.first(where: { (0xC0...0xCF).contains($0.marker) && $0.marker != 0xC4 && $0.marker != 0xC8 && $0.marker != 0xCC }), sof.range.count >= 9 else { return nil }
    let at = sof.range.lowerBound + 4
    return (Int(b[at + 3]) << 8 | Int(b[at + 4]), Int(b[at + 1]) << 8 | Int(b[at + 2]))
  }
}
