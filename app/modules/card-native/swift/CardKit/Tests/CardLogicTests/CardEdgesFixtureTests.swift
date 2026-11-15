import Foundation
import XCTest

@testable import CardLogic

/// The iPhone's finder against Android's, on the same bytes. Fixtures/card-edges.bin is written by
/// android/src/test/.../CardEdgesFixtureTest.kt, run by hand: pictures' brightness values (and Cb and Cr for those in
/// colour), what the Kotlin
/// CardEdges answered for each, and numbers java.util.Random gave. A change to either finder is made in both
/// and the file written again; this test fails when only one has moved.
final class CardEdgesFixtureTests: XCTestCase {
  /// The file as Java's DataOutputStream wrote it: big-endian, strings with a two-byte length.
  private struct Reader {
    let bytes: [UInt8]
    var at = 0

    mutating func take(_ n: Int) -> ArraySlice<UInt8> {
      defer { at += n }
      return bytes[at..<(at + n)]
    }
    mutating func int() -> Int32 { Int32(truncatingIfNeeded: take(4).reduce(0 as UInt32) { $0 << 8 | UInt32($1) }) }
    mutating func long() -> Int64 { Int64(truncatingIfNeeded: take(8).reduce(0 as UInt64) { $0 << 8 | UInt64($1) }) }
    mutating func double() -> Double { Double(bitPattern: take(8).reduce(0 as UInt64) { $0 << 8 | UInt64($1) }) }
    mutating func bool() -> Bool { take(1).first != 0 }
    mutating func string() -> String {
      let n = take(2).reduce(0) { $0 << 8 | Int($1) }
      return String(decoding: take(n), as: UTF8.self)
    }
  }

  private func fixture() throws -> Reader {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "card-edges", withExtension: "bin"))
    var r = Reader(bytes: Array(try Data(contentsOf: url)))
    XCTAssertEqual(String(decoding: r.take(4), as: UTF8.self), "CEFX")
    XCTAssertEqual(r.int(), 2)
    return r
  }

  func testTheGeneratorGivesJavasNumbers() throws {
    var r = try fixture()
    let runs = Int(r.int())
    XCTAssertEqual(runs, 28)
    for _ in 0..<runs {
      let seed = r.long()
      let bound = r.int()
      let java = (0..<Int(r.int())).map { _ in r.int() }
      var rnd = JavaRandom(seed: seed)
      XCTAssertEqual(java.map { _ in rnd.nextInt(bound) }, java, "seed \(seed), bound \(bound)")
    }
  }

  func testTheSameBytesGiveTheCornersTheKotlinFinderGave() throws {
    var r = try fixture()
    for _ in 0..<Int(r.int()) {
      _ = r.long()
      _ = r.int()
      _ = r.take(4 * Int(r.int()))
    }
    let cases = Int(r.int())
    XCTAssertEqual(cases, 32)
    var cards = 0
    var furthest = 0.0
    for _ in 0..<cases {
      let name = r.string()
      let w = Int(r.int()), h = Int(r.int())
      let frame = Box.frame(w, h, r.double(), r.double())
      let planes = Int(r.int())
      let kotlin: Quad? = r.bool() ? Quad(Pt(r.double(), r.double()), Pt(r.double(), r.double()), Pt(r.double(), r.double()), Pt(r.double(), r.double())) : nil
      let luma = Luma(width: w, height: h, pixels: Array(r.take(w * h)))
      let colour = planes == 3 ? Chroma(cb: Luma(width: w, height: h, pixels: Array(r.take(w * h))), cr: Luma(width: w, height: h, pixels: Array(r.take(w * h)))) : nil
      let found = CardEdges.find(luma, frame, colour)
      guard let kotlin else {
        XCTAssertNil(found, "\(name): Kotlin found no card")
        continue
      }
      cards += 1
      guard let found else {
        XCTFail("\(name): Kotlin found a card, and no card was found here")
        continue
      }
      for (i, (k, f)) in zip(kotlin.corners, found.corners).enumerated() {
        let apart = hypot(k.x - f.x, k.y - f.y)
        furthest = max(furthest, apart)
        // A hundredth of a pixel: hypot may differ in its last place between a JVM, Linux and an iPhone. More
        // than that is a decision that went the other way, and is a finding, not noise.
        XCTAssertLessThanOrEqual(apart, 0.01, "\(name): corner \(i) at (\(f.x), \(f.y)), Kotlin's at (\(k.x), \(k.y))")
      }
    }
    XCTAssertEqual(r.at, r.bytes.count, "the whole file was read")
    XCTAssertEqual(cards, 24)
    print("CardEdgesFixtureTests: \(cards) cards, the furthest corner \(furthest) pixels from Kotlin's")
  }
}
