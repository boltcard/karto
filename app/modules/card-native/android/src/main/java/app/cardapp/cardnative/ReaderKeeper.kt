package app.cardapp.cardnative

/**
 * Keeps reader mode on while the app wants cards. Android's NFC service turns it off without telling the
 * app: when another app's process dies (seen as an update of Karto Wallet under Karto PoS), and by refusing it on a
 * return to the front while it doesn't yet count the app as there ("Caller is not in foreground"). An app can't ask
 * whether reader mode is on, so the keeper turns it off and on again: at once and after AFTER_FRONT on a return to
 * the front, and PACKAGES_MS after a change of apps it can see; never while a card is being read (busy), in the
 * background, or while the phone is a card (armed). Off before on, so Android's service keeps one death watch for
 * the app, as it keeps for one enable: on a return to the front Android turns it on itself. No watch on a timer:
 * off and on drops a card resting on the phone and finds it again, a new tap the till would charge, and on alone
 * adds a death watch in Android's service each time.
 * Android's sources: android.googlesource.com/platform/packages/modules/Nfc, NfcService.setReaderMode and
 * ForegroundUtils.
 */
class ReaderKeeper(private val reader: Switch, private val later: Later, private val busy: () -> Boolean) {
  /** Reader mode on with the module's flags, and off. */
  interface Switch {
    fun on()
    fun off()
  }

  /** Runs after ms on the main thread; returns what cancels it. */
  fun interface Later {
    fun after(ms: Long, run: () -> Unit): () -> Unit
  }

  companion object {
    val AFTER_FRONT = listOf(500L, 2_000L)
    const val PACKAGES_MS = 1_000L
  }

  private var wanted = false
  private var front = true
  private var armed = false
  private val pending = mutableListOf<() -> Unit>()

  private val active get() = wanted && front && !armed

  fun start() {
    if (wanted) return
    wanted = true
    if (active) reader.on()
  }

  fun stop() {
    wanted = false
    cancel()
    reader.off()
  }

  fun front() {
    front = true
    cancel()
    if (!active) return
    again()
    AFTER_FRONT.forEach { schedule(it) }
  }

  /** Android turns reader mode off itself as the activity pauses. */
  fun back() {
    front = false
    cancel()
  }

  fun packagesChanged() {
    if (active) schedule(PACKAGES_MS)
  }

  /** The flags changed (the tag sound): on again with them. */
  fun changed() {
    if (active) again()
  }

  /** The phone becomes a card: it reads none meanwhile. */
  fun arm() {
    armed = true
    cancel()
    reader.off()
  }

  fun disarm() {
    armed = false
    if (active) reader.on()
  }

  private fun again() {
    reader.off()
    reader.on()
  }

  /** What runs is dropped from pending as it runs. */
  private fun schedule(ms: Long) {
    var cancel: (() -> Unit)? = null
    cancel = later.after(ms) {
      pending.remove(cancel)
      if (active && !busy()) again()
    }
    pending += cancel
  }

  private fun cancel() {
    pending.forEach { it() }
    pending.clear()
  }
}
