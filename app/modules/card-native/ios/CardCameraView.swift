import AVFoundation
import CardLogic
import ExpoModulesCore
import ImageIO
import UIKit

/// The card camera: the iPhone's side of
/// src/native/cardCamera.tsx, as android/.../CardCameraView.kt is Android's. A preview with the card-shaped
/// frame, the dimming around it and the found edges drawn over it; takePhoto() answers the card's thumbnail.
///
/// This file is Apple's camera, its layers and its JPEG encoder, and decides nothing: what a frame shows, where
/// the card is in a shot, the thumbnail and which file of it is answered are CardLogic's (CardShot, CardEdges,
/// CardThumb, Jpeg), tested on Linux. The camera permission is the screen's to ask for.
final class CardCameraView: ExpoView {
  let onFound = EventDispatcher()
  let onError = EventDispatcher()

  /// The frame: its width as a fraction of the view's, and its centre's fraction of the way down (props from cardphoto).
  var frameWidth = 0.86 { didSet { setNeedsLayout() } }
  var frameCentreY = 0.45 { didSet { setNeedsLayout() } }

  private let camera = CardCamera()
  private let preview = AVCaptureVideoPreviewLayer()
  /// Over the preview: the dimming outside the frame, the frame's outline, and the found edges in green. The
  /// same shapes and numbers as Android's overlay.
  private let dim = CAShapeLayer()
  private let frameLine = CAShapeLayer()
  private let edges = CAShapeLayer()
  /// From the back forward.
  private var layers: [CALayer] { [preview, dim, frameLine, edges] }
  /// The outline shown, as fractions of the view.
  private var outline: [Double]?
  private var found = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black
    clipsToBounds = true
    preview.videoGravity = .resizeAspectFill
    preview.session = camera.session
    dim.fillRule = .evenOdd
    dim.fillColor = UIColor(white: 0, alpha: 0.45).cgColor
    frameLine.fillColor = nil
    frameLine.strokeColor = UIColor.white.cgColor
    frameLine.lineWidth = 2.5
    edges.fillColor = nil
    edges.strokeColor = UIColor(red: 0x3f / 255.0, green: 0xb9 / 255.0, blue: 0x50 / 255.0, alpha: 1).cgColor
    edges.lineWidth = 3
    edges.lineJoin = .round
    for l in layers { layer.addSublayer(l) }
    camera.onOutline = { [weak self] outline in self?.show(outline) }
    camera.onError = { [weak self] reason in self?.broken(reason) }
  }

  /// The layers and the viewport follow the view's size.
  override func layoutSubviews() {
    super.layoutSubviews()
    camera.look(viewWidth: Double(bounds.width), viewHeight: Double(bounds.height), frameWidth: frameWidth, frameCentreY: frameCentreY)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for l in layers { l.frame = bounds }
    let f = Box.frame(Int(bounds.width.rounded()), Int(bounds.height.rounded()), frameWidth, frameCentreY)
    // A CR80 card's corner: 3.18 mm of its 54 mm height.
    let r = CGFloat(f.height * 3.18 / 54)
    let card = UIBezierPath(roundedRect: CGRect(x: f.left, y: f.top, width: f.width, height: f.height), cornerRadius: r)
    let outside = UIBezierPath(rect: bounds)
    outside.append(card)
    dim.path = outside.cgPath
    frameLine.path = card.cgPath
    drawEdges()
    CATransaction.commit()
  }

  /// The camera runs while the view is in a window, and its light is off as soon as it is not.
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { camera.start() } else { camera.stop() }
  }

  /// On the main thread, as every call of a view's is: the camera notes the outline and waits for its next
  /// frame, and the work is done and answered on a queue of its own.
  func takePhoto(_ promise: Promise) {
    camera.takePhoto(promise)
  }

  private func drawEdges() {
    guard let outline, outline.count == 8 else {
      edges.path = nil
      return
    }
    let q = Quad.ofFractions(outline, Int(bounds.width.rounded()), Int(bounds.height.rounded()))
    let path = UIBezierPath()
    path.move(to: CGPoint(x: q.tl.x, y: q.tl.y))
    for p in [q.tr, q.br, q.bl] { path.addLine(to: CGPoint(x: p.x, y: p.y)) }
    path.close()
    edges.path = path.cgPath
  }

  /// A frame was looked at. Nothing crosses to JavaScript for it unless the card was found or lost; a view that
  /// has left its window sends nothing.
  private func show(_ outline: [Double]?) {
    guard window != nil else { return }
    self.outline = outline
    // The outline is where the card is in this frame: it moves at once, never easing after the picture.
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    drawEdges()
    CATransaction.commit()
    frameLine.opacity = outline != nil ? 0.55 : 1
    if (outline != nil) != found {
      found = outline != nil
      onFound(["found": found])
    }
  }

  private func broken(_ reason: String) {
    guard window != nil else { return }
    onError(["message": reason])
  }
}

