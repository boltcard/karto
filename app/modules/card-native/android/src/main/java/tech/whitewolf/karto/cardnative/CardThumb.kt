package tech.whitewolf.karto.cardnative

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import expo.modules.kotlin.exception.CodedException
import java.io.ByteArrayOutputStream
import kotlin.math.hypot
import kotlin.math.max

class PhotoTooBigException : CodedException("ERR_PHOTO_TOO_BIG", "the photo is over 64 KB at quality 60", null)
class CaptureException(message: String) : CodedException("ERR_CAPTURE", message, null)
class CameraClosedException : CodedException("ERR_CAMERA_CLOSED", "the camera closed before the photo was taken", null)

/**
 * The card's thumbnail: the card
 * cut out along its four corners, straightened to 428×270 and saved as a
 * JPEG. Bitmap.compress writes no EXIF at all.
 */
object CardThumb {
  const val WIDTH = 428
  const val HEIGHT = 270
  /** cardd's limit (server/internal/cards MaxPhotoBytes). */
  const val MAX_BYTES = 64 * 1024
  private val QUALITIES = listOf(80, 60)

  /** The JPEG of the card at corners q (pixels of the upright picture src). */
  fun make(src: Bitmap, q: Quad): ByteArray {
    // A card much wider than the thumbnail is drawn at twice its size first, then scaled
    // down with filtering, so its detail doesn't break up.
    val across = max(hypot(q.tr.x - q.tl.x, q.tr.y - q.tl.y), hypot(q.br.x - q.bl.x, q.br.y - q.bl.y))
    val twice = across > 2 * WIDTH
    val w = if (twice) 2 * WIDTH else WIDTH
    val h = if (twice) 2 * HEIGHT else HEIGHT
    val drawn = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val m = Matrix()
    val from = q.corners.flatMap { listOf(it.x.toFloat(), it.y.toFloat()) }.toFloatArray()
    val to = floatArrayOf(0f, 0f, w.toFloat(), 0f, w.toFloat(), h.toFloat(), 0f, h.toFloat())
    if (!m.setPolyToPoly(from, 0, to, 0, 4)) throw CaptureException("the card's corners can't be straightened")
    Canvas(drawn).drawBitmap(src, m, Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
    val thumb = if (twice) Bitmap.createScaledBitmap(drawn, WIDTH, HEIGHT, true).also { drawn.recycle() } else drawn
    try {
      for (quality in QUALITIES) {
        val out = ByteArrayOutputStream()
        thumb.compress(Bitmap.CompressFormat.JPEG, quality, out)
        if (out.size() <= MAX_BYTES) return out.toByteArray()
      }
    } finally {
      thumb.recycle()
    }
    throw PhotoTooBigException()
  }

  /** cardThumbnail (the photo probe's): a JPEG decoded as stored, no EXIF orientation applied, corners as fractions of it. */
  fun fromJpeg(jpeg: ByteArray, corners: List<Double>): ByteArray {
    val src = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: throw CaptureException("not a picture Android can decode")
    try {
      return make(src, Quad.ofFractions(corners, src.width, src.height))
    } finally {
      src.recycle()
    }
  }
}
