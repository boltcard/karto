import XCTest

@testable import CardLogic

final class JpegTests: XCTestCase {
  private func segment(_ marker: UInt8, _ body: [UInt8]) -> [UInt8] {
    [0xFF, marker, UInt8((body.count + 2) >> 8), UInt8((body.count + 2) & 0xFF)] + body
  }

  private let soi: [UInt8] = [0xFF, 0xD8]
  private lazy var jfif = segment(0xE0, Array("JFIF\0".utf8) + [1, 1, 0, 0, 72, 0, 72, 0, 0])
  /// What a phone's camera writes: EXIF with where the photo was taken.
  private lazy var exif = segment(0xE1, Array("Exif\0\0".utf8) + Array("GPSLatitude 51.5 GPSLongitude -0.12".utf8))
  private lazy var xmp = segment(0xE1, Array("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>".utf8))
  private lazy var profile = segment(0xE2, Array("ICC_PROFILE\0".utf8) + [1, 1, 9, 9, 9])
  private lazy var iptc = segment(0xED, Array("Photoshop 3.0\0".utf8) + [1, 2, 3])
  private lazy var tables = segment(0xDB, [UInt8](repeating: 16, count: 65))
  /// The frame header of a 428×270 picture: 8 bits, height, width, 3 components.
  private lazy var frame = segment(0xC0, [8, 0x01, 0x0E, 0x01, 0xAC, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  /// The picture itself: from the start of scan to the end, with bytes in it that look like markers.
  private lazy var scan = segment(0xDA, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]) + [0x12, 0xFF, 0x00, 0xE1, 0x34, 0xFF, 0xD0, 0x56, 0xFF, 0xD9]

  func testEveryApp1AndApp13SegmentGoesAndTheRestStaysInOrder() {
    let jpeg = soi + jfif + exif + profile + xmp + iptc + tables + frame + scan
    XCTAssertEqual(Jpeg.withoutMetadata(jpeg), soi + jfif + profile + tables + frame + scan)
    XCTAssertTrue(Jpeg.hasApp1(jpeg))
    XCTAssertFalse(Jpeg.hasApp1(Jpeg.withoutMetadata(jpeg)!))
    // Where the photo was taken is in no byte that is left.
    XCTAssertNil(String(decoding: Jpeg.withoutMetadata(jpeg)!, as: UTF8.self).range(of: "GPS"))
  }

  func testAJpegWithNoMetadataIsLeftAsItIs() {
    let jpeg = soi + jfif + tables + frame + scan
    XCTAssertEqual(Jpeg.withoutMetadata(jpeg), jpeg)
    XCTAssertFalse(Jpeg.hasApp1(jpeg))
  }

  /// Fill bytes before a marker are allowed, and are kept.
  func testFillBytesBeforeAMarker() {
    let jpeg = soi + [0xFF, 0xFF] + exif + [0xFF] + tables + frame + scan
    XCTAssertEqual(Jpeg.withoutMetadata(jpeg), soi + [0xFF, 0xFF, 0xFF] + tables + frame + scan)
  }

  func testTheSizeIsReadFromTheFrameHeader() {
    XCTAssertEqual(Jpeg.size(soi + jfif + exif + tables + frame + scan).map { [$0.width, $0.height] }, [428, 270])
    // A progressive picture's header (SOF2) too; the tables for it (DHT, 0xC4) are not a frame header.
    let progressive = segment(0xC4, [0, 1, 2, 3]) + segment(0xC2, [8, 0x00, 0x10, 0x00, 0x20, 1, 1, 0x11, 0])
    XCTAssertEqual(Jpeg.size(soi + progressive + scan).map { [$0.width, $0.height] }, [32, 16])
    XCTAssertNil(Jpeg.size(soi + jfif + tables + scan))
  }

  func testWhatIsNotAJpegOrIsCutShortIsRefused() {
    XCTAssertNil(Jpeg.withoutMetadata([]))
    XCTAssertNil(Jpeg.withoutMetadata(Array("GIF89a".utf8)))
    XCTAssertNil(Jpeg.size(Array("GIF89a".utf8)))
    // No picture follows the segments.
    XCTAssertNil(Jpeg.withoutMetadata(soi + jfif + exif + tables + frame))
    // A segment that says it is longer than the file.
    XCTAssertNil(Jpeg.withoutMetadata(soi + [0xFF, 0xE1, 0x40, 0x00, 1, 2, 3]))
    // A segment too short to hold its own length.
    XCTAssertNil(Jpeg.withoutMetadata(soi + [0xFF, 0xE0, 0x00, 0x01] + scan))
    // Something that is not a marker where one must be.
    XCTAssertNil(Jpeg.withoutMetadata(soi + jfif + [0x12, 0x34] + scan))
  }
}