/// The card camera itself: one stream of frames for the preview, the finder and the shot, so the three are the
/// same picture. Three queues: the session is started and stopped on one, frames
/// arrive and are searched on a second, and a shot is cut and encoded on a third. What it reports, it reports on
/// the main thread.
private final class CardCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  /// The frames lie on their side, as the sensor has them: upright once turned clockwise by this much.
  private static let turn = 90

  /// What the view shows, for the frames' queue to read.
  private struct Look {
    var viewWidth = 0.0
    var viewHeight = 0.0
    var frameWidth = 0.86
    var frameCentreY = 0.45
    /// The outline shown, as fractions of the viewport.
    var outline: [Double]?
  }

  /// What a waiting shot is answered through, and the outline that was showing when it was asked for.
  private struct Shot {
    let promise: Promise
    let outline: [Double]?
  }

  let session = AVCaptureSession()
  /// On the main thread, after each frame: the outline to show, or nil.
  var onOutline: (([Double]?) -> Void)?
  /// On the main thread, once: why the camera cannot start, or has stopped.
  var onError: ((String) -> Void)?

  private let cameraQueue = DispatchQueue(label: "app.cardapp.photo.camera")
  private let frameQueue = DispatchQueue(label: "app.cardapp.photo.frames")
  private let shotQueue = DispatchQueue(label: "app.cardapp.photo.shot", qos: .userInitiated)
  private let lock = NSLock()
  private var looking = Look()
  private let shots = ShotGate<Shot>()
  /// Only on cameraQueue.
  private var configured = false
  private var reported = false
  private var logged = false
  private var frameConnection: AVCaptureConnection?
  /// Only on frameQueue.
  private let steady = Steady()
  private var frames = 0

  override init() {
    super.init()
    let centre = NotificationCenter.default
    centre.addObserver(self, selector: #selector(interrupted(_:)), name: .AVCaptureSessionWasInterrupted, object: session)
    centre.addObserver(self, selector: #selector(runtimeError(_:)), name: .AVCaptureSessionRuntimeError, object: session)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  // MARK: from the view, on the main thread

  func look(viewWidth: Double, viewHeight: Double, frameWidth: Double, frameCentreY: Double) {
    lock.lock()
    looking.viewWidth = viewWidth
    looking.viewHeight = viewHeight
    looking.frameWidth = frameWidth
    looking.frameCentreY = frameCentreY
    lock.unlock()
  }

  func start() {
    cameraQueue.async {
      guard self.configure() else { return }
      if !self.session.isRunning { self.session.startRunning() }
      // Once, for the log: the camera's format, and whether the frames really come unstabilised (which iOS
      // says only of a running camera).
      if !self.logged, self.session.isRunning, let device = (self.session.inputs.first as? AVCaptureDeviceInput)?.device {
        self.logged = true
        let size = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        let frame = CMTimeGetSeconds(device.activeVideoMinFrameDuration)
        let rate = frame > 0 ? Int((1 / frame).rounded()) : 0
        NSLog("%@", "CARDAPP-CAMERA format \(size.width)x\(size.height) at \(rate) a second, stabilisation off \(self.frameConnection?.activeVideoStabilizationMode == .off)")
      }
    }
  }

  /// Every way out of the screen comes here. A shot still waiting for its frame is answered at once.
  func stop() {
    closeShot()
    cameraQueue.async {
      if self.session.isRunning { self.session.stopRunning() }
    }
  }

  func takePhoto(_ promise: Promise) {
    guard session.isRunning else { return promise.reject(CardCamera.exception(ShotFailure.capture("the camera isn't ready"))) }
    guard let shot = shots.begin(Shot(promise: promise, outline: read().outline)) else {
      return promise.reject(CardCamera.exception(ShotFailure.capture("a photo is already being taken")))
    }
    // A running camera that gives no frame.
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [shots] in
      shots.expire(shot)?.promise.reject(CardCamera.exception(ShotFailure.capture("the camera gave no picture")))
    }
  }

  // MARK: the session, on cameraQueue

  private func configure() -> Bool {
    if configured { return true }
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { return failed("the camera isn't allowed") }
    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else { return failed("this phone has no camera") }
    guard let input = try? AVCaptureDeviceInput(device: device) else { return failed("the camera stopped working") }
    let output = AVCaptureVideoDataOutput()
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    // Late frames are dropped, so the finder always works on the newest.
    output.alwaysDiscardsLateVideoFrames = true
    session.beginConfiguration()
    guard session.canAddInput(input), session.canAddOutput(output) else {
      session.commitConfiguration()
      return failed("the camera stopped working")
    }
    session.addInput(input)
    session.addOutput(output)
    // Frames of the camera's own 4:3 shape, about 1920 across (Android's shot). The plain 8-bit formats, where
    // the camera has them.
    let plain = device.formats.filter { CMFormatDescriptionGetMediaSubType($0.formatDescription) == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange }
    let formats = plain.isEmpty ? device.formats : plain
    let sizes = formats.map { f -> (width: Int, height: Int) in
      let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
      return (Int(d.width), Int(d.height))
    }
    if let pick = Viewport.format(among: sizes), (try? device.lockForConfiguration()) != nil {
      device.activeFormat = formats[pick]
      // At most 30 frames a second: the outline needs no more, and at 60 the search keeps most of a core busy
      // while the camera is open. Set after the format, which puts the rate back to its own.
      let thirtieth = CMTime(value: 1, timescale: 30)
      if formats[pick].videoSupportedFrameRateRanges.contains(where: { $0.maxFrameRate >= 30 && $0.minFrameRate <= 30 }) {
        device.activeVideoMinFrameDuration = thirtieth
      }
      device.unlockForConfiguration()
    }
    // With stabilisation on, iOS crops and delays the frames but not the preview, and the two would no longer
    // be the same picture.
    let connection = output.connection(with: .video)
    if connection?.isVideoStabilizationSupported == true { connection?.preferredVideoStabilizationMode = .off }
    output.setSampleBufferDelegate(self, queue: frameQueue)
    session.commitConfiguration()
    frameConnection = connection
    configured = true
    return true
  }

  /// Why the camera cannot start or has stopped, told once. Always false, for configure to return.
  @discardableResult
  private func failed(_ reason: String) -> Bool {
    if !reported {
      reported = true
      DispatchQueue.main.async { self.onError?(reason) }
    }
    return false
  }

  /// iOS has taken the camera away. A shot that waits is answered at once, whatever the reason. The trip to the
  /// background that every app makes is no error: iOS starts the camera again on return, as it does after any
  /// other reason not named here.
  @objc private func interrupted(_ note: Notification) {
    closeShot()
    guard let raw = note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int, let reason = AVCaptureSession.InterruptionReason(rawValue: raw) else { return }
    switch reason {
    case .videoDeviceInUseByAnotherClient: cameraQueue.async { self.failed("another app is using the camera") }
    case .videoDeviceNotAvailableDueToSystemPressure: cameraQueue.async { self.failed("the camera stopped working") }
    default: break
    }
  }

  @objc private func runtimeError(_ note: Notification) {
    closeShot()
    cameraQueue.async { self.failed("the camera stopped working") }
  }

  private func closeShot() {
    shots.close()?.promise.reject(CardCamera.exception(ShotFailure.closed))
  }

  private func read() -> Look {
    lock.lock()
    defer { lock.unlock() }
    return looking
  }

  // MARK: frames, on frameQueue

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let started = DispatchTime.now().uptimeNanoseconds
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
    let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer), rowBytes = CVPixelBufferGetBytesPerRow(buffer)
    let bytes = UnsafeRawBufferPointer(start: base, count: rowBytes * height)
    let look = read()
    let crop = Viewport.crop(storedWidth: width, storedHeight: height, rotation: CardCamera.turn, viewWidth: look.viewWidth, viewHeight: look.viewHeight)
    // A shot that waits takes this frame, whole and in colour. It is copied: the buffer goes back to the camera.
    if let shot = shots.claim() {
      let picture = Picture.fromBGRA(bytes, bytesPerRow: rowBytes, crop: crop, rotation: CardCamera.turn)
      shotQueue.async { self.make(shot, picture, look) }
    }
    let seen = CardShot.look(bytes, bytesPerRow: rowBytes, crop: crop, rotation: CardCamera.turn, frameWidth: look.frameWidth, frameCentreY: look.frameCentreY)
    let shown = steady.add(seen.card)?.fractions(seen.width, seen.height)
    lock.lock()
    looking.outline = shown
    lock.unlock()
    frames += 1
    if frames % 30 == 1 {
      let ms = (DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
      NSLog("%@", "CARDAPP-CAMERA frame \(frames): \(seen.width)x\(seen.height), \(ms) ms, card \(seen.card != nil)")
    }
    DispatchQueue.main.async { self.onOutline?(shown) }
  }

  // MARK: a shot, on shotQueue

  private func make(_ shot: Shot, _ picture: Picture, _ look: Look) {
    defer { shots.done() }
    do {
      let (corners, source) = CardShot.corners(picture, shown: shot.outline, frameWidth: look.frameWidth, frameCentreY: look.frameCentreY)
      let jpeg = try CardShot.jpeg(of: try CardThumb.make(picture, corners), encode: CardCamera.encode)
      NSLog("%@", "CARDAPP-CAMERA shot \(picture.width)x\(picture.height): corners from the \(source), \(jpeg.count) bytes")
      // Nothing is written to the phone: the thumbnail leaves as base64 and the rest is let go.
      shot.promise.resolve(["jpeg": Data(jpeg).base64EncodedString(), "source": source])
    } catch {
      shot.promise.reject(CardCamera.exception(error))
    }
  }

  /// Apple's JPEG encoder, on bare pixels. What it writes besides the picture is logged, and taken off by the
  /// package before the file is weighed.
  private static func encode(_ picture: Picture, _ quality: Double) throws -> [UInt8] {
    let failure = ShotFailure.capture("the photo couldn't be made a JPEG")
    guard let provider = CGDataProvider(data: Data(picture.rgba) as CFData),
      let image = CGImage(
        width: picture.width, height: picture.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 4 * picture.width,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { throw failure }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else { throw failure }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw failure }
    let bytes = [UInt8](data as Data)
    NSLog("%@", "CARDAPP-CAMERA encoded at \(quality): \(bytes.count) bytes, \(bytes.count - (Jpeg.withoutMetadata(bytes)?.count ?? bytes.count)) of them metadata")
    return bytes
  }

  /// A failed shot for JavaScript: one of the three codes the app reads (src/cardphoto/take.ts), with its words.
  private static func exception(_ error: Error) -> Exception {
    let failure = (error as? ShotFailure) ?? ShotFailure.capture("\(error)")
    return Exception(name: "CardCameraException", description: failure.words, code: failure.code)
  }
}
