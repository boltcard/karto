import AVFoundation
import ExpoModulesCore
import UIKit

/// The QR scanner: the iPhone's side of
/// src/native/qrScanner.tsx, as android/.../QrScannerView.kt is Android's. A camera preview that fills the view;
/// the first QR code read is sent once as onCode. The codes are read by iOS itself. The camera permission is the
/// screen's to ask for. A camera that will not start draws nothing and says nothing, as on Android: the screen
/// keeps its Cancel.
final class QrScannerView: ExpoView {
  let onCode = EventDispatcher()

  private let camera = QrCamera()
  private let preview = AVCaptureVideoPreviewLayer()
  private var sent = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black
    clipsToBounds = true
    preview.videoGravity = .resizeAspectFill
    preview.session = camera.session
    layer.addSublayer(preview)
    camera.onCode = { [weak self] text in self?.read(text) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    preview.frame = bounds
    CATransaction.commit()
  }

  /// The camera runs while the view is in a window, and its light is off as soon as it is not.
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { camera.start() } else { camera.stop() }
  }

  /// Once, and never from a view that has left its window.
  private func read(_ text: String) {
    guard !sent, window != nil else { return }
    sent = true
    NSLog("%@", "CARDAPP-SCAN code read")
    onCode(["text": text])
  }
}

/// The scanner's camera: a session with the back camera and Apple's own reader of QR codes. Started and stopped
/// on a queue of its own, never on the main thread; a code is reported on the main thread.
private final class QrCamera: NSObject, AVCaptureMetadataOutputObjectsDelegate {
  let session = AVCaptureSession()
  /// On the main thread: the text of a QR code in view. Called for every frame that shows one.
  var onCode: ((String) -> Void)?

  private let queue = DispatchQueue(label: "tech.whitewolf.karto.scan.camera")
  /// Only on `queue`.
  private var configured = false

  func start() {
    queue.async {
      guard self.configure() else { return }
      if !self.session.isRunning {
        self.session.startRunning()
        NSLog("%@", "CARDAPP-SCAN running")
      }
    }
  }

  func stop() {
    queue.async {
      if self.session.isRunning { self.session.stopRunning() }
    }
  }

  /// The back camera in, QR codes out; false when the camera is not allowed, not there, or will not be had.
  private func configure() -> Bool {
    if configured { return true }
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized,
      let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
      let input = try? AVCaptureDeviceInput(device: device)
    else { return false }
    let output = AVCaptureMetadataOutput()
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    guard session.canAddInput(input), session.canAddOutput(output) else { return false }
    session.addInput(input)
    session.addOutput(output)
    // What an output can read is known only once it is in a session. QR alone, as Android's scanner reads.
    guard output.availableMetadataObjectTypes.contains(.qr) else { return false }
    output.metadataObjectTypes = [.qr]
    output.setMetadataObjectsDelegate(self, queue: .main)
    configured = true
    return true
  }

  func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
    for object in metadataObjects {
      // A code that holds bytes and no text is passed over.
      if let code = object as? AVMetadataMachineReadableCodeObject, code.type == .qr, let text = code.stringValue, !text.isEmpty {
        onCode?(text)
        return
      }
    }
  }
}
