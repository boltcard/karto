package tech.whitewolf.karto.cardnative

import java.io.IOException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NfcTagsTest {
  private class FakeTag(val answer: ByteArray = byteArrayOf(0x91.toByte(), 0x00)) : TagConnection {
    var lost = false
    var closed = false
    val sent = mutableListOf<String>()
    override fun transceive(apdu: ByteArray): ByteArray {
      if (lost) throw IOException("Tag was lost.") // android.nfc.TagLostException is an IOException
      sent += apdu.toHex()
      return answer
    }
    override fun close() {
      closed = true
    }
  }

  @Test
  fun passesCommandsToTheTagItsHandleNames() {
    val tags = NfcTags()
    val a = FakeTag()
    val b = FakeTag(byteArrayOf(0x90.toByte(), 0x00))
    val ha = tags.add(a)
    val hb = tags.add(b)
    assertNotEquals(ha, hb)
    assertArrayEquals(byteArrayOf(0x90.toByte(), 0x00), tags.transceive(hb, "00a4".hexToBytes()))
    assertEquals(listOf("00a4"), b.sent)
    assertTrue(a.sent.isEmpty())
  }

  @Test
  fun aLostTagIsTagGoneAndItsHandleIsClosed() {
    val tags = NfcTags()
    val tag = FakeTag()
    val h = tags.add(tag)
    tag.lost = true
    assertThrows(TagGone::class.java) { tags.transceive(h, byteArrayOf(0)) }
    assertTrue(tag.closed)
    tag.lost = false
    assertThrows(TagGone::class.java) { tags.transceive(h, byteArrayOf(0)) }
  }

  @Test
  fun closeAllClosesEveryTagAndHandlesAreNeverReused() {
    val tags = NfcTags()
    val first = FakeTag()
    val h1 = tags.add(first)
    tags.closeAll()
    assertTrue(first.closed)
    assertThrows(TagGone::class.java) { tags.transceive(h1, byteArrayOf(0)) }
    assertNotEquals(h1, tags.add(FakeTag()))
  }

  @Test
  fun hexRoundTrips() {
    assertEquals("00a4ff", "00A4FF".hexToBytes().toHex())
  }
}
