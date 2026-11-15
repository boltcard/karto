import XCTest

@testable import CardLogic

final class CardShotTests: XCTestCase {
  // MARK: the card's corners in a shot

  /// A shot 864×1200 of a plain table, with or without a card the frame's size on it.
  private func shot(card: Bool) -> Picture {
    let w = 864, h = 1200
    let f = Box.frame(w, h, 0.86, 0.45)
    var rgba = [UInt8](repeating: 255, count: 4 * w * h)
    for y in 0..<h {
      for x in 0..<w {
        let on = card && Double(x) >= f.left && Double(x) < f.right && Double(y) >= f.top && Double(y) < f.bottom
        for c in 0..<3 { rgba[4 * (y * w + x) + c] = on ? 210 : 70 }
      }
    }
    return Picture(width: w, height: h, rgba: rgba)
  }

  func testTheCornersAreFoundAgainInTheShot() {
    let p = shot(card: true)
    // Whatever outline was showing, the shot's own edges win: it was taken after the outline was drawn.
    let (q, source) = CardShot.corners(p, shown: [0.2, 0.2, 0.8, 0.2, 0.8, 0.5, 0.2, 0.5], frameWidth: 0.86, frameCentreY: 0.45)
    XCTAssertEqual(source, "shot")
    // In the shot's own pixels, not the narrower picture's that was searched.
    let f = Box.frame(864, 1200, 0.86, 0.45)
    for (found, drawn) in zip(q.corners, f.quad().corners) {
      XCTAssertEqual(found.x, drawn.x, accuracy: 3)
      XCTAssertEqual(found.y, drawn.y, accuracy: 3)
    }
  }

  func testFailingThatTheOutlineThatWasShowing() {
    let (q, source) = CardShot.corners(shot(card: false), shown: [0.25, 0.25, 0.75, 0.25, 0.75, 0.5, 0.25, 0.5], frameWidth: 0.86, frameCentreY: 0.45)
    XCTAssertEqual(source, "outline")
    XCTAssertEqual(q, Quad(Pt(216, 300), Pt(648, 300), Pt(648, 600), Pt(216, 600)))
  }

  func testFailingThatTheFrame() {
    let (q, source) = CardShot.corners(shot(card: false), shown: nil, frameWidth: 0.86, frameCentreY: 0.45)
    XCTAssertEqual(source, "frame")
    XCTAssertEqual(q, Box.frame(864, 1200, 0.86, 0.45).quad())
  }

  // MARK: one frame of the camera's

  func testAFrameIsSearchedAt576Across() {
    // The shot's picture as the camera stores it: on its side, BGRA.
    let p = shot(card: true)
    var stored = [UInt8](repeating: 255, count: 4 * p.width * p.height)
    for y in 0..<p.height {
      for x in 0..<p.width {
        // Upright (x, y) is stored at column y, row width - 1 - x: turned clockwise by 90 it is upright again.
        let to = 4 * ((p.width - 1 - x) * p.height + y)
        let from = 4 * (y * p.width + x)
        stored[to] = p.rgba[from + 2]
        stored[to + 1] = p.rgba[from + 1]
        stored[to + 2] = p.rgba[from]
      }
    }
    stored.withUnsafeBytes { b in
      let look = CardShot.look(b, bytesPerRow: 4 * p.height, crop: Crop(left: 0, top: 0, right: p.height, bottom: p.width), rotation: 90, frameWidth: 0.86, frameCentreY: 0.45)
      XCTAssertEqual([look.width, look.height], [576, 800])
      let f = Box.frame(576, 800, 0.86, 0.45)
      guard let q = look.card else { return XCTFail("no card found") }
      for (found, drawn) in zip(q.corners, f.quad().corners) {
        XCTAssertEqual(found.x, drawn.x, accuracy: 2)
        XCTAssertEqual(found.y, drawn.y, accuracy: 2)
      }
    }
  }

  // MARK: the thumbnail's file

  private let thumb = Picture(width: 428, height: 270, rgba: [UInt8](repeating: 200, count: 4 * 428 * 270))

  private func segment(_ marker: UInt8, _ body: [UInt8]) -> [UInt8] {
    [0xFF, marker, UInt8((body.count + 2) >> 8), UInt8((body.count + 2) & 0xFF)] + body
  }

  /// A JPEG of `bytes` bytes in all once its EXIF (30 bytes with its marker) is taken off, saying it is w×h.
  private func jpeg(_ bytes: Int, w: Int = 428, h: Int = 270, exif: Bool = true) -> [UInt8] {
    let frame = segment(0xC0, [8, UInt8(h >> 8), UInt8(h & 0xFF), UInt8(w >> 8), UInt8(w & 0xFF), 1, 1, 0x11, 0])
    let head: [UInt8] = [0xFF, 0xD8] + (exif ? segment(0xE1, [UInt8](repeating: 0x45, count: 26)) : [])
    let scan = segment(0xDA, [1, 1, 0, 0, 63, 0])
    let fixed = 2 + frame.count + scan.count + 2
    return head + frame + scan + [UInt8](repeating: 0x55, count: bytes - fixed) + [0xFF, 0xD9]
  }

