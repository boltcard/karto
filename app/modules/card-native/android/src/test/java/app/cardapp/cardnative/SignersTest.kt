package app.cardapp.cardnative

import org.junit.Assert.assertEquals
import org.junit.Test

// Whether two apps are signed by the same key now (deploy/signing/README.md): Karto Wallet asks it of Karto PoS
// before handing over a pairing code. Android's own checkSignatures would not do: from Android 11 it falls back to
// the oldest certificate of a signing history, and our apps' histories start from a key everyone has.
class SignersTest {
  private val ours = byteArrayOf(1, 2, 3)
  private val theirs = byteArrayOf(4, 5, 6)
  private val second = byteArrayOf(7, 8, 9)

  @Test
  fun theSameCertificatesAreTheSameSigner() {
    assertEquals("same", Signers.compare(listOf(ours), listOf(ours.copyOf())))
    assertEquals("same", Signers.compare(listOf(ours, second), listOf(second, ours)))
  }

  // Two apps whose histories both start from the debug key are signed, now, by different keys: only the signers
  // they have now are given here, and those differ.
  @Test
  fun differentSignersAreNotTheSameWhateverTheyOnceShared() {
    assertEquals("other", Signers.compare(listOf(ours), listOf(theirs)))
  }

  @Test
  fun oneSignerOfTwoIsNotTheSame() {
    assertEquals("other", Signers.compare(listOf(ours), listOf(ours, second)))
    assertEquals("other", Signers.compare(listOf(ours, second), listOf(ours)))
  }

  @Test
  fun noSignersAtAllAreNeverTheSame() {
    assertEquals("other", Signers.compare(emptyList(), emptyList()))
    assertEquals("other", Signers.compare(listOf(ours), emptyList()))
    assertEquals("other", Signers.compare(emptyList(), listOf(ours)))
  }
}
