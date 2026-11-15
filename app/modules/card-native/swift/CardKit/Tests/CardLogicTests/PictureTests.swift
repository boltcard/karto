import XCTest

@testable import CardLogic

final class PictureTests: XCTestCase {
  // MARK: which part of a frame the view shows

  /// The iPhone 12: frames stored 1920×1440 on their side, a view 390×844 points. Upright the frame is
  /// 1440×1920, wider for its height than the view, so the view shows its whole height and its middle 887.
  func testAViewTallerThanThePictureShowsItsMiddleAcross() {
    let c = Viewport.crop(storedWidth: 1920, storedHeight: 1440, rotation: 90, viewWidth: 390, viewHeight: 844)
    XCTAssertEqual(c, Crop(left: 0, top: 276, right: 1920, bottom: 1163))
    XCTAssertEqual([c.width, c.height], [1920, 887])
    // The same picture stored upright.
    XCTAssertEqual(Viewport.crop(storedWidth: 1440, storedHeight: 1920, rotation: 0, viewWidth: 390, viewHeight: 844), Crop(left: 276, top: 0, right: 1163, bottom: 1920))
  }

  func testAViewWiderThanThePictureShowsItsMiddleDown() {
    let c = Viewport.crop(storedWidth: 1920, storedHeight: 1440, rotation: 90, viewWidth: 400, viewHeight: 300)
    XCTAssertEqual(c, Crop(left: 420, top: 0, right: 1500, bottom: 1440))
    XCTAssertEqual(Viewport.crop(storedWidth: 1920, storedHeight: 1440, rotation: 270, viewWidth: 400, viewHeight: 300), c)
  }

  func testAViewOfThePicturesOwnShapeShowsAllOfIt() {
    XCTAssertEqual(Viewport.crop(storedWidth: 1920, storedHeight: 1440, rotation: 90, viewWidth: 300, viewHeight: 400), Crop(left: 0, top: 0, right: 1920, bottom: 1440))
  }

  /// Before its first layout a view has no size: the whole frame, never a division by nothing.
  func testAViewWithNoSizeShowsTheWholeFrame() {
    XCTAssertEqual(Viewport.crop(storedWidth: 1920, storedHeight: 1440, rotation: 90, viewWidth: 0, viewHeight: 0), Crop(left: 0, top: 0, right: 1920, bottom: 1440))
  }

  /// The camera is asked for frames of its own 4:3 shape, about 1920 across, the size of Android's shot.
  func testTheCamerasFormatNearest1920AcrossOfItsOwnShape() {
    XCTAssertEqual(Viewport.format(among: [(1280, 720), (1920, 1080), (1920, 1440), (4032, 3024), (1440, 1080)]), 2)
    XCTAssertEqual(Viewport.format(among: [(1280, 720), (1440, 1080), (2592, 1944)]), 1)
    // The first of two as near, and of two the same.
    XCTAssertEqual(Viewport.format(among: [(2400, 1800), (1440, 1080), (1440, 1080)]), 0)
    // A camera with none of that shape keeps the format it has.
    XCTAssertNil(Viewport.format(among: [(1280, 720), (1920, 1080)]))
    XCTAssertNil(Viewport.format(among: []))
  }

  // MARK: a frame's pixels

  /// A 4×4 frame in a buffer with rows of 6 pixels: the pixel at (x, y) is blue b, green g, red r.
  private func frame(_ pixel: (Int, Int) -> (b: Int, g: Int, r: Int)) -> [UInt8] {
    var buf = [UInt8](repeating: 0xEE, count: 6 * 4 * 4)
    for y in 0..<4 {
      for x in 0..<4 {
        let p = pixel(x, y)
        buf.replaceSubrange((y * 24 + x * 4)..<(y * 24 + x * 4 + 4), with: [UInt8(p.b), UInt8(p.g), UInt8(p.r), 255])
      }
    }
    return buf
  }

  private func rows(_ l: Luma) -> [[Int]] { (0..<l.height).map { y in (0..<l.width).map { x in l.at(x, y) } } }

