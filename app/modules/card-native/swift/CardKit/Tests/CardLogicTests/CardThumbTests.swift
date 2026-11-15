import Foundation
import XCTest

@testable import CardLogic

final class CardThumbTests: XCTestCase {
  /// A picture whose colour says where each pixel is: red its x, green its y, each in steps of `per` pixels.
  private func map(_ w: Int, _ h: Int, per: Int = 4) -> Picture {
    var rgba = [UInt8]()
    rgba.reserveCapacity(4 * w * h)
    for y in 0..<h {
      for x in 0..<w { rgba.append(contentsOf: [UInt8(x / per), UInt8(y / per), 7, 255]) }
    }
    return Picture(width: w, height: h, rgba: rgba)
  }

  private func at(_ p: Picture, _ x: Int, _ y: Int) -> [Int] { (0..<3).map { Int(p.rgba[4 * (y * p.width + x) + $0]) } }

  /// Where a pixel of the thumbnail was read from, by its colour, to the nearest 4 pixels.
  private func assertFrom(_ thumb: Picture, _ x: Int, _ y: Int, _ sx: Double, _ sy: Double, file: StaticString = #filePath, line: UInt = #line) {
    let c = at(thumb, x, y)
    XCTAssertEqual(Double(c[0]) * 4, sx, accuracy: 6, "(\(x), \(y)) across", file: file, line: line)
    XCTAssertEqual(Double(c[1]) * 4, sy, accuracy: 6, "(\(x), \(y)) down", file: file, line: line)
  }

  /// Corners that are already a 428×270 rectangle: the thumbnail is that part of the picture, pixel for pixel.
  func testACardAlreadyStraightIsCutOutAsItIs() throws {
    let src = map(700, 400, per: 3)
    let thumb = try CardThumb.make(src, Quad(Pt(100, 50), Pt(528, 50), Pt(528, 320), Pt(100, 320)))
    XCTAssertEqual([thumb.width, thumb.height], [428, 270])
    for (x, y) in [(0, 0), (427, 0), (427, 269), (0, 269), (200, 100), (33, 251)] {
      XCTAssertEqual(at(thumb, x, y), at(src, 100 + x, 50 + y), "(\(x), \(y))")
    }
    XCTAssertEqual(thumb.rgba[3], 255)
  }

  /// A card seen at an angle is a trapezium, and straightening it is not a plain stretch: its corners go to the
  /// thumbnail's corners, and the place where its diagonals cross goes to the thumbnail's middle (the mean of
  /// its corners, where a plain stretch would read, is somewhere else).
  func testACardAtAnAngleIsStraightened() throws {
    let src = map(1000, 800)
    let q = Quad(Pt(300, 200), Pt(700, 200), Pt(900, 600), Pt(100, 600))
    let thumb = try CardThumb.make(src, q)
    XCTAssertEqual([thumb.width, thumb.height], [428, 270])
    assertFrom(thumb, 0, 0, 300, 200)
    assertFrom(thumb, 427, 0, 700, 200)
    assertFrom(thumb, 427, 269, 900, 600)
    assertFrom(thumb, 0, 269, 100, 600)
    // The diagonals (300,200)–(900,600) and (700,200)–(100,600) cross a third of the way down, at (500, 333.3);
    // the corners' mean is (500, 400).
    assertFrom(thumb, 214, 135, 500, 333.3)
  }

  /// A card turned on the table keeps its own top left: the corners are taken in the order given.
  func testACardTurnedOnTheTable() throws {
    let src = map(1000, 800)
    let thumb = try CardThumb.make(src, Quad(Pt(400, 100), Pt(800, 300), Pt(700, 500), Pt(300, 300)))
    assertFrom(thumb, 0, 0, 400, 100)
    assertFrom(thumb, 427, 0, 800, 300)
    assertFrom(thumb, 427, 269, 700, 500)
    assertFrom(thumb, 0, 269, 300, 300)
    assertFrom(thumb, 214, 135, 550, 300)
  }

  /// A card more than 856 pixels across is drawn at twice the size and halved, so every pixel of it counts:
  /// here one column in four is white. Read once a thumbnail pixel, as a smaller card is, the white would be
  /// missed altogether; halved from twice the size it is a quarter of each pixel.
  func testAWideCardIsDrawnAtTwiceTheSizeAndHalved() throws {
    let w = 1712, h = 1080
    var rgba = [UInt8](repeating: 0, count: 4 * w * h)
    for y in 0..<h {
      for x in stride(from: 0, to: w, by: 4) {
        for c in 0..<3 { rgba[4 * (y * w + x) + c] = 255 }
      }
    }
    let src = Picture(width: w, height: h, rgba: rgba)
    let wide = try CardThumb.make(src, Quad(Pt(0, 0), Pt(1712, 0), Pt(1712, 1080), Pt(0, 1080)))
    XCTAssertEqual([wide.width, wide.height], [428, 270])
    XCTAssertEqual(at(wide, 100, 100), [64, 64, 64])
    XCTAssertEqual(at(wide, 427, 269), [64, 64, 64])
    // The same stripes on a card just narrow enough to be drawn once (856 across): each pixel reads between
    // two columns, one of them white on every second pixel.
    let narrow = try CardThumb.make(src, Quad(Pt(0, 0), Pt(856, 0), Pt(856, 540), Pt(0, 540)))
    XCTAssertEqual(Double(at(narrow, 100, 100)[0]), 127.5, accuracy: 1)
    XCTAssertEqual(at(narrow, 101, 100)[0], 0)
  }

  func testCornersThatCannotBeStraightenedAreRefused() {
    let src = map(100, 100)
    let refused = ShotFailure.capture("the card's corners can't be straightened")
    // Three in a line.
    XCTAssertThrowsError(try CardThumb.make(src, Quad(Pt(10, 10), Pt(50, 10), Pt(90, 10), Pt(10, 60)))) { XCTAssertEqual($0 as? ShotFailure, refused) }
    // Crossed.
    XCTAssertThrowsError(try CardThumb.make(src, Quad(Pt(10, 10), Pt(90, 60), Pt(90, 10), Pt(10, 60)))) { XCTAssertEqual($0 as? ShotFailure, refused) }
    // No size at all, or not a number.
    XCTAssertThrowsError(try CardThumb.make(src, Quad(Pt(10, 10), Pt(10, 10), Pt(10, 10), Pt(10, 10)))) { XCTAssertEqual($0 as? ShotFailure, refused) }
    XCTAssertThrowsError(try CardThumb.make(src, Quad(Pt(.nan, 10), Pt(90, 10), Pt(90, 60), Pt(10, 60)))) { XCTAssertEqual($0 as? ShotFailure, refused) }
  }

  /// Corners a little outside the picture (an outline at the screen's edge) read the picture's own edge there.
  func testCornersOutsideThePictureReadItsEdge() throws {
    let src = map(500, 300)
    let thumb = try CardThumb.make(src, Quad(Pt(-20, -10), Pt(408, -10), Pt(408, 260), Pt(-20, 260)))
    XCTAssertEqual(at(thumb, 0, 0), at(src, 0, 0))
    XCTAssertEqual(at(thumb, 427, 269), at(src, 407, 259))
  }
}
