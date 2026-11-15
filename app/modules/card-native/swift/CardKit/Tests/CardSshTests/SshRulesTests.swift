import CardLogic
import Crypto
import Foundation
import NIOConcurrencyHelpers
import NIOCore
import NIOPosix
import NIOSSH
import XCTest

@testable import CardSsh

/// What the app needs of the SSH layer beyond running a command, against the same OpenSSH server.
final class SshRulesTests: XCTestCase {
  private let target = (ProcessInfo.processInfo.environment["CARD_SSH_TEST"] ?? "").split(separator: ":").map(String.init)
  private let seed = Vectors.field("sshEd25519Seed")

  private func needServer() throws {
    try XCTSkipUnless(target.count == 4, "CARD_SSH_TEST is not set")
  }

  private func connect(through proxy: BlackHoleProxy? = nil, keepAliveSec: Int = 15) throws -> (SshSessions, Int) {
    let ssh = SshSessions()
    let id = try ssh.connect(
      host: proxy == nil ? target[0] : "127.0.0.1", port: proxy?.port ?? Int(target[1])!, user: target[2],
      hostKeyType: "ssh-ed25519", hostKeyBlob: target[3], seedHex: seed, keepAliveSec: keepAliveSec
    )
    return (ssh, id)
  }

  /// What a call threw, or nil.
  private func thrown(_ call: () throws -> Void) -> Error? {
    do {
      try call()
      return nil
    } catch {
      return error
    }
  }

  // MARK: a command's end

  // The server names the signal; the number is the package's own table of Linux's.
  func testACommandKilledByASignalAnswersAsAShellWouldSayIt() throws {
    try needServer()
    let (ssh, id) = try connect()
    XCTAssertEqual(try ssh.exec(id: id, command: "kill -9 $$", stdin: nil).code, 137)
    XCTAssertEqual(try ssh.exec(id: id, command: "echo before; kill -TERM $$", stdin: nil), ExecResult(code: 143, stdout: "before\n", stderr: ""))
    ssh.close(id: id)
  }

  func testTheTableOfSignals() {
    let table = ["HUP": 1, "INT": 2, "QUIT": 3, "ABRT": 6, "KILL": 9, "SEGV": 11, "PIPE": 13, "ALRM": 14, "TERM": 15]
    for (name, number) in table { XCTAssertEqual(ExitSignals.code(name), 128 + number, name) }
    XCTAssertNil(ExitSignals.code("USR1"))
    XCTAssertNil(ExitSignals.code("SIGKILL"))
    XCTAssertNil(ExitSignals.code(""))
  }

  // A code is never made up: a signal the table does not hold is a failure that says so.
  func testASignalTheTableDoesNotHoldRejectsWithItsName() throws {
    try needServer()
    let (ssh, id) = try connect()
    let e = thrown { _ = try ssh.exec(id: id, command: "kill -USR1 $$", stdin: nil) }
    XCTAssertEqual(e as? SshError, .killed("USR1"), "got \(String(describing: e))")
    XCTAssertEqual(sshWords(e!), "the command was ended by a signal with no exit code (USR1)")
    // The connection is still good.
    XCTAssertEqual(try ssh.exec(id: id, command: "echo ok", stdin: nil).stdout, "ok\n")
    ssh.close(id: id)
  }

  // MARK: a command's input

  // More than the server takes unread at once (its window is 2 MB): every byte arrives, in order.
  func testAnInputIsWrittenWhole() throws {
    try needServer()
    let (ssh, id) = try connect()
    let input = String(repeating: "0123456789abcdef", count: 400_000)
    let r = try ssh.exec(id: id, command: "tee input.txt | wc -c; sha256sum < input.txt | cut -d' ' -f1", stdin: input)
    XCTAssertEqual(r.code, 0)
    XCTAssertEqual(r.stdout.split(separator: "\n").map(String.init), ["6400000", Hex.encode(SHA256.hash(data: Data(input.utf8)))])
    ssh.close(id: id)
  }