  /// Android's case for a camera's Y plane (CardEdgesTest.aYPlaneWithARowStrideCroppedAndTurned), for BGRA: a
  /// grey whose value at (x, y) is 10·y + x, cropped to x 1..3, y 0..1, and turned.
  func testABgraFrameWithARowStrideCroppedAndTurned() {
    let buf = frame { x, y in (10 * y + x, 10 * y + x, 10 * y + x) }
    let crop = Crop(left: 1, top: 0, right: 4, bottom: 2)
    buf.withUnsafeBytes { b in
      XCTAssertEqual(rows(Luma.fromBGRA(b, bytesPerRow: 24, crop: crop, rotation: 0)), [[1, 2, 3], [11, 12, 13]])
      XCTAssertEqual(rows(Luma.fromBGRA(b, bytesPerRow: 24, crop: crop, rotation: 90)), [[11, 1], [12, 2], [13, 3]])
      XCTAssertEqual(rows(Luma.fromBGRA(b, bytesPerRow: 24, crop: crop, rotation: 180)), [[13, 12, 11], [3, 2, 1]])
      XCTAssertEqual(rows(Luma.fromBGRA(b, bytesPerRow: 24, crop: crop, rotation: 270)), [[3, 13], [2, 12], [1, 11]])
    }
  }

  /// Kotlin's fromArgb: 77 of red, 150 of green and 29 of blue, of 256 (CardEdgesTest.argbBecomesItsBrightness).
  func testAColourBecomesItsBrightness() {
    let colours = [(255, 255, 255), (0, 0, 255), (0, 0, 0), (255, 0, 0), (0, 255, 0)]  // b, g, r
    let buf = frame { x, y in y == 0 ? colours[x] : colours[4] }
    buf.withUnsafeBytes { b in
      let l = Luma.fromBGRA(b, bytesPerRow: 24, crop: Crop(left: 0, top: 0, right: 4, bottom: 2), rotation: 0)
      XCTAssertEqual(rows(l), [[255, 76, 0, 28], [149, 149, 149, 149]])
    }
  }

  /// The shot keeps its colours: the same crop and turn, as red, green, blue and a byte unused.
  func testAFrameInColourCroppedAndTurned() {
    let buf = frame { x, y in (10 * y + x, 100 + 10 * y + x, 200 + 10 * y + x) }
    buf.withUnsafeBytes { b in
      let p = Picture.fromBGRA(b, bytesPerRow: 24, crop: Crop(left: 1, top: 0, right: 4, bottom: 2), rotation: 90)
      XCTAssertEqual([p.width, p.height], [2, 3])
      XCTAssertEqual(p.rgba, [211, 111, 11, 255, 201, 101, 1, 255, 212, 112, 12, 255, 202, 102, 2, 255, 213, 113, 13, 255, 203, 103, 3, 255])
      // Its brightness is the frame's.
      XCTAssertEqual(rows(Luma.of(p)), rows(Luma.fromBGRA(b, bytesPerRow: 24, crop: Crop(left: 1, top: 0, right: 4, bottom: 2), rotation: 90)))
    }
  }

  /// Kotlin's Chroma.fromArgb (CardEdgesTest.argbBecomesItsColour), from BGRA in the same pass as the brightness:
  /// grey, (200, 150, 100), pure red and pure blue, gained; cropped and turned as the brightness is.
  func testBGRABecomesItsColourInOnePass() {
    let colours = [(100, 100, 100), (100, 150, 200), (0, 0, 255), (255, 0, 0)]  // b, g, r
    let buf = frame { x, y in y == 0 ? colours[x] : (128, 128, 128) }
    let crop = Crop(left: 0, top: 0, right: 4, bottom: 2)
    buf.withUnsafeBytes { b in
      let (luma, c) = Chroma.withLuma(fromBGRA: b, bytesPerRow: 24, crop: crop, rotation: 0)
      XCTAssertEqual(rows(luma), rows(Luma.fromBGRA(b, bytesPerRow: 24, crop: crop, rotation: 0)))
      XCTAssertEqual(rows(c.cb), [[128, 29, 0, 255], [128, 128, 128, 128]])
      XCTAssertEqual(rows(c.cr), [[128, 215, 255, 65], [128, 128, 128, 128]])
      let (turnedLuma, turned) = Chroma.withLuma(fromBGRA: b, bytesPerRow: 24, crop: crop, rotation: 90)
      XCTAssertEqual(rows(turnedLuma), rows(Luma.fromBGRA(b, bytesPerRow: 24, crop: crop, rotation: 90)))
      XCTAssertEqual(rows(turned.cb), [[128, 128], [128, 29], [128, 0], [128, 255]])
    }
  }

