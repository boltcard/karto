package tech.whitewolf.karto.cardnative

import java.io.FilterInputStream
import java.io.InputStream
import java.security.PublicKey
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.keepalive.KeepAliveProvider
import net.schmizz.keepalive.KeepAliveRunner
import net.schmizz.sshj.sftp.SFTPException
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.UserAuthException
import net.schmizz.sshj.userauth.keyprovider.KeyPairWrapper
import net.schmizz.sshj.xfer.InMemorySourceFile

class HostKeyMismatch(message: String) : Exception(message)

/** The server refused the phrase's SSH key. */
class SshAuthFailed(message: String, cause: Throwable) : Exception(message, cause)

/**
 * The server's file service refused an upload (no space, no permission): its own answer, with its words, not a
 * lost connection.
 */
class UploadRefused(message: String, cause: Throwable) : Exception(message, cause)

data class ExecResult(val code: Int, val stdout: String, val stderr: String)

/**
 * SSH sessions for onboarding (src/onboarding/ssh.ts). The only host key
 * accepted is the one LNVPS published, and only ssh-ed25519 is offered, so a
 * server can't negotiate a key type we have no pin for.
 */
class SshSessions {
  companion object {
    // No status at all (a transport error chained into SFTPException), the two that are no error, a garbled
    // message, and the two that speak of the connection (one is misspelt in sshj; both spellings are here).
    private val NOT_REFUSALS = setOf("UNKNOWN", "OK", "EOF", "BAD_MESSAGE", "NO_CONNECTION", "CONNECITON_LOST", "CONNECTION_LOST")

    /** Whether an SFTP status, by sshj's name for it, is the server refusing the file (no space, no permission, no such folder). */
    fun isRefusal(status: String): Boolean = status !in NOT_REFUSALS
  }

  init {
    KeyEncoding.installBouncyCastle()
  }

  private val sessions = ConcurrentHashMap<Int, SSHClient>()
  private val nextId = AtomicInteger(1)

