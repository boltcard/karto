import Foundation

/// What the card camera decides: what a
/// frame shows, where the card is in a shot, and which file of the thumbnail is answered. Android's are in
/// android/.../CardCameraView.kt (analyse, corners) and CardThumb.kt (the qualities); Apple's camera, its
/// encoder and its queues are ios/CardCameraView.swift, which decides nothing.
public enum CardShot {
  /// The width the finder's numbers are tuned at (Android's analysed frames once cropped and upright: 570 on
  /// the Pixel): every frame and every shot is searched at this.
  public static let ANALYSIS_WIDTH = 576
  /// Apple's scale of quality, the better first.
  static let QUALITIES = [0.80, 0.60]

  /// One frame of the camera's looked at, in brightness and colour: the card's corners in the picture that was
  /// searched, and its size (the corners become fractions of it). The frame is BGRA with its row stride; crop is
  /// the part the screen shows (Viewport.crop), turned clockwise by rotation to stand upright.
  public static func look(_ frame: UnsafeRawBufferPointer, bytesPerRow: Int, crop: Crop, rotation: Int, frameWidth: Double, frameCentreY: Double) -> (card: Quad?, width: Int, height: Int) {
    let (whole, colour) = Chroma.withLuma(fromBGRA: frame, bytesPerRow: bytesPerRow, crop: crop, rotation: rotation)
    let luma = whole.narrowed(to: ANALYSIS_WIDTH)
    return (CardEdges.find(luma, Box.frame(luma.width, luma.height, frameWidth, frameCentreY), colour.narrowed(to: ANALYSIS_WIDTH)), luma.width, luma.height)
  }

  /// The card's corners in the shot, and where they came from: found again there ("shot"); else the outline
  /// that was shown, as fractions of the screen's picture ("outline"); else the frame ("frame").
  public static func corners(_ shot: Picture, shown: [Double]?, frameWidth: Double, frameCentreY: Double) -> (Quad, String) {
    let luma = Luma.of(shot).narrowed(to: ANALYSIS_WIDTH)
    let colour = Chroma.of(shot).narrowed(to: ANALYSIS_WIDTH)
    let back = Double(shot.width) / Double(luma.width)
    if let q = CardEdges.find(luma, Box.frame(luma.width, luma.height, frameWidth, frameCentreY), colour) { return (q.scaled(back, back), "shot") }
    if let shown, shown.count == 8 { return (Quad.ofFractions(shown, shot.width, shot.height), "outline") }
    return (Box.frame(shot.width, shot.height, frameWidth, frameCentreY).quad(), "frame")
  }

  /// The thumbnail's file. `encode` makes a JPEG of the picture at a quality; its metadata is taken off, and
  /// only then is it weighed: over 64 KB it is made again at the lower quality, and still over is too big.
  /// Nothing is answered that is not a 428×270 JPEG of at most 64 KB without EXIF: the three things the app
  /// (src/cardphoto/take.ts) and the server check after this.
  public static func jpeg(of thumb: Picture, encode: (Picture, Double) throws -> [UInt8]) throws -> [UInt8] {
    for quality in QUALITIES {
      guard let clean = Jpeg.withoutMetadata(try encode(thumb, quality)), let size = Jpeg.size(clean), !Jpeg.hasApp1(clean) else {
        throw ShotFailure.capture("the photo's file can't be read")
      }
      guard size.width == CardThumb.WIDTH, size.height == CardThumb.HEIGHT else { throw ShotFailure.capture("the photo came out \(size.width)×\(size.height)") }
      if clean.count <= CardThumb.MAX_BYTES { return clean }
    }
    throw ShotFailure.tooBig
  }
}

/// One shot at a time, and each answered once. A shot waits for the camera's
/// next frame; that frame's arrival, two seconds without one, and the camera closing all happen on different
/// queues, and whichever comes first takes the waiter (what the shot is to be answered through).
public final class ShotGate<Waiter>: @unchecked Sendable {
  private enum State {
    case idle
    case waiting(Waiter, Int)
    case working
  }

  private let lock = NSLock()
  private var state = State.idle
  private var shots = 0

  public init() {}

  /// A shot is wanted: its number, or nil while another waits or is being made.
  public func begin(_ waiter: Waiter) -> Int? {
    lock.lock()
    defer { lock.unlock() }
    guard case .idle = state else { return nil }
    shots += 1
    state = .waiting(waiter, shots)
    return shots
  }

  /// A frame has arrived: the waiter whose shot it is, which is now being made (until done()); nil when none waits.
  public func claim() -> Waiter? {
    lock.lock()
    defer { lock.unlock() }
    guard case .waiting(let waiter, _) = state else { return nil }
    state = .working
    return waiter
  }

  /// The time allowed for shot number `shot` to get its frame has run out: its waiter, if it still waits.
  public func expire(_ shot: Int) -> Waiter? {
    lock.lock()
    defer { lock.unlock() }
    guard case .waiting(let waiter, let number) = state, number == shot else { return nil }
    state = .idle
    return waiter
  }

  /// The camera has closed: the waiter of a shot that still waits. One being made is left to be answered.
  public func close() -> Waiter? {
    lock.lock()
    defer { lock.unlock() }
    guard case .waiting(let waiter, _) = state else { return nil }
    state = .idle
    return waiter
  }

  /// The shot that was being made has been answered.
  public func done() {
    lock.lock()
    defer { lock.unlock() }
    if case .working = state { state = .idle }
  }
}
