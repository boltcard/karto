package tech.whitewolf.karto.cardnative

import android.nfc.NfcAdapter
import org.junit.Assert.assertEquals
import org.junit.Test

// Reader mode's flags (CardNativeModule.enableReader): NFC-A only, Android's NDEF check skipped, and, while the
// claim in front drops its taps, Android's tag sound off (src/cards/nfcSlot.ts), so a card the app closes unread
// doesn't beep as though it had been taken.
class ReaderFlagsTest {
  @Test
  fun readsWithAndroidsTagSound() {
    assertEquals(NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK, ReaderFlags.of(quiet = false))
  }

  @Test
  fun dropsTapsWithoutIt() {
    assertEquals(
      NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS,
      ReaderFlags.of(quiet = true),
    )
  }
}
