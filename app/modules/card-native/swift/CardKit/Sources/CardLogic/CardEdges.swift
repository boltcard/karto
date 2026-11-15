import Foundation

// Finding a card's four edges in a picture: each edge is looked for only in a band around the matching side of the card-shaped
// frame, and is the outermost straight step of brightness (and, given the colour, of Cb or Cr) that runs the
// side's length, so a magnetic stripe or a printed border inside the card never wins.
//
// This is android/.../cardnative/CardEdges.kt in Swift, line for line: the same constants under the same names,
// the same order of work, the same random trials (JavaRandom.swift), so the same brightness values give the same
// corners from both. A change to either finder is made in both; CardEdgesFixtureTests fails here when only one
// has moved.

/// A point in a picture's pixels.
public struct Pt: Equatable, Sendable {
  public let x: Double
  public let y: Double

  public init(_ x: Double, _ y: Double) {
    self.x = x
    self.y = y
  }
}

/// A card's corners, clockwise from its top left.
public struct Quad: Equatable, Sendable {
  public let tl: Pt
  public let tr: Pt
  public let br: Pt
  public let bl: Pt

  public init(_ tl: Pt, _ tr: Pt, _ br: Pt, _ bl: Pt) {
    self.tl = tl
    self.tr = tr
    self.br = br
    self.bl = bl
  }

  public var corners: [Pt] { [tl, tr, br, bl] }

  public func scaled(_ sx: Double, _ sy: Double) -> Quad {
    Quad(Pt(tl.x * sx, tl.y * sy), Pt(tr.x * sx, tr.y * sy), Pt(br.x * sx, br.y * sy), Pt(bl.x * sx, bl.y * sy))
  }

  /// As fractions of a w×h picture: x, y of each corner in turn.
  public func fractions(_ w: Int, _ h: Int) -> [Double] {
    corners.flatMap { [$0.x / Double(w), $0.y / Double(h)] }
  }

  public static func ofFractions(_ f: [Double], _ w: Int, _ h: Int) -> Quad {
    precondition(f.count == 8, "a quad has 4 corners")
    let w = Double(w), h = Double(h)
    return Quad(Pt(f[0] * w, f[1] * h), Pt(f[2] * w, f[3] * h), Pt(f[4] * w, f[5] * h), Pt(f[6] * w, f[7] * h))
  }
}

/// A rectangle in a picture's pixels.
public struct Box: Equatable, Sendable {
  public let left: Double
  public let top: Double
  public let right: Double
  public let bottom: Double

  public init(_ left: Double, _ top: Double, _ right: Double, _ bottom: Double) {
    self.left = left
    self.top = top
    self.right = right
    self.bottom = bottom
  }

  public var width: Double { right - left }
  public var height: Double { bottom - top }

  public func quad() -> Quad { Quad(Pt(left, top), Pt(right, top), Pt(right, bottom), Pt(left, bottom)) }

  /// The card-shaped frame in a w×h picture: widthFraction of its width, centred across, its centre centreY of the way down.
  public static func frame(_ w: Int, _ h: Int, _ widthFraction: Double, _ centreY: Double) -> Box {
    let fw = Double(w) * widthFraction
    let fh = fw / CardEdges.CARD_RATIO
    let left = (Double(w) - fw) / 2
    let top = Double(h) * centreY - fh / 2
    return Box(left, top, left + fw, top + fh)
  }
}

/// A picture's brightness, one byte a pixel, row by row. (Made from a camera's frame in Picture.swift.)
public struct Luma: Sendable {
  public let width: Int
  public let height: Int
  public let pixels: [UInt8]

  public init(width: Int, height: Int, pixels: [UInt8]) {
    precondition(pixels.count == width * height, "\(pixels.count) bytes for \(width)x\(height)")
    self.width = width
    self.height = height
    self.pixels = pixels
  }

