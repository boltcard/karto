package app.cardapp.cardnative

import java.io.File
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Against a real OpenSSH server: deploy/test/sshd-test.sh starts one and sets
 * CARD_SSH_TEST=host:port:user:hostKeyBlob. Skipped when it isn't set.
 */
class SshSessionsTest {
  private val target = System.getenv("CARD_SSH_TEST").orEmpty().split(":")
  private val vectors = File(System.getProperty("user.dir"), "../../../../testvectors/vectors.json").readText()
  private val seed = Regex("\"sshEd25519Seed\": \"([^\"]+)\"").find(vectors)!!.groupValues[1]

  private fun connect(blob: String = target[3], seedHex: String = seed) =
    SshSessions().let { it to it.connect(target[0], target[1].toInt(), target[2], "ssh-ed25519", blob, seedHex) }

  @Test
  fun execPassesStdinAndReportsExitCodes() {
    assumeTrue(target.size == 4)
    val (ssh, id) = connect()
    val r = ssh.exec(id, "cat > stdin.txt; wc -c < stdin.txt; echo oops >&2; exit 3", "prosper short ramp\n")
    assertEquals(3, r.code)
    assertEquals("19", r.stdout.trim())
    assertEquals("oops", r.stderr.trim())
    ssh.close(id)
  }

  // install.sh system prints a lot (apt): a full stderr pipe must not stall the command.
  // 4 MB is past sshj's 2 MiB channel window, so reading the streams one after the other would hang.
  @Test(timeout = 120_000)
  fun largeOutputOnBothStreamsDoesNotHang() {
    assumeTrue(target.size == 4)
    val (ssh, id) = connect()
    val r = ssh.exec(id, "head -c 4000000 /dev/zero | tr '\\0' e >&2; head -c 4000000 /dev/zero | tr '\\0' o", null)
    assertEquals(0, r.code)
    assertEquals(4_000_000, r.stdout.length)
    assertEquals(4_000_000, r.stderr.length)
    ssh.close(id)
  }

  // A VM that freezes, or a mobile NAT that forgets the connection, sends no RST: the exec must
  // fail on the calling thread (a retryable error), not hang, and no helper thread may die with an
  // uncaught exception (on Android that kills the app).
  @Test(timeout = 60_000)
  fun aPeerThatGoesSilentFailsTheExecInsteadOfHanging() {
    assumeTrue(target.size == 4)
    val stray = mutableListOf<Throwable>()
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { _, e -> synchronized(stray) { stray += e } }
    try {
      BlackHoleProxy(target[0], target[1].toInt()).use { proxy ->
        val ssh = SshSessions()
        val id = ssh.connect("127.0.0.1", proxy.port, target[2], "ssh-ed25519", target[3], seed, keepAliveSec = 1)
        thread { Thread.sleep(1_500); proxy.silent = true }
        val e = runCatching { ssh.exec(id, "sleep 30", null) }.exceptionOrNull()
        assertTrue("exec should fail, got $e", e != null)
        ssh.close(id)
      }
      Thread.sleep(500)
      synchronized(stray) { assertTrue("uncaught: $stray", stray.isEmpty()) }
    } finally {
      Thread.setDefaultUncaughtExceptionHandler(previous)
    }
  }

  @Test
  fun uploadCreatesDirectoriesAndSetsTheMode() {
    assumeTrue(target.size == 4)
    val (ssh, id) = connect()
    val data = "#!/bin/sh\necho hello\n".toByteArray()
    ssh.upload(id, "card-app/bin/hello", data.size.toLong(), { data.inputStream() }, 0b111_101_101)
    val r = ssh.exec(id, "stat -c %a card-app/bin/hello && card-app/bin/hello", null)
    assertEquals(0, r.code)
    assertEquals("755\nhello\n", r.stdout)
    ssh.close(id)
  }

  // The 11 MB cardd upload takes over a minute on a weak network: the screen shows how far it got.
  @Test
  fun uploadReportsTheBytesSentUpToTheFullSize() {
    assumeTrue(target.size == 4)
    val (ssh, id) = connect()
    val data = ByteArray(1_000_000) { (it % 251).toByte() }
    val seen = mutableListOf<Long>()
    ssh.upload(id, "card-app/big.bin", data.size.toLong(), { data.inputStream() }, 0b110_100_100) { seen += it }
    assertTrue("reports: $seen", seen.size > 2)
    assertEquals(seen.sorted(), seen)
    assertEquals(data.size.toLong(), seen.last())
    assertEquals("1000000", ssh.exec(id, "wc -c < card-app/big.bin", null).stdout.trim())
    ssh.close(id)
  }

  // The server's own answer, not a lost connection: the app shows its words and waits nothing out.
  @Test
  fun anUploadTheServerRefusesIsUploadRefusedWithTheServersWords() {
    assumeTrue(target.size == 4)
    val (ssh, id) = connect()
    val data = ByteArray(200_000) { 7 }
    ssh.exec(id, "mkdir -p card-app/locked && chmod 500 card-app/locked", null)
    try {
      // A folder that cannot be written.
      val denied = runCatching { ssh.upload(id, "card-app/locked/x", data.size.toLong(), { data.inputStream() }, 0b110_100_100) }.exceptionOrNull()
      assertTrue("got $denied", denied is UploadRefused)
      assertEquals("Permission denied", denied!!.message)
      // A file that cannot take a byte: every write to /dev/full fails as a full disk's does.
      val full = runCatching { ssh.upload(id, "/dev/full", data.size.toLong(), { data.inputStream() }, 0b110_100_100) }.exceptionOrNull()
      assertTrue("got $full", full is UploadRefused)
      assertTrue("words: ${full!!.message}", full.message!!.isNotBlank())
      // The session is still good for the next thing.
      assertEquals("ok\n", ssh.exec(id, "echo ok", null).stdout)
    } finally {
      ssh.exec(id, "chmod 700 card-app/locked && rmdir card-app/locked", null)
      ssh.close(id)
    }
  }

