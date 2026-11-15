/// The rules of reading a card on an iPhone (the calls and events are those of src/native/nfc.ts). An iPhone reads a card only inside a sheet
/// the app opens, one at a time. This machine is told what the app asked and what the reader reported, and says
/// what to do: which call to answer and how, which event to send, what to tell the reader. It knows nothing of
/// CoreNFC: on an iPhone the reader it is given is ios/NfcReader.swift, in the tests a stand-in.
///
/// Not safe to call from two threads: everything, the app's calls and the reader's reports, comes on one queue.

/// What kind of tag iOS found, by iOS's own names for them.
public enum TagKind: Equatable, Sendable {
  case iso7816, miFareDesfire, miFarePlus, miFareUltralight, miFareUnknown, feliCa, iso15693

  /// Whether the app's commands (ISO 7816, directly or in the MIFARE family's wrapping) can be sent to it.
  /// The others are still reported to the app, with handle -1, as Android reports a tag that is not IsoDep.
  public var talkable: Bool {
    switch self {
    case .iso7816, .miFareDesfire, .miFarePlus: return true
    case .miFareUltralight, .miFareUnknown, .feliCa, .iso15693: return false
    }
  }
}

/// The reader the machine drives.
public protocol CardReader: AnyObject {
  /// Opens the system's sheet with the line and looks for a card. false: the phone would not make a session.
  func begin(line: String) -> Bool
  func setLine(_ line: String)
  /// Looks for a card again; the sheet stays.
  func restart()
  /// Ends the session with the system's tick and the line.
  func end(line: String)
  /// Ends the session with the line as its error.
  func fail(line: String)
  /// Ends the session with nothing said.
  func cancel()
  /// Connects to one of the tags last reported found, by its place in that list.
  func connect(tag index: Int)
  /// Sends a command to the connected tag. The answer, or the failure, comes back with the same number.
  func send(_ apdu: [UInt8], command: Int)
}

/// Why a scan was not opened: the words the call is rejected with.
public struct ScanRefused: Error, Equatable, Sendable {
  public let words: String
}

public enum CommandFailure: Error, Equatable, Sendable {
  /// The card went, or the session did: ERR_TAG_LOST, and the app asks for the card again.
  case lost(String)
  /// The command could never be sent (malformed, too long): asking for the card again would not mend it.
  case unsendable(String)
}

public final class CardSession {
  public typealias ScanAnswer = (Result<Void, ScanRefused>) -> Void
  public typealias CommandAnswer = (Result<[UInt8], CommandFailure>) -> Void

  private enum State {
    case none
    /// The sheet was asked for; iOS has not yet said the session is active.
    case opening(ScanAnswer)
    case active
    /// The app asked for the end; iOS has not yet reported it. With the scan's answer if it was never active.
    case ending(ScanAnswer?)
  }

  /// A card was found: its handle (-1 for a tag the app cannot talk to) and its ID in hex.
  public var onTag: (Int, String) -> Void = { _, _ in }
  /// A session that had been active has ended: iOS's code and text, nothing worked out.
  public var onEnd: (Int, String) -> Void = { _, _ in }

  private let reader: CardReader
  private var state = State.none
  /// The card in hand: the one handle commands may be sent on.
  private var hand: Int?
  /// The ID of the tag being connected.
  private var connecting: [UInt8]?
  private var nextHandle = 1
  private var nextCommand = 1
  private var pending = [(command: Int, handle: Int, answer: CommandAnswer)]()
  private var tornDown = false

  public init(reader: CardReader) {
    self.reader = reader
  }

  /// Which of the reader's errors for a command (NFCReaderError's codes) mean the card went. Only "the packet is
  /// too long" (105) is the command's own fault; a lifted card has been seen as 102 as well as 100.
  public static func commandFailure(code: Int, text: String) -> CommandFailure {
    code == 105 ? .unsendable(text) : .lost(text)
  }

  // MARK: the app's calls

  /// nfcScan: answers once iOS says the session is active; refused if one is open, if the phone will not make
  /// one, or if iOS ends it before it was active (then with iOS's text, and no end is sent).
  public func scan(line: String, answer: @escaping ScanAnswer) {
    if tornDown { return answer(.failure(ScanRefused(words: "the card reader is shutting down"))) }
    guard case .none = state else { return answer(.failure(ScanRefused(words: "a card session is already open"))) }
    state = .opening(answer)
    if !reader.begin(line: line) {
      state = .none
      answer(.failure(ScanRefused(words: "this phone would not open a card session")))
    }
  }

