import CardLogic
import CoreNFC
import Foundation

/// Apple's card reader behind the session's rules. The rules are CardLogic's CardSession, tested on Linux
/// against a stand-in; this file is the reader it drives on an iPhone, and decides nothing itself: it does what
/// it is told, and reports what iOS says. Everything, the rules' calls and iOS's answers, runs on `queue`.
///
/// Nothing of a card's ID is written to the phone's log.
///
/// The rules' type is always written `CardLogic.CardSession` here: CoreNFC has a `CardSession` of its own (for a
/// phone that acts as a card), and this file imports both.
final class NfcReader: NSObject, CardReader, NFCTagReaderSessionDelegate {
  private enum Connected {
    case iso7816(NFCISO7816Tag)
    case miFare(NFCMiFareTag)
  }

  let queue = DispatchQueue(label: "tech.whitewolf.karto.nfc")
  /// Whom to report to. The module owns both.
  weak var rules: CardLogic.CardSession?

  private var session: NFCTagReaderSession?
  /// The tags iOS last reported found, in its order.
  private var found: [NFCTag] = []
  private var connected: Connected?

  static var available: Bool { NFCTagReaderSession.readingAvailable }

  // MARK: CardReader

  func begin(line: String) -> Bool {
    guard let session = NFCTagReaderSession(pollingOption: [.iso14443], delegate: self, queue: queue) else { return false }
    session.alertMessage = line
    self.session = session
    session.begin()
    return true
  }

  func setLine(_ line: String) {
    session?.alertMessage = line
  }

  func restart() {
    found = []
    connected = nil
    session?.restartPolling()
  }

  func end(line: String) {
    session?.alertMessage = line
    session?.invalidate()
  }

  func fail(line: String) {
    session?.invalidate(errorMessage: line)
  }

  func cancel() {
    session?.invalidate()
  }

  func connect(tag index: Int) {
    guard let session, found.indices.contains(index) else {
      queue.async { self.rules?.readerConnectFailed() }
      return
    }
    let tag = found[index]
    session.connect(to: tag) { [weak self] error in
      // Carried to the queue whatever thread iOS answers on.
      self?.queue.async {
        guard let self, self.session === session else { return }
        if error != nil {
          self.rules?.readerConnectFailed()
          return
        }
        switch tag {
        case .iso7816(let t): self.connected = .iso7816(t)
        case .miFare(let t): self.connected = .miFare(t)
        default:
          self.rules?.readerConnectFailed()
          return
        }
        self.rules?.readerConnected()
      }
    }
  }

  func send(_ apdu: [UInt8], command: Int) {
    guard let connected else {
      queue.async { self.rules?.readerFailed(command: command, .lost("the card is no longer connected")) }
      return
    }
    guard let message = NFCISO7816APDU(data: Data(apdu)) else {
      queue.async { self.rules?.readerFailed(command: command, .unsendable("the card reader refused the command as malformed")) }
      return
    }
    let session = self.session
    let answered: (Data, UInt8, UInt8, Error?) -> Void = { [weak self] data, sw1, sw2, error in
      self?.queue.async {
        guard let self, self.session === session else { return }
        if let error = error as NSError? {
          // CoreNFC's own codes say whether the card went; any other error under a command is a card that went.
          let code = error.domain == NFCReaderError.errorDomain ? error.code : 0
          self.rules?.readerFailed(command: command, CardLogic.CardSession.commandFailure(code: code, text: error.localizedDescription))
          return
        }
        self.rules?.readerAnswered(command: command, Array(data) + [sw1, sw2])
      }
    }
    switch connected {
    case .iso7816(let t): t.sendCommand(apdu: message, completionHandler: answered)
    case .miFare(let t): t.sendMiFareISO7816Command(message, completionHandler: answered)
    }
  }

  // MARK: NFCTagReaderSessionDelegate (called on `queue`)

  func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {
    guard session === self.session else { return }
    rules?.readerActive()
  }

  func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
    guard session === self.session else { return }
    self.session = nil
    found = []
    connected = nil
    let e = error as NSError
    rules?.readerEnded(code: e.code, text: e.localizedDescription)
  }

  func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
    guard session === self.session else { return }
    found = tags
    rules?.readerFound(tags.map { (Self.kind($0), Self.uid($0)) })
  }

  // MARK: -

  private static func kind(_ tag: NFCTag) -> TagKind {
    switch tag {
    case .iso7816: return .iso7816
    case .miFare(let t):
      switch t.mifareFamily {
      case .desfire: return .miFareDesfire
      case .plus: return .miFarePlus
      case .ultralight: return .miFareUltralight
      default: return .miFareUnknown
      }
    case .feliCa: return .feliCa
    case .iso15693: return .iso15693
    @unknown default: return .miFareUnknown
    }
  }

  private static func uid(_ tag: NFCTag) -> [UInt8] {
    switch tag {
    case .iso7816(let t): return Array(t.identifier)
    case .miFare(let t): return Array(t.identifier)
    case .feliCa(let t): return Array(t.currentIDm)
    case .iso15693(let t): return Array(t.identifier)
    @unknown default: return []
    }
  }
}
