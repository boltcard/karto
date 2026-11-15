package app.cardapp.cardnative

import java.io.DataOutputStream
import java.io.File
import java.util.Random
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Writes the file the iPhone's finder is checked against (swift/CardKit/Tests/CardLogicTests/Fixtures/card-edges.bin,
 * read by CardEdgesFixtureTests.swift): pictures' brightness values themselves (and Cb and Cr, gained, for those in
 * colour; made up, but for one real frame of a bare oak table from the Pixel 9a), what CardEdges answered
 * for each (its corners, or that there is no card), and numbers java.util.Random gave. CardEdges.swift is this
 * finder line for line and must answer the same from the same bytes, so a change to either is made in both, and
 * this is run again:
 *
 *   CARD_EDGES_FIXTURE=$PWD/app/modules/card-native/swift/CardKit/Tests/CardLogicTests/Fixtures make native-test
 *
 * Without CARD_EDGES_FIXTURE it is skipped: make native-test writes nothing.
 */
class CardEdgesFixtureTest {
  private val w = 320
  private val h = 288
  private val frame = Box.frame(w, h, 0.86, 0.5)

  private class Shape(val q: Quad, val level: Int, val radius: Double = 0.0)

  /** As CardEdgesTest's picture: background, each shape over the last, 3×3 samples a pixel, light, noise of ±noise levels. */
  private fun picture(background: Int, shapes: List<Shape>, noise: Int, light: (Int, Int) -> Int = { _, _ -> 0 }): Luma {
    val out = ByteArray(w * h)
    val rnd = Random(1)
    for (y in 0 until h) {
      for (x in 0 until w) {
        var sum = 0
        for (sy in 0 until 3) {
          for (sx in 0 until 3) {
            val px = x + (sx + 0.5) / 3
            val py = y + (sy + 0.5) / 3
            var v = background
            for (s in shapes) if (inside(s, px, py)) v = s.level
            sum += v
          }
        }
        val v = sum / 9 + light(x, y) + (if (noise > 0) rnd.nextInt(2 * noise + 1) - noise else 0)
        out[y * w + x] = v.coerceIn(0, 255).toByte()
      }
    }
    return Luma(w, h, out)
  }

  private fun inside(s: Shape, x: Double, y: Double): Boolean {
    val c = s.q.corners
    for (i in 0 until 4) {
      val a = c[i]
      val b = c[(i + 1) % 4]
      if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false
    }
    if (s.radius <= 0) return true
    for (i in 0 until 4) {
      val k = c[i]
      val u = unit(k, c[(i + 1) % 4])
      val v = unit(k, c[(i + 3) % 4])
      val du = (x - k.x) * u.x + (y - k.y) * u.y
      val dv = (x - k.x) * v.x + (y - k.y) * v.y
      if (du < s.radius && dv < s.radius && hypot(x - (k.x + (u.x + v.x) * s.radius), y - (k.y + (u.y + v.y) * s.radius)) > s.radius) return false
    }
    return true
  }

  private fun unit(a: Pt, b: Pt): Pt {
    val d = hypot(b.x - a.x, b.y - a.y)
    return Pt((b.x - a.x) / d, (b.y - a.y) / d)
  }

