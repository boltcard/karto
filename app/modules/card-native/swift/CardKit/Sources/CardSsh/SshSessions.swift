import CardLogic
import Foundation
import NIOConcurrencyHelpers
import NIOCore
import NIOPosix
import NIOSSH

/// The server presented a key that is not the pinned one.
public struct HostKeyMismatch: Error, CustomStringConvertible {
  public let description: String
}

/// The server refused the phrase's SSH key.
public struct SshAuthFailed: Error, CustomStringConvertible {
  public let description: String
}

/// The server presented a host key of another type: it has no ssh-ed25519 key to pin. Not a
/// mismatch. (The Kotlin offers only ssh-ed25519, so there this is a failed key exchange; this
/// library also offers ECDSA and its list can't be changed.)
public struct NoEd25519HostKey: Error, CustomStringConvertible {
  public let description: String
}

/// The server refused an upload: its command ended with a failure code (the disk is full, the folder cannot be
/// written). The server's answer, so not a dropped connection; `words` are the server's own.
public struct UploadRefused: Error, Equatable, CustomStringConvertible {
  public let code: Int
  public let words: String
  public var description: String { words }
}

/// Every other failure. To the app each is a failed connection (src/native/ssh.ts), and each says what happened.
public enum SshError: Error, Equatable, CustomStringConvertible {
  case unsupportedHostKeyType(String)
  /// The server (host:port) presented no host key.
  case noHostKey(String)
  case noSession(Int)
  /// The connection went: closed by the server, by the network, or by sshClose.
  case connectionLost
  /// No byte from the server for the idle limit: the connection is closed, and what waited on it sees connectionLost.
  case peerSilent
  /// What timed out.
  case timedOut(String)
  case execRefused
  /// The command's channel ended with neither an exit code nor a signal: a code is never made up.
  case noExitCode
  /// The command was ended by a signal ExitSignals has no number for.
  case killed(String)
  /// Anything else, already as a sentence.
  case failed(String)

  public var description: String {
    switch self {
    case .unsupportedHostKeyType(let type): return "the app pins only ssh-ed25519 host keys, not \(type)"
    case .noHostKey(let server): return "the server at \(server) presented no host key"
    case .noSession(let id): return "there is no SSH session \(id)"
    case .connectionLost: return "the connection closed"
    case .peerSilent: return "the server went silent, and the connection was closed"
    case .timedOut(let what): return "\(what) timed out"
    case .execRefused: return "the server would not run the command"
    case .noExitCode: return "the command ended with no exit code"
    case .killed(let signal): return "the command was ended by a signal with no exit code (\(signal))"
    case .failed(let words): return words
    }
  }
}

/// A failure's sentence, for the module to reject with. The library's own errors are bare numbers when the
/// system turns them to text ("NIOSSHError error 1"), so the module asks here and never there.
public func sshWords(_ error: Error) -> String {
  switch error {
  case let e as SshError: return e.description
  case let e as UploadRefused: return e.description
  case let e as HostKeyMismatch: return e.description
  case let e as SshAuthFailed: return e.description
  case let e as NoEd25519HostKey: return e.description
  case let e as KeyEncoding.BadSeed: return e.description
  default: return "the SSH connection failed: \(error)"
  }
}

/// What this package throws is its own: one of the named failures, or an SshError. A failure of the library or
/// of the socket under a call that had begun is the connection going.
func ours(_ error: Error) -> Error {
  switch error {
  case is SshError, is UploadRefused, is HostKeyMismatch, is SshAuthFailed, is NoEd25519HostKey, is KeyEncoding.BadSeed: return error
  case is ChannelError, is IOError: return SshError.connectionLost
  case let e as NIOSSHError where e.type == .tcpShutdown: return SshError.connectionLost
  case let e as NIOSSHError: return SshError.failed("the SSH connection failed: \(libraryKind(e))")
  default: return SshError.failed(sshWords(error))
  }
}

/// The library's own error in plain words: its kind ("protocol violation"), never its name or its fields, which
/// hold nothing a person can use.
func libraryKind(_ error: NIOSSHError) -> String {
  let kind = "\(error.type)"
  guard !kind.isEmpty, kind.allSatisfy({ $0.isLetter }) else { return "the server did not speak SSH as expected" }
  return kind.reduce(into: "") { words, c in
    if c.isUppercase { words += " " + c.lowercased() } else { words.append(c) }
  }
}

