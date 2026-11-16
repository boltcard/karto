package tech.whitewolf.karto.cardnative

/**
 * What a reader gets from a phone that is a card: a plain NFC
 * Forum Type 4 tag, with the NDEF application, its capability file and an NDEF file, and nothing of an NTAG 424.
 * No Android type is in it, so the module's unit tests run it; PhoneCardService only passes commands to it. The
 * app's own tests read a stand-in with the same rules (src/testing/phoneCardTag.ts).
 *
 * The files are the card's link with one tap's p and c each, made by the app when the pay screen opens. They are
 * held here, in memory, and nowhere else.
 */
class PhoneCardTag(private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 }) {
  /** When a tap was last handed to a reader (nowMs's clock), 0 for never: alerts read it (AlertNotifier.ownTap). */
  @Volatile private var givenAtMs = 0L

  /** How long ago this phone, as a card, last handed a reader a tap; null if it never has since the app started. */
  fun sinceGivenMs(): Long? = givenAtMs.takeIf { it != 0L }?.let { nowMs() - it }

  /** Told each time a file is handed to a reader: how many since the last load, and how many are left. */
  @Volatile var onGiven: ((given: Int, left: Int) -> Unit)? = null

  private val files = ArrayDeque<ByteArray>()
  private var handed = 0
  private var app = false
  private var file: ByteArray? = null

  /** Files handed to a reader since the last load. */
  val given: Int @Synchronized get() = handed
  val left: Int @Synchronized get() = files.size

  /** Takes the NDEF files to hand out, one per tap, replacing any it has. */
  @Synchronized
  fun load(files: List<ByteArray>) {
    this.files.clear()
    this.files.addAll(files)
    handed = 0
    deactivated()
  }

  @Synchronized
  fun add(files: List<ByteArray>) {
    this.files.addAll(files)
  }

  /** Drops what is left and answers how many were handed out. */
  @Synchronized
  fun clear(): Int {
    val given = handed
    load(emptyList())
    return given
  }

  /** The reader left the field: what it had selected is forgotten. */
  @Synchronized
  fun deactivated() {
    app = false
    file = null
  }

  fun answer(apdu: ByteArray): ByteArray {
    var told: Pair<Int, Int>? = null
    val out = synchronized(this) {
      val before = handed
      val answer = answerLocked(apdu)
      if (handed != before) {
        told = handed to files.size
        givenAtMs = nowMs()
      }
      answer
    }
    // Outside the lock: the listener sends an event to the app.
    told?.let { (given, left) -> onGiven?.invoke(given, left) }
    return out
  }

  private fun answerLocked(apdu: ByteArray): ByteArray {
    if (apdu.size < 4) return sw(0x6700)
    val (cla, ins, p1, p2) = apdu.take(4).map { it.toInt() and 0xff }
    if (cla != 0x00) return sw(0x6e00)
    val data = if (apdu.size > 5) apdu.copyOfRange(5, minOf(apdu.size, 5 + (apdu[4].toInt() and 0xff))) else ByteArray(0)
    if (ins == 0xa4 && p1 == 0x04) {
      deactivated()
      // With nothing to give, the phone is no Bolt Card to a reader.
      if (!data.contentEquals(NDEF_APP) || files.isEmpty()) return sw(0x6a82)
      app = true
      return sw(0x9000)
    }
    if (ins == 0xa4 && p1 == 0x00) {
      file = null
      val id = if (data.size == 2) ((data[0].toInt() and 0xff) shl 8) or (data[1].toInt() and 0xff) else -1
      if (!app) return sw(0x6a82)
      when {
        id == CC_FILE -> file = CC
        // Each select of the NDEF file is a new tap, as each read of a plastic card is.
        id == NDEF_FILE && files.isNotEmpty() -> {
          file = files.removeFirst()
          handed++
        }
        else -> return sw(0x6a82)
      }
      return sw(0x9000)
    }
    if (ins == 0xb0) {
      val selected = file ?: return sw(0x6986)
      val offset = (p1 shl 8) or p2
      if (offset > selected.size) return sw(0x6b00)
      val le = if (apdu.size > 4 && apdu[4].toInt() != 0) apdu[4].toInt() and 0xff else 256
      // Past its end the file reads as zeros, as a card's 256-byte file does.
      val out = ByteArray(le + 2)
      selected.copyInto(out, 0, offset, minOf(selected.size, offset + le))
      out[le] = 0x90.toByte()
      return out
    }
    return sw(0x6d00)
  }

  private companion object {
    val NDEF_APP = "d2760000850101".hexToBytes()
    const val CC_FILE = 0xe103
    const val NDEF_FILE = 0xe104

    /** CCLEN 15, mapping 2.0, MLe 255, MLc 52; then the NDEF file: E104, up to 256 bytes, read free, never written. */
    val CC = "000f2000ff00340406e104010000ff".hexToBytes()

    fun sw(n: Int) = byteArrayOf((n shr 8).toByte(), n.toByte())
  }
}
