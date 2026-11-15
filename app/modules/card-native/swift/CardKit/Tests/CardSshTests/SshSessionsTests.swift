import Crypto
import Foundation
import NIOConcurrencyHelpers
import NIOCore
import NIOPosix
import XCTest

@testable import CardSsh
import CardLogic

/// testvectors/vectors.json, read as text as the Kotlin tests do.
enum Vectors {
  static let text: String = {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<8 { root.deleteLastPathComponent() }
    return try! String(contentsOf: root.appendingPathComponent("testvectors/vectors.json"), encoding: .utf8)
  }()

  static func field(_ name: String) -> String {
    let marker = "\"\(name)\": \""
    let start = text.range(of: marker)!.upperBound
    return String(text[start..<text[start...].firstIndex(of: "\"")!])
  }
}

/// Against a real OpenSSH server: deploy/test/ios-swift-test.sh starts one and sets
/// CARD_SSH_TEST=host:port:user:hostKeyBlob. Skipped when it isn't set. These are
/// android/.../SshSessionsTest.kt's tests, one for one.
final class SshSessionsTests: XCTestCase {
  private let target = (ProcessInfo.processInfo.environment["CARD_SSH_TEST"] ?? "").split(separator: ":").map(String.init)
  private let seed = Vectors.field("sshEd25519Seed")

  private func needServer() throws {
    try XCTSkipUnless(target.count == 4, "CARD_SSH_TEST is not set")
  }

  private func connect(blob: String? = nil, seedHex: String? = nil) throws -> (SshSessions, Int) {
    let ssh = SshSessions()
    let id = try ssh.connect(
      host: target[0], port: Int(target[1])!, user: target[2], hostKeyType: "ssh-ed25519",
      hostKeyBlob: blob ?? target[3], seedHex: seedHex ?? seed
    )
    return (ssh, id)
  }

  func testExecPassesStdinAndReportsExitCodes() throws {
    try needServer()
    let (ssh, id) = try connect()
    let r = try ssh.exec(id: id, command: "cat > stdin.txt; wc -c < stdin.txt; echo oops >&2; exit 3", stdin: "prosper short ramp\n")
    XCTAssertEqual(r.code, 3)
    XCTAssertEqual(r.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "19")
    XCTAssertEqual(r.stderr.trimmingCharacters(in: .whitespacesAndNewlines), "oops")
    ssh.close(id: id)
  }

  // install.sh system prints a lot (apt): a full stderr pipe must not stall the command.
  func testLargeOutputOnBothStreamsDoesNotHang() throws {
    try needServer()
    let (ssh, id) = try connect()
    let r = try ssh.exec(id: id, command: "head -c 4000000 /dev/zero | tr '\\0' e >&2; head -c 4000000 /dev/zero | tr '\\0' o", stdin: nil)
    XCTAssertEqual(r.code, 0)
    XCTAssertEqual(r.stdout.utf8.count, 4_000_000)
    XCTAssertEqual(r.stderr.utf8.count, 4_000_000)
    ssh.close(id: id)
  }

  // A VM that freezes, or a mobile NAT that forgets the connection, sends no RST: the exec must
  // fail on the calling thread (a retryable error), not hang.
  func testAPeerThatGoesSilentFailsTheExecInsteadOfHanging() throws {
    try needServer()
    let proxy = try BlackHoleProxy(host: target[0], upstreamPort: Int(target[1])!)
    defer { proxy.close() }
    let ssh = SshSessions()
    let id = try ssh.connect(
      host: "127.0.0.1", port: proxy.port, user: target[2], hostKeyType: "ssh-ed25519",
      hostKeyBlob: target[3], seedHex: seed, keepAliveSec: 1
    )
    DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { proxy.goSilent() }
    let began = Date()
    XCTAssertThrowsError(try ssh.exec(id: id, command: "sleep 30", stdin: nil))
    XCTAssertLessThan(Date().timeIntervalSince(began), 15)
    ssh.close(id: id)
  }

  // The other half of the keepalive: a quiet command on a live server is NOT cut off, though it
  // prints nothing for longer than the idle limit (4 x 1 s here).
  func testAQuietCommandOnALiveServerIsLeftAlone() throws {
    try needServer()
    let ssh = SshSessions()
    let id = try ssh.connect(
      host: target[0], port: Int(target[1])!, user: target[2], hostKeyType: "ssh-ed25519",
      hostKeyBlob: target[3], seedHex: seed, keepAliveSec: 1
    )
    let r = try ssh.exec(id: id, command: "sleep 9; echo done", stdin: nil)
    XCTAssertEqual(r.code, 0)
    XCTAssertEqual(r.stdout, "done\n")
    ssh.close(id: id)
  }