/// Why a connect failed, in plain words.
func connectReason(_ error: Error) -> String {
  if let e = error as? NIOConnectionError {
    if let first = e.connectionErrors.first { return connectReason(first.error) }
    return e.dnsAError != nil || e.dnsAAAAError != nil ? "its address could not be found" : "no address answered"
  }
  if let e = error as? IOError { return String(cString: strerror(e.errnoCode)) }
  if let e = error as? ChannelError, case .connectTimeout = e { return "no answer in time" }
  return "\(error)"
}

public struct ExecResult: Equatable, Sendable {
  public let code: Int
  public let stdout: String
  public let stderr: String
}

/// Where an upload's bytes come from: up to `max` bytes a call, empty at the end.
public typealias ChunkSource = (_ max: Int) throws -> [UInt8]

/// SSH sessions for onboarding (src/onboarding/ssh.ts), as android/.../SshSessions.kt: the only
/// host key accepted is the pinned one, the login is the phrase's Ed25519 key, and all it does is
/// run commands and upload files. Calls block; make them off the main thread.
public final class SshSessions: @unchecked Sendable {
  private struct Session {
    let channel: Channel
    let keepAlive: RepeatedTask
  }

  private let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
  private let sessions = NIOLockedValueBox<[Int: Session]>([:])
  private let nextId = NIOLockedValueBox(1)

  public init() {}

  deinit {
    group.shutdownGracefully { _ in }
  }

  private func open(
    host: String, port: Int, timeoutMs: Int, idleSec: Int,
    check: HostKeyCheck, auth: SeedKeyAuth, ready: Once<Void>
  ) throws -> Channel {
    let bootstrap = ClientBootstrap(group: group)
      .channelInitializer { channel in
        channel.eventLoop.makeCompletedFuture {
          let sync = channel.pipeline.syncOperations
          try sync.addHandler(IdleStateHandler(readTimeout: .seconds(Int64(idleSec))))
          try sync.addHandler(IdleCloser())
          try sync.addHandler(
            NIOSSHHandler(
              role: .client(.init(userAuthDelegate: auth, serverAuthDelegate: check)),
              allocator: channel.allocator,
              inboundChildChannelInitializer: nil
            )
          )
          try sync.addHandler(ConnectionEvents(ready: ready))
        }
      }
      .channelOption(ChannelOptions.socketOption(.so_keepalive), value: 1)
      .channelOption(ChannelOptions.tcpOption(.tcp_nodelay), value: 1)
      .connectTimeout(.milliseconds(Int64(timeoutMs)))
    let channel: Channel
    do {
      channel = try bootstrap.connect(host: host, port: port).wait()
    } catch {
      throw SshError.failed("could not connect to \(host):\(port): \(connectReason(error))")
    }
    // The key exchange and login get the same time limit as the TCP connect.
    let limit = channel.eventLoop.scheduleTask(in: .milliseconds(Int64(timeoutMs))) {
      ready.fail(SshError.timedOut("the key exchange with \(host):\(port)"))
    }
    ready.future.whenComplete { _ in limit.cancel() }
    return channel
  }

  /// The server's ssh-ed25519 host key (type, base64 blob), read during key exchange without
  /// logging in: trust on first use, until LNVPS publishes the key to verify it against.
  public func scanHostKey(host: String, port: Int, timeoutMs: Int = 15_000) throws -> (type: String, blob: String) {
    let ready = Once<Void>(on: group.next())
    let check = HostKeyCheck(pin: nil)
    let auth = SeedKeyAuth(user: "", key: nil, onRefused: {})
    let channel = try open(host: host, port: port, timeoutMs: timeoutMs, idleSec: max(1, timeoutMs / 1000), check: check, auth: auth, ready: ready)
    let outcome = Result { try ready.future.wait() }
    channel.close(promise: nil)
    guard let seen = check.seen else {
      if case .failure(let e) = outcome { throw ours(e) }
      throw SshError.noHostKey("\(host):\(port)")
    }
    guard seen.type == "ssh-ed25519" else {
      throw NoEd25519HostKey(description: "the server at \(host):\(port) presented \(seen.type), not ssh-ed25519")
    }
    return seen
  }

