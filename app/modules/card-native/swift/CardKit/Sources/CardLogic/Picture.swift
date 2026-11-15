// A camera's frame made ready for the edge finder and for the thumbnail: which part of it the screen
// shows, that part turned upright as brightness and colour, or in colour, and a picture made narrower. Android has CameraX
// do the first and its Bitmap the last; the turn is android/.../CardEdges.kt's Luma.turned.

/// A rectangle of a frame's stored pixels, right and bottom excluded.
public struct Crop: Equatable, Sendable {
  public let left: Int
  public let top: Int
  public let right: Int
  public let bottom: Int

  public init(left: Int, top: Int, right: Int, bottom: Int) {
    self.left = left
    self.top = top
    self.right = right
    self.bottom = bottom
  }

  public var width: Int { right - left }
  public var height: Int { bottom - top }
}

public enum Viewport {
  /// The part of a frame a view shows. The preview fills the view and keeps the picture's shape, so that is
  /// the middle of the upright frame, cut to the view's shape. The frame is stored storedWidth×storedHeight and
  /// is upright once turned clockwise by rotation (0, 90, 180 or 270); the answer is in its stored pixels. The
  /// analysed picture, the shot and the drawn outline all use this one rectangle.
  public static func crop(storedWidth: Int, storedHeight: Int, rotation: Int, viewWidth: Double, viewHeight: Double) -> Crop {
    guard viewWidth > 0, viewHeight > 0 else { return Crop(left: 0, top: 0, right: storedWidth, bottom: storedHeight) }
    let sideways = rotation % 180 != 0
    let uprightWidth = sideways ? storedHeight : storedWidth
    let uprightHeight = sideways ? storedWidth : storedHeight
    var across = uprightWidth
    var down = uprightHeight
    if viewWidth * Double(uprightHeight) < viewHeight * Double(uprightWidth) {
      // The view is the narrower shape: all of the picture's height, the middle of its width.
      across = min(uprightWidth, max(1, roundToInt(Double(uprightHeight) * viewWidth / viewHeight)))
    } else {
      down = min(uprightHeight, max(1, roundToInt(Double(uprightWidth) * viewHeight / viewWidth)))
    }
    // The middle stays the middle whichever way the frame is turned.
    let width = sideways ? down : across
    let height = sideways ? across : down
    let left = (storedWidth - width) / 2
    let top = (storedHeight - height) / 2
    return Crop(left: left, top: top, right: left + width, bottom: top + height)
  }

  /// Which of a camera's formats to ask for, given their sizes as stored: the 4:3 one nearest 1920 across (a
  /// frame the size of Android's shot, 1920×1440), the first of equals; nil when it has none of that shape.
  public static func format(among sizes: [(width: Int, height: Int)]) -> Int? {
    var best: Int?
    for (i, size) in sizes.enumerated() where size.width * 3 == size.height * 4 {
      if let b = best, abs(sizes[b].width - 1920) <= abs(size.width - 1920) { continue }
      best = i
    }
    return best
  }
}

/// Where the pixels of a cropped frame go once it is turned clockwise by rotation: the turned picture's size,
/// and for each stored row the place of its first pixel and the step to the next.
private struct Turn {
  let width: Int
  let height: Int
  private let start: (Int) -> Int
  let step: Int

  init(_ crop: Crop, _ rotation: Int) {
    precondition([0, 90, 180, 270].contains(rotation), "rotation \(rotation)")
    let cw = crop.width, ch = crop.height
    switch rotation {
    case 90:  // (sx, sy) lands at (ch - 1 - sy, sx)
      (width, height, step) = (ch, cw, ch)
      start = { sy in ch - 1 - sy }
    case 180:  // at (cw - 1 - sx, ch - 1 - sy)
      (width, height, step) = (cw, ch, -1)
      start = { sy in (ch - 1 - sy) * cw + cw - 1 }
    case 270:  // at (sy, cw - 1 - sx)
      (width, height, step) = (ch, cw, -ch)
      start = { sy in (cw - 1) * ch + sy }
    default:
      (width, height, step) = (cw, ch, 1)
      start = { sy in sy * cw }
    }
  }

