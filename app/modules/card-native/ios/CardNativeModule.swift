import AVFoundation
import CardLogic
import CardSsh
import ExpoModulesCore
import Foundation

/// The card-native module for iOS. Its contract
/// is src/native/api.ts and CardNfcApi in src/native/nfc.ts; Android's is android/.../CardNativeModule.kt. This
/// file is the list of calls and views, their queues and their errors' codes, and nothing else of substance: SSH
/// is the package's CardSsh, the card session's rules are its CardLogic, the key is DeviceKey.swift, the reader
/// is NfcReader.swift, and the cameras are QrScannerView.swift and CardCameraView.swift.
///
/// Every call answers through its promise, so a rejection reaches JavaScript with exactly the code and the
/// sentence given here (what a function throws is wrapped by Expo in a sentence of its own).
public final class CardNativeModule: Module {
  private let ssh = SshSessions()
  private let nfc = NfcReader()
  private lazy var cards = CardSession(reader: nfc)

  // SSH calls can run for minutes (an install step, the 11 MB upload): a queue of their own, several at once,
  // so signing and the card reader never wait behind them, nor one command behind another.
  private let sshQueue = DispatchQueue(label: "app.cardapp.ssh", qos: .userInitiated, attributes: .concurrent)

  private static func exception(_ name: String, _ words: String, _ code: String) -> Exception {
    Exception(name: name, description: words, code: code)
  }

  /// An SSH failure for JavaScript. The three codes the app reads (src/native/ssh.ts); anything else is, to the
  /// app, a connection that failed, and carries the package's sentence for it.
  private static func sshException(_ error: Error) -> Exception {
    switch error {
    case is HostKeyMismatch: return exception("HostKeyMismatchException", sshWords(error), "ERR_HOST_KEY_MISMATCH")
    case is SshAuthFailed: return exception("SshAuthException", sshWords(error), "ERR_SSH_AUTH")
    case is UploadRefused: return exception("UploadRefusedException", sshWords(error), "ERR_UPLOAD_REFUSED")
    default: return exception("SshException", sshWords(error), "ERR_SSH")
    }
  }

  private static func keyException(_ error: Error) -> Exception {
    (error as? Exception) ?? exception("DeviceKeyException", "\(error)", "ERR_DEVICE_KEY")
  }

  /// Runs `work` and settles the promise with what it returns or throws.
  private static func settle<T>(_ promise: Promise, _ failure: (Error) -> Exception, _ work: () throws -> T) {
    do {
      promise.resolve(try work())
    } catch {
      promise.reject(failure(error))
    }
  }

  /// The same for work that returns nothing.
  private static func settle(_ promise: Promise, _ failure: (Error) -> Exception, done work: () throws -> Void) {
    do {
      try work()
      promise.resolve(nil)
    } catch {
      promise.reject(failure(error))
    }
  }

  /// A file of the server bundle: the app carries app/deploy-assets as a folder of its own (plugins/withDeployAssets.js).
  private static func bundled(_ path: String) throws -> URL {
    guard let root = Bundle.main.resourceURL else { throw SshError.failed("the app's own files cannot be found") }
    let url = root.appendingPathComponent("deploy-assets").appendingPathComponent(path)
    guard FileManager.default.fileExists(atPath: url.path) else { throw SshError.failed("the app carries no server file \(path)") }
    return url
  }

