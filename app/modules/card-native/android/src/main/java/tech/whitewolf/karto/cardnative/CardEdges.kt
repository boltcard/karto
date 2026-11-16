package tech.whitewolf.karto.cardnative

import java.nio.ByteBuffer
import java.util.Random
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Finding a card's four edges in a picture: each edge is looked for only in a band around the matching
 * side of the card-shaped frame, and is the outermost straight step of
 * brightness (and, given the colour, of Cb or Cr) that runs the side's length, so a magnetic stripe or a printed
 * border inside the card never wins. No Android types: the tests run on the
 * computer.
 *
 * The iPhone has this finder line for line in Swift (swift/CardKit/Sources/CardLogic/CardEdges.swift). A change
 * here is made there too, and the fixture the Swift is checked against is written again:
 * CARD_EDGES_FIXTURE=$PWD/app/modules/card-native/swift/CardKit/Tests/CardLogicTests/Fixtures make native-test
 * (CardEdgesFixtureTest.kt).
 */

/** A point in a picture's pixels. */
data class Pt(val x: Double, val y: Double)

/** A card's corners, clockwise from its top left. */
data class Quad(val tl: Pt, val tr: Pt, val br: Pt, val bl: Pt) {
  val corners: List<Pt> get() = listOf(tl, tr, br, bl)

  fun scaled(sx: Double, sy: Double) = Quad(Pt(tl.x * sx, tl.y * sy), Pt(tr.x * sx, tr.y * sy), Pt(br.x * sx, br.y * sy), Pt(bl.x * sx, bl.y * sy))

  /** As fractions of a w×h picture: x, y of each corner in turn. */
  fun fractions(w: Int, h: Int): List<Double> = corners.flatMap { listOf(it.x / w, it.y / h) }

  companion object {
    fun ofFractions(f: List<Double>, w: Int, h: Int): Quad {
      require(f.size == 8) { "a quad has 4 corners" }
      return Quad(Pt(f[0] * w, f[1] * h), Pt(f[2] * w, f[3] * h), Pt(f[4] * w, f[5] * h), Pt(f[6] * w, f[7] * h))
    }
  }
}

/** A rectangle in a picture's pixels. */
data class Box(val left: Double, val top: Double, val right: Double, val bottom: Double) {
  val width: Double get() = right - left
  val height: Double get() = bottom - top

  fun quad() = Quad(Pt(left, top), Pt(right, top), Pt(right, bottom), Pt(left, bottom))

  companion object {
    /** The card-shaped frame in a w×h picture: widthFraction of its width, centred across, its centre centreY of the way down. */
    fun frame(w: Int, h: Int, widthFraction: Double, centreY: Double): Box {
      val fw = w * widthFraction
      val fh = fw / CardEdges.CARD_RATIO
      val left = (w - fw) / 2
      val top = h * centreY - fh / 2
      return Box(left, top, left + fw, top + fh)
    }
  }
}

/** A picture's brightness, one byte a pixel, row by row. */
class Luma(val width: Int, val height: Int, val pixels: ByteArray) {
  init {
    require(pixels.size == width * height) { "${pixels.size} bytes for ${width}x$height" }
  }

  fun at(x: Int, y: Int): Int = pixels[y * width + x].toInt() and 0xff

