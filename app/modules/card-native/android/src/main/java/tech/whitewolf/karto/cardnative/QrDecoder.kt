package tech.whitewolf.karto.cardnative

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.nio.ByteBuffer

/** Reads a QR code from a camera frame's luminance (Y) plane, with ZXing. */
object QrDecoder {
  private val hints = mapOf(DecodeHintType.TRY_HARDER to true, DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE))

  /** The plane's rows without their padding (a camera's rowStride may be wider than the frame). */
  fun luma(plane: ByteBuffer, rowStride: Int, width: Int, height: Int): ByteArray {
    val out = ByteArray(width * height)
    val buf = plane.duplicate()
    for (row in 0 until height) {
      buf.position(row * rowStride)
      buf.get(out, row * width, width)
    }
    return out
  }

  /** The text of the QR code in this frame, or null if none can be read. */
  fun decode(luma: ByteArray, width: Int, height: Int): String? {
    val source = PlanarYUVLuminanceSource(luma, width, height, 0, 0, width, height, false)
    return try {
      QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), hints).text
    } catch (e: ReaderException) {
      null
    }
  }
}