  public func definition() -> ModuleDefinition {
    Name("CardNative")

    // Cards are read only inside a sheet the app opens (src/native/nfc.ts).
    Constant("nfcMode") { "session" }

    Events("sshUploadProgress", "nfcTag", "nfcEnd")

    OnCreate {
      self.nfc.rules = self.cards
      self.cards.onTag = { [weak self] handle, uid in self?.sendEvent("nfcTag", ["handle": handle, "uid": uid]) }
      self.cards.onEnd = { [weak self] code, text in self?.sendEvent("nfcEnd", ["code": code, "text": text]) }
    }

    // The app's JavaScript is being loaded again, or the app is going: nothing is left open.
    OnDestroy {
      self.ssh.closeAll()
      self.nfc.queue.async { self.cards.teardown() }
    }

    // MARK: the phone's key (src/native/deviceKey.ts)

    AsyncFunction("deviceKeyCreate") { (promise: Promise) in
      Self.settle(promise, Self.keyException) { try DeviceKey.create() }
    }.runOnQueue(DeviceKey.queue)

    AsyncFunction("devicePublicKey") { (promise: Promise) in
      Self.settle(promise, Self.keyException) { try DeviceKey.publicKeyHex() }
    }.runOnQueue(DeviceKey.queue)

    // Android's name; here it says whether the key is in the Secure Enclave.
    AsyncFunction("deviceKeyIsStrongBox") { (promise: Promise) in
      Self.settle(promise, Self.keyException) { try DeviceKey.isSecureEnclave() }
    }.runOnQueue(DeviceKey.queue)

    AsyncFunction("deviceSign") { (message: String, promise: Promise) in
      Self.settle(promise, Self.keyException) { try DeviceKey.sign(message) }
    }.runOnQueue(DeviceKey.queue)

    AsyncFunction("deviceKeyDelete") { (promise: Promise) in
      Self.settle(promise, Self.keyException, done: { try DeviceKey.delete() })
    }.runOnQueue(DeviceKey.queue)

    // MARK: the bundled server files and SSH (src/native/ssh.ts)

    AsyncFunction("readAssetText") { (path: String, promise: Promise) in
      Self.settle(promise, Self.sshException) { try String(contentsOf: Self.bundled(path), encoding: .utf8) }
    }.runOnQueue(sshQueue)

    AsyncFunction("sshScanHostKey") { (host: String, port: Int, promise: Promise) in
      Self.settle(promise, Self.sshException) { () -> [String: String] in
        let (type, blob) = try self.ssh.scanHostKey(host: host, port: port)
        return ["keyType": type, "publicKey": blob]
      }
    }.runOnQueue(sshQueue)

    AsyncFunction("sshConnect") { (host: String, port: Int, user: String, hostKeyType: String, hostKeyBlob: String, seedHex: String, promise: Promise) in
      Self.settle(promise, Self.sshException) {
        try self.ssh.connect(host: host, port: port, user: user, hostKeyType: hostKeyType, hostKeyBlob: hostKeyBlob, seedHex: seedHex)
      }
    }.runOnQueue(sshQueue)

    AsyncFunction("sshExec") { (id: Int, command: String, stdin: String?, promise: Promise) in
      Self.settle(promise, Self.sshException) { () -> [String: Any] in
        let r = try self.ssh.exec(id: id, command: command, stdin: stdin)
        return ["code": r.code, "stdout": r.stdout, "stderr": r.stderr]
      }
    }.runOnQueue(sshQueue)

    AsyncFunction("sshUploadBytes") { (id: Int, remotePath: String, base64: String, mode: Int, promise: Promise) in
      Self.settle(promise, Self.sshException, done: {
        guard let data = Data(base64Encoded: base64) else { throw SshError.failed("the file to upload is not base64") }
        try self.ssh.upload(id: id, remotePath: remotePath, read: chunks(of: Array(data)), mode: mode)
      })
    }.runOnQueue(sshQueue)

    // Files of the server bundle (the cardd program and deploy/), read from the app as they are sent and never
    // passed through JavaScript. The size is the manifest's, as on Android; here the file says its own.
    AsyncFunction("sshUploadAsset") { (id: Int, remotePath: String, asset: String, _: Double, mode: Int, promise: Promise) in
      Self.settle(promise, Self.sshException, done: {
        let handle = try FileHandle(forReadingFrom: Self.bundled(asset))
        defer { try? handle.close() }
        try self.ssh.upload(id: id, remotePath: remotePath, read: chunks(ofFile: handle), mode: mode) { sent in
          self.sendEvent("sshUploadProgress", ["id": id, "remotePath": remotePath, "sent": Double(sent)])
        }
      })
    }.runOnQueue(sshQueue)

    AsyncFunction("sshClose") { (id: Int, promise: Promise) in
      self.ssh.close(id: id)
      promise.resolve(nil)
    }.runOnQueue(sshQueue)

    // MARK: the cameras (src/native/qrScanner.tsx, src/native/cardCamera.tsx, src/cardphoto/take.ts)

    // The QR scanner first: it is the view the app asks for by the module's name alone, and that is a module's
    // first view. The card camera is asked for by its own name.
    View(QrScannerView.self) {
      Events("onCode")
    }

    View(CardCameraView.self) {
      Events("onFound", "onError")

      Prop("frameWidth") { (view: CardCameraView, value: Double) in
        view.frameWidth = value
      }

      Prop("frameCentreY") { (view: CardCameraView, value: Double) in
        view.frameCentreY = value
      }

      AsyncFunction("takePhoto") { (view: CardCameraView, promise: Promise) in
        view.takePhoto(promise)
      }
    }

    // iOS asks the person once, and never again: a camera refused before, or one the phone's owner has
    // restricted, can only be allowed in Settings. Android's module has no such call (React Native asks there).
    AsyncFunction("cameraPermission") { (promise: Promise) in
      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .authorized: promise.resolve("granted")
      case .notDetermined: AVCaptureDevice.requestAccess(for: .video) { granted in promise.resolve(granted ? "granted" : "refused_for_good") }
      default: promise.resolve("refused_for_good")
      }
    }