  func testUploadCreatesDirectoriesAndSetsTheMode() throws {
    try needServer()
    let (ssh, id) = try connect()
    let data = Array("#!/bin/sh\necho hello\n".utf8)
    try ssh.upload(id: id, remotePath: "card-app/bin/hello", read: chunks(of: data), mode: 0o755)
    let r = try ssh.exec(id: id, command: "stat -c %a card-app/bin/hello && card-app/bin/hello", stdin: nil)
    XCTAssertEqual(r.code, 0)
    XCTAssertEqual(r.stdout, "755\nhello\n")
    ssh.close(id: id)
  }

  // The 11 MB cardd upload takes over a minute on a weak network: the screen shows how far it got.
  func testUploadReportsTheBytesSentUpToTheFullSize() throws {
    try needServer()
    let (ssh, id) = try connect()
    let data = (0..<1_000_000).map { UInt8($0 % 251) }
    var seen = [Int]()
    try ssh.upload(id: id, remotePath: "card-app/big.bin", read: chunks(of: data), mode: 0o644) { seen.append($0) }
    XCTAssertGreaterThan(seen.count, 2, "reports: \(seen)")
    XCTAssertEqual(seen, seen.sorted())
    XCTAssertEqual(seen.last, data.count)
    let r = try ssh.exec(id: id, command: "wc -c < card-app/big.bin; sha256sum < card-app/big.bin", stdin: nil)
    XCTAssertEqual(r.stdout.split(separator: "\n").first.map(String.init), "1000000")
    ssh.close(id: id)
  }

  // The size of the real thing: cardd is about 12 MB, past the channel's 8 MB window.
  func testUploadsAFileTheSizeOfCardd() throws {
    try needServer()
    let (ssh, id) = try connect()
    var data = [UInt8](repeating: 0, count: 12_000_000)
    for i in data.indices { data[i] = UInt8(truncatingIfNeeded: i &* 7 &+ i >> 12) }
    try ssh.upload(id: id, remotePath: "card-app/huge.bin", read: chunks(of: data), mode: 0o755)
    let r = try ssh.exec(id: id, command: "wc -c < card-app/huge.bin; sha256sum < card-app/huge.bin", stdin: nil)
    let lines = r.stdout.split(separator: "\n").map(String.init)
    XCTAssertEqual(lines.first, "12000000")
    // The app checks the upload the same way (sha256sum -c): every byte arrived, in order.
    XCTAssertEqual(lines.last?.split(separator: " ").first.map(String.init), Hex.encode(SHA256.hash(data: data)))
    ssh.close(id: id)
  }

  // The diagnostics ask for this (src/diagnostics/checks.ts): a short call on a session must not
  // queue behind a long one.
  func testAShortCommandDoesNotWaitBehindALongOne() throws {
    try needServer()
    let (ssh, id) = try connect()
    let long = DispatchGroup()
    long.enter()
    DispatchQueue.global().async {
      _ = try? ssh.exec(id: id, command: "sleep 4", stdin: nil)
      long.leave()
    }
    Thread.sleep(forTimeInterval: 0.5)
    let began = Date()
    let r = try ssh.exec(id: id, command: "echo quick", stdin: nil)
    XCTAssertEqual(r.stdout, "quick\n")
    XCTAssertLessThan(Date().timeIntervalSince(began), 2)
    long.wait()
    ssh.close(id: id)
  }

  // The app explains this one (a new VM still installing our key, or another phrase's server).
  func testAKeyTheServerDoesNotKnowIsSshAuthFailed() throws {
    try needServer()
    XCTAssertThrowsError(try connect(seedHex: String(repeating: "11", count: 32))) { e in
      XCTAssertTrue(e is SshAuthFailed, "got \(e)")
    }
  }

  // Not a mismatch: the app only ever pins ssh-ed25519, so this is a bug, not a hostile server.
  func testAnUnsupportedHostKeyTypeIsNotReportedAsAMismatch() {
    XCTAssertThrowsError(
      try SshSessions().connect(host: "127.0.0.1", port: 1, user: "debian", hostKeyType: "ssh-unknown", hostKeyBlob: "AAAA", seedHex: seed)
    ) { e in
      XCTAssertEqual(e as? SshError, .unsupportedHostKeyType("ssh-unknown"), "got \(e)")
    }
  }