  // Were it left open, cat would wait for ever.
  func testACommandGivenNoInputSeesItsInputClosedAtOnce() throws {
    try needServer()
    let (ssh, id) = try connect()
    let began = Date()
    XCTAssertEqual(try ssh.exec(id: id, command: "cat; echo done", stdin: nil).stdout, "done\n")
    XCTAssertLessThan(Date().timeIntervalSince(began), 5)
    ssh.close(id: id)
  }

  // MARK: an upload the server refuses

  func testAnUploadTheServerRefusesIsUploadRefusedWithTheServersWords() throws {
    try needServer()
    let (ssh, id) = try connect()
    _ = try ssh.exec(id: id, command: "mkdir -p card-app/locked && chmod 500 card-app/locked", stdin: nil)
    defer {
      _ = try? ssh.exec(id: id, command: "chmod 700 card-app/locked && rmdir card-app/locked", stdin: nil)
      ssh.close(id: id)
    }
    let data = [UInt8](repeating: 7, count: 200_000)
    // A folder that cannot be written: the command fails before it has read a byte.
    let denied = thrown { try ssh.upload(id: id, remotePath: "card-app/locked/x", read: chunks(of: data), mode: 0o644) }
    guard let d = denied as? UploadRefused else { return XCTFail("got \(String(describing: denied))") }
    XCTAssertNotEqual(d.code, 0)
    XCTAssertTrue(d.words.contains("Permission denied"), d.words)
    XCTAssertEqual(sshWords(d), d.words)
    // The session is still good for the next thing.
    XCTAssertEqual(try ssh.exec(id: id, command: "echo ok", stdin: nil).stdout, "ok\n")
  }

  // Every write to /dev/full fails as a full disk's does, while the phone is still sending: the write that
  // fails on the phone's side decides nothing, the command's end does.
  func testAFileThatCannotTakeAByteIsRefusedThoughThePhoneWasStillWriting() throws {
    try needServer()
    let (ssh, id) = try connect()
    defer { ssh.close(id: id) }
    // A Mac standing in for the server has no such file: this case is Linux's, where the app's servers are.
    guard try ssh.exec(id: id, command: "test -c /dev/full", stdin: nil).code == 0 else { return }
    let data = [UInt8](repeating: 7, count: 12_000_000)
    let full = thrown { try ssh.upload(id: id, remotePath: "/dev/full", read: chunks(of: data), mode: 0o644) }
    guard let f = full as? UploadRefused else { return XCTFail("got \(String(describing: full))") }
    XCTAssertTrue(f.words.contains("No space left on device"), f.words)
    XCTAssertEqual(try ssh.exec(id: id, command: "echo ok", stdin: nil).stdout, "ok\n")
  }

  // The same moment from the other side: the connection goes under an upload. No exit code comes: a drop.
  func testAConnectionCutUnderAnUploadIsNotARefusal() throws {
    try needServer()
    for silent in [false, true] {
      let proxy = try BlackHoleProxy(host: target[0], upstreamPort: Int(target[1])!)
      defer { proxy.close() }
      let (ssh, id) = try connect(through: proxy, keepAliveSec: 1)
      let data = [UInt8](repeating: 7, count: 40_000_000)
      var cut = false
      let e = thrown {
        try ssh.upload(id: id, remotePath: "card-app/cut.bin", read: chunks(of: data), mode: 0o644) { sent in
          if !cut && sent >= 1_000_000 {
            cut = true
            if silent { proxy.goSilent() } else { proxy.cut() }
          }
        }
      }
      XCTAssertNotNil(e, "the upload should fail (silent: \(silent))")
      XCTAssertFalse(e is UploadRefused, "a cut is not the server's refusal (silent: \(silent)): \(String(describing: e))")
      XCTAssertEqual(e as? SshError, .connectionLost, "silent: \(silent), got \(String(describing: e))")
      ssh.close(id: id)
    }
  }

  // MARK: closing