    // MARK: reading a card (src/native/nfc.ts)

    // An iPhone has no NFC switch, and reads a card only in a sheet the app opens: nfcStart and nfcStop, which
    // on Android turn reader mode on and off, do nothing here, and nfcSettings is not offered.
    AsyncFunction("nfcState") { NfcReader.available ? "on" : "unsupported" }
    AsyncFunction("nfcStart") {}
    AsyncFunction("nfcStop") {}

    // Answers once iOS says the session is active.
    AsyncFunction("nfcScan") { (line: String, promise: Promise) in
      self.cards.scan(line: line) { result in
        switch result {
        case .success: promise.resolve(nil)
        case .failure(let refused): promise.reject(Self.exception("NfcScanException", refused.words, "ERR_NFC_SCAN"))
        }
      }
    }.runOnQueue(nfc.queue)

    AsyncFunction("nfcSay") { (line: String) in self.cards.say(line) }.runOnQueue(nfc.queue)
    AsyncFunction("nfcAgain") { (line: String) in self.cards.again(line) }.runOnQueue(nfc.queue)
    AsyncFunction("nfcDone") { (line: String) in self.cards.done(line) }.runOnQueue(nfc.queue)
    AsyncFunction("nfcFail") { (line: String) in self.cards.fail(line) }.runOnQueue(nfc.queue)
    AsyncFunction("nfcClose") { (handle: Int) in self.cards.close(handle: handle) }.runOnQueue(nfc.queue)

    // A card that went, or a session that ended, is ERR_TAG_LOST, as on Android. A command that could never be
    // sent has a code of its own, which the app does not take for a lost card.
    AsyncFunction("nfcTransceive") { (handle: Int, apduHex: String, promise: Promise) in
      guard let apdu = Hex.decode(apduHex) else {
        promise.reject(Self.exception("NfcCommandException", "the command is not hex", "ERR_NFC_COMMAND"))
        return
      }
      self.cards.transceive(handle: handle, apdu: apdu) { result in
        switch result {
        case .success(let answer): promise.resolve(Hex.encode(answer))
        case .failure(.lost(let why)): promise.reject(Self.exception("CardTagLostException", why, "ERR_TAG_LOST"))
        case .failure(.unsendable(let why)): promise.reject(Self.exception("NfcCommandException", why, "ERR_NFC_COMMAND"))
        }
      }
    }.runOnQueue(nfc.queue)
  }
}