  companion object {
    /**
     * The part of a camera Y plane inside the crop rectangle (in the plane's
     * stored pixels, right and bottom excluded), turned clockwise by rotation
     * (CameraX's rotationDegrees) so it is upright, taking every step-th pixel.
     * The plane is read with its row stride; nothing of the buffer is kept. into, when the right size, is filled
     * instead of a new array.
     */
    fun fromPlane(buf: ByteBuffer, rowStride: Int, cropLeft: Int, cropTop: Int, cropRight: Int, cropBottom: Int, rotation: Int, step: Int = 1, into: ByteArray? = null): Luma {
      val cw = (cropRight - cropLeft) / step
      val ch = (cropBottom - cropTop) / step
      val rows = Rows(buf, rowStride, cropLeft, (cw - 1) * step + 1)
      return turned(cw, ch, rotation, into) { sx, sy -> rows.at(cropTop + sy * step)[sx * step] }
    }

    /** The brightness of ARGB pixels (a decoded shot, already upright), every step-th pixel. */
    fun fromArgb(argb: IntArray, w: Int, h: Int, step: Int = 1): Luma =
      turned(w / step, h / step, 0) { sx, sy ->
        val c = argb[sy * step * w + sx * step]
        (((c shr 16 and 0xff) * 77 + (c shr 8 and 0xff) * 150 + (c and 0xff) * 29) shr 8).toByte()
      }

    internal inline fun turned(cw: Int, ch: Int, rotation: Int, into: ByteArray? = null, read: (Int, Int) -> Byte): Luma {
      require(rotation in setOf(0, 90, 180, 270)) { "rotation $rotation" }
      val sideways = rotation % 180 != 0
      val w = if (sideways) ch else cw
      val h = if (sideways) cw else ch
      val out = into?.takeIf { it.size == w * h } ?: ByteArray(w * h)
      for (sy in 0 until ch) {
        for (sx in 0 until cw) {
          // Where (sx, sy) lands once the picture is turned clockwise.
          val x: Int
          val y: Int
          when (rotation) {
            90 -> { x = ch - 1 - sy; y = sx }
            180 -> { x = cw - 1 - sx; y = ch - 1 - sy }
            270 -> { x = sy; y = cw - 1 - sx }
            else -> { x = sx; y = sy }
          }
          out[y * w + x] = read(sx, sy)
        }
      }
      return Luma(w, h, out)
    }
  }
}

/**
 * A camera plane's rows, read a stretch at a time: from byte `from` of each row, `length` bytes, one bulk copy a row
 * rather than a call a byte (the readers below take every row in turn). The buffer's own position is left alone.
 */
private class Rows(buf: ByteBuffer, private val rowStride: Int, private val from: Int, length: Int) {
  private val buf = buf.duplicate()
  private val row = ByteArray(length)
  private var at = -1

  fun at(r: Int): ByteArray {
    if (r != at) {
      buf.position(r * rowStride + from)
      buf.get(row)
      at = r
    }
    return row
  }
}

/**
 * A picture's colour as two planes the size of its brightness: Cb (blue against yellow) and Cr (red against
 * green), each already moved CardEdges.CHROMA_GAIN times as far from 128 as the camera gave it. The readers
 * apply the gain as they read, so a frame makes no copies. The finder searches each plane as it does the
 * brightness.
 */
class Chroma(val cb: Luma, val cr: Luma) {
  init {
    require(cb.width == cr.width && cb.height == cr.height) { "Cb ${cb.width}x${cb.height}, Cr ${cr.width}x${cr.height}" }
  }

  companion object {
    /** v moved CHROMA_GAIN times as far from 128, kept to 0..255. */
    fun gain(v: Int): Int = (128 + CardEdges.CHROMA_GAIN * (v - 128)).coerceIn(0, 255)

    /** From planes as the camera gives them, not yet gained (the tests, and the real frames they keep). */
    fun gained(cb: Luma, cr: Luma): Chroma = Chroma(gainedPlane(cb), gainedPlane(cr))

    private fun gainedPlane(l: Luma) = Luma(l.width, l.height, ByteArray(l.pixels.size) { gain(l.pixels[it].toInt() and 0xff).toByte() })

    /**
     * The U (Cb) and V (Cr) planes of a camera's YUV_420_888 frame inside the crop rectangle (in the Y plane's
     * pixels, right and bottom excluded), turned as Luma.fromPlane turns the Y, and gained. A chroma sample covers
     * 2×2 of the Y's pixels; each pixel takes the sample it lies in. U and V share a row stride and a pixel stride
     * (YUV_420_888 promises it; the pixel stride is 2 when they are interleaved, as on the Pixel 9a). Every step-th
     * pixel, as Luma.fromPlane's. cbInto and crInto, when the right size, are filled instead of new arrays; never the
     * same array for both.
     */
    fun fromPlanes(
      u: ByteBuffer, v: ByteBuffer, rowStride: Int, pixelStride: Int,
      cropLeft: Int, cropTop: Int, cropRight: Int, cropBottom: Int, rotation: Int, step: Int = 1,
      cbInto: ByteArray? = null, crInto: ByteArray? = null,
    ): Chroma {
      require(cbInto == null || cbInto !== crInto) { "Cb and Cr can't be read into the same array" }
      val cw = (cropRight - cropLeft) / step
      val ch = (cropBottom - cropTop) / step
      // The samples a row of the crop lies in: from the first pixel's to the last's.
      val first = cropLeft / 2
      val length = ((cropLeft + (cw - 1) * step) / 2 - first) * pixelStride + 1
      val us = Rows(u, rowStride, first * pixelStride, length)
      val vs = Rows(v, rowStride, first * pixelStride, length)
      fun sample(rows: Rows, sx: Int, sy: Int) = gain(rows.at((cropTop + sy * step) / 2)[((cropLeft + sx * step) / 2 - first) * pixelStride].toInt() and 0xff).toByte()
      return Chroma(Luma.turned(cw, ch, rotation, cbInto) { sx, sy -> sample(us, sx, sy) }, Luma.turned(cw, ch, rotation, crInto) { sx, sy -> sample(vs, sx, sy) })
    }

    /** The colour of ARGB pixels (a decoded shot, already upright), gained. */
    fun fromArgb(argb: IntArray, w: Int, h: Int): Chroma {
      val cb = ByteArray(w * h)
      val cr = ByteArray(w * h)
      for (i in 0 until w * h) {
        val c = argb[i]
        val r = c shr 16 and 0xff
        val g = c shr 8 and 0xff
        val b = c and 0xff
        cb[i] = gain(cbOf(r, g, b)).toByte()
        cr[i] = gain(crOf(r, g, b)).toByte()
      }
      return Chroma(Luma(w, h, cb), Luma(w, h, cr))
    }

    /** BT.601's full-range Cb and Cr, in whole numbers as Luma.fromArgb's brightness, kept to 0..255 (pure blue's Cb, pure red's Cr would be 256). */
    fun cbOf(r: Int, g: Int, b: Int): Int = (128 + ((-43 * r - 85 * g + 128 * b + 128) shr 8)).coerceIn(0, 255)
    fun crOf(r: Int, g: Int, b: Int): Int = (128 + ((128 * r - 107 * g - 21 * b + 128) shr 8)).coerceIn(0, 255)
  }
}