  func testClosingASessionFailsACommandStillRunningOnIt() throws {
    try needServer()
    let (ssh, id) = try connect()
    let failed = expectation(description: "the running command fails")
    DispatchQueue.global().async {
      let e = self.thrown { _ = try ssh.exec(id: id, command: "sleep 30", stdin: nil) }
      XCTAssertEqual(e as? SshError, .connectionLost, "got \(String(describing: e))")
      failed.fulfill()
    }
    Thread.sleep(forTimeInterval: 0.7)
    ssh.close(id: id)
    wait(for: [failed], timeout: 5)
    XCTAssertEqual(thrown { _ = try ssh.exec(id: id, command: "echo late", stdin: nil) } as? SshError, .noSession(id))
  }

  func testClosingAllEndsEverySession() throws {
    try needServer()
    let ssh = SshSessions()
    let ids = try (0..<2).map { _ in
      try ssh.connect(host: target[0], port: Int(target[1])!, user: target[2], hostKeyType: "ssh-ed25519", hostKeyBlob: target[3], seedHex: seed)
    }
    ssh.closeAll()
    for id in ids { XCTAssertEqual(thrown { _ = try ssh.exec(id: id, command: "echo late", stdin: nil) } as? SshError, .noSession(id)) }
  }

  // MARK: every rejection says what happened

  func testEachFailureIsASentenceAndNeverTheLibrarysBareName() throws {
    try needServer()
    // Nothing listening.
    let free = try freePort()
    let refused = thrown { _ = try SshSessions().connect(host: "127.0.0.1", port: free, user: "debian", hostKeyType: "ssh-ed25519", hostKeyBlob: target[3], seedHex: seed, timeoutMs: 2_000) }
    XCTAssertTrue(sshWords(refused!).hasPrefix("could not connect to 127.0.0.1:\(free): "), sshWords(refused!))
    let noScan = thrown { _ = try SshSessions().scanHostKey(host: "127.0.0.1", port: free, timeoutMs: 2_000) }
    XCTAssertTrue(sshWords(noScan!).hasPrefix("could not connect to 127.0.0.1:\(free): "), sshWords(noScan!))
    // A peer that goes silent under a command, and one that is cut.
    for silent in [true, false] {
      let proxy = try BlackHoleProxy(host: target[0], upstreamPort: Int(target[1])!)
      defer { proxy.close() }
      let (ssh, id) = try connect(through: proxy, keepAliveSec: 1)
      DispatchQueue.global().asyncAfter(deadline: .now() + 1) { if silent { proxy.goSilent() } else { proxy.cut() } }
      let e = thrown { _ = try ssh.exec(id: id, command: "sleep 30", stdin: nil) }
      XCTAssertEqual(sshWords(e!), "the connection closed", "silent: \(silent), got \(String(describing: e))")
      ssh.close(id: id)
    }
    // The refusals the app names, and a session that is not there.
    let wrong = "AAAAC3NzaC1lZDI1NTE5AAAAIM7OaJ/OiX8fQqSebMIWCvTHRxCAl3j+ZDKh4HZao3gE"
    let mismatch = thrown { _ = try SshSessions().connect(host: self.target[0], port: Int(self.target[1])!, user: self.target[2], hostKeyType: "ssh-ed25519", hostKeyBlob: wrong, seedHex: self.seed) }
    XCTAssertEqual(sshWords(mismatch!), "server presented ssh-ed25519 \(target[3]), expected ssh-ed25519 \(wrong)")
    let auth = thrown { _ = try SshSessions().connect(host: self.target[0], port: Int(self.target[1])!, user: self.target[2], hostKeyType: "ssh-ed25519", hostKeyBlob: self.target[3], seedHex: String(repeating: "11", count: 32)) }
    XCTAssertEqual(sshWords(auth!), "the server refused the key for \(target[2])")
    XCTAssertEqual(sshWords(thrown { _ = try SshSessions().exec(id: 99, command: "ls", stdin: nil) }!), "there is no SSH session 99")
    for e in [refused!, noScan!, mismatch!, auth!] {
      XCTAssertFalse(sshWords(e).contains("NIO"), sshWords(e))
      XCTAssertFalse(sshWords(e).contains(seed), "the key's seed is in no error")
    }
  }