  func first(_ sy: Int) -> Int { start(sy) }
}

/// An upright picture in colour: four bytes a pixel (red, green, blue, and one unused), row by row.
public struct Picture: Sendable {
  public let width: Int
  public let height: Int
  public let rgba: [UInt8]

  public init(width: Int, height: Int, rgba: [UInt8]) {
    precondition(rgba.count == 4 * width * height, "\(rgba.count) bytes for \(width)x\(height)")
    self.width = width
    self.height = height
    self.rgba = rgba
  }

  /// The part of a camera's BGRA frame inside crop, turned clockwise by rotation so it is upright. The frame is
  /// read with its row stride; nothing of the buffer is kept.
  public static func fromBGRA(_ frame: UnsafeRawBufferPointer, bytesPerRow: Int, crop: Crop, rotation: Int) -> Picture {
    let turn = Turn(crop, rotation)
    var out = [UInt8](repeating: 255, count: 4 * turn.width * turn.height)
    out.withUnsafeMutableBufferPointer { o in
      for sy in 0..<crop.height {
        var from = (crop.top + sy) * bytesPerRow + 4 * crop.left
        var to = 4 * turn.first(sy)
        for _ in 0..<crop.width {
          o[to] = frame[from + 2]
          o[to + 1] = frame[from + 1]
          o[to + 2] = frame[from]
          from += 4
          to += 4 * turn.step
        }
      }
    }
    return Picture(width: turn.width, height: turn.height, rgba: out)
  }
}

/// A pixel's brightness, as Kotlin's Luma.fromArgb: 77 of red, 150 of green and 29 of blue, of 256.
@inline(__always)
private func brightness(_ r: UInt8, _ g: UInt8, _ b: UInt8) -> UInt8 {
  UInt8((Int(r) * 77 + Int(g) * 150 + Int(b) * 29) >> 8)
}

/// BT.601's full-range Cb and Cr, as Kotlin's Chroma.cbOf and crOf: in whole numbers, kept to 0...255 (pure blue's
/// Cb, pure red's Cr would be 256).
@inline(__always)
private func cbOf(_ r: UInt8, _ g: UInt8, _ b: UInt8) -> Int { min(255, max(0, 128 + ((-43 * Int(r) - 85 * Int(g) + 128 * Int(b) + 128) >> 8))) }

@inline(__always)
private func crOf(_ r: UInt8, _ g: UInt8, _ b: UInt8) -> Int { min(255, max(0, 128 + ((128 * Int(r) - 107 * Int(g) - 21 * Int(b) + 128) >> 8))) }

extension Chroma {
  /// One pass over the part of a camera's BGRA frame inside crop, turned clockwise by rotation: its brightness
  /// (Luma.fromBGRA's) and its colour, gained. The iPhone gains before it narrows; Android's shot narrows its
  /// pixels first. They differ only near saturation, where the card is far past any step either way.
  public static func withLuma(fromBGRA frame: UnsafeRawBufferPointer, bytesPerRow: Int, crop: Crop, rotation: Int) -> (Luma, Chroma) {
    let turn = Turn(crop, rotation)
    let n = turn.width * turn.height
    // Three arrays of their own: `var cb = y` would share y's storage until written, and each would then be copied.
    var y = [UInt8](repeating: 0, count: n)
    var cb = [UInt8](repeating: 0, count: n)
    var cr = [UInt8](repeating: 0, count: n)
    y.withUnsafeMutableBufferPointer { oy in
      cb.withUnsafeMutableBufferPointer { ob in
        cr.withUnsafeMutableBufferPointer { orr in
          for sy in 0..<crop.height {
            var from = (crop.top + sy) * bytesPerRow + 4 * crop.left
            var to = turn.first(sy)
            for _ in 0..<crop.width {
              let b = frame[from], g = frame[from + 1], r = frame[from + 2]
              oy[to] = brightness(r, g, b)
              ob[to] = UInt8(gain(cbOf(r, g, b)))
              orr[to] = UInt8(gain(crOf(r, g, b)))
              from += 4
              to += turn.step
            }
          }
        }
      }
    }
    let w = turn.width, h = turn.height
    return (Luma(width: w, height: h, pixels: y), Chroma(cb: Luma(width: w, height: h, pixels: cb), cr: Luma(width: w, height: h, pixels: cr)))
  }

