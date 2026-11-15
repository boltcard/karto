package app.cardapp.cardnative

import java.io.File
import java.math.BigInteger
import java.security.MessageDigest
import java.security.Security
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyEncodingTest {
  // testvectors/vectors.json, read as text to avoid a JSON dependency.
  private val vectors = File(System.getProperty("user.dir"), "../../../../testvectors/vectors.json").readText()
  private fun field(name: String) = Regex("\"$name\": \"([^\"]+)\"").find(vectors)!!.groupValues[1]

  @Test
  fun ed25519KeyFromSeedMatchesThePhraseVector() {
    val pair = KeyEncoding.ed25519KeyPair(KeyEncoding.unhex(field("sshEd25519Seed")))
    val (type, blob) = KeyEncoding.sshKeyTypeAndBlob(pair.public)
    assertEquals(field("sshAuthorizedKey"), "$type $blob")
  }

  // Android puts its Keystore workaround provider ahead of "BC" so Keystore keys never reach
  // BouncyCastle; the full BC must not jump that queue (expo-secure-store uses unqualified lookups).
  @Test
  fun bouncyCastleIsRegisteredWithoutTakingOverUnqualifiedLookups() {
    KeyEncoding.installBouncyCastle()
    assertTrue(Security.getProvider("BC") is BouncyCastleProvider)
    assertNotEquals("BC", MessageDigest.getInstance("SHA-256").provider.name)
    assertEquals("BC", Security.getProviders().last().name)
  }

  @Test
  fun uncompressedPointRoundTripsTheDeviceAuthVector() {
    val pub = KeyEncoding.unhex(field("publicKey"))
    val x = BigInteger(1, pub.copyOfRange(1, 33))
    val y = BigInteger(1, pub.copyOfRange(33, 65))
    assertArrayEquals(pub, KeyEncoding.uncompressedPoint(x, y))
  }

  @Test
  fun uncompressedPointPadsShortCoordinates() {
    val p = KeyEncoding.uncompressedPoint(BigInteger.ONE, BigInteger.valueOf(256))
    assertEquals(65, p.size)
    assertEquals("04" + "00".repeat(31) + "01" + "00".repeat(30) + "0100", KeyEncoding.hex(p))
  }

  @Test(expected = IllegalArgumentException::class)
  fun unhexRejectsGarbage() {
    KeyEncoding.unhex("zz")
  }
}