object CardEdges {
  /** CR80: 85.6 × 54 mm. */
  const val CARD_RATIO = 85.6 / 54.0
  /** Each band reaches this much of the frame's height inside and outside its side. */
  const val BAND = 0.20
  /** The least step of brightness, in grey levels of 255, that can be an edge. */
  const val MIN_STEP = 16
  /** Every second line across a band. */
  const val LINE_EVERY = 2
  /** Only the middle of each side is read: the corners are rounded, and the other sides' edges cross there. */
  const val SIDE_INSET = 0.10
  /** Two-point trials per line looked for, from a fixed seed, so the tests repeat. */
  const val TRIALS = 200
  const val SEED = 7L
  /** A point is on a line within this many pixels. */
  const val NEAR = 2.0
  /** A side's line needs a point on it from at least this share of the band's lines. */
  const val SUPPORT = 0.5
  /** The most an edge may lean from its side (about 20°). */
  const val MAX_TILT = 0.36
  /** The card's long sides over its short ones: 1.586 allowing for the card held at an angle. */
  const val MIN_RATIO = 1.17
  const val MAX_RATIO = 2.14
  /** The card covers at least this share of the frame. */
  const val MIN_AREA = 0.40
  /** The table's brightness is read in the outermost quarter of each band, beyond where the card usually is. */
  const val TABLE_PART = 0.25
  /**
   * A line's inside is read 1–3 pixels from it, so a line of grain just outside the card doesn't see the
   * card, and again 1–6 pixels from it, so a dark grain stripe a few pixels wide outside the card isn't
   * taken for the card past it (an oak table); its outside 2–6 pixels from it. Each is the
   * median along the side, so a stripe or a finger across part of it doesn't move it.
   */
  const val INSIDE_NEAR = 1
  const val INSIDE_FAR = 3
  const val INSIDE_DEEP = 6
  const val OUTSIDE_NEAR = 2
  const val OUTSIDE_FAR = 6
  /**
   * The card's edge steps across all along the side: inside and outside at least MIN_STEP apart at this share
   * of the places read along it (every fourth pixel) that have the table outside them. A pencil by the card
   * along part of the side doesn't, nor a line joining the card's edge on part of the side to a grain stripe on
   * the rest; a finger lying over part of the edge has neither the step nor the table outside, so is left out.
   */
  const val STEPS_ALONG = 0.75
  /**
   * The card's edge has the table outside it and something unlike the table inside: its outside is no
   * further from the table's brightness than this share of how far its inside is, and its inside is at
   * least two steps from it. A line of wood grain has the table on both sides; a printed line inside the
   * card has the card outside it.
   */
  const val OUTSIDE_LIKE_TABLE = 1.0 / 3
  /**
   * Light from one side, low, leaves a soft shadow along the card's far edge, darker than the table, so the strip
   * outside that edge isn't the table and the side was refused (an iPhone 12 outlined a dark card on
   * white in 1 of 59 frames). A line also passes when its outside is plainly such a shadow: on the shadow's side of
   * the table (darker; in Cb and Cr, nearer grey), coming back to it within SHADOW_TO pixels, about 1.7 mm (read
   * further, dark printing inside a card that brightens towards its edge passed too): a SHADOW_WINDOW-pixel window
   * starting SHADOW_FROM to SHADOW_TO pixels out has its median within a third of inFar of the table; from the line to
   * the window's end no pixel's median differs from the last by more than SHADOW_SMOOTH (a hard step is no shadow),
   * and up to the window none is further from the table than the last by more than SHADOW_SLACK.
   */
  const val SHADOW_FROM = 6
  const val SHADOW_TO = 10
  const val SHADOW_WINDOW = 5
  const val SHADOW_SMOOTH = 12
  const val SHADOW_SLACK = 4

