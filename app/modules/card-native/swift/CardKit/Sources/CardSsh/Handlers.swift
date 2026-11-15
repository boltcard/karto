import NIOConcurrencyHelpers
import NIOCore
import NIOSSH

/// A result that several parties may try to settle (a handler, a delegate, a timeout): the first wins.
final class Once<Value>: @unchecked Sendable {
  private let promise: EventLoopPromise<Value>
  private let settled = NIOLockedValueBox(false)

  init(on loop: EventLoop) {
    self.promise = loop.makePromise(of: Value.self)
  }

  // One nobody settled (the TCP connect itself failed, say) must not be left hanging: NIO treats
  // a dropped, unsettled promise as a bug.
  deinit {
    fail(SshError.connectionLost)
  }

  var future: EventLoopFuture<Value> { promise.futureResult }

  private func first() -> Bool {
    settled.withLockedValue { done in
      if done { return false }
      done = true
      return true
    }
  }

  func succeed(_ value: Value) {
    if first() { promise.succeed(value) }
  }

  func fail(_ error: Error) {
    if first() { promise.fail(error) }
  }
}

struct ScanFinished: Error {}
struct HostKeyRejected: Error {}

/// Notes the host key the server presents. With a pin, only that key passes; without one (a scan)
/// nothing passes, so the connection ends before any login.
final class HostKeyCheck: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
  private let pin: (type: String, blob: String)?
  private let box = NIOLockedValueBox<(type: String, blob: String)?>(nil)

  init(pin: (type: String, blob: String)?) {
    self.pin = pin
  }

  var seen: (type: String, blob: String)? { box.withLockedValue { $0 } }

  func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
    let actual = KeyEncoding.sshKeyTypeAndBlob(hostKey)
    box.withLockedValue { $0 = actual }
    guard let pin else { return validationCompletePromise.fail(ScanFinished()) }
    if pin.type == actual.type && pin.blob == actual.blob {
      validationCompletePromise.succeed(())
    } else {
      validationCompletePromise.fail(HostKeyRejected())
    }
  }
}

/// Offers the phrase's key once, and lets go of it as it does: nothing here holds it for the connection's
/// life. The library has no "refused" error: being asked a second time is the refusal, and what the connection
/// does after a nil answer is its own business, so the refusal is told to the caller here.
final class SeedKeyAuth: NIOSSHClientUserAuthenticationDelegate, @unchecked Sendable {
  private let user: String
  private let onRefused: @Sendable () -> Void
  private let state: NIOLockedValueBox<(key: NIOSSHPrivateKey?, refused: Bool)>

  init(user: String, key: NIOSSHPrivateKey?, onRefused: @escaping @Sendable () -> Void) {
    self.user = user
    self.state = NIOLockedValueBox((key, false))
    self.onRefused = onRefused
  }

  var refused: Bool { state.withLockedValue { $0.refused } }
  var holdsKey: Bool { state.withLockedValue { $0.key != nil } }

  func nextAuthenticationType(
    availableMethods: NIOSSHAvailableUserAuthenticationMethods,
    nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>
  ) {
    let key: NIOSSHPrivateKey? = state.withLockedValue { s in
      guard let key = s.key, availableMethods.contains(.publicKey) else {
        s.refused = true
        return nil
      }
      s.key = nil
      return key
    }
    guard let key else {
      nextChallengePromise.succeed(nil)
      onRefused()
      return
    }
    nextChallengePromise.succeed(.init(username: user, serviceName: "", offer: .privateKey(.init(privateKey: key))))
  }
}

/// Sits between the idle timer and the SSH handler: no bytes from the peer for the whole read
/// timeout closes the connection, which fails everything waiting on it.
final class IdleCloser: ChannelInboundHandler {
  typealias InboundIn = ByteBuffer
  typealias InboundOut = ByteBuffer

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if let idle = event as? IdleStateHandler.IdleStateEvent, idle == .read {
      context.fireErrorCaught(SshError.peerSilent)
      context.close(promise: nil)
      return
    }
    context.fireUserInboundEventTriggered(event)
  }
}