  public func at(_ x: Int, _ y: Int) -> Int { Int(pixels[y * width + x]) }
}

/// A picture's colour as two planes the size of its brightness: Cb (blue against yellow) and Cr (red against
/// green), each already moved CardEdges.CHROMA_GAIN times as far from 128 as the camera gave it. The readers
/// (Picture.swift) apply the gain as they read. The finder searches each plane as it does the brightness.
/// Kotlin's Chroma, in CardEdges.kt.
public struct Chroma: Sendable {
  public let cb: Luma
  public let cr: Luma

  public init(cb: Luma, cr: Luma) {
    precondition(cb.width == cr.width && cb.height == cr.height, "Cb \(cb.width)x\(cb.height), Cr \(cr.width)x\(cr.height)")
    self.cb = cb
    self.cr = cr
  }

  /// v moved CHROMA_GAIN times as far from 128, kept to 0...255.
  public static func gain(_ v: Int) -> Int { min(255, max(0, 128 + CardEdges.CHROMA_GAIN * (v - 128))) }

  /// From planes as the camera gives them, not yet gained (the tests).
  public static func gained(_ cb: Luma, _ cr: Luma) -> Chroma {
    func plane(_ l: Luma) -> Luma { Luma(width: l.width, height: l.height, pixels: l.pixels.map { UInt8(gain(Int($0))) }) }
    return Chroma(cb: plane(cb), cr: plane(cr))
  }

  /// Both planes made `across` pixels across, as Luma.narrowed.
  public func narrowed(to across: Int) -> Chroma { Chroma(cb: cb.narrowed(to: across), cr: cr.narrowed(to: across)) }
}

public enum CardEdges {
  /// CR80: 85.6 × 54 mm.
  public static let CARD_RATIO = 85.6 / 54.0
  /// Each band reaches this much of the frame's height inside and outside its side.
  public static let BAND = 0.20
  /// The least step of brightness, in grey levels of 255, that can be an edge.
  static let MIN_STEP = 16
  /// Every second line across a band.
  static let LINE_EVERY = 2
  /// Only the middle of each side is read: the corners are rounded, and the other sides' edges cross there.
  static let SIDE_INSET = 0.10
  /// Two-point trials per line looked for, from a fixed seed, so the tests repeat.
  static let TRIALS = 200
  static let SEED: Int64 = 7
  /// A point is on a line within this many pixels.
  static let NEAR = 2.0
  /// A side's line needs a point on it from at least this share of the band's lines.
  static let SUPPORT = 0.5
  /// The most an edge may lean from its side (about 20°).
  static let MAX_TILT = 0.36
  /// The card's long sides over its short ones: 1.586 allowing for the card held at an angle.
  static let MIN_RATIO = 1.17
  static let MAX_RATIO = 2.14
  /// The card covers at least this share of the frame.
  static let MIN_AREA = 0.40
  /// The table's brightness is read in the outermost quarter of each band, beyond where the card usually is.
  static let TABLE_PART = 0.25
  /// A line's inside is read 1–3 pixels from it, so a line of grain just outside the card doesn't see the
  /// card, and again 1–6 pixels from it, so a dark grain stripe a few pixels wide outside the card isn't
  /// taken for the card past it (an oak table); its outside 2–6 pixels from it. Each is the
  /// median along the side, so a stripe or a finger across part of it doesn't move it.
  static let INSIDE_NEAR = 1
  static let INSIDE_FAR = 3
  static let INSIDE_DEEP = 6
  static let OUTSIDE_NEAR = 2
  static let OUTSIDE_FAR = 6
  /// The card's edge steps across all along the side: inside and outside at least MIN_STEP apart at this share
  /// of the places read along it (every fourth pixel) that have the table outside them. A pencil by the card
  /// along part of the side doesn't, nor a line joining the card's edge on part of the side to a grain stripe on
  /// the rest; a finger lying over part of the edge has neither the step nor the table outside, so is left out.
  static let STEPS_ALONG = 0.75
  /// The card's edge has the table outside it and something unlike the table inside: its outside is no
  /// further from the table's brightness than this share of how far its inside is, and its inside is at
  /// least two steps from it. A line of wood grain has the table on both sides; a printed line inside the
  /// card has the card outside it.
  static let OUTSIDE_LIKE_TABLE = 1.0 / 3
  /// Light from one side, low, leaves a soft shadow along the card's far edge, darker than the table, so the strip
  /// outside that edge isn't the table and the side was refused (an iPhone 12 outlined a dark card on
  /// white in 1 of 59 frames). A line also passes when its outside is plainly such a shadow: on the shadow's side of
  /// the table (darker; in Cb and Cr, nearer grey), coming back to it within SHADOW_TO pixels, about 1.7 mm (read
  /// further, dark printing inside a card that brightens towards its edge passed too): a SHADOW_WINDOW-pixel window
  /// starting SHADOW_FROM to SHADOW_TO pixels out has its median within a third of inFar of the table; from the line to
  /// the window's end no pixel's median differs from the last by more than SHADOW_SMOOTH (a hard step is no shadow),
  /// and up to the window none is further from the table than the last by more than SHADOW_SLACK.
  static let SHADOW_FROM = 6
  static let SHADOW_TO = 10
  static let SHADOW_WINDOW = 5
  static let SHADOW_SMOOTH = 12
  static let SHADOW_SLACK = 4