  /** How a line passed as an edge: not at all, with the table outside it, or with a shadow outside it. */
  private enum class Edge { NONE, TABLE, SHADOW }
  /**
   * Cb and Cr are searched with every difference trebled about 128. A grey card on an oak table, the same
   * brightness, differs from it by about 32 in each (Pixel 9a frames): under the 48 a point needs
   * across a 3-pixel sum, about 96 once trebled. Doubled found 13 of 38 such frames, trebled 14, four times 14;
   * none found a card in 232 frames without one.
   */
  const val CHROMA_GAIN = 3

  private enum class Side(val horizontal: Boolean, val outward: Int) { TOP(true, -1), RIGHT(false, 1), BOTTOM(true, 1), LEFT(false, -1) }

  /** A side's line: across = a + b × along (along is x for the top and bottom, y for the left and right). */
  private class Line(val a: Double, val b: Double) {
    /** hypot(1, b), worked out once (as the Swift does): distance is asked millions of times a frame. */
    private val length = hypot(1.0, b)

    fun across(along: Double) = a + b * along
    fun distance(along: Double, across: Double) = abs(across - across(along)) / length
  }

  /**
   * The card's corners in the picture, or null when its four edges aren't all found. With its colour, each
   * side is looked for in the brightness, Cb and Cr alike (each against its own table), and the outermost
   * line any of them finds is the side's.
   */
  fun find(p: Luma, frame: Box, colour: Chroma? = null): Quad? {
    require(colour == null || (colour.cb.width == p.width && colour.cb.height == p.height)) { "colour ${colour?.cb?.width}x${colour?.cb?.height} for ${p.width}x${p.height}" }
    val band = frame.height * BAND
    val channels = if (colour == null) listOf(p) else listOf(p, colour.cb, colour.cr)
    val tables = channels.map { Table.read(it, frame, band) }
    if (tables[0] == null) return null
    val top = outermost(channels, tables, frame, band, Side.TOP) ?: return null
    val right = outermost(channels, tables, frame, band, Side.RIGHT) ?: return null
    val bottom = outermost(channels, tables, frame, band, Side.BOTTOM) ?: return null
    val left = outermost(channels, tables, frame, band, Side.LEFT) ?: return null
    val q = Quad(cross(top, left), cross(top, right), cross(bottom, right), cross(bottom, left))
    return q.takeIf { isCard(it, frame) }
  }

  /**
   * The side's line: of the lines the channels pass, the outermost at the side's middle; of equals the first, in the
   * order Y, Cb, Cr. A steep shadow makes a line of its own a few pixels out from the card, which passes as a shadow
   * too and would be the outermost: a line passed only as a shadow with another passed line, of any channel, within
   * SHADOW_TO pixels inside it is in the shadow (a grey card on oak has no edge in brightness, only in
   * colour, so the shadow's brightness line is dropped by colour's edge).
   */
  private fun outermost(channels: List<Luma>, tables: List<Table?>, frame: Box, band: Double, s: Side): Line? {
    val (from, to) = span(frame, s)
    val middle = (from + to) / 2
    val passed = ArrayList<Pair<Line, Edge>>()
    for (i in channels.indices) {
      val table = tables[i] ?: continue
      passed.addAll(side(channels[i], frame, band, s, table, brightness = i == 0))
    }
    val found = passed.filter { (line, edge) ->
      val out = line.across(middle) * s.outward
      edge != Edge.SHADOW || passed.none { (other, _) -> other !== line && out - other.across(middle) * s.outward > 0 && out - other.across(middle) * s.outward <= SHADOW_TO }
    }.map { it.first }
    return found.maxByOrNull { it.across(middle) * s.outward }
  }