/// After the SSH handler on the connection: reports the login, and the first error or the close.
final class ConnectionEvents: ChannelInboundHandler {
  typealias InboundIn = Any

  private let ready: Once<Void>

  init(ready: Once<Void>) {
    self.ready = ready
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if event is UserAuthSuccessEvent { ready.succeed(()) }
    context.fireUserInboundEventTriggered(event)
  }

  func errorCaught(context: ChannelHandlerContext, error: Error) {
    ready.fail(error)
    context.close(promise: nil)
  }

  func channelInactive(context: ChannelHandlerContext) {
    ready.fail(SshError.connectionLost)
    context.fireChannelInactive()
  }
}

/// One command on its own SSH channel: collects stdout and stderr as they come (so neither can
/// fill up and stall the command) and the exit status.
final class ExecHandler: ChannelDuplexHandler {
  typealias InboundIn = SSHChannelData
  typealias OutboundIn = ByteBuffer
  typealias OutboundOut = SSHChannelData

  private let command: String
  private let started: Once<Void>
  private let done: Once<ExecResult>
  private var stdout = ByteBuffer()
  private var stderr = ByteBuffer()
  private var exitStatus: Int?
  /// The name of the signal that ended the command, as the server sends it.
  private var exitSignal: String?
  private var ended = false

  init(command: String, started: Once<Void>, done: Once<ExecResult>) {
    self.command = command
    self.started = started
    self.done = done
  }

  func handlerAdded(context: ChannelHandlerContext) {
    context.channel.setOption(ChannelOptions.allowRemoteHalfClosure, value: true).whenFailure { [started, done] e in
      started.fail(e)
      done.fail(e)
    }
  }

  func channelActive(context: ChannelHandlerContext) {
    let request = SSHChannelRequestEvent.ExecRequest(command: command, wantReply: true)
    context.triggerUserOutboundEvent(request).whenFailure { [started, done] e in
      started.fail(e)
      done.fail(e)
    }
    context.fireChannelActive()
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    switch event {
    case is ChannelSuccessEvent:
      started.succeed(())
    case is ChannelFailureEvent:
      started.fail(SshError.execRefused)
      done.fail(SshError.execRefused)
    case let status as SSHChannelRequestEvent.ExitStatus:
      exitStatus = status.exitStatus
    case let signal as SSHChannelRequestEvent.ExitSignal:
      exitSignal = signal.signalName
      ended = true
    case let e as ChannelEvent where e == .inputClosed:
      ended = true
    default:
      context.fireUserInboundEventTriggered(event)
    }
  }

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    let message = unwrapInboundIn(data)
    guard case .byteBuffer(var bytes) = message.data else { return }
    switch message.type {
    case .channel: stdout.writeBuffer(&bytes)
    case .stdErr: stderr.writeBuffer(&bytes)
    default: break
    }
  }

  func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
    let bytes = unwrapOutboundIn(data)
    context.write(wrapOutboundOut(SSHChannelData(type: .channel, data: .byteBuffer(bytes))), promise: promise)
  }

  func errorCaught(context: ChannelHandlerContext, error: Error) {
    started.fail(error)
    done.fail(error)
    context.close(promise: nil)
  }

  // The server ends a command with EOF, its exit status (or the signal that ended it), then the close. A
  // channel that goes away with none of those was cut off: the connection dropped. An exit code is never made
  // up: a signal ExitSignals has no number for, and an end with neither code nor signal, are failures.
  func channelInactive(context: ChannelHandlerContext) {
    let code: Int?
    let failure: SshError
    if let exitStatus {
      (code, failure) = (exitStatus, .noExitCode)
    } else if let exitSignal {
      (code, failure) = (ExitSignals.code(exitSignal), .killed(exitSignal))
    } else {
      (code, failure) = (nil, ended ? .noExitCode : .connectionLost)
    }
    if let code {
      started.succeed(())
      done.succeed(
        ExecResult(
          code: code,
          stdout: String(decoding: stdout.readableBytesView, as: UTF8.self),
          stderr: String(decoding: stderr.readableBytesView, as: UTF8.self)
        )
      )
    } else {
      started.fail(failure)
      done.fail(failure)
    }
    context.fireChannelInactive()
  }
}