  /// How a line passed as an edge: not at all, with the table outside it, or with a shadow outside it.
  private enum Edge { case none, table, shadow }
  /// Cb and Cr are searched with every difference trebled about 128. A grey card on an oak table, the same
  /// brightness, differs from it by about 32 in each (Pixel 9a frames): under the 48 a point needs
  /// across a 3-pixel sum, about 96 once trebled. Doubled found 13 of 38 such frames, trebled 14, four times 14;
  /// none found a card in 232 frames without one.
  static let CHROMA_GAIN = 3

  /// The sides in the order they are looked for (the Kotlin enum's order).
  private enum Side: CaseIterable {
    case top, right, bottom, left

    var horizontal: Bool { self == .top || self == .bottom }
    var outward: Int { self == .top || self == .left ? -1 : 1 }
  }

  /// A side's line: across = a + b × along (along is x for the top and bottom, y for the left and right).
  private struct Line {
    let a: Double
    let b: Double
    /// hypot(1, b), worked out once, as the Kotlin's `length`.
    let length: Double

    init(_ a: Double, _ b: Double) {
      self.a = a
      self.b = b
      self.length = hypot(1.0, b)
    }

    func across(_ along: Double) -> Double { a + b * along }
    func distance(_ along: Double, _ across: Double) -> Double { abs(across - self.across(along)) / length }
  }

  /// A step of brightness found in a band: where, and on which of the band's lines.
  private struct Step {
    let along: Double
    let across: Double
    let line: Int
  }

  /// The card's corners in the picture, or nil when its four edges aren't all found. With its colour, each
  /// side is looked for in the brightness, Cb and Cr alike (each against its own table), and the outermost
  /// line any of them finds is the side's.
  public static func find(_ p: Luma, _ frame: Box, _ colour: Chroma? = nil) -> Quad? {
    precondition(colour == nil || (colour!.cb.width == p.width && colour!.cb.height == p.height), "colour \(colour?.cb.width ?? 0)x\(colour?.cb.height ?? 0) for \(p.width)x\(p.height)")
    let band = frame.height * BAND
    let channels = colour.map { [p, $0.cb, $0.cr] } ?? [p]
    let tables = channels.map { Table.read($0, frame, band) }
    guard tables[0] != nil else { return nil }
    guard let top = outermost(channels, tables, frame, band, .top) else { return nil }
    guard let right = outermost(channels, tables, frame, band, .right) else { return nil }
    guard let bottom = outermost(channels, tables, frame, band, .bottom) else { return nil }
    guard let left = outermost(channels, tables, frame, band, .left) else { return nil }
    let q = Quad(cross(top, left), cross(top, right), cross(bottom, right), cross(bottom, left))
    return isCard(q, frame) ? q : nil
  }

