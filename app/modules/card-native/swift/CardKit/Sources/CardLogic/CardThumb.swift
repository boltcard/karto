import Foundation

/// Why a shot gave no photo: the three codes the app reads (src/native/cardCamera.tsx) and the words that go
/// with each, Android's own (android/.../CardThumb.kt) where Android has them.
public enum ShotFailure: Error, Equatable {
  case tooBig
  case capture(String)
  case closed

  public var code: String {
    switch self {
    case .tooBig: return "ERR_PHOTO_TOO_BIG"
    case .capture: return "ERR_CAPTURE"
    case .closed: return "ERR_CAMERA_CLOSED"
    }
  }

  public var words: String {
    switch self {
    case .tooBig: return "the photo is over 64 KB at quality 60"
    case .capture(let words): return words
    case .closed: return "the camera closed before the photo was taken"
    }
  }
}

/// The card's thumbnail: the card cut out along its four corners and straightened to 428×270. Android's is CardThumb.kt, which
/// has its Matrix and Canvas do the drawing; here it is done by hand, and the result is pixels: making them a
/// JPEG is Apple's code (ios/CardCameraView.swift), weighed by CardShot.jpeg.
public enum CardThumb {
  public static let WIDTH = 428
  public static let HEIGHT = 270
  /// cardd's limit (server/internal/cards MaxPhotoBytes).
  public static let MAX_BYTES = 64 * 1024

  /// The card at corners q (pixels of the upright picture src), straightened.
  public static func make(_ src: Picture, _ q: Quad) throws -> Picture {
    guard let map = Straighten(q) else { throw ShotFailure.capture("the card's corners can't be straightened") }
    // A card much wider than the thumbnail is drawn at twice its size first, then halved, so its detail
    // doesn't break up.
    let across = max(hypot(q.tr.x - q.tl.x, q.tr.y - q.tl.y), hypot(q.br.x - q.bl.x, q.br.y - q.bl.y))
    let twice = across > Double(2 * WIDTH)
    let w = twice ? 2 * WIDTH : WIDTH
    let h = twice ? 2 * HEIGHT : HEIGHT
    var drawn = [UInt8](repeating: 255, count: 4 * w * h)
    let sw = src.width, sh = src.height
    src.rgba.withUnsafeBufferPointer { s in
      drawn.withUnsafeMutableBufferPointer { d in
        for j in 0..<h {
          let v = (Double(j) + 0.5) / Double(h)
          for i in 0..<w {
            // The middle of this pixel, in the picture: between four of its pixels' middles, each counted by
            // how near it is. Outside the picture, its edge.
            let at = map.at((Double(i) + 0.5) / Double(w), v)
            let fx = min(max(at.x - 0.5, -1), Double(sw)), fy = min(max(at.y - 0.5, -1), Double(sh))
            let x0 = fx.rounded(.down), y0 = fy.rounded(.down)
            let tx = fx - x0, ty = fy - y0
            let xa = min(max(Int(x0), 0), sw - 1), xb = min(max(Int(x0) + 1, 0), sw - 1)
            let ya = min(max(Int(y0), 0), sh - 1), yb = min(max(Int(y0) + 1, 0), sh - 1)
            for c in 0..<3 {
              let top = Double(s[4 * (ya * sw + xa) + c]) * (1 - tx) + Double(s[4 * (ya * sw + xb) + c]) * tx
              let bottom = Double(s[4 * (yb * sw + xa) + c]) * (1 - tx) + Double(s[4 * (yb * sw + xb) + c]) * tx
              d[4 * (j * w + i) + c] = UInt8(min(255, max(0, (top * (1 - ty) + bottom * ty + 0.5).rounded(.down))))
            }
          }
        }
      }
    }
    if !twice { return Picture(width: w, height: h, rgba: drawn) }
    var out = [UInt8](repeating: 255, count: 4 * WIDTH * HEIGHT)
    for j in 0..<HEIGHT {
      for i in 0..<WIDTH {
        for c in 0..<3 {
          let a = 4 * (2 * j * w + 2 * i) + c
          let b = a + 4 * w
          out[4 * (j * WIDTH + i) + c] = UInt8((Int(drawn[a]) + Int(drawn[a + 4]) + Int(drawn[b]) + Int(drawn[b + 4]) + 2) / 4)
        }
      }
    }
    return Picture(width: WIDTH, height: HEIGHT, rgba: out)
  }

  /// The mapping that takes a rectangle onto four corners, as a camera sees a card at an angle (what Android's
  /// Matrix.setPolyToPoly gives for four points): straight lines stay straight, and the middle of the card is
  /// where its diagonals cross, not half way between its corners.
  private struct Straighten {
    let a, b, c, d, e, f, g, h: Double

    /// nil for corners no card has: not numbers, three in a line, a crossed shape.
    init?(_ q: Quad) {
      let p = q.corners
      guard p.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else { return nil }
      let turns = (0..<4).map { i -> Double in
        let a = p[i], b = p[(i + 1) % 4], d = p[(i + 2) % 4]
        return (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x)
      }
      guard turns.allSatisfy({ $0 > 0 }) || turns.allSatisfy({ $0 < 0 }) else { return nil }
      let dx1 = p[1].x - p[2].x, dx2 = p[3].x - p[2].x, dx3 = p[0].x - p[1].x + p[2].x - p[3].x
      let dy1 = p[1].y - p[2].y, dy2 = p[3].y - p[2].y, dy3 = p[0].y - p[1].y + p[2].y - p[3].y
      let den = dx1 * dy2 - dx2 * dy1
      guard den != 0 else { return nil }
      g = (dx3 * dy2 - dx2 * dy3) / den
      h = (dx1 * dy3 - dx3 * dy1) / den
      a = p[1].x - p[0].x + g * p[1].x
      b = p[3].x - p[0].x + h * p[3].x
      c = p[0].x
      d = p[1].y - p[0].y + g * p[1].y
      e = p[3].y - p[0].y + h * p[3].y
      f = p[0].y
    }

    /// Where the point u across and v down the card (each from 0 to 1) is in the picture.
    func at(_ u: Double, _ v: Double) -> Pt {
      let w = g * u + h * v + 1
      return Pt((a * u + b * v + c) / w, (d * u + e * v + f) / w)
    }
  }
}
