import XCTest

@testable import CardLogic

/// A reader that only writes down what it was told.
private final class StandInReader: CardReader {
  var told = [String]()
  var refusesToBegin = false

  func begin(line: String) -> Bool {
    told.append("begin \(line)")
    return !refusesToBegin
  }
  func setLine(_ line: String) { told.append("line \(line)") }
  func restart() { told.append("restart") }
  func end(line: String) { told.append("end \(line)") }
  func fail(line: String) { told.append("fail \(line)") }
  func cancel() { told.append("cancel") }
  func connect(tag index: Int) { told.append("connect \(index)") }
  func send(_ apdu: [UInt8], command: Int) { told.append("send \(Hex.encode(apdu)) #\(command)") }
}

/// The rules of reading a card on an iPhone (CardSession.swift), each against a stand-in.
final class CardSessionTests: XCTestCase {
  private var reader = StandInReader()
  private var session: CardSession!
  /// Everything the app was sent or answered, in order.
  private var heard = [String]()

  override func setUp() {
    reader = StandInReader()
    heard = []
    session = CardSession(reader: reader)
    session.onTag = { [unowned self] handle, uid in self.heard.append("tag \(handle) \(uid)") }
    session.onEnd = { [unowned self] code, text in self.heard.append("end \(code) \(text)") }
  }

  private func scan(_ line: String = "Hold your card") {
    session.scan(line: line) { [unowned self] r in
      switch r {
      case .success: self.heard.append("scan ok")
      case .failure(let e): self.heard.append("scan refused: \(e.words)")
      }
    }
  }

  private func transceive(_ handle: Int, _ apdu: [UInt8]) {
    session.transceive(handle: handle, apdu: apdu) { [unowned self] r in
      switch r {
      case .success(let bytes): self.heard.append("answer \(Hex.encode(bytes))")
      case .failure(.lost(let why)): self.heard.append("lost: \(why)")
      case .failure(.unsendable(let why)): self.heard.append("unsendable: \(why)")
      }
    }
  }

  private let card: [UInt8] = [0x08, 0x11, 0x22, 0x33]
  /// A session open and active, with one card in hand as handle 1.
  private func withCardInHand() {
    scan()
    session.readerActive()
    session.readerFound([(.iso7816, card)])
    session.readerConnected()
    heard = []
    reader.told = []
  }

  // MARK: opening

  func testAScanOpensTheSheetAndAnswersWhenTheSessionIsActive() {
    scan("Hold Daily")
    XCTAssertEqual(reader.told, ["begin Hold Daily"])
    XCTAssertEqual(heard, [])
    session.readerActive()
    XCTAssertEqual(heard, ["scan ok"])
  }

  func testOneSessionAtATime() {
    scan()
    scan("again")
    XCTAssertEqual(heard, ["scan refused: a card session is already open"])
    session.readerActive()
    scan("and again")
    XCTAssertEqual(heard, ["scan refused: a card session is already open", "scan ok", "scan refused: a card session is already open"])
    XCTAssertEqual(reader.told, ["begin Hold your card"])
  }

  func testAPhoneThatWillNotMakeASessionRefusesTheScanAndIsReadyForTheNext() {
    reader.refusesToBegin = true
    scan()
    XCTAssertEqual(heard, ["scan refused: this phone would not open a card session"])
    reader.refusesToBegin = false
    scan()
    session.readerActive()
    XCTAssertEqual(heard.last, "scan ok")
  }

  func testASessionEndedBeforeItWasActiveFailsTheScanAndReportsNoEnd() {
    scan()
    session.readerEnded(code: 203, text: "System resource unavailable")
    XCTAssertEqual(heard, ["scan refused: System resource unavailable"])
    scan()
    XCTAssertEqual(reader.told, ["begin Hold your card", "begin Hold your card"])
  }

  func testBeforeItIsActiveFailAndDoneEndItSaySetsTheLineAndAgainDoesNothing() {
    scan()
    session.say("Hold it still")
    session.again("Try again")
    session.fail("Card reading stopped.")
    XCTAssertEqual(reader.told, ["begin Hold your card", "line Hold it still", "fail Card reading stopped."])
    // iOS may still say it became active on its way out: the scan is not answered as open.
    session.readerActive()
    XCTAssertEqual(heard, [])
    session.readerEnded(code: 200, text: "Session invalidated by user")
    XCTAssertEqual(heard, ["scan refused: Session invalidated by user"])

    scan()
    session.done("Done")
    XCTAssertEqual(reader.told.last, "end Done")
    session.readerEnded(code: 200, text: "Session invalidated by user")
    XCTAssertEqual(heard, ["scan refused: Session invalidated by user", "scan refused: Session invalidated by user"])
  }

  // MARK: the end