  /** Whether four corners can be the card: convex, a card's proportions, and big enough. */
  fun isCard(q: Quad, frame: Box): Boolean {
    val c = q.corners
    val turns = (0 until 4).map { i ->
      val a = c[i]
      val b = c[(i + 1) % 4]
      val d = c[(i + 2) % 4]
      (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x)
    }
    if (!(turns.all { it > 0 } || turns.all { it < 0 })) return false
    val long = (dist(q.tl, q.tr) + dist(q.bl, q.br)) / 2
    val short = (dist(q.tl, q.bl) + dist(q.tr, q.br)) / 2
    if (short <= 0 || long / short !in MIN_RATIO..MAX_RATIO) return false
    val area = abs((0 until 4).sumOf { i -> c[i].x * c[(i + 1) % 4].y - c[(i + 1) % 4].x * c[i].y }) / 2
    return area >= MIN_AREA * frame.width * frame.height
  }

  private fun dist(a: Pt, b: Pt) = hypot(a.x - b.x, a.y - b.y)

  /** Where a top or bottom line meets a left or right one. */
  private fun cross(h: Line, v: Line): Pt {
    // y = h.a + h.b·x and x = v.a + v.b·y
    val x = (v.a + v.b * h.a) / (1 - v.b * h.b)
    return Pt(x, h.across(x))
  }

  /** Where a side of the frame is, across, and the span it runs along. */
  private fun sideAt(frame: Box, s: Side): Double = when (s) {
    Side.TOP -> frame.top
    Side.BOTTOM -> frame.bottom
    Side.LEFT -> frame.left
    Side.RIGHT -> frame.right
  }

  private fun span(frame: Box, s: Side): Pair<Double, Double> = if (s.horizontal) frame.left to frame.right else frame.top to frame.bottom

  /** A pixel, across and along a side; null outside the picture. */
  private fun pixel(p: Luma, s: Side, along: Int, across: Int): Int? =
    if (s.horizontal) (if (across in 0 until p.height && along in 0 until p.width) p.at(along, across) else null)
    else (if (across in 0 until p.width && along in 0 until p.height) p.at(across, along) else null)

  private fun median(seen: MutableList<Int>): Int {
    seen.sort()
    return seen[seen.size / 2]
  }

  /**
   * The table's brightness beside each side, read in the outermost quarter of the bands. Light seldom falls
   * evenly on a table: the phone held over the card shades one side of it, and white paper read 140 above a card
   * and 210 below it (in photos taken with the phone). So each side is held to the table beside it: the median of
   * its own band's quarter, when at least half of that is in the picture; else (the frame's left and right sides
   * are near the picture's edges, and their quarters off it) a plane through the medians of the halves of the
   * quarters that are, read where the line is; else the median of everything read.
   */
  private class Table(private val own: Map<Side, Int>, private val plane: DoubleArray?, private val whole: Int) {
    /** The table beside side s at (x, y). */
    fun beside(s: Side, x: Double, y: Double): Int = own[s] ?: plane?.let { (it[0] + it[1] * x + it[2] * y).roundToInt() } ?: whole

