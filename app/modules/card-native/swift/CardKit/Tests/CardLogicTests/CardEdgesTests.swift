import Foundation
import XCTest

@testable import CardLogic

/// CardEdges on made-up pictures the size of an analysed frame: Android's cases
/// (android/src/test/.../CardEdgesTest.kt), each under its name there, with its pictures made the same way: a
/// card drawn as a filled four-sided shape, smoothed at its edges, with a little noise from the same generator.
/// A change to either file's cases is made in both.
final class CardEdgesTests: XCTestCase {
  private let w = 576
  private let h = 1280
  private lazy var frame = Box.frame(w, h, 0.86, 0.45)

  /// A shape drawn over the picture: its corners and its grey level.
  private struct Shape {
    let q: Quad
    let level: Int
    var radius = 0.0
  }

  /// The picture: background, then each shape over the last, 3×3 samples a pixel, then light (levels added at a
  /// pixel, for light that falls unevenly), then noise of ±noise levels.
  /// The Kotlin asks every sample about every shape; here each shape is asked only about the samples in the
  /// box round its corners (a shape has nothing outside it), which is what a debug build has the time for.
  private func picture(_ background: Int, _ shapes: [Shape], noise: Int = 3, light: (Int, Int) -> Int = { _, _ in 0 }) -> Luma {
    var samples = [UInt8](repeating: UInt8(background), count: 9 * w * h)
    for s in shapes {
      let xs = s.q.corners.map(\.x)
      let ys = s.q.corners.map(\.y)
      let x0 = max(0, Int(xs.min()!.rounded(.down)) - 1), x1 = min(w - 1, Int(xs.max()!.rounded(.up)) + 1)
      let y0 = max(0, Int(ys.min()!.rounded(.down)) - 1), y1 = min(h - 1, Int(ys.max()!.rounded(.up)) + 1)
      guard x0 <= x1, y0 <= y1 else { continue }
      for y in y0...y1 {
        for sy in 0..<3 {
          let py = Double(y) + (Double(sy) + 0.5) / 3
          for x in x0...x1 {
            for sx in 0..<3 where inside(s, Double(x) + (Double(sx) + 0.5) / 3, py) {
              samples[(3 * y + sy) * 3 * w + 3 * x + sx] = UInt8(s.level)
            }
          }
        }
      }
    }
    var out = [UInt8](repeating: 0, count: w * h)
    var rnd = JavaRandom(seed: 1)
    for y in 0..<h {
      for x in 0..<w {
        var sum = 0
        for sy in 0..<3 {
          for sx in 0..<3 { sum += Int(samples[(3 * y + sy) * 3 * w + 3 * x + sx]) }
        }
        let v = sum / 9 + light(x, y) + (noise > 0 ? Int(rnd.nextInt(Int32(2 * noise + 1))) - noise : 0)
        out[y * w + x] = UInt8(min(255, max(0, v)))
      }
    }
    return Luma(width: w, height: h, pixels: out)
  }

  private func inside(_ s: Shape, _ x: Double, _ y: Double) -> Bool {
    let c = s.q.corners
    for i in 0..<4 {
      let a = c[i], b = c[(i + 1) % 4]
      if (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0 { return false }
    }
    if s.radius <= 0 { return true }
    // A rounded corner: inside the corner's r×r square but outside its circle is outside the card.
    for i in 0..<4 {
      let k = c[i]
      let u = unit(k, c[(i + 1) % 4]), v = unit(k, c[(i + 3) % 4])
      let du = (x - k.x) * u.x + (y - k.y) * u.y
      let dv = (x - k.x) * v.x + (y - k.y) * v.y
      if du < s.radius && dv < s.radius {
        let cx = k.x + (u.x + v.x) * s.radius
        let cy = k.y + (u.y + v.y) * s.radius
        if hypot(x - cx, y - cy) > s.radius { return false }
      }
    }
    return true
  }

  private func unit(_ a: Pt, _ b: Pt) -> Pt {
    let d = hypot(b.x - a.x, b.y - a.y)
    return Pt((b.x - a.x) / d, (b.y - a.y) / d)
  }

  /// A card the frame's size (times scale), turned by degrees about the frame's centre and moved by dx, dy.
  private func card(degrees: Double = 0, dx: Double = 0, dy: Double = 0, scale: Double = 1) -> Quad {
    let cx = (frame.left + frame.right) / 2
    let cy = (frame.top + frame.bottom) / 2
    let hw = frame.width / 2 * scale
    let hh = frame.height / 2 * scale
    let r = degrees / 180 * Double.pi
    func at(_ x: Double, _ y: Double) -> Pt { Pt(cx + dx + x * cos(r) - y * sin(r), cy + dy + x * sin(r) + y * cos(r)) }
    return Quad(at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh))
  }