  /// A straightened picture's colour, as a frame's.
  func testAPicturesColour() {
    let p = Picture(width: 2, height: 2, rgba: [100, 100, 100, 255, 200, 150, 100, 255, 255, 0, 0, 255, 0, 0, 255, 255])
    let c = Chroma.of(p)
    XCTAssertEqual(rows(c.cb), [[128, 29], [0, 255]])
    XCTAssertEqual(rows(c.cr), [[128, 215], [255, 65]])
  }

  /// Both planes narrowed as the brightness is.
  func testChromaNarrowsBothPlanes() {
    let cb = Luma(width: 4, height: 2, pixels: [0, 10, 20, 30, 40, 50, 60, 70])
    let cr = Luma(width: 4, height: 2, pixels: [70, 60, 50, 40, 30, 20, 10, 0])
    let n = Chroma(cb: cb, cr: cr).narrowed(to: 2)
    XCTAssertEqual(rows(n.cb), rows(cb.narrowed(to: 2)))
    XCTAssertEqual(rows(n.cr), rows(cr.narrowed(to: 2)))
  }

  // MARK: a picture made narrower

  /// Each pixel of the narrower picture is the mean of the area it covers in the wider: three across made two,
  /// the middle one shared half and half.
  func testNarrowedByTheMeanOfTheAreaEachPixelCovers() {
    let l = Luma(width: 3, height: 1, pixels: [0, 90, 240]).narrowed(to: 2)
    XCTAssertEqual([l.width, l.height], [2, 1])
    XCTAssertEqual(l.pixels, [30, 190])
    // Down as well as across, and a half goes upward: (0·4 + 10·2 + 30·2 + 50·1) / 9 = 14.4, and so on.
    let m = Luma(width: 3, height: 3, pixels: [0, 10, 20, 30, 50, 70, 100, 200, 255]).narrowed(to: 2)
    XCTAssertEqual([m.width, m.height], [2, 2])
    XCTAssertEqual(m.pixels, [14, 32, 101, 179])
  }

  /// The iPhone 12's viewport is 887 across, and the finder's numbers are tuned at 576.
  func testAPicture887AcrossIsMadeExactly576() {
    var pixels = [UInt8]()
    for _ in 0..<1920 {
      pixels.append(contentsOf: (0..<887).map { $0 < 444 ? 40 : 100 })
    }
    let l = Luma(width: 887, height: 1920, pixels: pixels).narrowed(to: 576)
    XCTAssertEqual([l.width, l.height], [576, 1246])
    // An edge 444 of 887 across is 288.3 of 576 across: flat to its left and right, and the pixel it falls in
    // mixed by the share of each side: (288·40 + 599·100) / 887.
    XCTAssertEqual((0..<5).map { l.at(286 + $0, 600) }, [40, 40, 81, 100, 100])
    XCTAssertEqual(l.at(0, 0), 40)
    XCTAssertEqual(l.at(575, 1245), 100)
  }

  func testAPictureNoWiderIsLeftAsItIs() {
    let l = Luma(width: 3, height: 2, pixels: [1, 2, 3, 4, 5, 6])
    XCTAssertEqual(l.narrowed(to: 576).pixels, l.pixels)
    XCTAssertEqual(l.narrowed(to: 3).pixels, l.pixels)
  }
}
