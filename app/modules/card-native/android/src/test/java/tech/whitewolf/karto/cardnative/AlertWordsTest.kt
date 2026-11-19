package tech.whitewolf.karto.cardnative

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// An alert's words, composed on the phone from cardd's payload.
// testvectors/alerts.json is cardd's: every case's title and text are the truth the phone must give.
class AlertWordsTest {
  private val cases = JSONObject(File(System.getProperty("user.dir"), "../../../../testvectors/alerts.json").readText()).getJSONArray("cases")
  private fun case(name: String): JSONObject = (0 until cases.length()).map { cases.getJSONObject(it) }.first { it.getString("name") == name }
  private fun alert(name: String) = AlertWords.of(case(name).getJSONObject("payload").toString().toByteArray())

  @Test
  fun everyCaseGivesItsTitleAndText() {
    assertTrue(cases.length() >= 24)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val a = AlertWords.of(c.getJSONObject("payload").toString().toByteArray())
      assertEquals(c.getString("name"), c.getString("title"), a.title)
      assertEquals(c.getString("name"), c.getString("text"), a.text)
      // cardd's test writes each case's link from the payload: the phone must make the same one ("" for none).
      assertEquals(c.getString("name"), c.getString("link"), a.link ?: "")
    }
  }

  @Test
  fun spendsAndRefusalsGoToTheSpendsChannelMoneyInAndTheTestToReceived() {
    assertEquals("alerts-spends", alert("spend").channel)
    assertEquals("alerts-spends", alert("refused-daily").channel)
    assertEquals("alerts-received", alert("topup-card").channel)
    assertEquals("alerts-received", alert("sale-priced").channel)
    assertEquals("alerts-received", alert("test").channel)
  }

  @Test
  fun aHostingAlertOpensHostingOnTheReceivedChannelUnderOneTag() {
    val a = alert("hosting-low-5")
    assertEquals("alerts-received", a.channel)
    assertEquals("karto://account?id=hosting", a.link)
    // Each day's replaces the last.
    assertEquals("hosting-low", a.tag)
    assertFalse(ownTap(a, 60_000))
  }

  @Test
  fun theUnpaidCapsAlertOpensTheAppOnTheReceivedChannelUnderOneTag() {
    val a = alert("invoices-capped")
    assertEquals("alerts-received", a.channel)
    assertNull(a.link)
    // A later one replaces the last.
    assertEquals("invoices-capped", a.tag)
    assertFalse(ownTap(a, 60_000))
  }

  @Test
  fun aPaymentOpensItsPageAndARefusalItsCard() {
    assertEquals("karto://payment?account=b1ee&tx=41", alert("topup-card").link)
    assertEquals("karto://payment?account=pool&tx=42", alert("topup-pool").link)
    assertEquals("karto://payment?account=shop&tx=45", alert("sale-priced").link)
    assertEquals("karto://payment?account=b1ee&tx=47", alert("spend").link)
    assertEquals("karto://account?id=b1ee", alert("refused-daily").link)
    // No payment to open: the app opens.
    assertNull(alert("test").link)
  }

  @Test
  fun onlyACardTapsAlertIsQuietOnThePhoneThatWasTheCardAMomentAgo() {
    // The phone handed a reader a tap a minute ago: its card's spend or refusal is that tap.
    assertTrue(ownTap(alert("spend"), 60_000))
    assertTrue(ownTap(alert("refused-per-tap"), 0))
    // Money in, the test and the fallback always show; so does any alert when the phone hasn't been a card lately.
    assertFalse(ownTap(alert("topup-card"), 60_000))
    assertFalse(ownTap(alert("sale-priced"), 60_000))
    assertFalse(ownTap(alert("test"), 60_000))
    assertFalse(ownTap(AlertWords.FALLBACK, 60_000))
    assertFalse(ownTap(alert("refused-hour-summary"), 60_000))
    assertFalse(ownTap(alert("spend"), null))
    assertFalse(ownTap(alert("spend"), OWN_TAP_MS))
  }

  @Test
  fun aRefusalTakesItsWindowsTagAndAPaymentItsTransactions() {
    assertEquals("refused-b1ee-1792238400", alert("refused-daily").tag)
    assertEquals("refused-b1ee-hour-1792242000", alert("refused-hour-summary").tag)
    assertEquals("tx-41", alert("topup-card").tag)
    assertEquals("test", alert("test").tag)
  }

  @Test
  fun aFoldedUpdateIsMarkedSoItAlertsOnlyWhenNotAlreadyShowing() {
    assertTrue(alert("refused-folded").update)
    assertFalse(alert("refused-daily").update)
    assertFalse(alert("refused-hour-summary").update)
  }

  @Test
  fun theTimeIsThePayloadsAt() {
    assertEquals(1792238400_000L, alert("spend").atMs)
  }

  @Test
  fun aPayloadThatDoesNotParseOrIsAnotherVersionGivesTheFallback() {
    val v2 = case("spend").getJSONObject("payload").put("v", 2).toString()
    val noKind = case("spend").getJSONObject("payload").apply { remove("kind") }.toString()
    val oddKind = case("spend").getJSONObject("payload").put("kind", "renewed").toString()
    for (bad in listOf("", "not json", "[1,2]", "{}", v2, noKind, oddKind)) {
      val a = AlertWords.of(bad.toByteArray())
      assertEquals(bad, AlertWords.FALLBACK, a)
    }
    assertEquals("Karto", AlertWords.FALLBACK.title)
    assertEquals("New activity", AlertWords.FALLBACK.text)
    assertEquals("alerts-received", AlertWords.FALLBACK.channel)
    assertNull(AlertWords.FALLBACK.link)
    assertNull(AlertWords.FALLBACK.atMs)
  }

  @Test
  fun anyExceptionWhileReadingGivesTheFallbackNotOnlyJsons() {
    assertEquals(AlertWords.FALLBACK, AlertWords.orFallback { throw IllegalStateException("not org.json's") })
    assertEquals(AlertWords.FALLBACK, AlertWords.orFallback { throw NumberFormatException() })
    assertEquals(AlertWords.FALLBACK, AlertWords.orFallback { null })
    val spend = alert("spend")
    assertEquals(spend, AlertWords.orFallback { spend })
  }

  @Test
  fun aCurrencyThePhoneDoesNotKnowIsLeftOut() {
    val sek = case("spend").getJSONObject("payload").apply { getJSONObject("fiat").put("currency", "SEK") }.toString()
    assertEquals("100 sat spent", AlertWords.of(sek.toByteArray()).text)
  }
}