  // sshj reports a connection lost under a transfer with the same class as the server's refusal: only the
  // status tells them apart. Cut both ways: the sockets closed, and a peer gone silent (the keepalive ends it).
  @Test(timeout = 120_000)
  fun aConnectionCutUnderAnUploadIsNotARefusal() {
    assumeTrue(target.size == 4)
    val stray = mutableListOf<Throwable>()
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { _, e -> synchronized(stray) { stray += e } }
    try {
      for (silent in listOf(false, true)) {
        BlackHoleProxy(target[0], target[1].toInt()).use { proxy ->
          val ssh = SshSessions()
          val id = ssh.connect("127.0.0.1", proxy.port, target[2], "ssh-ed25519", target[3], seed, keepAliveSec = 1)
          val data = ByteArray(40_000_000) { (it % 251).toByte() }
          var cut = false
          val e = runCatching {
            ssh.upload(id, "card-app/cut.bin", data.size.toLong(), { data.inputStream() }, 0b110_100_100) { sent ->
              if (!cut && sent >= 1_000_000) {
                cut = true
                if (silent) proxy.silent = true else proxy.cut()
              }
            }
          }.exceptionOrNull()
          assertTrue("the upload should fail (silent=$silent), got $e", e != null)
          assertFalse("a cut is not the server's refusal (silent=$silent): $e", e is UploadRefused)
          ssh.close(id)
        }
      }
      Thread.sleep(500)
      synchronized(stray) { assertTrue("uncaught: $stray", stray.isEmpty()) }
    } finally {
      Thread.setDefaultUncaughtExceptionHandler(previous)
    }
  }

  @Test
  fun onlyAStatusOfTheServersOwnIsARefusal() {
    for (status in listOf("NO_SUCH_FILE", "PERMISSION_DENIED", "FAILURE", "OP_UNSUPPORTED")) assertTrue(status, SshSessions.isRefusal(status))
    // No status at all (a transport error chained into the same class), and the statuses that speak of the connection.
    for (status in listOf("UNKNOWN", "OK", "EOF", "BAD_MESSAGE", "NO_CONNECTION", "CONNECITON_LOST", "CONNECTION_LOST")) assertFalse(status, SshSessions.isRefusal(status))
  }

  // The app explains this one (a new VM still installing our key, or another phrase's server).
  @Test
  fun aKeyTheServerDoesNotKnowIsSshAuthFailed() {
    assumeTrue(target.size == 4)
    val e = runCatching { connect(seedHex = "11".repeat(32)) }.exceptionOrNull()
    assertTrue("got $e", e is SshAuthFailed)
  }

  // Not a mismatch: the app only ever pins ssh-ed25519, so this is a bug, not a hostile server.
  @Test
  fun anUnsupportedHostKeyTypeIsNotReportedAsAMismatch() {
    val e = runCatching { SshSessions().connect("127.0.0.1", 1, "debian", "ssh-unknown", "AAAA", seed) }.exceptionOrNull()
    assertTrue("got $e", e is IllegalArgumentException)
  }

  // Trust on first use, until LNVPS publishes the key (about an hour after boot): read the
  // server's ed25519 host key without logging in.
  @Test
  fun readsTheServersEd25519HostKeyWithoutLoggingIn() {
    assumeTrue(target.size == 4)
    val (type, blob) = SshSessions().scanHostKey(target[0], target[1].toInt())
    assertEquals("ssh-ed25519", type)
    assertEquals(target[3], blob)
  }

  @Test
  fun scanningNothingListeningFails() {
    val free = ServerSocket(0).use { it.localPort }
    val e = runCatching { SshSessions().scanHostKey("127.0.0.1", free, timeoutMs = 2_000) }.exceptionOrNull()
    assertTrue("got $e", e != null)
  }

  @Test
  fun refusesAServerWhoseKeyIsNotThePinnedOne() {
    assumeTrue(target.size == 4)
    val wrong = "AAAAC3NzaC1lZDI1NTE5AAAAIM7OaJ/OiX8fQqSebMIWCvTHRxCAl3j+ZDKh4HZao3gE"
    val e = runCatching { connect(wrong) }.exceptionOrNull()
    assertTrue("got $e", e is HostKeyMismatch)
  }
}

/** Forwards one TCP connection; once silent, drops every byte both ways without closing anything. */
private class BlackHoleProxy(host: String, upstreamPort: Int) : AutoCloseable {
  private val server = ServerSocket(0)
  val port = server.localPort
  @Volatile var silent = false
  private val sockets = mutableListOf<Socket>()

  init {
    thread(isDaemon = true) {
      runCatching {
        val a = server.accept()
        val b = Socket(host, upstreamPort)
        synchronized(sockets) { sockets += a; sockets += b }
        pump(a, b)
        pump(b, a)
      }
    }
  }

  private fun pump(from: Socket, to: Socket) = thread(isDaemon = true) {
    runCatching {
      val buf = ByteArray(16_384)
      while (true) {
        val n = from.getInputStream().read(buf)
        if (n < 0) break
        if (!silent) to.getOutputStream().write(buf, 0, n)
      }
    }
  }

  /** Both sides' sockets closed at once, as a network that went. */
  fun cut() = synchronized(sockets) { sockets.forEach { runCatching { it.close() } } }

  override fun close() {
    server.close()
    cut()
  }
}