  /// The colour of an upright picture, gained.
  public static func of(_ p: Picture) -> Chroma {
    var cb = [UInt8](repeating: 0, count: p.width * p.height)
    var cr = [UInt8](repeating: 0, count: p.width * p.height)
    p.rgba.withUnsafeBufferPointer { src in
      for i in 0..<cb.count {
        cb[i] = UInt8(gain(cbOf(src[4 * i], src[4 * i + 1], src[4 * i + 2])))
        cr[i] = UInt8(gain(crOf(src[4 * i], src[4 * i + 1], src[4 * i + 2])))
      }
    }
    return Chroma(cb: Luma(width: p.width, height: p.height, pixels: cb), cr: Luma(width: p.width, height: p.height, pixels: cr))
  }
}

extension Luma {
  /// The brightness of the part of a camera's BGRA frame inside crop, turned clockwise by rotation so it is
  /// upright (Kotlin's fromPlane, for a frame in colour).
  public static func fromBGRA(_ frame: UnsafeRawBufferPointer, bytesPerRow: Int, crop: Crop, rotation: Int) -> Luma {
    let turn = Turn(crop, rotation)
    var out = [UInt8](repeating: 0, count: turn.width * turn.height)
    out.withUnsafeMutableBufferPointer { o in
      for sy in 0..<crop.height {
        var from = (crop.top + sy) * bytesPerRow + 4 * crop.left
        var to = turn.first(sy)
        for _ in 0..<crop.width {
          o[to] = brightness(frame[from + 2], frame[from + 1], frame[from])
          from += 4
          to += turn.step
        }
      }
    }
    return Luma(width: turn.width, height: turn.height, pixels: out)
  }

  /// The brightness of an upright picture.
  public static func of(_ p: Picture) -> Luma {
    var out = [UInt8](repeating: 0, count: p.width * p.height)
    p.rgba.withUnsafeBufferPointer { src in
      for i in 0..<out.count { out[i] = brightness(src[4 * i], src[4 * i + 1], src[4 * i + 2]) }
    }
    return Luma(width: p.width, height: p.height, pixels: out)
  }

  /// This picture made `across` pixels across, its height in proportion; itself when it is no wider. Each
  /// pixel of the narrower picture is the mean of the area it covers in this one, whatever the ratio, in whole
  /// numbers throughout, a half going upward. (The finder's numbers are in pixels and were tuned on pictures
  /// about 570 across; Android's camera hands it frames of that size, an iPhone's does not.)
  public func narrowed(to across: Int) -> Luma {
    if width <= across { return self }
    let w = width, h = height
    let W = across, H = max(1, h * across / w)
    var out = [UInt8](repeating: 0, count: W * H)
    var row = [Int](repeating: 0, count: W)  // one of this picture's rows made W across: each a sum of w shares
    var sums = [Int](repeating: 0, count: W)
    var rowOf = -1
    let whole = w * h
    pixels.withUnsafeBufferPointer { src in
      for j in 0..<H {
        for i in 0..<W { sums[i] = 0 }
        // The rows of this picture that row j covers, each by `share` of H parts.
        var k = j * h / H
        while k * H < (j + 1) * h {
          let share = min((j + 1) * h, (k + 1) * H) - max(j * h, k * H)
          if rowOf != k {
            rowOf = k
            for i in 0..<W {
              var sum = 0
              var x = i * w / W
              while x * W < (i + 1) * w {
                sum += (min((i + 1) * w, (x + 1) * W) - max(i * w, x * W)) * Int(src[k * w + x])
                x += 1
              }
              row[i] = sum
            }
          }
          for i in 0..<W { sums[i] += share * row[i] }
          k += 1
        }
        for i in 0..<W { out[j * W + i] = UInt8((sums[i] + whole / 2) / whole) }
      }
    }
    return Luma(width: W, height: H, pixels: out)
  }
}