  func testEveryScanThatAnsweredIsFollowedByExactlyOneEnd() {
    scan()
    session.readerActive()
    session.readerEnded(code: 201, text: "Session timeout")
    session.readerEnded(code: 201, text: "Session timeout")
    XCTAssertEqual(heard, ["scan ok", "end 201 Session timeout"])
  }

  func testAnEndWithNoSessionIsDropped() {
    session.readerEnded(code: 200, text: "stray")
    XCTAssertEqual(heard, [])
  }

  // The app opens the next sheet the moment it hears the end.
  func testTheSessionIsCountedGoneBeforeItsEndIsSent() {
    scan()
    session.readerActive()
    session.onEnd = { [unowned self] code, _ in
      self.heard.append("end \(code)")
      self.scan("The next sheet")
    }
    session.readerEnded(code: 200, text: "Session invalidated by user")
    XCTAssertEqual(heard, ["scan ok", "end 200"])
    XCTAssertEqual(reader.told.last, "begin The next sheet")
    session.readerActive()
    XCTAssertEqual(heard.last, "scan ok")
  }

  func testDoneAndFailEndTheSessionOnceAndNothingIsAskedOfItAfter() {
    scan()
    session.readerActive()
    session.done("Card added")
    session.done("Card added")
    session.fail("No")
    session.say("late")
    session.again("late")
    XCTAssertEqual(reader.told, ["begin Hold your card", "end Card added"])
    session.readerEnded(code: 200, text: "Session invalidated by user")
    XCTAssertEqual(heard, ["scan ok", "end 200 Session invalidated by user"])
    session.done("after the end")
    session.fail("after the end")
    session.again("after the end")
    session.say("after the end")
    XCTAssertEqual(reader.told, ["begin Hold your card", "end Card added"])

    scan()
    session.readerActive()
    session.fail("This is not your card.")
    XCTAssertEqual(reader.told.last, "fail This is not your card.")
  }

  // MARK: a card found

  func testACardFoundIsConnectedAndSentWithANewHandleAndItsId() {
    scan()
    session.readerActive()
    session.readerFound([(.iso7816, card)])
    XCTAssertEqual(reader.told.last, "connect 0")
    XCTAssertEqual(heard, ["scan ok"])
    session.readerConnected()
    XCTAssertEqual(heard, ["scan ok", "tag 1 08112233"])
    // The next card, in this session or a later one, gets a handle never used before.
    session.again("Hold the other card")
    session.readerFound([(.miFareDesfire, [0x04, 0xaa])])
    session.readerConnected()
    XCTAssertEqual(heard.last, "tag 2 04aa")
  }

  func testATagTheAppCannotTalkToIsSentWithHandleMinusOne() {
    scan()
    session.readerActive()
    session.readerFound([(.miFareUltralight, [0x04, 0x01])])
    XCTAssertEqual(heard, ["scan ok", "tag -1 0401"])
    XCTAssertEqual(reader.told, ["begin Hold your card"])
  }

  func testOfSeveralTagsTheFirstThatCanBeTalkedToIsTaken() {
    scan()
    session.readerActive()
    session.readerFound([(.feliCa, [1]), (.iso15693, [2]), (.miFarePlus, [3]), (.iso7816, [4])])
    XCTAssertEqual(reader.told.last, "connect 2")
    session.readerConnected()
    XCTAssertEqual(heard.last, "tag 1 03")
  }

  func testWhichKindsCanBeTalkedTo() {
    XCTAssertEqual([TagKind.iso7816, .miFareDesfire, .miFarePlus].map(\.talkable), [true, true, true])
    XCTAssertEqual([TagKind.miFareUltralight, .miFareUnknown, .feliCa, .iso15693].map(\.talkable), [false, false, false, false])
  }

  func testACardGoneBeforeItCouldBeConnectedIsLookedForAgain() {
    scan()
    session.readerActive()
    session.readerFound([(.iso7816, card)])
    session.readerConnectFailed()
    XCTAssertEqual(reader.told, ["begin Hold your card", "connect 0", "restart"])
    XCTAssertEqual(heard, ["scan ok"])
  }

  func testNothingFoundOutsideAnActiveSessionIsTaken() {
    session.readerFound([(.iso7816, card)])
    scan()
    session.readerFound([(.iso7816, card)])
    XCTAssertEqual(reader.told, ["begin Hold your card"])
    XCTAssertEqual(heard, [])
  }

  // MARK: commands

  func testACommandGoesToTheCardAndItsAnswerComesBack() {
    withCardInHand()
    transceive(1, [0x90, 0x60, 0, 0, 0])
    XCTAssertEqual(reader.told, ["send 9060000000 #1"])
    session.readerAnswered(command: 1, [0x04, 0x01, 0x91, 0xaf])
    XCTAssertEqual(heard, ["answer 040191af"])
    transceive(1, [0x90, 0xaf, 0, 0, 0])
    XCTAssertEqual(reader.told.last, "send 90af000000 #2")
  }

