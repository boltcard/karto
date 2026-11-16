package tech.whitewolf.karto.cardnative

import org.junit.Assert.assertEquals
import org.junit.Test

// The answers of a phone that is a card. The app's own tests
// read a stand-in with these rules (app/src/testing/phoneCardTag.ts and its test): the two must give the same
// answers to the same commands.
class PhoneCardTagTest {
  private val selectApp = "00a4040007d276000085010100"
  private val selectCc = "00a4000c02e103"
  private val selectNdef = "00a4000c02e104"

  /** An NDEF file of 2 bytes of message: NLEN, then i twice. */
  private fun file(i: Int) = byteArrayOf(0x00, 0x02, i.toByte(), i.toByte())

  private fun tag(n: Int = 3) = PhoneCardTag().apply { load((1..n).map { file(it) }) }

  private fun PhoneCardTag.send(hex: String) = answer(hex.hexToBytes()).toHex()

  @Test
  fun answersAsATypeFourTagTheApplicationItsCapabilityFileAndItsNdefFile() {
    val t = tag()
    assertEquals("9000", t.send(selectApp))
    assertEquals("9000", t.send(selectCc))
    // CCLEN 15, mapping 2.0, MLe 255, MLc 52; the NDEF file E104, up to 256 bytes, read free, never written.
    assertEquals("000f2000ff00340406e104010000ff9000", t.send("00b000000f"))
    assertEquals("9000", t.send(selectNdef))
    assertEquals("00029000", t.send("00b0000002"))
    assertEquals("01019000", t.send("00b0000202"))
  }

  @Test
  fun takesTheSelectWithOrWithoutItsLastByteAndAnyP2ForAFile() {
    val t = tag()
    assertEquals("9000", t.send("00a4040007d2760000850101"))
    assertEquals("9000", t.send("00a4000002e10400"))
    assertEquals("9000", t.send("00a4000c02e103"))
  }

  @Test
  fun handsOutTheNextFileAtEachSelectOfTheNdefFileAndCountsThem() {
    val t = tag(3)
    val told = mutableListOf<Pair<Int, Int>>()
    t.onGiven = { given, left -> told += given to left }
    assertEquals(listOf(0, 3), listOf(t.given, t.left))
    t.send(selectApp)
    t.send(selectCc)
    assertEquals(emptyList<Pair<Int, Int>>(), told)
    t.send(selectNdef)
    assertEquals("01019000", t.send("00b0000202"))
    t.send(selectApp)
    t.send(selectNdef)
    assertEquals("02029000", t.send("00b0000202"))
    assertEquals(listOf(2, 1), listOf(t.given, t.left))
    assertEquals(listOf(1 to 2, 2 to 1), told)
  }

  @Test
  fun saysHowLongAgoItLastHandedOutATapForAlerts() {
    var now = 1_000L
    val t = PhoneCardTag { now }.apply { load((1..2).map { file(it) }) }
    assertEquals(null, t.sinceGivenMs())
    t.send(selectApp)
    t.send(selectCc)
    assertEquals(null, t.sinceGivenMs())
    t.send(selectNdef)
    now = 31_000L
    assertEquals(30_000L, t.sinceGivenMs())
  }

  @Test
  fun refusesTheNdefFileWhenNoneIsLeftAndThenTheApplicationToo() {
    val t = tag(1)
    t.send(selectApp)
    t.send(selectNdef)
    assertEquals("6a82", t.send(selectNdef))
    // What was selected is gone with the refusal: nothing is read twice.
    assertEquals("6986", t.send("00b0000002"))
    assertEquals("6a82", t.send(selectApp))
    assertEquals("6a82", t.send(selectCc))
    assertEquals(1, t.given)
  }

  @Test
  fun hasNothingToGiveBeforeItIsLoadedAndAfterItIsCleared() {
    assertEquals("6a82", PhoneCardTag().send(selectApp))
    val t = tag(3)
    t.send(selectApp)
    t.send(selectNdef)
    assertEquals(1, t.clear())
    assertEquals(listOf(0, 0), listOf(t.given, t.left))
    assertEquals("6986", t.send("00b0000002"))
    assertEquals("6a82", t.send(selectApp))
  }

  @Test
  fun addsFilesAfterTheOnesItHasAndALoadReplacesThemAndStartsTheCountAgain() {
    val t = tag(1)
    t.add(listOf(file(7)))
    assertEquals(2, t.left)
    t.send(selectApp)
    t.send(selectNdef)
    assertEquals("01019000", t.send("00b0000202"))
    t.send(selectNdef)
    assertEquals("07079000", t.send("00b0000202"))
    assertEquals(2, t.given)
    t.load(listOf(file(20), file(21)))
    assertEquals(listOf(0, 2), listOf(t.given, t.left))
    // The load forgot what the reader had selected.
    assertEquals("6986", t.send("00b0000002"))
    t.send(selectApp)
    t.send(selectNdef)
    assertEquals("14149000", t.send("00b0000202"))
  }

  @Test
  fun readsZerosPastTheEndOfAFileAndRefusesAReadThatBeginsPastItOrWithNoFileSelected() {
    val t = tag()
    t.send(selectApp)
    assertEquals("6986", t.send("00b0000002"))
    t.send(selectCc)
    assertEquals("00ff00009000", t.send("00b0000d04"))
    assertEquals("00009000", t.send("00b0000f02"))
    assertEquals("6b00", t.send("00b0001002"))
    // No length, or a length of 0, asks for 256 bytes.
    assertEquals(256 + 2, t.answer("00b00000".hexToBytes()).size)
    assertEquals(256 + 2, t.answer("00b0000000".hexToBytes()).size)
  }

  @Test
  fun refusesEverythingElse() {
    val t = tag()
    // A file before the application, another application, another file, a file id of one byte.
    assertEquals("6a82", t.send(selectNdef))
    assertEquals("6a82", t.send("00a4040007a000000003101000"))
    t.send(selectApp)
    assertEquals("6a82", t.send("00a4000c02e105"))
    assertEquals("6a82", t.send("00a4000c01e1"))
    // The NTAG 424's own commands: key version, file settings, version.
    assertEquals("6e00", t.send("90640000010000"))
    assertEquals("6e00", t.send("90f50000010200"))
    assertEquals("6e00", t.send("9060000000"))
    // A write, and a command too short to be one.
    assertEquals("6d00", t.send("00d6000002abcd"))
    assertEquals("6700", t.send("00"))
    assertEquals("6700", t.answer(ByteArray(0)).toHex())
  }

  @Test
  fun forgetsWhatWasSelectedWhenTheReaderGoesAndKeepsItsFiles() {
    val t = tag(2)
    t.send(selectApp)
    t.send(selectNdef)
    t.deactivated()
    assertEquals("6986", t.send("00b0000002"))
    assertEquals(listOf(1, 1), listOf(t.given, t.left))
  }
}