  // Trust on first use, until LNVPS publishes the key (about an hour after boot): read the
  // server's ed25519 host key without logging in.
  func testReadsTheServersEd25519HostKeyWithoutLoggingIn() throws {
    try needServer()
    let (type, blob) = try SshSessions().scanHostKey(host: target[0], port: Int(target[1])!)
    XCTAssertEqual(type, "ssh-ed25519")
    XCTAssertEqual(blob, target[3])
  }

  func testScanningNothingListeningFails() throws {
    let free = try freePort()
    XCTAssertThrowsError(try SshSessions().scanHostKey(host: "127.0.0.1", port: free, timeoutMs: 2_000))
  }

  func testRefusesAServerWhoseKeyIsNotThePinnedOne() throws {
    try needServer()
    let wrong = "AAAAC3NzaC1lZDI1NTE5AAAAIM7OaJ/OiX8fQqSebMIWCvTHRxCAl3j+ZDKh4HZao3gE"
    XCTAssertThrowsError(try connect(blob: wrong)) { e in
      XCTAssertTrue(e is HostKeyMismatch, "got \(e)")
    }
  }

  private func freePort() throws -> Int {
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    defer { try? group.syncShutdownGracefully() }
    let server = try ServerBootstrap(group: group).bind(host: "127.0.0.1", port: 0).wait()
    let port = server.localAddress!.port!
    try server.close().wait()
    return port
  }
}

final class KeyEncodingTests: XCTestCase {
  func testEd25519KeyFromSeedMatchesThePhraseVector() throws {
    let key = try KeyEncoding.ed25519PrivateKey(seed: Hex.decode(Vectors.field("sshEd25519Seed"))!)
    let (type, blob) = KeyEncoding.sshKeyTypeAndBlob(key.publicKey)
    XCTAssertEqual("\(type) \(blob)", Vectors.field("sshAuthorizedKey"))
  }

  func testASeedThatIsNotThirtyTwoBytesIsRefused() {
    XCTAssertThrowsError(try KeyEncoding.ed25519PrivateKey(seed: [1, 2, 3]))
    XCTAssertThrowsError(
      try SshSessions().connect(host: "127.0.0.1", port: 1, user: "debian", hostKeyType: "ssh-ed25519", hostKeyBlob: "AAAA", seedHex: "zz")
    )
  }
}

/// Forwards one TCP connection; once silent, drops every byte both ways without closing anything; cut, both
/// sides are closed at once, as a network that went.
final class BlackHoleProxy {
  private let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
  private let silent = NIOLockedValueBox(false)
  private let ends = NIOLockedValueBox<[Channel]>([])
  private var server: Channel!
  var port: Int { server.localAddress!.port! }

  init(host: String, upstreamPort: Int) throws {
    let silent = self.silent
    let ends = self.ends
    server = try ServerBootstrap(group: group)
      .childChannelOption(ChannelOptions.autoRead, value: false)
      .childChannelInitializer { inbound in
        ClientBootstrap(group: inbound.eventLoop)
          .channelInitializer { out in out.pipeline.addHandler(Forward(to: inbound, silent: silent)) }
          .connect(host: host, port: upstreamPort)
          .flatMap { out in
            ends.withLockedValue { $0 += [inbound, out] }
            return inbound.pipeline.addHandler(Forward(to: out, silent: silent))
          }
          .flatMap { inbound.setOption(ChannelOptions.autoRead, value: true) }
      }
      .bind(host: "127.0.0.1", port: 0).wait()
  }

  func goSilent() {
    silent.withLockedValue { $0 = true }
  }

  func cut() {
    for end in ends.withLockedValue({ $0 }) { end.close(promise: nil) }
  }

  func close() {
    try? group.syncShutdownGracefully()
  }

  private final class Forward: ChannelInboundHandler {
    typealias InboundIn = ByteBuffer
    private let peer: Channel
    private let silent: NIOLockedValueBox<Bool>

    init(to peer: Channel, silent: NIOLockedValueBox<Bool>) {
      self.peer = peer
      self.silent = silent
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
      if silent.withLockedValue({ $0 }) { return }
      peer.writeAndFlush(data, promise: nil)
    }
  }
}