  /// The side's line: of the lines the channels pass, the outermost at the side's middle; of equals the first, in the
  /// order Y, Cb, Cr. A steep shadow makes a line of its own a few pixels out from the card, which passes as a shadow
  /// too and would be the outermost: a line passed only as a shadow with another passed line, of any channel, within
  /// SHADOW_TO pixels inside it is in the shadow (a grey card on oak has no edge in brightness, only in
  /// colour, so the shadow's brightness line is dropped by colour's edge).
  private static func outermost(_ channels: [Luma], _ tables: [Table?], _ frame: Box, _ band: Double, _ s: Side) -> Line? {
    let (from, to) = span(frame, s)
    let middle = (from + to) / 2
    var passed = [(line: Line, edge: Edge)]()
    for i in channels.indices {
      guard let table = tables[i] else { continue }
      passed += side(channels[i], frame, band, s, table, brightness: i == 0)
    }
    let found = passed.enumerated().filter { i, l in
      let out = l.line.across(middle) * Double(s.outward)
      return l.edge != .shadow || !passed.enumerated().contains { j, o in
        j != i && out - o.line.across(middle) * Double(s.outward) > 0 && out - o.line.across(middle) * Double(s.outward) <= Double(SHADOW_TO)
      }
    }.map { $0.element.line }
    return firstGreatest(found) { $0.across(middle) * Double(s.outward) }
  }

  /// Whether four corners can be the card: convex, a card's proportions, and big enough.
  public static func isCard(_ q: Quad, _ frame: Box) -> Bool {
    let c = q.corners
    let turns = (0..<4).map { i -> Double in
      let a = c[i]
      let b = c[(i + 1) % 4]
      let d = c[(i + 2) % 4]
      return (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x)
    }
    if !(turns.allSatisfy { $0 > 0 } || turns.allSatisfy { $0 < 0 }) { return false }
    let long = (dist(q.tl, q.tr) + dist(q.bl, q.br)) / 2
    let short = (dist(q.tl, q.bl) + dist(q.tr, q.br)) / 2
    if short <= 0 || !(MIN_RATIO...MAX_RATIO).contains(long / short) { return false }
    var sum = 0.0
    for i in 0..<4 { sum += c[i].x * c[(i + 1) % 4].y - c[(i + 1) % 4].x * c[i].y }
    let area = abs(sum) / 2
    return area >= MIN_AREA * frame.width * frame.height
  }

  private static func dist(_ a: Pt, _ b: Pt) -> Double { hypot(a.x - b.x, a.y - b.y) }

  /// Where a top or bottom line meets a left or right one.
  private static func cross(_ h: Line, _ v: Line) -> Pt {
    // y = h.a + h.b·x and x = v.a + v.b·y
    let x = (v.a + v.b * h.a) / (1 - v.b * h.b)
    return Pt(x, h.across(x))
  }

  /// Where a side of the frame is, across, and the span it runs along.
  private static func sideAt(_ frame: Box, _ s: Side) -> Double {
    switch s {
    case .top: return frame.top
    case .bottom: return frame.bottom
    case .left: return frame.left
    case .right: return frame.right
    }
  }

  private static func span(_ frame: Box, _ s: Side) -> (Double, Double) {
    s.horizontal ? (frame.left, frame.right) : (frame.top, frame.bottom)
  }

  /// A pixel, across and along a side; nil outside the picture.
  private static func pixel(_ p: Luma, _ s: Side, _ along: Int, _ across: Int) -> Int? {
    if s.horizontal { return across >= 0 && across < p.height && along >= 0 && along < p.width ? p.at(along, across) : nil }
    return across >= 0 && across < p.width && along >= 0 && along < p.height ? p.at(across, along) : nil
  }

