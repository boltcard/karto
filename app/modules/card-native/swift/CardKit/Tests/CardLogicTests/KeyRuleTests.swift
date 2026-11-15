import XCTest

@testable import CardLogic

/// What the Keychain's answers mean for the phone's key. The numbers are Apple's OSStatus
/// values, written out here because Security is not there on Linux.
final class KeyRuleTests: XCTestCase {
  private let success: Int32 = 0
  private let notFound: Int32 = -25300
  private let interactionNotAllowed: Int32 = -25308
  private let authFailed: Int32 = -25293
  private let param: Int32 = -50

  func testAKeyThatIsThereIsFound() {
    XCTAssertEqual(KeyRule.lookup(status: success), .found)
  }

  // "No key" makes the app ask for the wallet to be paired again: only the Keychain saying so may say so.
  func testOnlyNotFoundIsNoKey() {
    XCTAssertEqual(KeyRule.lookup(status: notFound), .absent)
    for status in [interactionNotAllowed, authFailed, param, 1, -1, -34018] {
      XCTAssertEqual(KeyRule.lookup(status: status), .failed(status), "status \(status)")
    }
  }

  func testADeleteIsDoneWhenTheKeyWentOrWasNeverThere() {
    XCTAssertEqual(KeyRule.deleted(status: success), .done)
    XCTAssertEqual(KeyRule.deleted(status: notFound), .done)
    XCTAssertEqual(KeyRule.deleted(status: interactionNotAllowed), .failed(interactionNotAllowed))
    XCTAssertEqual(KeyRule.deleted(status: param), .failed(param))
  }

  func testAFailureSaysWhatAndCarriesTheStatus() {
    XCTAssertEqual(
      KeyRule.words("reading the key", status: interactionNotAllowed),
      "reading the key failed: the Keychain cannot be read until this phone has been unlocked once (status -25308)"
    )
    XCTAssertEqual(KeyRule.words("deleting the key", status: param), "deleting the key failed: the Keychain answered with status -50")
  }
}
