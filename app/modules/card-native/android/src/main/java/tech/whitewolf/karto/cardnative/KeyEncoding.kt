package tech.whitewolf.karto.cardnative

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPair
import java.security.PublicKey
import java.security.Security
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.jce.provider.BouncyCastleProvider

/** Pure key-format helpers, kept apart from Android so JVM unit tests can cover them. */
object KeyEncoding {
  /**
   * Android ships a cut-down provider named "BC" without Ed25519; replace it
   * with the full BouncyCastle so sshj and ed25519KeyPair work. Idempotent.
   * Both ask for "BC" by name, so it goes last: unqualified lookups keep their
   * usual providers, and Keystore keys never reach BouncyCastle.
   */
  @Synchronized
  fun installBouncyCastle() {
    if (Security.getProvider("BC") is BouncyCastleProvider) return
    Security.removeProvider("BC")
    Security.addProvider(BouncyCastleProvider())
  }

  fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

  fun unhex(s: String): ByteArray {
    require(s.length % 2 == 0 && s.all { it in "0123456789abcdefABCDEF" }) { "not hex" }
    return ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }
  }

  /** P-256 point as cardd wants it: 0x04 || X || Y, each coordinate left-padded to 32 bytes. */
  fun uncompressedPoint(x: BigInteger, y: BigInteger): ByteArray {
    fun fixed(v: BigInteger): ByteArray {
      val b = v.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
      require(b.size <= 32) { "coordinate too large" }
      return ByteArray(32 - b.size) + b
    }
    return byteArrayOf(4) + fixed(x) + fixed(y)
  }

  private val ED25519_PKCS8_PREFIX = unhex("302e020100300506032b657004220420")
  private val ED25519_X509_PREFIX = unhex("302a300506032b6570032100")

  /** The phrase-derived SSH key (keys.sshEd25519Seed) as a JCA key pair, via BouncyCastle. */
  fun ed25519KeyPair(seed: ByteArray): KeyPair {
    require(seed.size == 32) { "Ed25519 seed must be 32 bytes" }
    installBouncyCastle()
    val pub = Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded
    val kf = KeyFactory.getInstance("Ed25519", "BC")
    return KeyPair(
      kf.generatePublic(X509EncodedKeySpec(ED25519_X509_PREFIX + pub)),
      kf.generatePrivate(PKCS8EncodedKeySpec(ED25519_PKCS8_PREFIX + seed)),
    )
  }

  /** "ssh-ed25519" and the base64 blob, exactly as LNVPS's host_ssh_keys and known_hosts show them. */
  fun sshKeyTypeAndBlob(key: PublicKey): Pair<String, String> =
    KeyType.fromKey(key).toString() to Base64.getEncoder().encodeToString(Buffer.PlainBuffer().putPublicKey(key).compactData)
}