  /// A strip of the card between fractions from and to of its height from its top edge.
  private func strip(_ card: Quad, _ from: Double, _ to: Double) -> Quad {
    func along(_ a: Pt, _ b: Pt, _ t: Double) -> Pt { Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) }
    return Quad(along(card.tl, card.bl, from), along(card.tr, card.br, from), along(card.tr, card.br, to), along(card.tl, card.bl, to))
  }

  /// The card's own shape inset by d pixels on every side (a printed border's outline).
  private func inset(_ card: Quad, _ d: Double) -> Quad {
    let c = card.corners
    return Quad(Pt(c[0].x + d, c[0].y + d), Pt(c[1].x - d, c[1].y + d), Pt(c[2].x - d, c[2].y - d), Pt(c[3].x + d, c[3].y - d))
  }

  /// A stripe the picture's height, its left side at x, width pixels wide.
  private func upright(_ x: Double, _ width: Double, _ from: Double = 0, _ to: Double? = nil) -> Quad {
    let to = to ?? Double(h)
    return Quad(Pt(x, from), Pt(x + width, from), Pt(x + width, to), Pt(x, to))
  }

  private func assertCorners(_ expected: Quad, _ found: Quad?, file: StaticString = #filePath, line: UInt = #line) {
    guard let found else { return XCTFail("no card found", file: file, line: line) }
    for (i, (e, f)) in zip(expected.corners, found.corners).enumerated() {
      XCTAssertLessThanOrEqual(hypot(e.x - f.x, e.y - f.y), 2.0, "corner \(i) at (\(f.x), \(f.y)), drawn at (\(e.x), \(e.y))", file: file, line: line)
    }
  }

  func testACardSquareToTheFrame() {
    let c = card()
    assertCorners(c, CardEdges.find(picture(90, [Shape(q: c, level: 200)]), frame))
  }

  func testSkewedBy5And10Degrees() {
    for d in [5.0, -10.0] {
      let c = card(degrees: d, scale: 0.92)
      assertCorners(c, CardEdges.find(picture(90, [Shape(q: c, level: 200)]), frame))
    }
  }

  func testAtAnAngleATrapezium() {
    let c = card()
    let narrow = frame.width * 0.08
    let t = Quad(Pt(c.tl.x + narrow, c.tl.y + 10), Pt(c.tr.x - narrow, c.tr.y + 10), c.br, c.bl)
    assertCorners(t, CardEdges.find(picture(90, [Shape(q: t, level: 200)]), frame))
  }

  func testShiftedTowardTheEdgeOfTheBands() {
    let band = frame.height * CardEdges.BAND
    let c = card(dx: -band * 0.6, dy: band * 0.7, scale: 0.97)
    assertCorners(c, CardEdges.find(picture(90, [Shape(q: c, level: 200)]), frame))
  }

  func testBandsClippedByThePicturesEdges() {
    // The frame's left side is about 40 pixels from the picture's edge; its band reaches 62. A card
    // reaching nearly to the edge is still found.
    let c = card(dx: -frame.left + 6, scale: 1.0)
    assertCorners(c, CardEdges.find(picture(90, [Shape(q: c, level: 200)]), frame))
  }

  func testAFingerAcrossOneEdge() {
    let c = card()
    let mx = (frame.left + frame.right) / 2
    let finger = Quad(Pt(mx - 30, c.bl.y - 60), Pt(mx + 30, c.bl.y - 60), Pt(mx + 30, Double(h) - 1.0), Pt(mx - 30, Double(h) - 1.0))
    assertCorners(c, CardEdges.find(picture(90, [Shape(q: c, level: 200), Shape(q: finger, level: 150)]), frame))
  }

  func testRoundedCorners() {
    let c = card(degrees: 3.0, scale: 0.95)
    assertCorners(c, CardEdges.find(picture(90, [Shape(q: c, level: 200, radius: frame.height * 3.18 / 54)]), frame))
  }

  func testACardDarkerThanItsBackgroundAndOneLighter() {
    let c = card(degrees: 2.0)
    assertCorners(c, CardEdges.find(picture(210, [Shape(q: c, level: 60)]), frame))
    assertCorners(c, CardEdges.find(picture(40, [Shape(q: c, level: 120)]), frame))
  }

  func testAMagneticStripeIsNotTheEdge() {
    // A card's back: the stripe starts 5.5 mm from the top edge and is much darker than the card is
    // against the table, so its step is the stronger.
    let c = card()
    let stripe = strip(c, 5.5 / 54, 18.0 / 54)
    assertCorners(c, CardEdges.find(picture(120, [Shape(q: c, level: 200), Shape(q: stripe, level: 15)]), frame))
  }

  func testAPrintedBorderIsNotTheEdge() {
    let c = card(degrees: -2.0)
    let outer = inset(c, 8.0)
    let inner = inset(c, 12.0)
    let p = picture(110, [Shape(q: c, level: 190), Shape(q: outer, level: 20), Shape(q: inner, level: 190)])
    assertCorners(c, CardEdges.find(p, frame))
  }

  func testABusyFaceNearTheEdge() {
    // Three thin printed lines just inside the top edge: six steps on each line across the band, all
    // stronger than the card's own edge against the table. The edge must still be among the steps kept.
    let c = card()
    let px = 1.0 / frame.height
    let lines = [10.0, 22.0, 34.0].map { Shape(q: strip(c, $0 * px, ($0 + 4) * px), level: 20) }
    assertCorners(c, CardEdges.find(picture(150, [Shape(q: c, level: 200)] + lines), frame))
  }

  func testManyPrintedLinesNearTheEdgeAtAnySpacing() {
    // Up to five thin printed lines inside the top edge (ten steps, all stronger than the edge) at
    // several spacings: however many straight lines the band holds, the outermost one is the edge.
    let c = card()
    let px = 1.0 / frame.height
    for offsets in [[8.0, 16.0, 24.0, 32.0, 40.0], [12.0, 26.0, 40.0], [6.0, 18.0, 30.0, 42.0], [14.0, 22.0, 36.0, 48.0, 56.0]] {
      let lines = offsets.map { Shape(q: strip(c, $0 * px, ($0 + 3) * px), level: 20) }
      assertCorners(c, CardEdges.find(picture(150, [Shape(q: c, level: 200)] + lines), frame))
    }
  }

  func testStraightWoodGrainOutsideTheCardIsNotTheEdge() {
    // A table with straight grain: thin darker lines every 9 pixels, the whole picture's height, as on
    // an oak table. Each is a straight line in the left and right bands, outside
    // the card; none has the table on one side and the card on the other.
    // At several spacings and card places, so a grain line lands at every distance from the card's edge.
    for (spacing, c) in [(9, card(degrees: 1.5, scale: 0.94)), (7, card(dx: 3.0, scale: 0.9)), (13, card(degrees: -2.0, dx: -4.0, scale: 0.96)), (11, card(dy: 5.0))] {
      let grain = stride(from: 0, to: w, by: spacing).map { x in
        Shape(q: Quad(Pt(Double(x), 0.0), Pt(Double(x) + 2.0, 0.0), Pt(Double(x) + 2.0, Double(h)), Pt(Double(x), Double(h))), level: 95)
      }
      assertCorners(c, CardEdges.find(picture(125, grain + [Shape(q: c, level: 225)]), frame))
    }
  }

  func testATableLitUnevenly() {
    // Photos taken with the phone (2026-10-16): the phone held over the card shades the table on one side, so
    // white paper read 140 above the card and 210 below it. Held to one brightness for the whole table, the top
    // edge had "something unlike the table" outside it and was refused. Light falling off top to bottom over a
    // dark card and a light one, and side to side, where the left and right bands are off the picture.
    let c = card(degrees: 1.5, scale: 0.95)
    let midX = (frame.left + frame.right) / 2
    let midY = (frame.top + frame.bottom) / 2
    assertCorners(c, CardEdges.find(picture(165, [Shape(q: c, level: 40)], light: { _, y in roundToInt((Double(y) - midY) * 0.3) }), frame))
    assertCorners(c, CardEdges.find(picture(80, [Shape(q: c, level: 200)], light: { _, y in roundToInt((Double(y) - midY) * 0.25) }), frame))
    assertCorners(c, CardEdges.find(picture(165, [Shape(q: c, level: 40)], light: { x, _ in roundToInt((Double(x) - midX) * 0.3) }), frame))
  }

  /// A shadow along the card's left side: stripes a pixel wide and the card's height, levels[d] at d pixels out (0 the first).
  private func shadowLeft(_ c: Quad, _ levels: [Int]) -> [Shape] {
    levels.enumerated().map { d, v in Shape(q: upright(c.tl.x - Double(d) - 1, 1, c.tl.y, c.bl.y), level: v) }
  }

  /// start, start + step, … while short of end.
  private func ramp(_ start: Int, _ step: Int, _ end: Int) -> [Int] {
    Array(stride(from: start, to: end, by: step))
  }

  func testASoftShadowAlongOneSide() {
    // Light from the left, low: the paper beside the card's left side is 100 at the edge and climbs 6 a
    // pixel back to the paper's 200, as the iPhone 12 saw a dark card on white (about 100, 4 to 7 a pixel).
    let c = card(scale: 0.95)
    assertCorners(c, CardEdges.find(picture(200, shadowLeft(c, ramp(100, 6, 200)) + [Shape(q: c, level: 30)], noise: 1), frame))
  }

  func testASoftShadowAlongATurnedCard() {
    let c = card(degrees: 2, scale: 0.93)
    let shadow = ramp(100, 6, 200).enumerated().map { d, v in
      Shape(q: Quad(Pt(c.tl.x - Double(d) - 1, c.tl.y), Pt(c.tl.x - Double(d), c.tl.y), Pt(c.bl.x - Double(d), c.bl.y), Pt(c.bl.x - Double(d) - 1, c.bl.y)), level: v)
    }
    assertCorners(c, CardEdges.find(picture(200, shadow + [Shape(q: c, level: 30)], noise: 1), frame))
  }

  func testAShadowTooWideIsNotTaken() {
    // 60 at the edge, 6 a pixel: within a third of the table only about 14 pixels out, past SHADOW_TO.
    let c = card(scale: 0.95)
    XCTAssertNil(CardEdges.find(picture(200, shadowLeft(c, ramp(60, 6, 200)) + [Shape(q: c, level: 30)], noise: 1), frame))
  }

  func testABrightHaloIsNoShadow() {
    // Lighter than the table beside the edge: no shadow does that.
    let c = card(scale: 0.95)
    XCTAssertNil(CardEdges.find(picture(128, shadowLeft(c, ramp(200, -5, 128)) + [Shape(q: c, level: 30)], noise: 1), frame))
  }

  func testAShadowWithAHardStepIsNoShadow() {
    // A jump of 14 between plateaus: over SHADOW_SMOOTH, and too small a step over two pixels to be a line itself.
    // The jump must land on a pixel boundary, or the 3×3 sampling spreads it under SHADOW_SMOOTH.
    let c0 = card(scale: 0.95)
    let c = card(dx: c0.tl.x.rounded(.up) - c0.tl.x, scale: 0.95)
    let broken = [100, 106, 112, 118, 124, 124, 138, 138] + ramp(144, 6, 200)
    XCTAssertNil(CardEdges.find(picture(200, shadowLeft(c, broken) + [Shape(q: c, level: 30)], noise: 1), frame))
  }

  func testAShadowInColour() {
    // A grey card on a warm table of its brightness, the table's colour 14 nearer grey beside the left edge and
    // back over 10 pixels: in Cb and Cr a shadow.
    let c = card(scale: 0.95)
    let y = picture(150, [Shape(q: c, level: 150)])
    let cb = shadowLeft(c, (0..<10).map { 110 + Int((14 * Double(10 - $0) / 10).rounded()) }) + [Shape(q: c, level: 128)]
    let cr = shadowLeft(c, (0..<10).map { 150 - Int((14 * Double(10 - $0) / 10).rounded()) }) + [Shape(q: c, level: 128)]
    assertCorners(c, CardEdges.find(y, frame, colour(110, cb, 150, cr)))
  }

  func testAShadowsOwnLineInBrightnessIsNotTheEdgeOfAColourCard() {
    // Seen on an iPhone 12: a grey card on oak has no edge in brightness, so a shadow's own line there had
    // nothing in its own channel to drop it, and the outermost of the channels took it. A grey card on a warm table of
    // its brightness, a shadow beside its left side in brightness only: a core of 60 four pixels wide, then 100
    // climbing 6 a pixel. Colour has the card's edge; brightness, the core's outer edge 4 pixels out.
    let c = card(scale: 0.95)
    let y = picture(150, shadowLeft(c, Array(repeating: 60, count: 4) + ramp(100, 6, 150)) + [Shape(q: c, level: 150)], noise: 1)
    assertCorners(c, CardEdges.find(y, frame, colour(110, [Shape(q: c, level: 128)], 150, [Shape(q: c, level: 128)])))
  }

  func testAShadowBesideACardAtThePicturesEdge() {
    // The card's left edge 8 px from the picture's: the 14 pixels read past it leave the picture, so no shadow is
    // taken there, and no card.
    let c0 = card(scale: 0.95)
    let c = card(dx: 8 - c0.tl.x, scale: 0.95)
    XCTAssertNil(CardEdges.find(picture(200, shadowLeft(c, ramp(100, 6, 200)) + [Shape(q: c, level: 30)], noise: 1), frame))
  }

  func testADarkPrintedRampInsideTheCardIsNotTheEdge() {
    // Dark printing that brightens towards a light card's edge (as the artwork the port let in at 15 to 30 px):
    // the card's edge, further out, is the side. Each deeper inset is drawn over the last: 193 at 4 px in, darkening
    // 7 a pixel to 60 at 23 px in.
    let c = card(scale: 0.95)
    let printed = (0..<20).map { k in Shape(q: inset(c, 4 + Double(k)), level: 193 - 7 * k) }
    assertCorners(c, CardEdges.find(picture(90, [Shape(q: c, level: 230)] + printed, noise: 1), frame))
  }

  func testASoftGradientAndNoCardIsNoCard() {
    // A lamp's falloff across the table, 0.6 a pixel: no step anywhere, so nothing for the shadow rule to take.
    let midX = (frame.left + frame.right) / 2
    XCTAssertNil(CardEdges.find(picture(190, [], noise: 1) { x, _ in -Int((max(0, midX - Double(x)) * 0.6).rounded()) }, frame))
  }

  func testAGrainStripeBesideTheCardIsNotTheEdge() {
    // Oak (2026-10-16): a dark grain stripe about 3 pixels wide, 20 pixels outside the card's left edge, the side's
    // whole length. Read 1 to 3 pixels in, its inside was the stripe itself, unlike the table, so it passed as the
    // card's edge; 1 to 6 pixels in, it is the table again past the stripe.
    let c = card(scale: 0.94)
    let stripe = Shape(q: upright(c.tl.x - 23, 3), level: 100)
    assertCorners(c, CardEdges.find(picture(165, [stripe, Shape(q: c, level: 50)]), frame))
  }

  func testAStripeAlongPartOfASideIsNotTheEdge() {
    // A pencil by the card, or a grain stripe that runs out: dark, wide, straight, 20 pixels outside the left edge,
    // along 60% of the side, so its line has the support a line needs and the table outside it. Only along part
    // of the side does it step across: the card's edge steps all along it.
    let c = card(scale: 0.94)
    let pencil = Shape(q: upright(c.tl.x - 25, 5, frame.top, frame.top + frame.height * 0.6), level: 60)
    assertCorners(c, CardEdges.find(picture(165, [pencil, Shape(q: c, level: 230)]), frame))
  }

  func testAFingerAcrossTwoFifthsOfAShortSide() {
    // The card held flat by its end: a finger over the left edge for 40% of the side read. Where the finger is,
    // inside and outside are both finger and don't step, but nor is the table outside: those places don't count.
    // (Counted, they refused a side under any finger wider than about 11 mm.)
    let c = card()
    let midY = (frame.top + frame.bottom) / 2
    let half = frame.height * 0.8 * 0.4 / 2
    let finger = Quad(Pt(0, midY - half), Pt(c.tl.x + 60, midY - half), Pt(c.tl.x + 60, midY + half), Pt(0, midY + half))
    assertCorners(c, CardEdges.find(picture(90, [Shape(q: c, level: 200), Shape(q: finger, level: 150)]), frame))
  }

  /// Colour planes drawn as picture draws brightness (noise of ±1), then gained as a camera frame's are.
  private func colour(_ cb: Int, _ cbShapes: [Shape], _ cr: Int, _ crShapes: [Shape]) -> Chroma {
    Chroma.gained(picture(cb, cbShapes, noise: 1), picture(cr, crShapes, noise: 1))
  }

  func testTheGain() {
    XCTAssertEqual([0, 85, 100, 128, 150, 171, 255].map { Chroma.gain($0) }, [0, 0, 44, 128, 194, 255, 255])
  }

  func testAGreyCardOnAWarmTableOfItsBrightness() {
    // A grey artwork card on an oak table: no step of brightness at its edge, one of colour.
    let c = card(degrees: 1.5, scale: 0.95)
    let y = picture(150, [Shape(q: c, level: 150)])
    XCTAssertNil(CardEdges.find(y, frame))
    assertCorners(c, CardEdges.find(y, frame, colour(110, [Shape(q: c, level: 128)], 150, [Shape(q: c, level: 128)])))
  }

  func testAPrintedLineInsideAGreyCardIsNotTheEdge() {
    // In brightness the card outside the line is the table's, so the line passes as an edge: colour's is further out.
    let c = card(degrees: 1.5, scale: 0.95)
    let y = picture(150, [Shape(q: c, level: 150), Shape(q: inset(c, 6), level: 60), Shape(q: inset(c, 14), level: 150)])
    guard let alone = CardEdges.find(y, frame) else { return XCTFail("brightness alone takes the printed line") }
    for (e, f) in zip(c.corners, alone.corners) { XCTAssertGreaterThan(hypot(e.x - f.x, e.y - f.y), 4.0, "brightness alone at (\(f.x), \(f.y))") }
    assertCorners(c, CardEdges.find(y, frame, colour(110, [Shape(q: c, level: 128)], 150, [Shape(q: c, level: 128)])))
  }

  func testColourfulPrintingNearTheEdgeIsNotTheEdge() {
    let c = card(degrees: -2.0, scale: 0.94)
    let y = picture(150, [Shape(q: c, level: 150)])
    let printed = [Shape(q: c, level: 128), Shape(q: inset(c, 5), level: 200), Shape(q: inset(c, 13), level: 128)]
    assertCorners(c, CardEdges.find(y, frame, colour(110, printed, 150, [Shape(q: c, level: 128)])))
  }

  func testStripesOfColourOnTheTableAreNotTheEdge() {
    // Stripes 10 levels from the table in Cb, 30 once gained, as the brightness grain test's are; the oak's own
    // grain differs by at most 6 in Cb or Cr (measured on a Pixel 9a), by up to 44 in brightness.
    let c = card(degrees: 1.5, scale: 0.94)
    let stripes = stride(from: 0, to: w, by: 9).map { x in Shape(q: upright(Double(x), 2), level: 100) }
    let y = picture(150, [Shape(q: c, level: 150)])
    assertCorners(c, CardEdges.find(y, frame, colour(110, stripes + [Shape(q: c, level: 128)], 150, [Shape(q: c, level: 128)])))
  }

  func testStripesOfColourAndNoCardAreNoCard() {
    let stripes = stride(from: 0, to: w, by: 9).map { x in Shape(q: upright(Double(x), 2), level: 100) }
    XCTAssertNil(CardEdges.find(picture(150, []), frame, colour(110, stripes, 150, [])))
  }

  func testColourWithNothingInItChangesNothing() {
    let flat = Luma(width: w, height: h, pixels: [UInt8](repeating: 128, count: w * h))
    let grey = Chroma(cb: flat, cr: flat)
    let tilted = card(degrees: -2.0)
    let grain = stride(from: 0, to: w, by: 9).map { x in Shape(q: upright(Double(x), 2), level: 95) }
    let midY = (frame.top + frame.bottom) / 2
    let pictures = [
      picture(90, [Shape(q: card(), level: 200)]),
      picture(110, [Shape(q: tilted, level: 190), Shape(q: inset(tilted, 6), level: 20), Shape(q: inset(tilted, 9), level: 190)]),
      picture(125, grain + [Shape(q: card(degrees: 1.5, scale: 0.94), level: 225)]),
      picture(165, [Shape(q: card(degrees: 1.5, scale: 0.95), level: 40)], light: { _, y in roundToInt((Double(y) - midY) * 0.4) }),
      picture(110, []),
    ]
    // A sample of the existing cases, one of each kind: the plain card, printing, grain, uneven light, no card.
    for p in pictures { XCTAssertEqual(CardEdges.find(p, frame), CardEdges.find(p, frame, grey)) }
  }

  // Kotlin's colourOfAnotherSizeIsRefused is not here: a failed precondition stops the whole test run.

  func testLowContrastAndAPlainPictureAreNoCard() {
    XCTAssertNil(CardEdges.find(picture(110, [Shape(q: card(), level: 120)], noise: 2), frame))
    XCTAssertNil(CardEdges.find(picture(110, []), frame))
  }

  func testACardShapedEdgeOutsideTheBandsIsNoCard() {
    XCTAssertNil(CardEdges.find(picture(90, [Shape(q: card(scale: 0.45), level: 200)]), frame))
  }

  func testTheWrongProportionsAreRefused() {
    // Edges in all four bands, but the top and bottom near the frame's middle: too long for its height.
    let band = frame.height * CardEdges.BAND
    let c = Quad(
      Pt(frame.left, frame.top + band * 0.9), Pt(frame.right, frame.top + band * 0.9),
      Pt(frame.right, frame.bottom - band * 0.9), Pt(frame.left, frame.bottom - band * 0.9))
    XCTAssertNil(CardEdges.find(picture(90, [Shape(q: c, level: 200)]), frame))
  }

  func testIsCardRefusesTooSmallCrossedAndOddlyShapedCorners() {
    XCTAssertTrue(CardEdges.isCard(frame.quad(), frame))
    XCTAssertFalse(CardEdges.isCard(card(scale: 0.6), frame), "too small")
    let c = frame.quad()
    XCTAssertFalse(CardEdges.isCard(Quad(c.tl, c.br, c.tr, c.bl), frame), "crossed")
    XCTAssertFalse(CardEdges.isCard(Quad(c.tl, Pt(c.tl.x + frame.height, c.tl.y), Pt(c.tl.x + frame.height, c.bl.y), c.bl), frame), "square")
  }

  func testSteadyShowsAfterThreeAndGoesAfterFive() {
    let s = Steady()
    let a = card()
    let b = card(dx: 3.0)
    XCTAssertNil(s.add(a))
    XCTAssertNil(s.add(a))
    XCTAssertNil(s.add(nil))  // the run broke: three more are needed
    XCTAssertNil(s.add(a))
    XCTAssertNil(s.add(a))
    assertCorners(a, s.add(a))
    // The mean of the last three found.
    let shown = s.add(b)!
    XCTAssertEqual(shown.tl.x, a.tl.x + 1.0, accuracy: 1e-9)
    for _ in 0..<4 { XCTAssertNotNil(s.add(nil)) }
    XCTAssertNil(s.add(nil))
  }

  func testCornersAsFractionsMapOntoAPictureOfAnotherSize() {
    let q = Quad(Pt(57.6, 128.0), Pt(518.4, 128.0), Pt(518.4, 640.0), Pt(57.6, 640.0))
    let f = q.fractions(w, h)
    XCTAssertEqual(f.map { ($0 * 1000).rounded() / 1000 }, [0.1, 0.1, 0.9, 0.1, 0.9, 0.5, 0.1, 0.5])
    let big = Quad.ofFractions(f, 864, 1920)
    XCTAssertEqual(Pt((big.tl.x * 10).rounded() / 10, (big.tl.y * 10).rounded() / 10), Pt(86.4, 192.0))
    XCTAssertEqual(big.br.x, 777.6, accuracy: 1e-9)
  }

  func testTheFrameIsCardShapedAndPlaced() {
    XCTAssertEqual(frame.width, 0.86 * Double(w), accuracy: 1e-9)
    XCTAssertEqual(frame.height, frame.width / CardEdges.CARD_RATIO, accuracy: 1e-9)
    XCTAssertEqual((frame.top + frame.bottom) / 2, 0.45 * Double(h), accuracy: 1e-9)
    XCTAssertEqual((frame.left + frame.right) / 2, Double(w) / 2.0, accuracy: 1e-9)
  }

  // Two of the port's rules that no picture here turns on; the others are
  // JavaRandomTests' and the fixture's.

  func testTheMedianOfAnEvenCountIsTheUpperOne() {
    XCTAssertEqual(CardEdges.median([4, 1, 3, 2]), 3)
    XCTAssertEqual(CardEdges.median([2, 9, 5]), 5)
    XCTAssertEqual(CardEdges.median([7]), 7)
    XCTAssertNil(CardEdges.median([]))
  }

  func testTheFirstOfEqualGreatestWins() {
    XCTAssertEqual(CardEdges.firstGreatest(["a", "bb", "cc", "d"]) { Double($0.count) }, "bb")
    XCTAssertEqual(CardEdges.firstGreatest([3.0, -1.0]) { -$0 }, -1.0)
    XCTAssertNil(CardEdges.firstGreatest([Double]()) { $0 })
  }
}