  public func connect(
    host: String, port: Int, user: String, hostKeyType: String, hostKeyBlob: String, seedHex: String,
    timeoutMs: Int = 15_000, keepAliveSec: Int = 15
  ) throws -> Int {
    guard hostKeyType == "ssh-ed25519" else { throw SshError.unsupportedHostKeyType(hostKeyType) }
    guard let seed = Hex.decode(seedHex) else { throw KeyEncoding.BadSeed() }
    let key = try KeyEncoding.ed25519PrivateKey(seed: seed)
    let ready = Once<Void>(on: group.next())
    let check = HostKeyCheck(pin: (hostKeyType, hostKeyBlob))
    let auth = SeedKeyAuth(user: user, key: key) {
      ready.fail(SshAuthFailed(description: "the server refused the key for \(user)"))
    }
    // A peer that goes silent (frozen VM, a NAT that forgot us) sends no RST. The library has no
    // SSH keepalive to send, so: a probe every keepAliveSec that a live server answers (below),
    // and no bytes at all for 4 x keepAliveSec closes the connection, failing every pending call.
    let channel = try open(host: host, port: port, timeoutMs: timeoutMs, idleSec: 4 * keepAliveSec, check: check, auth: auth, ready: ready)
    do {
      try ready.future.wait()
    } catch {
      channel.close(promise: nil)
      if let seen = check.seen, seen.type != hostKeyType {
        throw NoEd25519HostKey(description: "the server presented \(seen.type), not \(hostKeyType)")
      }
      if let seen = check.seen, seen.blob != hostKeyBlob {
        throw HostKeyMismatch(description: "server presented \(seen.type) \(seen.blob), expected \(hostKeyType) \(hostKeyBlob)")
      }
      if auth.refused { throw SshAuthFailed(description: "the server refused the key for \(user)") }
      throw ours(error)
    }
    let keepAlive = channel.eventLoop.scheduleRepeatedTask(
      initialDelay: .seconds(Int64(keepAliveSec)), delay: .seconds(Int64(keepAliveSec))
    ) { _ in
      Self.probe(channel)
    }
    channel.closeFuture.whenComplete { _ in keepAlive.cancel() }
    let id = nextId.withLockedValue { n in
      defer { n += 1 }
      return n
    }
    sessions.withLockedValue { $0[id] = Session(channel: channel, keepAlive: keepAlive) }
    return id
  }

  /// Opens a channel and closes it once the server confirms: bytes from a live server, which is
  /// all the idle timer needs. sshd answers while a command prints nothing, so a long quiet
  /// install step is unaffected.
  private static func probe(_ channel: Channel) {
    guard let ssh = try? channel.pipeline.syncOperations.handler(type: NIOSSHHandler.self) else { return }
    let opened = channel.eventLoop.makePromise(of: Channel.self)
    ssh.createChannel(opened, channelType: .session) { child, _ in child.eventLoop.makeSucceededVoidFuture() }
    opened.futureResult.whenSuccess { $0.close(promise: nil) }
  }

  private func channel(_ id: Int) throws -> Channel {
    guard let s = sessions.withLockedValue({ $0[id] }) else { throw SshError.noSession(id) }
    return s.channel
  }

  /// Starts a command on a new channel; `started` is settled once the server has taken it.
  private func start(_ id: Int, _ command: String) throws -> (child: Channel, done: Once<ExecResult>) {
    let channel = try channel(id)
    let started = Once<Void>(on: channel.eventLoop)
    let done = Once<ExecResult>(on: channel.eventLoop)
    let opened = channel.eventLoop.makePromise(of: Channel.self)
    channel.eventLoop.execute {
      do {
        let ssh = try channel.pipeline.syncOperations.handler(type: NIOSSHHandler.self)
        ssh.createChannel(opened, channelType: .session) { child, _ in
          child.eventLoop.makeCompletedFuture {
            try child.pipeline.syncOperations.addHandler(ExecHandler(command: command, started: started, done: done))
          }
        }
      } catch {
        opened.fail(error)
      }
    }
    do {
      let child = try opened.futureResult.wait()
      try started.future.wait()
      return (child, done)
    } catch {
      started.fail(error)
      done.fail(error)
      throw ours(error)
    }
  }