  /// The median, the upper one of an even count, as the Kotlin takes it (the sorted list's element at half its
  /// count); nil of nothing.
  static func median(_ seen: [Int]) -> Int? {
    if seen.isEmpty { return nil }
    return seen.sorted()[seen.count / 2]
  }

  /// The item with the greatest value, the first of equal ones, as Kotlin's maxByOrNull.
  static func firstGreatest<T>(_ items: [T], by value: (T) -> Double) -> T? {
    var best: T?
    var greatest = 0.0
    for item in items {
      let v = value(item)
      if best == nil || v > greatest {
        best = item
        greatest = v
      }
    }
    return best
  }

  /// The table's brightness beside each side, read in the outermost quarter of the bands. Light seldom falls
  /// evenly on a table: the phone held over the card shades one side of it, and white paper read 140 above a card
  /// and 210 below it (in photos taken with the phone). So each side is held to the table beside it: the median of
  /// its own band's quarter, when at least half of that is in the picture; else (the frame's left and right sides
  /// are near the picture's edges, and their quarters off it) a plane through the medians of the halves of the
  /// quarters that are, read where the line is; else the median of everything read.
  private struct Table {
    let own: [Side: Int]
    let plane: [Double]?
    let whole: Int

    /// The table beside side s at (x, y).
    func beside(_ s: Side, _ x: Double, _ y: Double) -> Int {
      if let t = own[s] { return t }
      if let b = plane { return roundToInt(b[0] + b[1] * x + b[2] * y) }
      return whole
    }

    static func read(_ p: Luma, _ frame: Box, _ band: Double) -> Table? {
      var all = [Int]()
      var own = [Side: Int]()
      var halves = [[Double]]() // x, y, brightness
      for s in Side.allCases {
        let at = sideAt(frame, s)
        let (from, to) = span(frame, s)
        let middle = (from + to) / 2
        let outward = Double(s.outward)
        var seen = [[Int]](repeating: [], count: 2)
        var tried = [0, 0]
        var sumX = [0.0, 0.0]
        var sumY = [0.0, 0.0]
        var across = at + outward * band * (1 - TABLE_PART)
        while (across - at) * outward <= band {
          var along = from
          while along <= to {
            let half = along < middle ? 0 : 1
            let x = roundToInt(s.horizontal ? along : across)
            let y = roundToInt(s.horizontal ? across : along)
            tried[half] += 1
            if x >= 0 && x < p.width && y >= 0 && y < p.height {
              seen[half].append(p.at(x, y))
              sumX[half] += Double(x)
              sumY[half] += Double(y)
            }
            along += 4
          }
          across += Double(2 * s.outward)
        }
        for half in 0...1 {
          let n = seen[half].count
          all += seen[half]
          if n > 0 && 2 * n >= tried[half], let m = median(seen[half]) {
            halves.append([sumX[half] / Double(n), sumY[half] / Double(n), Double(m)])
          }
        }
        let both = seen[0] + seen[1]
        if !both.isEmpty && 2 * both.count >= tried[0] + tried[1] { own[s] = median(both) }
      }
      guard let whole = median(all) else { return nil }
      return Table(own: own, plane: plane(halves), whole: whole)
    }

    /// The plane b0 + b1·x + b2·y nearest the points (least squares), or nil when they don't fix one (fewer than
    /// three, or in a line).
    private static func plane(_ points: [[Double]]) -> [Double]? {
      if points.count < 3 { return nil }
      // The normal equations, m · b = v, solved by Cramer's rule.
      var m = [[Double]](repeating: [0, 0, 0], count: 3)
      var v = [0.0, 0.0, 0.0]
      for pt in points {
        let row = [1.0, pt[0], pt[1]]
        for i in 0...2 {
          for j in 0...2 { m[i][j] += row[i] * row[j] }
          v[i] += row[i] * pt[2]
        }
      }
      func det(_ a: [[Double]]) -> Double {
        a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
      }
      let d = det(m)
      if abs(d) <= 1e-9 * m[0][0] * m[1][1] * m[2][2] { return nil }
      return (0...2).map { k in det((0...2).map { i in (0...2).map { j in j == k ? v[i] : m[i][j] } }) / d }
    }
  }

