import XCTest

@testable import CardLogic

final class HexTests: XCTestCase {
  func testEncodesLowerCaseTwoDigitsAByte() {
    XCTAssertEqual(Hex.encode([0, 255, 16, 0xab]), "00ff10ab")
    XCTAssertEqual(Hex.encode([]), "")
  }

  func testDecodesEitherCase() {
    XCTAssertEqual(Hex.decode("00fF10Ab"), [0, 255, 16, 0xab])
    XCTAssertEqual(Hex.decode(""), [])
  }

  func testRefusesWhatIsNotHex() {
    XCTAssertNil(Hex.decode("zz"))
    XCTAssertNil(Hex.decode("abc"))
    XCTAssertNil(Hex.decode("0x10"))
    XCTAssertNil(Hex.decode("é0"))
  }
}
