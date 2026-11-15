import XCTest

@testable import CardLogic

/// The numbers are java.util.Random's own, read off a JVM (Temurin 21) on 2026-10-14; the edge finder's fixture
/// (CardEdgesFixtureTests) carries more of them.
final class JavaRandomTests: XCTestCase {
  private func first(_ n: Int, seed: Int64, bound: Int32) -> [Int32] {
    var r = JavaRandom(seed: seed)
    return (0..<n).map { _ in r.nextInt(bound) }
  }

  func testABoundThatIsAPowerOfTwo() {
    XCTAssertEqual(first(8, seed: 7, bound: 16), [11, 10, 11, 0, 5, 7, 14, 11])
    XCTAssertEqual(first(8, seed: -3, bound: 16), [4, 15, 5, 2, 12, 0, 15, 7])
    XCTAssertEqual(first(3, seed: 7, bound: 1), [0, 0, 0])
  }

  func testAnyOtherBound() {
    XCTAssertEqual(first(8, seed: 7, bound: 7), [3, 5, 4, 2, 5, 6, 5, 0])
    XCTAssertEqual(first(8, seed: 1, bound: 1000), [985, 588, 847, 313, 254, 904, 434, 606])
    XCTAssertEqual(first(8, seed: 123_456_789_012_345, bound: 1000), [174, 4, 19, 652, 285, 868, 260, 989])
  }

  /// A bound over half of 2^31: the generator throws numbers away, and its test for that overflows 32 bits.
  func testABoundSoLargeThatNumbersAreThrownAway() {
    XCTAssertEqual(first(8, seed: 7, bound: 1_500_000_000), [1_371_249_164, 20_678_044, 747_989_380, 1_053_566_254, 1_222_239_534, 755_731_200, 259_278_708, 542_588_911])
    XCTAssertEqual(first(8, seed: 7, bound: 1_073_741_825), [20_678_044, 747_989_380, 1_053_566_254, 755_731_200, 259_278_708, 542_588_911, 178_712_961, 234_738_279])
    XCTAssertEqual(first(8, seed: -3, bound: 1_073_741_825), [577_165_164, 754_537_216, 322_603_170, 118_466_140, 1_037_255_520, 326_062_791, 235_552_103, 459_176_357])
  }

  /// Kotlin's roundToInt: a half goes upward, whatever the sign.
  func testRoundingAsKotlinDoes() {
    XCTAssertEqual([0.5, 1.5, -0.5, -1.5, 2.5, 0.49999999999999994, -2.5000001, 3.2, -3.7].map(roundToInt), [1, 2, 0, -1, 3, 0, -3, 3, -4])
  }
}