  private fun card(degrees: Double = 0.0, dx: Double = 0.0, dy: Double = 0.0, scale: Double = 1.0): Quad {
    val cx = (frame.left + frame.right) / 2
    val cy = (frame.top + frame.bottom) / 2
    val hw = frame.width / 2 * scale
    val hh = frame.height / 2 * scale
    val r = Math.toRadians(degrees)
    fun at(x: Double, y: Double) = Pt(cx + dx + x * cos(r) - y * sin(r), cy + dy + x * sin(r) + y * cos(r))
    return Quad(at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh))
  }

  private fun strip(card: Quad, from: Double, to: Double): Quad {
    fun along(a: Pt, b: Pt, t: Double) = Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
    return Quad(along(card.tl, card.bl, from), along(card.tr, card.br, from), along(card.tr, card.br, to), along(card.tl, card.bl, to))
  }

  private fun inset(card: Quad, d: Double): Quad {
    val c = card.corners
    return Quad(Pt(c[0].x + d, c[0].y + d), Pt(c[1].x - d, c[1].y + d), Pt(c[2].x - d, c[2].y - d), Pt(c[3].x + d, c[3].y - d))
  }

  /**
   * A picture, and whether the finder is expected to find a card in it (so a fixture of nothing but "no card" is never
   * written); its colour, gained, when it has one; where its frame is.
   */
  private class Case(val name: String, val luma: Luma, val card: Boolean, val colour: Chroma? = null, val widthFraction: Double = 0.86, val centreY: Double = 0.5)

  /** A real frame from the Pixel 9a or the iPhone 12, as CardEdgesTest.real reads it (src/test/resources/realframes). */
  private fun realCase(name: String, resource: String, card: Boolean): Case {
    java.io.DataInputStream(java.util.zip.GZIPInputStream(javaClass.getResourceAsStream("/realframes/$resource.bin.gz")!!)).use {
      val magic = ByteArray(4).also { m -> it.readFully(m) }
      assertEquals("RF54", String(magic))
      val w = it.readInt()
      val h = it.readInt()
      val widthFraction = it.readDouble()
      val centreY = it.readDouble()
      fun plane() = Luma(w, h, ByteArray(w * h).also { b -> it.readFully(b) })
      val y = plane()
      return Case(name, y, card, Chroma.gained(plane(), plane()), widthFraction, centreY)
    }
  }

  private fun cases(): List<Case> {
    val band = frame.height * CardEdges.BAND
    val px = 1.0 / frame.height
    val square = card()
    val tilted = card(degrees = -2.0)
    val grainCard = card(degrees = 1.5, scale = 0.94)
    val grain = (0 until w step 9).map { x -> Shape(Quad(Pt(x.toDouble(), 0.0), Pt(x + 2.0, 0.0), Pt(x + 2.0, h.toDouble()), Pt(x.toDouble(), h.toDouble())), 95) }
    val narrow = frame.width * 0.08
    val midX = (frame.left + frame.right) / 2
    val midY = (frame.top + frame.bottom) / 2
    val inset = card(scale = 0.94)
    fun colour(cb: Int, cbShapes: List<Shape>, cr: Int, crShapes: List<Shape>) = Chroma.gained(picture(cb, cbShapes, 1), picture(cr, crShapes, 1))
    val grey = card(degrees = 1.5, scale = 0.95)
    val warm = colour(110, listOf(Shape(grey, 128)), 150, listOf(Shape(grey, 128)))
    fun upright(x: Double, width: Double, from: Double, to: Double) = Shape(Quad(Pt(x, from), Pt(x + width, from), Pt(x + width, to), Pt(x, to)), 0)
    val sq95 = card(scale = 0.95)
    // The hard step's case with the card's left edge on a pixel boundary (the 3×3 sampling would spread the jump).
    val sq95b = card(dx = ceil(sq95.tl.x) - sq95.tl.x, scale = 0.95)
    fun shadowLeft(c: Quad, levels: List<Int>) = levels.mapIndexed { d, v -> Shape(upright(c.tl.x - d - 1, 1.0, c.tl.y, c.bl.y).q, v) }
    fun ramp(start: Int, step: Int, end: Int) = generateSequence(start) { it + step }.takeWhile { if (step > 0) it < end else it > end }.toList()
    val wide = Quad(
      Pt(frame.left, frame.top + band * 0.9), Pt(frame.right, frame.top + band * 0.9),
      Pt(frame.right, frame.bottom - band * 0.9), Pt(frame.left, frame.bottom - band * 0.9),
    )
    return listOf(
      Case("square to the frame", picture(90, listOf(Shape(square, 200)), 3), true),
      Case("turned by 5 degrees", picture(90, listOf(Shape(card(degrees = 5.0, scale = 0.92), 200)), 3), true),
      Case("turned by -10 degrees", picture(90, listOf(Shape(card(degrees = -10.0, scale = 0.92), 200)), 1), true),
      Case("a trapezium", picture(90, listOf(Shape(Quad(Pt(square.tl.x + narrow, square.tl.y + 6), Pt(square.tr.x - narrow, square.tr.y + 6), square.br, square.bl), 200)), 1), true),
      Case("rounded corners", picture(90, listOf(Shape(card(degrees = 3.0, scale = 0.95), 200, radius = frame.height * 3.18 / 54)), 1), true),
      Case("dark on light", picture(210, listOf(Shape(card(degrees = 2.0), 60)), 1), true),
      Case("a magnetic stripe", picture(120, listOf(Shape(square, 200), Shape(strip(square, 5.5 / 54, 18.0 / 54), 15)), 3), true),
      Case("a printed border", picture(110, listOf(Shape(tilted, 190), Shape(inset(tilted, 6.0), 20), Shape(inset(tilted, 9.0), 190)), 1), true),
      Case("printed lines near the edge", picture(150, listOf(Shape(square, 200)) + listOf(8.0, 16.0, 24.0).map { Shape(strip(square, it * px, (it + 3) * px), 20) }, 1), true),
      Case("wood grain", picture(125, grain + Shape(grainCard, 225), 3), true),
      Case("shifted toward the bands' edge", picture(90, listOf(Shape(card(dx = -band * 0.6, dy = band * 0.7, scale = 0.97), 200)), 1), true),
      Case("clipped by the picture's edge", picture(90, listOf(Shape(card(dx = -frame.left + 4), 200)), 1), true),
      Case("lit unevenly, top to bottom", picture(165, listOf(Shape(card(degrees = 1.5, scale = 0.95), 40)), 1) { _, y -> ((y - midY) * 0.4).roundToInt() }, true),
      Case("lit unevenly, side to side", picture(165, listOf(Shape(card(degrees = 1.5, scale = 0.95), 40)), 1) { x, _ -> ((x - midX) * 0.3).roundToInt() }, true),
      Case("a grain stripe beside the card", picture(165, listOf(Shape(upright(inset.tl.x - 13, 3.0, 0.0, h.toDouble()).q, 100), Shape(inset, 50)), 1), true),
      Case("a pencil along part of a side", picture(165, listOf(Shape(upright(inset.tl.x - 14, 5.0, frame.top, frame.top + frame.height * 0.6).q, 60), Shape(inset, 230)), 1), true),
      Case("a finger over part of a short side", picture(90, listOf(Shape(square, 200), Shape(Quad(Pt(0.0, midY - frame.height * 0.16), Pt(square.tl.x + 30, midY - frame.height * 0.16), Pt(square.tl.x + 30, midY + frame.height * 0.16), Pt(0.0, midY + frame.height * 0.16)), 150)), 1), true),
      Case("a plain picture", picture(110, emptyList(), 3), false),
      Case("too faint", picture(110, listOf(Shape(square, 120)), 2), false),
      Case("the wrong proportions", picture(90, listOf(Shape(wide, 200)), 1), false),
      // Colour: a grey card the table's brightness, and the cases its colour must get right.
      Case("a grey card on a warm table", picture(150, listOf(Shape(grey, 150)), 3), true, warm),
      Case("the same without its colour", picture(150, listOf(Shape(grey, 150)), 3), false),
      Case("a printed line inside a grey card", picture(150, listOf(Shape(grey, 150), Shape(inset(grey, 6.0), 60), Shape(inset(grey, 14.0), 150)), 3), true, warm),
      Case(
        "colourful printing near the edge", picture(150, listOf(Shape(grey, 150)), 3), true,
        colour(110, listOf(Shape(grey, 128), Shape(inset(grey, 5.0), 200), Shape(inset(grey, 13.0), 128)), 150, listOf(Shape(grey, 128))),
      ),
      Case(
        "stripes of colour on the table", picture(150, listOf(Shape(grey, 150)), 3), true,
        colour(110, (0 until w step 9).map { x -> Shape(upright(x.toDouble(), 2.0, 0.0, h.toDouble()).q, 100) } + Shape(grey, 128), 150, listOf(Shape(grey, 128))),
      ),
      realCase("bare oak, from the Pixel 9a", "bare-oak", false),
      // A soft shadow along one side and the shadows the rule refuses.
      Case("a soft shadow along one side", picture(200, shadowLeft(sq95, ramp(100, 6, 200)) + Shape(sq95, 30), 1), true),
      Case("a shadow too wide", picture(200, shadowLeft(sq95, ramp(60, 6, 200)) + Shape(sq95, 30), 1), false),
      Case("a bright halo", picture(128, shadowLeft(sq95, ramp(200, -5, 128)) + Shape(sq95, 30), 1), false),
      Case("a shadow with a hard step", picture(200, shadowLeft(sq95b, listOf(100, 106, 112, 118, 124, 124, 138, 138) + ramp(144, 6, 200)) + Shape(sq95b, 30), 1), false),
      Case(
        "a shadow in colour", picture(150, listOf(Shape(sq95, 150)), 3), true,
        colour(
          110, shadowLeft(sq95, (0 until 10).map { 110 + (14 * (10 - it) / 10.0).roundToInt() }) + Shape(sq95, 128),
          150, shadowLeft(sq95, (0 until 10).map { 150 - (14 * (10 - it) / 10.0).roundToInt() }) + Shape(sq95, 128),
        ),
      ),
      Case(
        "a shadow's own line in brightness beside a colour edge", picture(150, shadowLeft(sq95, List(4) { 60 } + ramp(100, 6, 150)) + Shape(sq95, 150), 1), true,
        colour(110, listOf(Shape(sq95, 128)), 150, listOf(Shape(sq95, 128))),
      ),
    )
  }

  @Test fun writesTheFixtureTheSwiftFinderIsCheckedAgainst() {
    val dir = System.getenv("CARD_EDGES_FIXTURE").orEmpty()
    assumeTrue("run by hand, with CARD_EDGES_FIXTURE", dir.isNotEmpty())
    val cases = cases()
    DataOutputStream(File(dir, "card-edges.bin").outputStream().buffered()).use { out ->
      out.writeBytes("CEFX")
      out.writeInt(2)
      // java.util.Random's own numbers: bounds that are powers of two, others, and two over half of 2^31,
      // where numbers are thrown away.
      val seeds = listOf(CardEdges.SEED, 1L, -3L, 123_456_789_012_345L)
      val bounds = listOf(1, 16, 4096, 7, 1000, 1_500_000_000, 1_073_741_825)
      out.writeInt(seeds.size * bounds.size)
      for (seed in seeds) {
        for (bound in bounds) {
          val rnd = Random(seed)
          out.writeLong(seed)
          out.writeInt(bound)
          out.writeInt(64)
          repeat(64) { out.writeInt(rnd.nextInt(bound)) }
        }
      }
      out.writeInt(cases.size)
      for (c in cases) {
        val found = CardEdges.find(c.luma, Box.frame(c.luma.width, c.luma.height, c.widthFraction, c.centreY), c.colour)
        assertEquals(c.name, c.card, found != null)
        out.writeUTF(c.name)
        out.writeInt(c.luma.width)
        out.writeInt(c.luma.height)
        out.writeDouble(c.widthFraction)
        out.writeDouble(c.centreY)
        out.writeInt(if (c.colour == null) 1 else 3)
        out.writeBoolean(found != null)
        found?.corners?.forEach {
          out.writeDouble(it.x)
          out.writeDouble(it.y)
        }
        out.write(c.luma.pixels)
        c.colour?.let {
          out.write(it.cb.pixels)
          out.write(it.cr.pixels)
        }
      }
    }
  }
}