  /// A line's median brightness near..far pixels to one side: outward (+1) or inward (-1) of the card.
  private static func beside(_ p: Luma, _ s: Side, _ line: Line, _ first: Int, _ last: Int, _ way: Int, _ near: Int, _ far: Int) -> Int? {
    var seen = [Int]()
    var along = first
    while along <= last {
      for d in near...far {
        if let v = pixel(p, s, along, roundToInt(line.across(Double(along)) + Double(way * s.outward * d))) { seen.append(v) }
      }
      along += 4
    }
    return median(seen)
  }

  /// How a line passes: its inside unlike the table and its outside like it (table), or its outside a shadow that
  /// comes back to the table (shadow); and it steps across all along it, its outside read where the table is.
  private static func hasTableOutside(_ p: Luma, _ s: Side, _ line: Line, _ first: Int, _ last: Int, _ table: Int, brightness: Bool) -> Edge {
    guard let outside = beside(p, s, line, first, last, 1, OUTSIDE_NEAR, OUTSIDE_FAR) else { return .none }
    guard let inside = beside(p, s, line, first, last, -1, INSIDE_NEAR, INSIDE_FAR) else { return .none }
    guard let deep = beside(p, s, line, first, last, -1, INSIDE_NEAR, INSIDE_DEEP) else { return .none }
    let inFar = min(abs(inside - table), abs(deep - table))
    if inFar < 2 * MIN_STEP { return .none }
    if Double(abs(outside - table)) <= Double(inFar) * OUTSIDE_LIKE_TABLE {
      return stepsAlong(p, s, line, first, last, table, inFar, OUTSIDE_NEAR, OUTSIDE_FAR) ? .table : .none
    }
    guard let from = shadowReached(p, s, line, first, last, table, inFar, outside, brightness: brightness) else { return .none }
    return stepsAlong(p, s, line, first, last, table, inFar, from, from + SHADOW_WINDOW - 1) ? .shadow : .none
  }

  /// Where a shadow outside the line has come back to the table: its window's first pixel out; nil when it is no such shadow.
  private static func shadowReached(_ p: Luma, _ s: Side, _ line: Line, _ first: Int, _ last: Int, _ table: Int, _ inFar: Int, _ outside: Int, brightness: Bool) -> Int? {
    let shadowSide = brightness ? outside < table : abs(outside - 128) < abs(table - 128)
    if !shadowSide { return nil }
    let far = SHADOW_TO + SHADOW_WINDOW - 1
    var m = [Int](repeating: 0, count: far + 1)
    for d in OUTSIDE_NEAR...far {
      guard let v = beside(p, s, line, first, last, 1, d, d) else { return nil }
      m[d] = v
    }
    var from = -1
    for start in SHADOW_FROM...SHADOW_TO {
      let window = m[start..<(start + SHADOW_WINDOW)].sorted()
      if Double(abs(window[SHADOW_WINDOW / 2] - table)) <= Double(inFar) * OUTSIDE_LIKE_TABLE {
        from = start
        break
      }
    }
    if from < 0 { return nil }
    for d in OUTSIDE_NEAR..<(from + SHADOW_WINDOW - 1) where abs(m[d + 1] - m[d]) > SHADOW_SMOOTH { return nil }
    for d in OUTSIDE_NEAR..<from where abs(m[d + 1] - table) > abs(m[d] - table) + SHADOW_SLACK { return nil }
    return from
  }

