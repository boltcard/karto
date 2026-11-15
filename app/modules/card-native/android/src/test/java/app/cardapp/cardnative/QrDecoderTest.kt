package app.cardapp.cardnative

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import java.nio.ByteBuffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QrDecoderTest {
  private val invoice =
    "LNBC1PVJLUEZSP5ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYG3ZYGSPP5QQQSYQCYQ5RQWZQFQQQSYQCYQ5RQWZQFQQQSYQCYQ5RQWZQFQYPQ"

  /** A frame's Y plane holding a QR code of text, as a camera would deliver it: rowStride bytes per row. */
  private fun frame(text: String, size: Int, rowStride: Int): ByteBuffer {
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 4))
    val buf = ByteBuffer.allocate(rowStride * (size - 1) + size)
    for (y in 0 until size) for (x in 0 until size) buf.put(y * rowStride + x, if (m[x, y]) 0 else 255.toByte())
    return buf
  }

  @Test
  fun readsAQrCodeFromALumaPlane() {
    val luma = QrDecoder.luma(frame(invoice, 400, 400), 400, 400, 400)
    assertEquals(invoice, QrDecoder.decode(luma, 400, 400))
  }

  @Test
  fun dropsTheRowPaddingOfAWiderStride() {
    val luma = QrDecoder.luma(frame(invoice, 400, 448), 448, 400, 400)
    assertEquals(400 * 400, luma.size)
    assertEquals(invoice, QrDecoder.decode(luma, 400, 400))
  }

  @Test
  fun aFrameWithoutACodeReadsAsNothing() {
    val blank = ByteArray(400 * 400) { 200.toByte() }
    assertNull(QrDecoder.decode(blank, 400, 400))
  }
}