  /**
   * The server's ssh-ed25519 host key (type, base64 blob), read during key exchange without
   * logging in: trust on first use, until LNVPS publishes the key to verify it against.
   */
  fun scanHostKey(host: String, port: Int, timeoutMs: Int = 15_000): Pair<String, String> {
    val config = DefaultConfig()
    config.keyAlgorithms = config.keyAlgorithms.filter { it.name == "ssh-ed25519" }
    val client = SSHClient(config)
    var seen: Pair<String, String>? = null
    client.addHostKeyVerifier(object : HostKeyVerifier {
      override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
        seen = KeyEncoding.sshKeyTypeAndBlob(key)
        return true
      }
      override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = listOf("ssh-ed25519")
    })
    client.connectTimeout = timeoutMs
    client.timeout = timeoutMs
    try {
      client.connect(host, port)
    } finally {
      client.close()
    }
    return seen ?: throw IllegalStateException("the server at $host:$port presented no host key")
  }

  fun connect(host: String, port: Int, user: String, hostKeyType: String, hostKeyBlob: String, seedHex: String, timeoutMs: Int = 15_000, keepAliveSec: Int = 15): Int {
    val config = DefaultConfig()
    config.keyAlgorithms = config.keyAlgorithms.filter { it.name == hostKeyType }
    require(config.keyAlgorithms.isNotEmpty()) { "unsupported host key type $hostKeyType" }
    config.keepAliveProvider = KeepAliveProvider.KEEP_ALIVE
    val client = SSHClient(config)
    var seen: Pair<String, String>? = null
    client.addHostKeyVerifier(object : HostKeyVerifier {
      override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
        val actual = KeyEncoding.sshKeyTypeAndBlob(key)
        seen = actual
        return actual.first == hostKeyType && actual.second == hostKeyBlob
      }
      override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = listOf(hostKeyType)
    })
    client.connectTimeout = timeoutMs
    // A peer that goes silent (frozen VM, a NAT that forgot us) sends no RST: keepalives notice it
    // within about 4 x keepAliveSec and kill the transport, so every pending read fails. sshd answers
    // them while a command prints nothing, so a long quiet install step is unaffected.
    (client.connection.keepAlive as KeepAliveRunner).maxAliveCount = 4
    // Set before connect: sshj starts the keepalive thread in onConnect, and only sends once authenticated.
    client.connection.keepAlive.keepAliveInterval = keepAliveSec
    try {
      client.connect(host, port)
    } catch (e: Exception) {
      client.close()
      val s = seen
      if (s != null && (s.first != hostKeyType || s.second != hostKeyBlob)) {
        throw HostKeyMismatch("server presented ${s.first} ${s.second}, expected $hostKeyType $hostKeyBlob")
      }
      throw e
    }
    try {
      client.authPublickey(user, KeyPairWrapper(KeyEncoding.ed25519KeyPair(KeyEncoding.unhex(seedHex))))
    } catch (e: Exception) {
      client.close()
      if (e is UserAuthException) throw SshAuthFailed("the server refused the key for $user", e)
      throw e
    }
    val id = nextId.getAndIncrement()
    sessions[id] = client
    return id
  }

  private fun client(id: Int) = sessions[id] ?: throw IllegalStateException("no SSH session $id")

  fun exec(id: Int, command: String, stdin: String?): ExecResult {
    client(id).startSession().use { session ->
      val cmd = session.exec(command)
      cmd.outputStream.use { out -> if (stdin != null) out.write(stdin.toByteArray(Charsets.UTF_8)) }
      // Read stderr alongside stdout so neither pipe can fill up and stall the command. A dropped
      // connection fails both reads; the helper's failure is handed back here, since an uncaught
      // exception on any thread kills an Android app.
      var stderr = ""
      var errFailure: Throwable? = null
      val errReader = Thread {
        try {
          stderr = cmd.errorStream.readBytes().toString(Charsets.UTF_8)
        } catch (e: Throwable) {
          errFailure = e
        }
      }.apply { isDaemon = true; start() }
      val stdout = try {
        cmd.inputStream.readBytes().toString(Charsets.UTF_8)
      } finally {
        errReader.join()
      }
      errFailure?.let { throw it }
      cmd.join(10, TimeUnit.MINUTES)
      return ExecResult(cmd.exitStatus ?: -1, stdout, stderr)
    }
  }

  /**
   * Writes a file (path relative to the login user's home), then sets its mode. onProgress gets the
   * bytes sent so far, every [PROGRESS_STEP] bytes and at the end. Throws [UploadRefused] when the
   * server's file service refuses it.
   */
  fun upload(id: Int, remotePath: String, length: Long, open: () -> InputStream, mode: Int, onProgress: (Long) -> Unit = {}) {
    try {
      client(id).newSFTPClient().use { sftp ->
        val dir = remotePath.substringBeforeLast('/', "")
        if (dir.isNotEmpty()) sftp.mkdirs(dir)
        sftp.put(object : InMemorySourceFile() {
          override fun getName() = remotePath.substringAfterLast('/')
          override fun getLength() = length
          override fun getInputStream(): InputStream = CountingInputStream(open(), onProgress)
        }, remotePath)
        sftp.chmod(remotePath, mode)
      }
    } catch (e: SFTPException) {
      // sshj throws this one class for the server's refusal and for a connection lost under the transfer:
      // only a status of the server's own makes it a refusal. Anything else goes on as it came, a drop.
      if (!isRefusal(e.statusCode.name)) throw e
      throw UploadRefused(e.message ?: e.statusCode.name, e)
    }
  }

  fun close(id: Int) {
    sessions.remove(id)?.close()
  }
}

private const val PROGRESS_STEP = 256 * 1024L

/** Reports the bytes read so far: every PROGRESS_STEP bytes, and once at the end of the stream. */
private class CountingInputStream(source: InputStream, private val onProgress: (Long) -> Unit) : FilterInputStream(source) {
  private var count = 0L
  private var reported = -1L

  private fun advance(n: Long) {
    if (n > 0) count += n
    if (n < 0 || count - reported >= PROGRESS_STEP) report()
  }

  private fun report() {
    if (count == reported) return
    reported = count
    onProgress(count)
  }

  override fun read(): Int = super.read().also { advance(if (it < 0) -1 else 1) }
  override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { advance(it.toLong()) }
  override fun skip(n: Long): Long = super.skip(n).also { advance(it) }
  override fun markSupported() = false
}