  /// nfcSay.
  public func say(_ line: String) {
    switch state {
    case .opening, .active: reader.setLine(line)
    case .none, .ending: break
    }
  }

  /// nfcAgain: lets go of the card in hand, sets the line and looks again; the sheet stays.
  public func again(_ line: String) {
    guard case .active = state else { return }
    letGo("the card was let go")
    reader.setLine(line)
    reader.restart()
  }

  /// nfcDone: ends the session with the tick and the line.
  public func done(_ line: String) {
    if beginEnding() { reader.end(line: line) }
  }

  /// nfcFail: ends the session with the line as its error.
  public func fail(_ line: String) {
    if beginEnding() { reader.fail(line: line) }
  }

  private func beginEnding() -> Bool {
    switch state {
    case .opening(let answer):
      state = .ending(answer)
      return true
    case .active:
      state = .ending(nil)
      return true
    case .none, .ending:
      return false
    }
  }

  /// nfcClose: lets go of that handle only. iOS has no call to let a card go: the handle is forgotten, and the
  /// card stays connected until the session looks again or ends.
  public func close(handle: Int) {
    if hand == handle { letGo("the card was let go") }
  }

  /// nfcTransceive.
  public func transceive(handle: Int, apdu: [UInt8], answer: @escaping CommandAnswer) {
    guard case .active = state, hand == handle else { return answer(.failure(.lost("the card is no longer connected"))) }
    let command = nextCommand
    nextCommand += 1
    pending.append((command, handle, answer))
    reader.send(apdu, command: command)
  }

  /// The module is going (the app's JavaScript is loaded again): an open session is ended, and nothing more is sent.
  public func teardown() {
    tornDown = true
    onTag = { _, _ in }
    onEnd = { _, _ in }
    switch state {
    case .none: return
    case .opening(let answer), .ending(.some(let answer)):
      reader.cancel()
      state = .none
      answer(.failure(ScanRefused(words: "the card session ended")))
    case .active, .ending(.none):
      reader.cancel()
      state = .none
    }
    letGo("the card session ended")
  }

  // MARK: the reader's reports

  public func readerActive() {
    guard case .opening(let answer) = state else { return }
    state = .active
    answer(.success(()))
  }

  /// The tags iOS found at once, each with its kind and ID. The first that can be talked to is connected; if
  /// none can, the first is reported with handle -1.
  public func readerFound(_ tags: [(kind: TagKind, uid: [UInt8])]) {
    guard case .active = state, hand == nil, connecting == nil else { return }
    if let index = tags.firstIndex(where: { $0.kind.talkable }) {
      connecting = tags[index].uid
      reader.connect(tag: index)
    } else if let first = tags.first {
      onTag(-1, Hex.encode(first.uid))
    }
  }

  public func readerConnected() {
    guard case .active = state, let uid = connecting else { return }
    connecting = nil
    let handle = nextHandle
    nextHandle += 1
    hand = handle
    onTag(handle, Hex.encode(uid))
  }

  /// The card went before it could be talked to: the next hold tries again, as on Android.
  public func readerConnectFailed() {
    guard case .active = state, connecting != nil else { return }
    connecting = nil
    reader.restart()
  }

  public func readerAnswered(command: Int, _ data: [UInt8]) {
    take(command)?.answer(.success(data))
  }

  /// A lost card takes its handle with it; the session stays open, and the app decides what follows.
  public func readerFailed(command: Int, _ why: CommandFailure) {
    guard let p = take(command) else { return }
    if case .lost = why, hand == p.handle { hand = nil }
    p.answer(.failure(why))
  }

  /// iOS reports the session's end. The session is counted gone before anything is sent: the app may open the
  /// next sheet the moment it hears the end.
  public func readerEnded(code: Int, text: String) {
    let was = state
    state = .none
    switch was {
    case .none:
      return
    case .opening(let answer), .ending(.some(let answer)):
      letGo("the card session ended")
      answer(.failure(ScanRefused(words: text)))
    case .active, .ending(.none):
      letGo("the card session ended")
      onEnd(code, text)
    }
  }

  // MARK: -

  private func take(_ command: Int) -> (command: Int, handle: Int, answer: CommandAnswer)? {
    guard let i = pending.firstIndex(where: { $0.command == command }) else { return nil }
    return pending.remove(at: i)
  }

  /// No card is in hand any more, and every command waiting on one fails as a lost card.
  private func letGo(_ why: String) {
    hand = nil
    connecting = nil
    let waiting = pending
    pending = []
    for p in waiting { p.answer(.failure(.lost(why))) }
  }
}
