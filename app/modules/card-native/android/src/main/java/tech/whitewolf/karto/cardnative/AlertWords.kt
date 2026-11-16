package tech.whitewolf.karto.cardnative

import org.json.JSONObject

/**
 * One alert as the phone shows it. channel: AlertWords.CHANNEL_SPENDS or CHANNEL_RECEIVED. tag: the notification's,
 * so a refusal's later count replaces its window's notification. link: the wallet's page a tap opens, null for the
 * app itself. atMs: when it happened, null for none. update: a later count of a notification already sent, which
 * alerts only when that one is not showing.
 */
internal data class Alert(
  val title: String,
  val text: String,
  val channel: String,
  val tag: String,
  val link: String?,
  val atMs: Long?,
  val update: Boolean,
)

/**
 * An alert's words, composed on the phone from cardd's payload: the app's JavaScript isn't running when one arrives. testvectors/alerts.json holds the words
 * for each payload, and the iPhone's extension composes the same ones from it.
 */
internal object AlertWords {
  const val CHANNEL_SPENDS = "alerts-spends"
  const val CHANNEL_RECEIVED = "alerts-received"

  /** What a payload that doesn't parse, or isn't version 1, shows: the app opens. */
  val FALLBACK = Alert("Karto", "New activity", CHANNEL_RECEIVED, "activity", null, null, false)

  /** Karto Wallet's link scheme (app.json): only the wallet takes alerts. */
  private const val SCHEME = "karto"

  // The currencies cardd prices in, as app/src/money/fiat.ts writes them: symbol and decimals.
  private val CURRENCIES = mapOf(
    "USD" to ("$" to 2), "EUR" to ("€" to 2), "GBP" to ("£" to 2), "CAD" to ("CA$" to 2),
    "CHF" to ("CHF " to 2), "AUD" to ("A$" to 2), "JPY" to ("¥" to 0),
  )

  // A refusal's reason in words, after "was refused: ".
  private val REASONS = mapOf(
    "paused" to "spending is paused",
    "per-tap" to "over its per-payment limit",
    "daily" to "over its daily limit",
    "funds" to "not enough money on the card",
    "invoice" to "the terminal's invoice can't be paid",
  )

  /** The alert for a decrypted payload; FALLBACK for anything it can't read. */
  fun of(payload: ByteArray): Alert = orFallback { read(JSONObject(String(payload, Charsets.UTF_8))) }

  /**
   * The alert block gives, else FALLBACK: for null, and for any exception, not only org.json's, since a payload is
   * read in the alerts' service with the app closed, where a throw would show nothing at all.
   */
  internal fun orFallback(block: () -> Alert?): Alert =
    try {
      block() ?: FALLBACK
    } catch (e: Exception) {
      FALLBACK
    }

  private fun read(p: JSONObject): Alert? {
    if (p.optInt("v", 0) != 1) return null
    val kind = p.str("kind") ?: return null
    if (kind !in listOf("received", "spent", "refused", "test", "hosting")) return null
    val account = p.str("account") ?: ""
    val name = p.str("name") ?: ""
    val card = p.str("card")
    val tx = if (p.isNull("tx")) null else p.optLong("tx")
    val sat = p.optLong("sat")
    val text = when (kind) {
      "received" -> "${thousands(sat)} sat received${fiat(p.optJSONObject("fiat"))}"
      "spent" -> "${thousands(sat)} sat spent${fiat(p.optJSONObject("fiat"))}"
      "refused" -> refused(p.str("reason"), p.optInt("count"), sat, p.optLong("msat"))
      // Hosting's daily alert while it covers under 7 days: count is its whole days.
      "hosting" -> p.optInt("count").let { "Covers about $it ${if (it == 1) "day" else "days"}: top it up or move from Pool" }
      else -> "Alerts work"
    }
    // The app's pages name an account as its API does: pool, hosting, shop, or a card's bare id (cardd's payload
    // says card:<id>). A card's own page is account?id=<id>; card?id= is the screen that holds a card to add it.
    val pageAccount = account.removePrefix("card:")
    val link = when {
      kind == "refused" -> card?.let { "$SCHEME://account?id=${encode(it)}" }
      kind == "hosting" -> "$SCHEME://account?id=hosting"
      tx != null && pageAccount.isNotEmpty() -> "$SCHEME://payment?account=${encode(pageAccount)}&tx=$tx"
      else -> null
    }
    return Alert(
      title = when (kind) {
        "test" -> "Karto"
        "hosting" -> "Hosting"
        else -> title(account, name)
      },
      text = text,
      channel = if (kind == "spent" || kind == "refused") CHANNEL_SPENDS else CHANNEL_RECEIVED,
      tag = p.str("tag")?.takeIf { it.isNotEmpty() } ?: tx?.let { "tx-$it" } ?: kind,
      link = link,
      atMs = if (p.has("at") && !p.isNull("at")) p.optLong("at") * 1000 else null,
      update = p.optBoolean("update", false),
    )
  }

  /** The account's name: the card's ("Blue card"), the till's ("Shop · Till 1"), else the wallet's. */
  private fun title(account: String, name: String): String =
    when {
      account.startsWith("card:") -> if (name.isEmpty()) "Card" else "$name card"
      account == "shop" -> if (name.isEmpty()) "Shop" else "Shop · $name"
      account == "hosting" -> "Hosting"
      else -> "Karto"
    }

  /**
   * A refused tap: one in words, with its amount when the terminal's invoice was read; a 60 s window's or an hour's
   * fold as a count, of spends when the refusals had amounts, else of taps.
   */
  private fun refused(reason: String?, count: Int, sat: Long, msat: Long): String {
    if (count >= 2) return if (msat > 0) "$count spends refused" else "$count taps refused"
    if (reason == "repeated") return "A repeated tap was refused"
    if (reason == "off") return "The card is off: a tap was refused"
    val lead = if (msat > 0) "A ${thousands(sat)} sat spend was refused" else "A tap was refused"
    return REASONS[reason]?.let { "$lead: $it" } ?: lead
  }

  /** " (£0.31)", " (priced £5.00)" for a sale rung up in the currency, or nothing without a currency the phone knows. */
  private fun fiat(f: JSONObject?): String {
    val (symbol, decimals) = CURRENCIES[f?.str("currency")] ?: return ""
    val minor = f!!.optLong("minor", -1)
    if (minor < 0) return ""
    val figures = if (decimals == 0) thousands(minor) else "${thousands(minor / 100)}.${(minor % 100).toString().padStart(2, '0')}"
    return " (${if (f.optBoolean("priced")) "priced " else ""}$symbol$figures)"
  }

  /** 1234567 as "1,234,567". */
  private fun thousands(n: Long): String = String.format(java.util.Locale.ROOT, "%,d", n)

  /** A query value, with all but RFC 3986's unreserved characters escaped. */
  private fun encode(s: String): String =
    buildString {
      for (b in s.toByteArray(Charsets.UTF_8)) {
        val c = b.toInt().toChar()
        if (c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c in "-._~") append(c) else append("%%%02X".format(b.toInt() and 0xff))
      }
    }

  /** A string field, null when absent, null or not a string. */
  private fun JSONObject.str(key: String): String? = opt(key) as? String
}