  private static func send(_ child: Channel, _ bytes: [UInt8]) throws {
    var buffer = child.allocator.buffer(capacity: bytes.count)
    buffer.writeBytes(bytes)
    try child.writeAndFlush(buffer).wait()
  }

  /// Runs a command and answers with its exit code and both outputs. The input, if any, is written whole and
  /// then closed, with no clock of its own; with none, the command's input is closed at once. No clock runs on
  /// the command either: only the connection's end fails it.
  public func exec(id: Int, command: String, stdin: String?) throws -> ExecResult {
    let (child, done) = try start(id, command)
    // A command that ends without reading its stdin makes these fail; its result is still the answer.
    if let stdin { try? Self.send(child, Array(stdin.utf8)) }
    try? child.close(mode: .output).wait()
    do {
      return try done.future.wait()
    } catch {
      throw ours(error)
    }
  }

  /// Writes a file (path relative to the login user's home), then sets its mode. onProgress gets
  /// the bytes sent so far, every 256 KB and at the end. There is no SFTP in the library, so the
  /// bytes go to `cat` on the command's stdin; each write waits for the one before, which is the
  /// backpressure.
  ///
  /// Throws UploadRefused when the server's command ended with a failure code. A write that fails decides
  /// nothing by itself: when the server's command dies it closes the channel under the next write, so a refusal
  /// and a cut look the same at that moment. The command's end decides: an exit code is the server's answer, and
  /// none is the connection going.
  public func upload(id: Int, remotePath: String, read: ChunkSource, mode: Int, onProgress: (Int) -> Void = { _ in }) throws {
    let path = Self.quoted(remotePath)
    var command = "cat > \(path) && chmod \(String(mode, radix: 8)) -- \(path)"
    if let slash = remotePath.lastIndex(of: "/"), slash != remotePath.startIndex {
      command = "mkdir -p -- \(Self.quoted(String(remotePath[..<slash]))) && " + command
    }
    let (child, done) = try start(id, command)
    var sent = 0
    var reported = -1
    var writeFailed = false
    while true {
      let chunk: [UInt8]
      do {
        chunk = try read(Self.chunkSize)
      } catch {
        // The file could not be read: the channel is closed without an end of input, so the command is not
        // told the file was whole.
        child.close(promise: nil)
        throw SshError.failed("reading the file to upload failed: \(error)")
      }
      if chunk.isEmpty { break }
      do {
        try Self.send(child, chunk)
      } catch {
        writeFailed = true
        break
      }
      sent += chunk.count
      if sent - reported >= Self.progressStep {
        reported = sent
        onProgress(sent)
      }
    }
    try? child.close(mode: .output).wait()
    let r: ExecResult
    do {
      r = try done.future.wait()
    } catch {
      child.close(promise: nil)
      throw ours(error)
    }
    guard r.code == 0 else {
      let words = r.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
      throw UploadRefused(code: r.code, words: words.isEmpty ? "the upload's command ended with exit code \(r.code)" : words)
    }
    // The command says it is done, but not every byte was taken: not the server's refusal.
    if writeFailed { throw SshError.connectionLost }
    if sent != reported { onProgress(sent) }
  }

  private static let chunkSize = 32 * 1024
  private static let progressStep = 256 * 1024

  private static func quoted(_ s: String) -> String {
    "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }

  /// Closes the connection. Every call still waiting on it fails as a connection that went.
  public func close(id: Int) {
    guard let s = sessions.withLockedValue({ $0.removeValue(forKey: id) }) else { return }
    s.keepAlive.cancel()
    try? s.channel.close().wait()
  }

  /// Every connection, when the module is torn down.
  public func closeAll() {
    for id in sessions.withLockedValue({ Array($0.keys) }) { close(id: id) }
  }
}

/// An upload's bytes from memory.
public func chunks(of data: [UInt8]) -> ChunkSource {
  var at = 0
  return { max in
    let end = min(data.count, at + max)
    defer { at = end }
    return Array(data[at..<end])
  }
}

/// An upload's bytes from a file (the bundled cardd), read as it goes.
public func chunks(ofFile handle: FileHandle) -> ChunkSource {
  { max in
    guard let d = try handle.read(upToCount: max) else { return [] }
    return Array(d)
  }
}
