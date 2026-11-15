package app.cardapp.cardnative

import java.nio.ByteBuffer
import java.util.Random
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * CardEdges on made-up pictures the size of an analysed frame (about 576×1280
 * once the viewport's crop is turned upright): a card drawn as a filled
 * four-sided shape, smoothed at its edges, with a little noise. Its cases are
 * carried in Swift by swift/CardKit/Tests/CardLogicTests/CardEdgesTests.swift:
 * a case added here is added there.
 */
class CardEdgesTest {
  private val w = 576
  private val h = 1280
  private val frame = Box.frame(w, h, 0.86, 0.45)

  /** A shape drawn over the picture: its corners and its grey level. */
  private class Shape(val q: Quad, val level: Int, val radius: Double = 0.0)

  /**
   * The picture: background, then each shape over the last, 3×3 samples a pixel, then light (levels added at a
   * pixel, for light that falls unevenly), then noise of ±noise levels.
   */
  private fun picture(background: Int, shapes: List<Shape>, noise: Int = 3, light: (Int, Int) -> Int = { _, _ -> 0 }): Luma {
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

  /** A stripe the picture's height, its left side at x, width pixels wide. */
  private fun upright(x: Double, width: Double, from: Double = 0.0, to: Double = h.toDouble()) =
    Quad(Pt(x, from), Pt(x + width, from), Pt(x + width, to), Pt(x, to))

  private fun inside(s: Shape, x: Double, y: Double): Boolean {
    val c = s.q.corners
    for (i in 0 until 4) {
      val a = c[i]
      val b = c[(i + 1) % 4]
      if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false
    }
    if (s.radius <= 0) return true
    // A rounded corner: inside the corner's r×r square but outside its circle is outside the card.
    for (i in 0 until 4) {
      val k = c[i]
      val u = unit(k, c[(i + 1) % 4])
      val v = unit(k, c[(i + 3) % 4])
      val du = (x - k.x) * u.x + (y - k.y) * u.y
      val dv = (x - k.x) * v.x + (y - k.y) * v.y
      if (du < s.radius && dv < s.radius) {
        val cx = k.x + (u.x + v.x) * s.radius
        val cy = k.y + (u.y + v.y) * s.radius
        if (hypot(x - cx, y - cy) > s.radius) return false
      }
    }
    return true
  }

  private fun unit(a: Pt, b: Pt): Pt {
    val d = hypot(b.x - a.x, b.y - a.y)
    return Pt((b.x - a.x) / d, (b.y - a.y) / d)
  }

  /** A card the frame's size (times scale), turned by degrees about the frame's centre and moved by dx, dy. */
  private fun card(degrees: Double = 0.0, dx: Double = 0.0, dy: Double = 0.0, scale: Double = 1.0): Quad {
    val cx = (frame.left + frame.right) / 2
    val cy = (frame.top + frame.bottom) / 2
    val hw = frame.width / 2 * scale
    val hh = frame.height / 2 * scale
    val r = Math.toRadians(degrees)
    fun at(x: Double, y: Double) = Pt(cx + dx + x * cos(r) - y * sin(r), cy + dy + x * sin(r) + y * cos(r))
    return Quad(at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh))
  }

  /** A strip of the card between fractions from and to of its height from its top edge. */
  private fun strip(card: Quad, from: Double, to: Double): Quad {
    fun along(a: Pt, b: Pt, t: Double) = Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
    return Quad(along(card.tl, card.bl, from), along(card.tr, card.br, from), along(card.tr, card.br, to), along(card.tl, card.bl, to))
  }

  /** The card's own shape inset by d pixels on every side (a printed border's outline). */
  private fun inset(card: Quad, d: Double): Quad {
    val c = card.corners
    return Quad(
      Pt(c[0].x + d, c[0].y + d), Pt(c[1].x - d, c[1].y + d), Pt(c[2].x - d, c[2].y - d), Pt(c[3].x + d, c[3].y - d),
    )
  }

  private fun assertCorners(expected: Quad, found: Quad?) {
    assertNotNull("no card found", found)
    expected.corners.zip(found!!.corners).forEachIndexed { i, (e, f) ->
      assertTrue("corner $i at (${f.x}, ${f.y}), drawn at (${e.x}, ${e.y})", hypot(e.x - f.x, e.y - f.y) <= 2.0)
    }
  }

  @Test fun aCardSquareToTheFrame() {
    val c = card()
    assertCorners(c, CardEdges.find(picture(90, listOf(Shape(c, 200))), frame))
  }

  @Test fun skewedBy5And10Degrees() {
    for (d in listOf(5.0, -10.0)) {
      val c = card(degrees = d, scale = 0.92)
      assertCorners(c, CardEdges.find(picture(90, listOf(Shape(c, 200))), frame))
    }
  }

  @Test fun atAnAngleATrapezium() {
    val c = card()
    val narrow = frame.width * 0.08
    val t = Quad(Pt(c.tl.x + narrow, c.tl.y + 10), Pt(c.tr.x - narrow, c.tr.y + 10), c.br, c.bl)
    assertCorners(t, CardEdges.find(picture(90, listOf(Shape(t, 200))), frame))
  }

  @Test fun shiftedTowardTheEdgeOfTheBands() {
    val band = frame.height * CardEdges.BAND
    val c = card(dx = -band * 0.6, dy = band * 0.7, scale = 0.97)
    assertCorners(c, CardEdges.find(picture(90, listOf(Shape(c, 200))), frame))
  }

  @Test fun bandsClippedByThePicturesEdges() {
    // The frame's left side is about 40 pixels from the picture's edge; its band reaches 62. A card
    // reaching nearly to the edge is still found.
    val c = card(dx = -frame.left + 6, scale = 1.0)
    assertCorners(c, CardEdges.find(picture(90, listOf(Shape(c, 200))), frame))
  }

  @Test fun aFingerAcrossOneEdge() {
    val c = card()
    val mx = (frame.left + frame.right) / 2
    val finger = Quad(Pt(mx - 30, c.bl.y - 60), Pt(mx + 30, c.bl.y - 60), Pt(mx + 30, h - 1.0), Pt(mx - 30, h - 1.0))
    assertCorners(c, CardEdges.find(picture(90, listOf(Shape(c, 200), Shape(finger, 150))), frame))
  }

  @Test fun roundedCorners() {
    val c = card(degrees = 3.0, scale = 0.95)
    assertCorners(c, CardEdges.find(picture(90, listOf(Shape(c, 200, radius = frame.height * 3.18 / 54))), frame))
  }

  @Test fun aCardDarkerThanItsBackgroundAndOneLighter() {
    val c = card(degrees = 2.0)
    assertCorners(c, CardEdges.find(picture(210, listOf(Shape(c, 60))), frame))
    assertCorners(c, CardEdges.find(picture(40, listOf(Shape(c, 120))), frame))
  }

  @Test fun aMagneticStripeIsNotTheEdge() {
    // A card's back: the stripe starts 5.5 mm from the top edge and is much darker than the card is
    // against the table, so its step is the stronger.
    val c = card()
    val stripe = strip(c, 5.5 / 54, 18.0 / 54)
    assertCorners(c, CardEdges.find(picture(120, listOf(Shape(c, 200), Shape(stripe, 15))), frame))
  }

  @Test fun aPrintedBorderIsNotTheEdge() {
    val c = card(degrees = -2.0)
    val outer = inset(c, 8.0)
    val inner = inset(c, 12.0)
    val picture = picture(110, listOf(Shape(c, 190), Shape(outer, 20), Shape(inner, 190)))
    assertCorners(c, CardEdges.find(picture, frame))
  }

  @Test fun aBusyFaceNearTheEdge() {
    // Three thin printed lines just inside the top edge: six steps on each line across the band, all
    // stronger than the card's own edge against the table. The edge must still be among the steps kept.
    val c = card()
    val px = 1.0 / frame.height
    val lines = listOf(10.0, 22.0, 34.0).map { Shape(strip(c, it * px, (it + 4) * px), 20) }
    assertCorners(c, CardEdges.find(picture(150, listOf(Shape(c, 200)) + lines), frame))
  }

  @Test fun manyPrintedLinesNearTheEdgeAtAnySpacing() {
    // Up to five thin printed lines inside the top edge (ten steps, all stronger than the edge) at
    // several spacings: however many straight lines the band holds, the outermost one is the edge.
    val c = card()
    val px = 1.0 / frame.height
    for (offsets in listOf(listOf(8.0, 16.0, 24.0, 32.0, 40.0), listOf(12.0, 26.0, 40.0), listOf(6.0, 18.0, 30.0, 42.0), listOf(14.0, 22.0, 36.0, 48.0, 56.0))) {
      val lines = offsets.map { Shape(strip(c, it * px, (it + 3) * px), 20) }
      assertCorners(c, CardEdges.find(picture(150, listOf(Shape(c, 200)) + lines), frame))
    }
  }

  @Test fun straightWoodGrainOutsideTheCardIsNotTheEdge() {
    // A table with straight grain: thin darker lines every 9 pixels, the whole picture's height, as on
    // an oak table. Each is a straight line in the left and right bands, outside
    // the card; none has the table on one side and the card on the other.
    // At several spacings and card places, so a grain line lands at every distance from the card's edge.
    for ((spacing, c) in listOf(9 to card(degrees = 1.5, scale = 0.94), 7 to card(dx = 3.0, scale = 0.9), 13 to card(degrees = -2.0, dx = -4.0, scale = 0.96), 11 to card(dy = 5.0))) {
      val grain = (0 until w step spacing).map { x -> Shape(Quad(Pt(x.toDouble(), 0.0), Pt(x + 2.0, 0.0), Pt(x + 2.0, h.toDouble()), Pt(x.toDouble(), h.toDouble())), 95) }
      assertCorners(c, CardEdges.find(picture(125, grain + Shape(c, 225)), frame))
    }
  }

  @Test fun aTableLitUnevenly() {
    // Photos taken with the phone (2026-10-16): the phone held over the card shades the table on one side, so
    // white paper read 140 above the card and 210 below it. Held to one brightness for the whole table, the top
    // edge had "something unlike the table" outside it and was refused. Light falling off top to bottom over a
    // dark card and a light one, and side to side, where the left and right bands are off the picture.
    val c = card(degrees = 1.5, scale = 0.95)
    val midX = (frame.left + frame.right) / 2
    val midY = (frame.top + frame.bottom) / 2
    assertCorners(c, CardEdges.find(picture(165, listOf(Shape(c, 40)), light = { _, y -> ((y - midY) * 0.3).roundToInt() }), frame))
    assertCorners(c, CardEdges.find(picture(80, listOf(Shape(c, 200)), light = { _, y -> ((y - midY) * 0.25).roundToInt() }), frame))
    assertCorners(c, CardEdges.find(picture(165, listOf(Shape(c, 40)), light = { x, _ -> ((x - midX) * 0.3).roundToInt() }), frame))
  }

  /** A shadow along the card's left side: stripes a pixel wide and the card's height, levels[d] at d pixels out (0 the first). */
  private fun shadowLeft(c: Quad, levels: List<Int>) = levels.mapIndexed { d, v -> Shape(upright(c.tl.x - d - 1, 1.0, c.tl.y, c.bl.y), v) }

  /** start, start + step, … while short of end. */
  private fun ramp(start: Int, step: Int, end: Int) = generateSequence(start) { it + step }.takeWhile { if (step > 0) it < end else it > end }.toList()

  @Test fun aSoftShadowAlongOneSide() {
    // Light from the left, low: the paper beside the card's left side is 100 at the edge and climbs 6 a
    // pixel back to the paper's 200, as the iPhone 12 saw a dark card on white (about 100, 4 to 7 a pixel).
    val c = card(scale = 0.95)
    assertCorners(c, CardEdges.find(picture(200, shadowLeft(c, ramp(100, 6, 200)) + Shape(c, 30), noise = 1), frame))
  }

  @Test fun aSoftShadowAlongATurnedCard() {
    val c = card(degrees = 2.0, scale = 0.93)
    val shadow = ramp(100, 6, 200).mapIndexed { d, v -> Shape(Quad(Pt(c.tl.x - d - 1, c.tl.y), Pt(c.tl.x - d, c.tl.y), Pt(c.bl.x - d, c.bl.y), Pt(c.bl.x - d - 1, c.bl.y)), v) }
    assertCorners(c, CardEdges.find(picture(200, shadow + Shape(c, 30), noise = 1), frame))
  }

  @Test fun aShadowTooWideIsNotTaken() {
    // 60 at the edge, 6 a pixel: within a third of the table only about 14 pixels out, past SHADOW_TO.
    val c = card(scale = 0.95)
    assertNull(CardEdges.find(picture(200, shadowLeft(c, ramp(60, 6, 200)) + Shape(c, 30), noise = 1), frame))
  }

  @Test fun aBrightHaloIsNoShadow() {
    // Lighter than the table beside the edge: no shadow does that.
    val c = card(scale = 0.95)
    assertNull(CardEdges.find(picture(128, shadowLeft(c, ramp(200, -5, 128)) + Shape(c, 30), noise = 1), frame))
  }

  @Test fun aShadowWithAHardStepIsNoShadow() {
    // A jump of 14 between plateaus: over SHADOW_SMOOTH, and too small a step over two pixels to be a line itself.
    // The jump must land on a pixel boundary, or the 3x3 sampling spreads it under SHADOW_SMOOTH.
    val c0 = card(scale = 0.95)
    val c = card(dx = ceil(c0.tl.x) - c0.tl.x, scale = 0.95)
    val broken = listOf(100, 106, 112, 118, 124, 124, 138, 138) + ramp(144, 6, 200)
    assertNull(CardEdges.find(picture(200, shadowLeft(c, broken) + Shape(c, 30), noise = 1), frame))
  }

  @Test fun aShadowInColour() {
    // A grey card on a warm table of its brightness, the table's colour 14 nearer grey beside the left edge and
    // back over 10 pixels: in Cb and Cr a shadow.
    val c = card(scale = 0.95)
    val y = picture(150, listOf(Shape(c, 150)))
    val cb = shadowLeft(c, (0 until 10).map { 110 + (14 * (10 - it) / 10.0).roundToInt() }) + Shape(c, 128)
    val cr = shadowLeft(c, (0 until 10).map { 150 - (14 * (10 - it) / 10.0).roundToInt() }) + Shape(c, 128)
    assertCorners(c, CardEdges.find(y, frame, colour(110, cb, 150, cr)))
  }

  @Test fun aShadowsOwnLineInBrightnessIsNotTheEdgeOfAColourCard() {
    // Seen on an iPhone 12: a grey card on oak has no edge in brightness, so a shadow's own line there had
    // nothing in its own channel to drop it, and the outermost of the channels took it. A grey card on a warm table of
    // its brightness, a shadow beside its left side in brightness only: a core of 60 four pixels wide, then 100
    // climbing 6 a pixel. Colour has the card's edge; brightness, the core's outer edge 4 pixels out.
    val c = card(scale = 0.95)
    val y = picture(150, shadowLeft(c, List(4) { 60 } + ramp(100, 6, 150)) + Shape(c, 150), noise = 1)
    assertCorners(c, CardEdges.find(y, frame, colour(110, listOf(Shape(c, 128)), 150, listOf(Shape(c, 128)))))
  }

  @Test fun aShadowBesideACardAtThePicturesEdge() {
    // The card's left edge 8 px from the picture's: the 14 pixels read past it leave the picture, so no shadow is
    // taken there, and no card.
    val c0 = card(scale = 0.95)
    val c = card(dx = 8 - c0.tl.x, scale = 0.95)
    assertNull(CardEdges.find(picture(200, shadowLeft(c, ramp(100, 6, 200)) + Shape(c, 30), noise = 1), frame))
  }

  @Test fun aDarkPrintedRampInsideTheCardIsNotTheEdge() {
    // Dark printing that brightens towards a light card's edge (as the artwork the port let in at 15 to 30 px):
    // the card's edge, further out, is the side.
    // Each deeper inset is drawn over the last: 193 at 4 px in, darkening 7 a pixel to 60 at 23 px in.
    val c = card(scale = 0.95)
    val printed = (0 until 20).map { k -> Shape(inset(c, 4.0 + k), 193 - 7 * k) }
    assertCorners(c, CardEdges.find(picture(90, listOf(Shape(c, 230)) + printed, noise = 1), frame))
  }

  @Test fun aSoftGradientAndNoCardIsNoCard() {
    // A lamp's falloff across the table, 0.6 a pixel: no step anywhere, so nothing for the shadow rule to take.
    val midX = (frame.left + frame.right) / 2
    assertNull(CardEdges.find(picture(190, emptyList(), noise = 1) { x, _ -> -((midX - x).coerceAtLeast(0.0) * 0.6).roundToInt() }, frame))
  }

  @Test fun aGrainStripeBesideTheCardIsNotTheEdge() {
    // Oak (2026-10-16): a dark grain stripe about 3 pixels wide, 20 pixels outside the card's left edge, the side's
    // whole length. Read 1 to 3 pixels in, its inside was the stripe itself, unlike the table, so it passed as the
    // card's edge; 1 to 6 pixels in, it is the table again past the stripe.
    val c = card(scale = 0.94)
    val stripe = Shape(upright(c.tl.x - 23, 3.0), 100)
    assertCorners(c, CardEdges.find(picture(165, listOf(stripe, Shape(c, 50))), frame))
  }

  @Test fun aStripeAlongPartOfASideIsNotTheEdge() {
    // A pencil by the card, or a grain stripe that runs out: dark, wide, straight, 20 pixels outside the left edge,
    // along 60% of the side, so its line has the support a line needs and the table outside it. Only along part
    // of the side does it step across: the card's edge steps all along it.
    val c = card(scale = 0.94)
    val pencil = Shape(upright(c.tl.x - 25, 5.0, frame.top, frame.top + frame.height * 0.6), 60)
    assertCorners(c, CardEdges.find(picture(165, listOf(pencil, Shape(c, 230))), frame))
  }

  @Test fun aFingerAcrossTwoFifthsOfAShortSide() {
    // The card held flat by its end: a finger over the left edge for 40% of the side read. Where the finger is,
    // inside and outside are both finger and don't step, but nor is the table outside: those places don't count.
    // (Counted, they refused a side under any finger wider than about 11 mm.)
    val c = card()
    val midY = (frame.top + frame.bottom) / 2
    val half = frame.height * 0.8 * 0.4 / 2
    val finger = Quad(Pt(0.0, midY - half), Pt(c.tl.x + 60, midY - half), Pt(c.tl.x + 60, midY + half), Pt(0.0, midY + half))
    assertCorners(c, CardEdges.find(picture(90, listOf(Shape(c, 200), Shape(finger, 150))), frame))
  }

  /** Colour planes drawn as picture draws brightness (noise of ±1), then gained as a camera frame's are. */
  private fun colour(cb: Int, cbShapes: List<Shape>, cr: Int, crShapes: List<Shape>) =
    Chroma.gained(picture(cb, cbShapes, noise = 1), picture(cr, crShapes, noise = 1))

  @Test fun theGain() {
    assertEquals(listOf(0, 0, 44, 128, 194, 255, 255), listOf(0, 85, 100, 128, 150, 171, 255).map { Chroma.gain(it) })
  }

  @Test fun aGreyCardOnAWarmTableOfItsBrightness() {
    // A grey artwork card on an oak table: no step of brightness at its edge, one of colour.
    val c = card(degrees = 1.5, scale = 0.95)
    val y = picture(150, listOf(Shape(c, 150)))
    assertNull(CardEdges.find(y, frame))
    assertCorners(c, CardEdges.find(y, frame, colour(110, listOf(Shape(c, 128)), 150, listOf(Shape(c, 128)))))
  }

  @Test fun aPrintedLineInsideAGreyCardIsNotTheEdge() {
    // In brightness the card outside the line is the table's, so the line passes as an edge: colour's is further out.
    val c = card(degrees = 1.5, scale = 0.95)
    val y = picture(150, listOf(Shape(c, 150), Shape(inset(c, 6.0), 60), Shape(inset(c, 14.0), 150)))
    val alone = CardEdges.find(y, frame)
    assertNotNull("brightness alone takes the printed line", alone)
    c.corners.zip(alone!!.corners).forEach { (e, f) -> assertTrue("brightness alone at (${f.x}, ${f.y})", hypot(e.x - f.x, e.y - f.y) > 4.0) }
    assertCorners(c, CardEdges.find(y, frame, colour(110, listOf(Shape(c, 128)), 150, listOf(Shape(c, 128)))))
  }

  @Test fun colourfulPrintingNearTheEdgeIsNotTheEdge() {
    val c = card(degrees = -2.0, scale = 0.94)
    val y = picture(150, listOf(Shape(c, 150)))
    val printed = listOf(Shape(c, 128), Shape(inset(c, 5.0), 200), Shape(inset(c, 13.0), 128))
    assertCorners(c, CardEdges.find(y, frame, colour(110, printed, 150, listOf(Shape(c, 128)))))
  }

  @Test fun stripesOfColourOnTheTableAreNotTheEdge() {
    // Stripes 10 levels from the table in Cb, 30 once gained, as the brightness grain test's are; the oak's own
    // grain differs by at most 6 in Cb or Cr (measured on a Pixel 9a), by up to 44 in brightness.
    val c = card(degrees = 1.5, scale = 0.94)
    val stripes = (0 until w step 9).map { x -> Shape(upright(x.toDouble(), 2.0), 100) }
    val y = picture(150, listOf(Shape(c, 150)))
    assertCorners(c, CardEdges.find(y, frame, colour(110, stripes + Shape(c, 128), 150, listOf(Shape(c, 128)))))
  }

  @Test fun stripesOfColourAndNoCardAreNoCard() {
    val stripes = (0 until w step 9).map { x -> Shape(upright(x.toDouble(), 2.0), 100) }
    assertNull(CardEdges.find(picture(150, emptyList()), frame, colour(110, stripes, 150, emptyList())))
  }

  @Test fun colourWithNothingInItChangesNothing() {
    val grey = Chroma(Luma(w, h, ByteArray(w * h) { 128.toByte() }), Luma(w, h, ByteArray(w * h) { 128.toByte() }))
    val tilted = card(degrees = -2.0)
    val grain = (0 until w step 9).map { x -> Shape(upright(x.toDouble(), 2.0), 95) }
    val pictures = listOf(
      picture(90, listOf(Shape(card(), 200))),
      picture(110, listOf(Shape(tilted, 190), Shape(inset(tilted, 6.0), 20), Shape(inset(tilted, 9.0), 190))),
      picture(125, grain + Shape(card(degrees = 1.5, scale = 0.94), 225)),
      picture(165, listOf(Shape(card(degrees = 1.5, scale = 0.95), 40))) { _, y -> ((y - (frame.top + frame.bottom) / 2) * 0.4).roundToInt() },
      picture(110, emptyList()),
    )
    // A sample of the existing cases, one of each kind: the plain card, printing, grain, uneven light, no card.
    for (p in pictures) assertEquals(CardEdges.find(p, frame), CardEdges.find(p, frame, grey))
  }

  @Test fun colourOfAnotherSizeIsRefused() {
    val small = Luma(w / 2, h, ByteArray(w / 2 * h))
    assertThrows(IllegalArgumentException::class.java) { CardEdges.find(picture(90, emptyList()), frame, Chroma(small, small)) }
    assertThrows(IllegalArgumentException::class.java) { Chroma(small, Luma(w, h, ByteArray(w * h))) }
  }

  /**
   * A real analysis frame from the Pixel 9a (src/test/resources/realframes): its brightness, its colour as the camera gave it, its frame.
   */
  private class Real(val luma: Luma, val cb: Luma, val cr: Luma, val frame: Box)

  private fun real(name: String): Real {
    val input = java.io.DataInputStream(java.util.zip.GZIPInputStream(javaClass.getResourceAsStream("/realframes/$name.bin.gz")!!))
    input.use {
      val magic = ByteArray(4).also { m -> it.readFully(m) }
      assertEquals("RF54", String(magic))
      val w = it.readInt()
      val h = it.readInt()
      val frame = Box.frame(w, h, it.readDouble(), it.readDouble())
      fun plane() = Luma(w, h, ByteArray(w * h).also { b -> it.readFully(b) })
      return Real(plane(), plane(), plane(), frame)
    }
  }

  @Test fun bareOakFromThePixel9a() {
    val r = real("bare-oak")
    assertNull(CardEdges.find(r.luma, r.frame, Chroma.gained(r.cb, r.cr)))
  }

  @Test fun lowContrastAndAPlainPictureAreNoCard() {
    assertNull(CardEdges.find(picture(110, listOf(Shape(card(), 120)), noise = 2), frame))
    assertNull(CardEdges.find(picture(110, emptyList()), frame))
  }

  @Test fun aCardShapedEdgeOutsideTheBandsIsNoCard() {
    assertNull(CardEdges.find(picture(90, listOf(Shape(card(scale = 0.45), 200))), frame))
  }

  @Test fun theWrongProportionsAreRefused() {
    // Edges in all four bands, but the top and bottom near the frame's middle: too long for its height.
    val band = frame.height * CardEdges.BAND
    val c = Quad(
      Pt(frame.left, frame.top + band * 0.9), Pt(frame.right, frame.top + band * 0.9),
      Pt(frame.right, frame.bottom - band * 0.9), Pt(frame.left, frame.bottom - band * 0.9),
    )
    assertNull(CardEdges.find(picture(90, listOf(Shape(c, 200))), frame))
  }

  @Test fun isCardRefusesTooSmallCrossedAndOddlyShapedCorners() {
    assertTrue(CardEdges.isCard(frame.quad(), frame))
    assertFalse("too small", CardEdges.isCard(card(scale = 0.6), frame))
    val c = frame.quad()
    assertFalse("crossed", CardEdges.isCard(Quad(c.tl, c.br, c.tr, c.bl), frame))
    assertFalse("square", CardEdges.isCard(Quad(c.tl, Pt(c.tl.x + frame.height, c.tl.y), Pt(c.tl.x + frame.height, c.bl.y), c.bl), frame))
  }

  @Test fun steadyShowsAfterThreeAndGoesAfterFive() {
    val s = Steady()
    val a = card()
    val b = card(dx = 3.0)
    assertNull(s.add(a))
    assertNull(s.add(a))
    assertNull(s.add(null)) // the run broke: three more are needed
    assertNull(s.add(a))
    assertNull(s.add(a))
    assertCorners(a, s.add(a))
    // The mean of the last three found.
    val shown = s.add(b)!!
    assertEquals(a.tl.x + 1.0, shown.tl.x, 1e-9)
    repeat(4) { assertNotNull(s.add(null)) }
    assertNull(s.add(null))
  }

  @Test fun aYPlaneWithARowStrideCroppedAndTurned() {
    // A 4×4 plane in a buffer with rows of 6 bytes: the value at (x, y) is 10·y + x.
    val buf = ByteBuffer.allocate(6 * 4)
    for (y in 0 until 4) for (x in 0 until 4) buf.put(y * 6 + x, (10 * y + x).toByte())
    fun rows(l: Luma) = (0 until l.height).map { y -> (0 until l.width).map { x -> l.at(x, y) } }
    // Cropped to x 1..3, y 0..1, turned.
    assertEquals(listOf(listOf(1, 2, 3), listOf(11, 12, 13)), rows(Luma.fromPlane(buf, 6, 1, 0, 4, 2, 0)))
    assertEquals(listOf(listOf(11, 1), listOf(12, 2), listOf(13, 3)), rows(Luma.fromPlane(buf, 6, 1, 0, 4, 2, 90)))
    assertEquals(listOf(listOf(13, 12, 11), listOf(3, 2, 1)), rows(Luma.fromPlane(buf, 6, 1, 0, 4, 2, 180)))
    assertEquals(listOf(listOf(3, 13), listOf(2, 12), listOf(1, 11)), rows(Luma.fromPlane(buf, 6, 1, 0, 4, 2, 270)))
    // Every second pixel.
    assertEquals(listOf(listOf(0, 2), listOf(20, 22)), rows(Luma.fromPlane(buf, 6, 0, 0, 4, 4, 0, step = 2)))
  }

  @Test fun argbBecomesItsBrightness() {
    val white = 0xffffffff.toInt()
    val red = 0xffff0000.toInt()
    val l = Luma.fromArgb(intArrayOf(white, red, 0xff000000.toInt(), white), 2, 2)
    assertEquals(listOf(255, 76, 0, 255), listOf(l.at(0, 0), l.at(1, 0), l.at(0, 1), l.at(1, 1)))
  }

  @Test fun uAndVPlanesCroppedTurnedAndGained() {
    // A 6×4 frame's chroma: 3×2 samples, each covering 2×2 pixels; U at (col, row) is 100 + 10·row + col, V 150 + 10·row + col.
    fun rows(l: Luma) = (0 until l.height).map { y -> (0 until l.width).map { x -> l.at(x, y) } }
    for (pixelStride in listOf(1, 2)) {
      val rowStride = 3 * pixelStride + 2
      val u = ByteBuffer.allocate(rowStride * 2)
      val v = ByteBuffer.allocate(rowStride * 2)
      for (row in 0 until 2) for (col in 0 until 3) {
        u.put(row * rowStride + col * pixelStride, (100 + 10 * row + col).toByte())
        v.put(row * rowStride + col * pixelStride, (150 + 10 * row + col).toByte())
      }
      // Cropped to x 1..4, y 1..2: odd offsets, so pixel (0, 0) of the crop is in sample (0, 0) and (1, 1) in (1, 1).
      val c = Chroma.fromPlanes(u, v, rowStride, pixelStride, 1, 1, 5, 3, 0)
      assertEquals("stride $pixelStride", listOf(listOf(44, 47, 47, 50), listOf(74, 77, 77, 80)), rows(c.cb))
      assertEquals("stride $pixelStride", listOf(listOf(194, 197, 197, 200), listOf(224, 227, 227, 230)), rows(c.cr))
      assertEquals(listOf(listOf(74, 44), listOf(77, 47), listOf(77, 47), listOf(80, 50)), rows(Chroma.fromPlanes(u, v, rowStride, pixelStride, 1, 1, 5, 3, 90).cb))
      assertEquals(listOf(listOf(80, 77, 77, 74), listOf(50, 47, 47, 44)), rows(Chroma.fromPlanes(u, v, rowStride, pixelStride, 1, 1, 5, 3, 180).cb))
      assertEquals(listOf(listOf(50, 80), listOf(47, 77), listOf(47, 77), listOf(44, 74)), rows(Chroma.fromPlanes(u, v, rowStride, pixelStride, 1, 1, 5, 3, 270).cb))
    }
  }

  @Test fun uAndVPlanesEveryOtherPixelAndToTheBuffersLastByte() {
    // As Luma.fromPlane's step: every second pixel of the crop, each taking the sample it lies in. The buffers end
    // at the last sample's byte, as a camera's last row does (it isn't padded to the row stride).
    fun rows(l: Luma) = (0 until l.height).map { y -> (0 until l.width).map { x -> l.at(x, y) } }
    for (pixelStride in listOf(1, 2)) {
      val rowStride = 3 * pixelStride + 2
      val u = ByteBuffer.allocate(rowStride + 2 * pixelStride + 1)
      val v = ByteBuffer.allocate(rowStride + 2 * pixelStride + 1)
      for (row in 0 until 2) for (col in 0 until 3) {
        u.put(row * rowStride + col * pixelStride, (100 + 10 * row + col).toByte())
        v.put(row * rowStride + col * pixelStride, (150 + 10 * row + col).toByte())
      }
      val c = Chroma.fromPlanes(u, v, rowStride, pixelStride, 0, 0, 6, 4, 0, step = 2)
      assertEquals("stride $pixelStride", listOf(listOf(44, 47, 50), listOf(74, 77, 80)), rows(c.cb))
      assertEquals("stride $pixelStride", listOf(listOf(194, 197, 200), listOf(224, 227, 230)), rows(c.cr))
      assertEquals("stride $pixelStride", listOf(listOf(44, 47, 47, 50, 50), listOf(74, 77, 77, 80, 80)), rows(Chroma.fromPlanes(u, v, rowStride, pixelStride, 1, 1, 6, 3, 0).cb))
    }
    // A Y plane's last row unpadded too.
    val y = ByteBuffer.allocate(8 + 4)
    for (i in 0 until 12) y.put(i, i.toByte())
    assertEquals(listOf(listOf(1, 2, 3), listOf(9, 10, 11)), (0 until 2).map { r -> (0 until 3).map { x -> Luma.fromPlane(y, 8, 1, 0, 4, 2, 0).at(x, r) } })
  }

  @Test fun theSameArrayIsNotTakenForBothPlanes() {
    val u = ByteBuffer.allocate(16)
    val shared = ByteArray(8)
    assertThrows(IllegalArgumentException::class.java) { Chroma.fromPlanes(u, u, 4, 1, 0, 0, 4, 2, 0, cbInto = shared, crInto = shared) }
  }

  @Test fun planesFillTheArraysGivenWhenTheyFit() {
    val u = ByteBuffer.allocate(16)
    val y = ByteBuffer.allocate(64)
    val cb = ByteArray(8)
    val cr = ByteArray(8)
    val luma = ByteArray(8)
    val c = Chroma.fromPlanes(u, u, 4, 1, 0, 0, 4, 2, 0, cbInto = cb, crInto = cr)
    assertTrue(c.cb.pixels === cb && c.cr.pixels === cr)
    assertTrue(Luma.fromPlane(y, 8, 0, 0, 4, 2, 0, into = luma).pixels === luma)
    // The crop grew: arrays of the old size are left alone.
    val bigger = Chroma.fromPlanes(u, u, 4, 1, 0, 0, 4, 4, 0, cbInto = cb, crInto = cr)
    assertTrue(bigger.cb.pixels !== cb && bigger.cb.pixels.size == 16)
    assertTrue(Luma.fromPlane(y, 8, 0, 0, 4, 4, 0, into = luma).pixels !== luma)
  }

  @Test fun argbBecomesItsColour() {
    fun argb(r: Int, g: Int, b: Int) = (0xff shl 24) or (r shl 16) or (g shl 8) or b
    val c = Chroma.fromArgb(intArrayOf(argb(100, 100, 100), argb(200, 150, 100), argb(255, 0, 0), argb(0, 0, 255)), 2, 2)
    assertEquals(listOf(128, 29, 0, 255), listOf(c.cb.at(0, 0), c.cb.at(1, 0), c.cb.at(0, 1), c.cb.at(1, 1)))
    assertEquals(listOf(128, 215, 255, 65), listOf(c.cr.at(0, 0), c.cr.at(1, 0), c.cr.at(0, 1), c.cr.at(1, 1)))
    // Before the gain: pure blue's Cb and pure red's Cr would be 256.
    assertEquals(listOf(95, 255, 85), listOf(Chroma.cbOf(200, 150, 100), Chroma.cbOf(0, 0, 255), Chroma.cbOf(255, 0, 0)))
    assertEquals(listOf(157, 255, 107), listOf(Chroma.crOf(200, 150, 100), Chroma.crOf(255, 0, 0), Chroma.crOf(0, 0, 255)))
  }

  @Test fun cornersAsFractionsMapOntoAPictureOfAnotherSize() {
    val q = Quad(Pt(57.6, 128.0), Pt(518.4, 128.0), Pt(518.4, 640.0), Pt(57.6, 640.0))
    val f = q.fractions(w, h)
    assertEquals(listOf(0.1, 0.1, 0.9, 0.1, 0.9, 0.5, 0.1, 0.5), f.map { Math.round(it * 1000) / 1000.0 })
    val big = Quad.ofFractions(f, 864, 1920)
    assertEquals(Pt(86.4, 192.0), Pt(Math.round(big.tl.x * 10) / 10.0, Math.round(big.tl.y * 10) / 10.0))
    assertEquals(777.6, big.br.x, 1e-9)
  }

  @Test fun theFrameIsCardShapedAndPlaced() {
    assertEquals(0.86 * w, frame.width, 1e-9)
    assertEquals(frame.width / CardEdges.CARD_RATIO, frame.height, 1e-9)
    assertEquals(0.45 * h, (frame.top + frame.bottom) / 2, 1e-9)
    assertEquals(w / 2.0, (frame.left + frame.right) / 2, 1e-9)
  }
}