  func testTheFirstQualityIsUsedWhenItFits() throws {
    var asked = [Double]()
    let out = try CardShot.jpeg(of: thumb) { picture, quality in
      XCTAssertEqual([picture.width, picture.height], [428, 270])
      asked.append(quality)
      return self.jpeg(CardThumb.MAX_BYTES)
    }
    XCTAssertEqual(asked, [0.80])
    XCTAssertEqual(out.count, CardThumb.MAX_BYTES)
    XCTAssertFalse(Jpeg.hasApp1(out))
  }

  /// It is weighed only once its metadata is off: a file over the limit by its EXIF alone fits.
  func testItIsWeighedWithoutItsMetadata() throws {
    let encoded = jpeg(CardThumb.MAX_BYTES)
    XCTAssertEqual(encoded.count, CardThumb.MAX_BYTES + 30)
    XCTAssertEqual(try CardShot.jpeg(of: thumb) { _, _ in encoded }.count, CardThumb.MAX_BYTES)
  }

  func testOverTheLimitItIsMadeAgainAtTheLowerQuality() throws {
    var asked = [Double]()
    let out = try CardShot.jpeg(of: thumb) { _, quality in
      asked.append(quality)
      return self.jpeg(quality > 0.7 ? CardThumb.MAX_BYTES + 1 : 40_000)
    }
    XCTAssertEqual(asked, [0.80, 0.60])
    XCTAssertEqual(out.count, 40_000)
  }

  func testStillOverTheLimitIsTooBig() {
    XCTAssertThrowsError(try CardShot.jpeg(of: thumb) { _, _ in self.jpeg(CardThumb.MAX_BYTES + 1) }) { XCTAssertEqual($0 as? ShotFailure, .tooBig) }
  }

  /// The three things the app's guard and the server check after it (cardphoto/take.ts, cards/photo.go).
  func testAFileThatIsNotAThumbnailIsNeverAnswered() {
    XCTAssertThrowsError(try CardShot.jpeg(of: thumb) { _, _ in self.jpeg(30_000, w: 856, h: 540) }) {
      XCTAssertEqual($0 as? ShotFailure, .capture("the photo came out 856×540"))
    }
    XCTAssertThrowsError(try CardShot.jpeg(of: thumb) { _, _ in Array("not a picture".utf8) }) {
      XCTAssertEqual($0 as? ShotFailure, .capture("the photo's file can't be read"))
    }
    // What the encoder itself throws is passed on.
    XCTAssertThrowsError(try CardShot.jpeg(of: thumb) { _, _ in throw ShotFailure.capture("the photo couldn't be made a JPEG") }) {
      XCTAssertEqual($0 as? ShotFailure, .capture("the photo couldn't be made a JPEG"))
    }
  }

  // MARK: what a failed shot says

  func testEachFailureHasTheCodeTheAppReadsAndAndroidsWords() {
    XCTAssertEqual([ShotFailure.tooBig.code, ShotFailure.tooBig.words], ["ERR_PHOTO_TOO_BIG", "the photo is over 64 KB at quality 60"])
    XCTAssertEqual([ShotFailure.closed.code, ShotFailure.closed.words], ["ERR_CAMERA_CLOSED", "the camera closed before the photo was taken"])
    XCTAssertEqual([ShotFailure.capture("the camera gave no picture").code, ShotFailure.capture("the camera gave no picture").words], ["ERR_CAPTURE", "the camera gave no picture"])
  }

  // MARK: one shot at a time

  func testAShotWaitsForTheNextFrameAndIsTheOnlyOne() {
    let gate = ShotGate<String>()
    XCTAssertNil(gate.claim(), "no shot is wanted")
    let first = gate.begin("first")
    XCTAssertNotNil(first)
    XCTAssertNil(gate.begin("second"), "a photo is already being taken")
    XCTAssertEqual(gate.claim(), "first")
    XCTAssertNil(gate.claim(), "the next frame is not the shot's")
    XCTAssertNil(gate.begin("third"), "it is still being made")
    gate.done()
    XCTAssertNotNil(gate.begin("fourth"))
  }

  func testAShotNoFrameCameForIsGivenUpOnce() {
    let gate = ShotGate<String>()
    let first = gate.begin("first")!
    XCTAssertEqual(gate.expire(first), "first")
    XCTAssertNil(gate.expire(first))
    XCTAssertNil(gate.claim())
    // A frame came in time: the two seconds running out afterwards is nothing.
    let second = gate.begin("second")!
    XCTAssertEqual(gate.claim(), "second")
    XCTAssertNil(gate.expire(second))
    gate.done()
    // Nor does an old shot's time running out take a newer one.
    let third = gate.begin("third")!
    XCTAssertNil(gate.expire(second))
    XCTAssertNotEqual(second, third)
    XCTAssertEqual(gate.claim(), "third")
  }

  func testTheCameraClosingAnswersAWaitingShotOnce() {
    let gate = ShotGate<String>()
    XCTAssertNil(gate.close(), "nothing waits")
    let first = gate.begin("first")!
    XCTAssertEqual(gate.close(), "first")
    XCTAssertNil(gate.close())
    XCTAssertNil(gate.expire(first))
    XCTAssertNil(gate.claim())
    // One whose frame has come is left to be made and answered.
    _ = gate.begin("second")
    XCTAssertEqual(gate.claim(), "second")
    XCTAssertNil(gate.close())
    XCTAssertNil(gate.begin("third"))
    gate.done()
    XCTAssertNotNil(gate.begin("fourth"))
  }
}