    companion object {
      fun read(p: Luma, frame: Box, band: Double): Table? {
        val all = ArrayList<Int>()
        val own = HashMap<Side, Int>()
        val halves = ArrayList<DoubleArray>() // x, y, brightness
        for (s in Side.values()) {
          val at = sideAt(frame, s)
          val (from, to) = span(frame, s)
          val middle = (from + to) / 2
          val seen = List(2) { ArrayList<Int>() }
          val tried = IntArray(2)
          val sumX = DoubleArray(2)
          val sumY = DoubleArray(2)
          var across = at + s.outward * band * (1 - TABLE_PART)
          while ((across - at) * s.outward <= band) {
            var along = from
            while (along <= to) {
              val half = if (along < middle) 0 else 1
              val x = (if (s.horizontal) along else across).roundToInt()
              val y = (if (s.horizontal) across else along).roundToInt()
              tried[half]++
              if (x in 0 until p.width && y in 0 until p.height) {
                seen[half].add(p.at(x, y))
                sumX[half] += x.toDouble()
                sumY[half] += y.toDouble()
              }
              along += 4
            }
            across += 2 * s.outward
          }
          for (half in 0..1) {
            val n = seen[half].size
            all.addAll(seen[half])
            if (n > 0 && 2 * n >= tried[half]) halves.add(doubleArrayOf(sumX[half] / n, sumY[half] / n, median(ArrayList(seen[half])).toDouble()))
          }
          val both = ArrayList<Int>().apply { addAll(seen[0]); addAll(seen[1]) }
          if (both.isNotEmpty() && 2 * both.size >= tried.sum()) own[s] = median(both)
        }
        if (all.isEmpty()) return null
        return Table(own, plane(halves), median(all))
      }

      /** The plane b0 + b1·x + b2·y nearest the points (least squares), or null when they don't fix one (fewer than three, or in a line). */
      private fun plane(points: List<DoubleArray>): DoubleArray? {
        if (points.size < 3) return null
        // The normal equations, m · b = v, solved by Cramer's rule.
        val m = Array(3) { DoubleArray(3) }
        val v = DoubleArray(3)
        for (pt in points) {
          val row = doubleArrayOf(1.0, pt[0], pt[1])
          for (i in 0..2) {
            for (j in 0..2) m[i][j] += row[i] * row[j]
            v[i] += row[i] * pt[2]
          }
        }
        fun det(a: Array<DoubleArray>) =
          a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
        val d = det(m)
        if (abs(d) <= 1e-9 * m[0][0] * m[1][1] * m[2][2]) return null
        return DoubleArray(3) { k -> det(Array(3) { i -> DoubleArray(3) { j -> if (j == k) v[i] else m[i][j] } }) / d }
      }
    }
  }

  /** A line's median brightness near..far pixels to one side: outward (+1) or inward (-1) of the card. */
  private fun beside(p: Luma, s: Side, line: Line, first: Int, last: Int, way: Int, near: Int, far: Int): Int? {
    val seen = ArrayList<Int>()
    var along = first
    while (along <= last) {
      for (d in near..far) pixel(p, s, along, (line.across(along.toDouble()) + way * s.outward * d).roundToInt())?.let { seen.add(it) }
      along += 4
    }
    if (seen.isEmpty()) return null
    seen.sort()
    return seen[seen.size / 2]
  }

  /**
   * How a line passes: its inside unlike the table and its outside like it (TABLE), or its outside a shadow that comes
   * back to the table (SHADOW); and it steps across all along it, its outside read where the table is.
   */
  private fun hasTableOutside(p: Luma, s: Side, line: Line, first: Int, last: Int, table: Int, brightness: Boolean): Edge {
    val outside = beside(p, s, line, first, last, 1, OUTSIDE_NEAR, OUTSIDE_FAR) ?: return Edge.NONE
    val inside = beside(p, s, line, first, last, -1, INSIDE_NEAR, INSIDE_FAR) ?: return Edge.NONE
    val deep = beside(p, s, line, first, last, -1, INSIDE_NEAR, INSIDE_DEEP) ?: return Edge.NONE
    val inFar = min(abs(inside - table), abs(deep - table))
    if (inFar < 2 * MIN_STEP) return Edge.NONE
    if (abs(outside - table) <= inFar * OUTSIDE_LIKE_TABLE) {
      return if (stepsAlong(p, s, line, first, last, table, inFar, OUTSIDE_NEAR, OUTSIDE_FAR)) Edge.TABLE else Edge.NONE
    }
    val from = shadowReached(p, s, line, first, last, table, inFar, outside, brightness) ?: return Edge.NONE
    return if (stepsAlong(p, s, line, first, last, table, inFar, from, from + SHADOW_WINDOW - 1)) Edge.SHADOW else Edge.NONE
  }