  /// Whether the line's inside (1–6 pixels) and outside (near–far pixels: 2–6, or where a shadow came back to the
  /// table) are MIN_STEP apart at STEPS_ALONG of the places along it whose outside is as like the table as the whole
  /// line's must be.
  private static func stepsAlong(_ p: Luma, _ s: Side, _ line: Line, _ first: Int, _ last: Int, _ table: Int, _ inFar: Int, _ near: Int, _ far: Int) -> Bool {
    var places = 0
    var steps = 0
    var along = first
    while along <= last {
      let at = line.across(Double(along))
      var inside = [Int]()
      var outside = [Int]()
      for d in INSIDE_NEAR...INSIDE_DEEP {
        if let v = pixel(p, s, along, roundToInt(at - Double(s.outward * d))) { inside.append(v) }
      }
      for d in near...far {
        if let v = pixel(p, s, along, roundToInt(at + Double(s.outward * d))) { outside.append(v) }
      }
      if let i = median(inside), let o = median(outside), Double(abs(o - table)) <= Double(inFar) * OUTSIDE_LIKE_TABLE {
        places += 1
        if abs(i - o) >= MIN_STEP { steps += 1 }
      }
      along += 4
    }
    return places > 0 && Double(steps) >= STEPS_ALONG * Double(places)
  }

  /// The lines across a side's band that pass as its edge, each with how it passed; none when the band is off the picture.
  private static func side(_ p: Luma, _ frame: Box, _ band: Double, _ s: Side, _ table: Table, brightness: Bool) -> [(line: Line, edge: Edge)] {
    let at = sideAt(frame, s)
    let (from, to) = span(frame, s)
    let alongLimit = (s.horizontal ? p.width : p.height) - 2
    let acrossLimit = (s.horizontal ? p.height : p.width) - 2
    // The band, clipped to the picture (the frame's left and right sides are near its edges).
    let lo = max(1, Int((at - band).rounded(.up)))
    let hi = min(acrossLimit, Int((at + band).rounded(.down)))
    if hi - lo < 5 { return [] }
    let inset = (to - from) * SIDE_INSET
    let first = max(1, Int((from + inset).rounded(.up)))
    let last = min(alongLimit, Int((to - inset).rounded(.down)))
    var points = [Step]()
    var lines = 0
    let n = hi - lo + 1
    var sums = [Int](repeating: 0, count: n)
    var steps = [Int](repeating: 0, count: n)
    var along = first
    while along <= last {
      // The brightness across the band, each a 3-pixel sum along the side.
      for i in 0..<n {
        let c = lo + i
        sums[i] = s.horizontal ? p.at(along - 1, c) + p.at(along, c) + p.at(along + 1, c) : p.at(c, along - 1) + p.at(c, along) + p.at(c, along + 1)
      }
      for i in 1..<(n - 1) { steps[i] = abs(sums[i + 1] - sums[i - 1]) }
      // Every step over the threshold is kept, not only the strongest: printing near the edge is often a
      // stronger step than the card against the table, and the outermost line decides below.
      for i in 2..<(n - 2) {
        let m = steps[i]
        if m < 3 * MIN_STEP || m < steps[i - 1] || m <= steps[i + 1] { continue }
        // A parabola through the peak and its neighbours places it between pixels.
        let den = steps[i - 1] - 2 * m + steps[i + 1]
        let offset = den != 0 ? 0.5 * Double(steps[i - 1] - steps[i + 1]) / Double(den) : 0.0
        points.append(Step(along: Double(along), across: Double(lo + i) + offset, line: lines))
      }
      lines += 1
      along += LINE_EVERY
    }
    // The lines with the table outside them (or a shadow that comes back to it): the card's physical edge, not its
    // printing inside it nor the table's own grain outside it; outermost() takes the outermost of every channel's.
    let middle = (from + to) / 2
    var passed = [(line: Line, edge: Edge)]()
    for line in self.lines(points, lines) {
      let across = line.across(middle)
      let edge = hasTableOutside(p, s, line, first, last, s.horizontal ? table.beside(s, middle, across) : table.beside(s, across, middle), brightness: brightness)
      if edge != .none { passed.append((line, edge)) }
    }
    return passed
  }