  // Something that answers as an SSH server and then is not one: the library's own error for it must reach a
  // person as a sentence, never as its name and its fields.
  func testAServerThatBreaksTheProtocolFailsWithASentence() throws {
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    defer { try? group.syncShutdownGracefully() }
    let server = try ServerBootstrap(group: group)
      .childChannelInitializer { channel in channel.pipeline.addHandler(NotSsh()) }
      .bind(host: "127.0.0.1", port: 0).wait()
    defer { try? server.close().wait() }
    let port = server.localAddress!.port!
    let e = thrown { _ = try SshSessions().connect(host: "127.0.0.1", port: port, user: "debian", hostKeyType: "ssh-ed25519", hostKeyBlob: "AAAA", seedHex: self.seed, timeoutMs: 5_000) }
    let words = sshWords(e!)
    XCTAssertTrue(words.hasPrefix("the SSH connection failed: "), words)
    XCTAssertFalse(words.contains("NIO"), words)
    XCTAssertFalse(words.contains("("), words)
  }

  func testTheWordsOfEachOfThePackagesOwnFailures() {
    XCTAssertEqual(sshWords(SshError.connectionLost), "the connection closed")
    XCTAssertEqual(sshWords(SshError.noExitCode), "the command ended with no exit code")
    XCTAssertEqual(sshWords(SshError.execRefused), "the server would not run the command")
    XCTAssertEqual(sshWords(SshError.timedOut("the key exchange with 10.0.0.1:22")), "the key exchange with 10.0.0.1:22 timed out")
    XCTAssertEqual(sshWords(SshError.unsupportedHostKeyType("ssh-rsa")), "the app pins only ssh-ed25519 host keys, not ssh-rsa")
    XCTAssertEqual(sshWords(SshError.noHostKey("10.0.0.1:22")), "the server at 10.0.0.1:22 presented no host key")
    XCTAssertEqual(sshWords(SshError.failed("could not connect to 10.0.0.1:22: connection refused")), "could not connect to 10.0.0.1:22: connection refused")
    XCTAssertEqual(sshWords(UploadRefused(code: 1, words: "cat: write error: No space left on device")), "cat: write error: No space left on device")
    XCTAssertEqual(sshWords(KeyEncoding.BadSeed()), "the SSH key's seed is not 32 bytes of hex")
    struct Foreign: Error {}
    XCTAssertEqual(sshWords(Foreign()), "the SSH connection failed: Foreign()")
  }

  // MARK: the phrase's key

  // It is offered once and let go: nothing of the module holds it for the connection's life.
  func testThePhrasesKeyIsLetGoOnceItHasBeenOffered() throws {
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    defer { try? group.syncShutdownGracefully() }
    let key = try KeyEncoding.ed25519PrivateKey(seed: [UInt8](repeating: 1, count: 32))
    let refusals = NIOLockedValueBox(0)
    let auth = SeedKeyAuth(user: "debian", key: key) { refusals.withLockedValue { $0 += 1 } }
    XCTAssertTrue(auth.holdsKey)
    let first = group.next().makePromise(of: NIOSSHUserAuthenticationOffer?.self)
    auth.nextAuthenticationType(availableMethods: .publicKey, nextChallengePromise: first)
    XCTAssertNotNil(try first.futureResult.wait())
    XCTAssertFalse(auth.holdsKey)
    // Asked again, the server has refused it: nothing is offered.
    let second = group.next().makePromise(of: NIOSSHUserAuthenticationOffer?.self)
    auth.nextAuthenticationType(availableMethods: .publicKey, nextChallengePromise: second)
    XCTAssertNil(try second.futureResult.wait())
    XCTAssertEqual([auth.refused, refusals.withLockedValue { $0 } == 1], [true, true])
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

/// Greets as an SSH server would, then sends what no SSH server sends.
private final class NotSsh: ChannelInboundHandler {
  typealias InboundIn = ByteBuffer

  func channelActive(context: ChannelHandlerContext) {
    var bytes = context.channel.allocator.buffer(capacity: 128)
    bytes.writeString("SSH-2.0-NotReally\r\n")
    bytes.writeBytes([UInt8](repeating: 0xff, count: 96))
    context.writeAndFlush(NIOAny(bytes), promise: nil)
  }
}