  /** Where a shadow outside the line has come back to the table: its window's first pixel out; null when it is no such shadow. */
  private fun shadowReached(p: Luma, s: Side, line: Line, first: Int, last: Int, table: Int, inFar: Int, outside: Int, brightness: Boolean): Int? {
    val shadowSide = if (brightness) outside < table else abs(outside - 128) < abs(table - 128)
    if (!shadowSide) return null
    val far = SHADOW_TO + SHADOW_WINDOW - 1
    val m = IntArray(far + 1)
    for (d in OUTSIDE_NEAR..far) m[d] = beside(p, s, line, first, last, 1, d, d) ?: return null
    val window = IntArray(SHADOW_WINDOW)
    var from = -1
    for (start in SHADOW_FROM..SHADOW_TO) {
      for (i in 0 until SHADOW_WINDOW) window[i] = m[start + i]
      window.sort()
      if (abs(window[SHADOW_WINDOW / 2] - table) <= inFar * OUTSIDE_LIKE_TABLE) {
        from = start
        break
      }
    }
    if (from < 0) return null
    for (d in OUTSIDE_NEAR until from + SHADOW_WINDOW - 1) if (abs(m[d + 1] - m[d]) > SHADOW_SMOOTH) return null
    for (d in OUTSIDE_NEAR until from) if (abs(m[d + 1] - table) > abs(m[d] - table) + SHADOW_SLACK) return null
    return from
  }

  /**
   * Whether the line's inside (1–6 pixels) and outside (near–far pixels: 2–6, or where a shadow came back to the
   * table) are MIN_STEP apart at STEPS_ALONG of the places along it whose outside is as like the table as the whole
   * line's must be.
   */
  private fun stepsAlong(p: Luma, s: Side, line: Line, first: Int, last: Int, table: Int, inFar: Int, near: Int, far: Int): Boolean {
    var places = 0
    var steps = 0
    val inside = ArrayList<Int>()
    val outside = ArrayList<Int>()
    var along = first
    while (along <= last) {
      val at = line.across(along.toDouble())
      inside.clear()
      outside.clear()
      for (d in INSIDE_NEAR..INSIDE_DEEP) pixel(p, s, along, (at - s.outward * d).roundToInt())?.let { inside.add(it) }
      for (d in near..far) pixel(p, s, along, (at + s.outward * d).roundToInt())?.let { outside.add(it) }
      if (inside.isNotEmpty() && outside.isNotEmpty()) {
        val out = median(outside)
        if (abs(out - table) <= inFar * OUTSIDE_LIKE_TABLE) {
          places++
          if (abs(median(inside) - out) >= MIN_STEP) steps++
        }
      }
      along += 4
    }
    return places > 0 && steps >= STEPS_ALONG * places
  }

  /** The lines across a side's band that pass as its edge, each with how it passed; none when the band is off the picture. */
  private fun side(p: Luma, frame: Box, band: Double, s: Side, table: Table, brightness: Boolean): List<Pair<Line, Edge>> {
    val at = sideAt(frame, s)
    val (from, to) = span(frame, s)
    val alongLimit = (if (s.horizontal) p.width else p.height) - 2
    val acrossLimit = (if (s.horizontal) p.height else p.width) - 2
    // The band, clipped to the picture (the frame's left and right sides are near its edges).
    val lo = max(1, ceil(at - band).toInt())
    val hi = min(acrossLimit, floor(at + band).toInt())
    if (hi - lo < 5) return emptyList()
    val inset = (to - from) * SIDE_INSET
    val first = max(1, ceil(from + inset).toInt())
    val last = min(alongLimit, floor(to - inset).toInt())
    val points = ArrayList<DoubleArray>() // along, across, the line's number
    var lines = 0
    val n = hi - lo + 1
    val sums = IntArray(n)
    val steps = IntArray(n)
    var along = first
    while (along <= last) {
      // The brightness across the band, each a 3-pixel sum along the side.
      for (i in 0 until n) {
        val c = lo + i
        sums[i] = if (s.horizontal) p.at(along - 1, c) + p.at(along, c) + p.at(along + 1, c) else p.at(c, along - 1) + p.at(c, along) + p.at(c, along + 1)
      }
      for (i in 1 until n - 1) steps[i] = abs(sums[i + 1] - sums[i - 1])
      // Every step over the threshold is kept, not only the strongest: printing near the edge is often a
      // stronger step than the card against the table, and the outermost line decides below.
      for (i in 2 until n - 2) {
        val m = steps[i]
        if (m < 3 * MIN_STEP || m < steps[i - 1] || m <= steps[i + 1]) continue
        // A parabola through the peak and its neighbours places it between pixels.
        val den = steps[i - 1] - 2 * m + steps[i + 1]
        val offset = if (den != 0) 0.5 * (steps[i - 1] - steps[i + 1]) / den else 0.0
        points.add(doubleArrayOf(along.toDouble(), lo + i + offset, lines.toDouble()))
      }
      lines++
      along += LINE_EVERY
    }
    // The lines with the table outside them (or a shadow that comes back to it): the card's physical edge, not its
    // printing inside it nor the table's own grain outside it; outermost() takes the outermost of every channel's.
    val middle = (from + to) / 2
    val passed = ArrayList<Pair<Line, Edge>>()
    for (line in lines(points, lines)) {
      val across = line.across(middle)
      val edge = hasTableOutside(p, s, line, first, last, if (s.horizontal) table.beside(s, middle, across) else table.beside(s, across, middle), brightness)
      if (edge != Edge.NONE) passed.add(line to edge)
    }
    return passed
  }