  // An early prototype left the sheet standing ten seconds here, because nothing was told that the card had gone.
  func testACardThatGoesFailsTheCommandInHandAtOnceAndTheSessionStaysOpen() {
    withCardInHand()
    transceive(1, [0x90, 0x60, 0, 0, 0])
    session.readerFailed(command: 1, .lost("Tag response error"))
    XCTAssertEqual(heard, ["lost: Tag response error"])
    // Its handle went with it: nothing more is sent to the reader for it.
    transceive(1, [0x90, 0xaf, 0, 0, 0])
    XCTAssertEqual(heard, ["lost: Tag response error", "lost: the card is no longer connected"])
    XCTAssertEqual(reader.told, ["send 9060000000 #1"])
    // The app decides what follows: it looks again, and the next card is a new one.
    session.again("Hold the card again")
    XCTAssertEqual(reader.told, ["send 9060000000 #1", "line Hold the card again", "restart"])
    session.readerFound([(.iso7816, card)])
    session.readerConnected()
    XCTAssertEqual(heard.last, "tag 2 08112233")
  }

  func testACommandThatCouldNeverBeSentIsNotALostCard() {
    withCardInHand()
    transceive(1, [0x90])
    session.readerFailed(command: 1, .unsendable("the card reader refused the command as malformed"))
    XCTAssertEqual(heard, ["unsendable: the card reader refused the command as malformed"])
    // The card is still in hand.
    transceive(1, [0x90, 0x60, 0, 0, 0])
    XCTAssertEqual(reader.told.last, "send 9060000000 #2")
  }

  func testWhichOfTheReadersErrorsAreALostCard() {
    for code in [100, 101, 102, 103, 104, 2, 0] {
      XCTAssertEqual(CardSession.commandFailure(code: code, text: "x"), .lost("x"), "code \(code)")
    }
    XCTAssertEqual(CardSession.commandFailure(code: 105, text: "Packet length exceeds limit"), .unsendable("Packet length exceeds limit"))
  }

  func testTheSessionsEndFailsEveryCommandInHandAndEveryLaterOneOnAnOldHandle() {
    withCardInHand()
    transceive(1, [1])
    transceive(1, [2])
    session.readerEnded(code: 202, text: "Session invalidated unexpectedly")
    XCTAssertEqual(heard, ["lost: the card session ended", "lost: the card session ended", "end 202 Session invalidated unexpectedly"])
    transceive(1, [3])
    XCTAssertEqual(heard.last, "lost: the card is no longer connected")
    // An answer that comes late for a command already failed is dropped: each command is answered once.
    session.readerAnswered(command: 1, [0x91, 0x00])
    session.readerFailed(command: 2, .lost("late"))
    XCTAssertEqual(heard.count, 4)
  }

  func testAgainLetsGoOfTheCardInHandSetsTheLineAndLooksAgain() {
    withCardInHand()
    transceive(1, [1])
    session.again("Hold Daily again")
    XCTAssertEqual(reader.told, ["send 01 #1", "line Hold Daily again", "restart"])
    XCTAssertEqual(heard, ["lost: the card was let go"])
    transceive(1, [2])
    XCTAssertEqual(heard.last, "lost: the card is no longer connected")
  }

  func testCloseLetsGoOfTheHandleOnlyAndTheSessionStaysOpen() {
    withCardInHand()
    session.close(handle: 1)
    session.close(handle: 99)
    XCTAssertEqual(reader.told, [])
    transceive(1, [1])
    XCTAssertEqual(heard, ["lost: the card is no longer connected"])
    session.done("Card added")
    XCTAssertEqual(reader.told, ["end Card added"])
  }

  func testAHandleThatWasNeverOnesIsALostCard() {
    transceive(7, [1])
    transceive(-1, [1])
    XCTAssertEqual(heard, ["lost: the card is no longer connected", "lost: the card is no longer connected"])
  }

  // MARK: the module torn down

  func testTornDownAnOpenSessionIsEndedAndNothingMoreIsSent() {
    withCardInHand()
    transceive(1, [1])
    session.teardown()
    XCTAssertEqual(reader.told, ["send 01 #1", "cancel"])
    session.readerEnded(code: 200, text: "Session invalidated by user")
    XCTAssertEqual(heard, ["lost: the card session ended"])
  }

  func testTornDownWithNoSessionNothingIsAsked() {
    session.teardown()
    XCTAssertEqual(reader.told, [])
  }

  func testAScanAfterTheModuleWasTornDownIsRefusedInItsOwnWords() {
    session.teardown()
    scan()
    XCTAssertEqual(heard, ["scan refused: the card reader is shutting down"])
    XCTAssertEqual(reader.told, [])
  }
}