  /// Every straight line through the points with enough support, best first, ignoring the outliers: all
  /// of them, however much printing the band holds, so the outermost is always among them.
  private static func lines(_ all: [Step], _ lines: Int) -> [Line] {
    var rnd = JavaRandom(seed: SEED)
    var out = [Line]()
    var left = all
    while left.count >= 2 {
      var best: Line?
      var bestSupport = 0
      for _ in 0..<TRIALS {
        let p = left[Int(rnd.nextInt(Int32(left.count)))]
        let q = left[Int(rnd.nextInt(Int32(left.count)))]
        if p.line == q.line { continue }
        let b = (q.across - p.across) / (q.along - p.along)
        if abs(b) > MAX_TILT { continue }
        let line = Line(p.across - b * p.along, b)
        let n = support(left, line, lines)
        if n > bestSupport {
          best = line
          bestSupport = n
        }
      }
      guard let rough = best else { break }
      if Double(bestSupport) < SUPPORT * Double(lines) { break }
      let line = leastSquares(left.filter { rough.distance($0.along, $0.across) <= NEAR }) ?? rough
      out.append(line)
      left = left.filter { line.distance($0.along, $0.across) > NEAR && rough.distance($0.along, $0.across) > NEAR }
    }
    return out
  }

  /// How many of the band's lines give a point on the line.
  private static func support(_ points: [Step], _ line: Line, _ lines: Int) -> Int {
    var seen = [Bool](repeating: false, count: lines)
    var n = 0
    for p in points where line.distance(p.along, p.across) <= NEAR && !seen[p.line] {
      seen[p.line] = true
      n += 1
    }
    return n
  }

  private static func leastSquares(_ points: [Step]) -> Line? {
    if points.count < 2 { return nil }
    let n = Double(points.count)
    var sx = 0.0, sy = 0.0
    for p in points {
      sx += p.along
      sy += p.across
    }
    let mx = sx / n
    let my = sy / n
    var sxx = 0.0
    for p in points { sxx += (p.along - mx) * (p.along - mx) }
    if sxx == 0.0 { return nil }
    var sxy = 0.0
    for p in points { sxy += (p.along - mx) * (p.across - my) }
    let b = sxy / sxx
    return Line(my - b * mx, b)
  }
}

/// The outline as the screen shows it: once three frames running found the card, at the mean of the last three
/// found, until five frames running find nothing.
public final class Steady {
  private let show: Int
  private let hide: Int
  private var recent = [Quad]()
  private var misses = 0

  public private(set) var shown: Quad?

  public init(show: Int = 3, hide: Int = 5) {
    self.show = show
    self.hide = hide
  }

  @discardableResult
  public func add(_ q: Quad?) -> Quad? {
    guard let q else {
      misses += 1
      if shown == nil {
        recent.removeAll()
      } else if misses >= hide {
        shown = nil
        recent.removeAll()
      }
      return shown
    }
    misses = 0
    recent.append(q)
    if recent.count > show { recent.removeFirst() }
    if shown != nil || recent.count == show { shown = mean(recent) }
    return shown
  }

  private func mean(_ qs: [Quad]) -> Quad {
    func avg(_ pick: (Quad) -> Pt) -> Pt {
      var x = 0.0, y = 0.0
      for q in qs {
        x += pick(q).x
        y += pick(q).y
      }
      return Pt(x / Double(qs.count), y / Double(qs.count))
    }
    return Quad(avg { $0.tl }, avg { $0.tr }, avg { $0.br }, avg { $0.bl })
  }
}