  /**
   * Every straight line through the points with enough support, best first, ignoring the outliers: all
   * of them, however much printing the band holds, so the outermost is always among them.
   */
  private fun lines(all: List<DoubleArray>, lines: Int): List<Line> {
    val rnd = Random(SEED)
    val out = ArrayList<Line>()
    var left = all
    while (left.size >= 2) {
      // The points as flat arrays, for the trials' support: the same numbers in the same order, read faster.
      val along = DoubleArray(left.size) { left[it][0] }
      val across = DoubleArray(left.size) { left[it][1] }
      val band = IntArray(left.size) { left[it][2].toInt() }
      var best: Line? = null
      var bestSupport = 0
      repeat(TRIALS) {
        val p = left[rnd.nextInt(left.size)]
        val q = left[rnd.nextInt(left.size)]
        if (p[2] == q[2]) return@repeat
        val b = (q[1] - p[1]) / (q[0] - p[0])
        if (abs(b) > MAX_TILT) return@repeat
        val line = Line(p[1] - b * p[0], b)
        val n = support(along, across, band, line, lines)
        if (n > bestSupport) {
          best = line
          bestSupport = n
        }
      }
      val rough = best ?: break
      if (bestSupport < SUPPORT * lines) break
      val line = leastSquares(left.filter { rough.distance(it[0], it[1]) <= NEAR }) ?: rough
      out.add(line)
      left = left.filter { line.distance(it[0], it[1]) > NEAR && rough.distance(it[0], it[1]) > NEAR }
    }
    return out
  }

  /** How many of the band's lines give a point on the line. */
  private fun support(along: DoubleArray, across: DoubleArray, band: IntArray, line: Line, lines: Int): Int {
    val seen = BooleanArray(lines)
    var n = 0
    for (i in along.indices) {
      if (line.distance(along[i], across[i]) <= NEAR && !seen[band[i]]) {
        seen[band[i]] = true
        n++
      }
    }
    return n
  }

  private fun leastSquares(points: List<DoubleArray>): Line? {
    if (points.size < 2) return null
    val n = points.size.toDouble()
    val mx = points.sumOf { it[0] } / n
    val my = points.sumOf { it[1] } / n
    val sxx = points.sumOf { (it[0] - mx) * (it[0] - mx) }
    if (sxx == 0.0) return null
    val b = points.sumOf { (it[0] - mx) * (it[1] - my) } / sxx
    return Line(my - b * mx, b)
  }
}

/**
 * The outline as the screen shows it: once three frames running found the
 * card, at the mean of the last three found, until five frames running find
 * nothing.
 */
class Steady(private val show: Int = 3, private val hide: Int = 5) {
  private val recent = ArrayDeque<Quad>()
  private var misses = 0

  var shown: Quad? = null
    private set

  fun add(q: Quad?): Quad? {
    if (q == null) {
      misses++
      if (shown == null) recent.clear()
      else if (misses >= hide) {
        shown = null
        recent.clear()
      }
      return shown
    }
    misses = 0
    recent.addLast(q)
    if (recent.size > show) recent.removeFirst()
    if (shown != null || recent.size == show) shown = mean(recent)
    return shown
  }

  private fun mean(qs: Collection<Quad>): Quad {
    fun avg(pick: (Quad) -> Pt) = Pt(qs.sumOf { pick(it).x } / qs.size, qs.sumOf { pick(it).y } / qs.size)
    return Quad(avg { it.tl }, avg { it.tr }, avg { it.br }, avg { it.bl })
  }
}
