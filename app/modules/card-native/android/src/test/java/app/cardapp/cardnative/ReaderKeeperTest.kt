package app.cardapp.cardnative

import org.junit.Assert.assertEquals
import org.junit.Test

// Reader mode kept on while the app wants cards: Android's NFC service turns it off without telling the
// app (another app's process dying, seen as an update of Karto Wallet under the till), and can refuse it on a
// return to the front ("Caller is not in foreground"). An app can't ask whether it is on, so the keeper turns it
// off and on again after a return to the front and after a change of apps, never while a card is being read.
class ReaderKeeperTest {
  private class Clock : ReaderKeeper.Later {
    var now = 0L
    private val due = mutableListOf<Triple<Long, Int, () -> Unit>>()
    private var next = 0

    override fun after(ms: Long, run: () -> Unit): () -> Unit {
      val entry = Triple(now + ms, next++, run)
      due += entry
      return { due.remove(entry) }
    }

    fun pass(ms: Long) {
      val until = now + ms
      while (true) {
        val first = due.filter { it.first <= until }.minWithOrNull(compareBy({ it.first }, { it.second })) ?: break
        due.remove(first)
        now = first.first
        first.third()
      }
      now = until
    }
  }

  private class Reader : ReaderKeeper.Switch {
    val calls = mutableListOf<String>()
    override fun on() { calls += "on" }
    override fun off() { calls += "off" }
  }

  private val clock = Clock()
  private val reader = Reader()
  private var busy = false
  private val keeper = ReaderKeeper(reader, clock) { busy }

  @Test
  fun startTurnsItOnOnceAndStopTurnsItOff() {
    keeper.start()
    keeper.start()
    keeper.stop()
    assertEquals(listOf("on", "off"), reader.calls)
  }

  @Test
  fun aReturnToTheFrontTurnsItOffAndOnNowAndAgainAfterHalfASecondAndTwoSeconds() {
    keeper.start()
    keeper.back()
    reader.calls.clear()
    keeper.front()
    assertEquals(listOf("off", "on"), reader.calls)
    clock.pass(499)
    assertEquals(2, reader.calls.size)
    clock.pass(1)
    assertEquals(listOf("off", "on", "off", "on"), reader.calls)
    clock.pass(1_500)
    assertEquals(6, reader.calls.size)
  }

  // No watch on a timer: turning reader mode off and on drops a card resting on the phone and finds it again, a
  // new tap that the till would charge (seen on a Pixel 8 Pro), and on alone adds a death watch each time.
  @Test
  fun withoutATriggerItIsLeftAlone() {
    keeper.start()
    reader.calls.clear()
    clock.pass(600_000)
    assertEquals(0, reader.calls.size)
  }

  @Test
  fun notWhileACardIsBeingRead() {
    keeper.start()
    keeper.back()
    keeper.front()
    reader.calls.clear()
    busy = true
    clock.pass(500)
    keeper.packagesChanged()
    clock.pass(1_000)
    assertEquals(0, reader.calls.size)
    busy = false
    clock.pass(1_000)
    // The one at 2 s, the card gone by then.
    assertEquals(listOf("off", "on"), reader.calls)
  }

  @Test
  fun nothingInTheBackgroundOrAfterStop() {
    keeper.start()
    keeper.back()
    reader.calls.clear()
    clock.pass(60_000)
    keeper.packagesChanged()
    clock.pass(60_000)
    assertEquals(0, reader.calls.size)
    keeper.front()
    keeper.stop()
    reader.calls.clear()
    clock.pass(60_000)
    keeper.front()
    keeper.packagesChanged()
    clock.pass(60_000)
    assertEquals(0, reader.calls.size)
  }

  @Test
  fun aChangeOfAppsTurnsItOffAndOnAfterASecond() {
    keeper.start()
    reader.calls.clear()
    keeper.packagesChanged()
    clock.pass(999)
    assertEquals(0, reader.calls.size)
    clock.pass(1)
    assertEquals(listOf("off", "on"), reader.calls)
  }

  // While the phone is a card it reads none.
  @Test
  fun whileThePhoneIsACardItStaysOffAndComesBackOnAfter() {
    keeper.start()
    reader.calls.clear()
    keeper.arm()
    clock.pass(30_000)
    keeper.front()
    keeper.packagesChanged()
    clock.pass(30_000)
    assertEquals(listOf("off"), reader.calls)
    keeper.disarm()
    assertEquals(listOf("off", "on"), reader.calls)
  }

  @Test
  fun aChangeOfSoundTurnsItOffAndOnWithTheNewFlagsOnlyWhileItIsOn() {
    keeper.changed()
    keeper.start()
    reader.calls.clear()
    keeper.changed()
    assertEquals(listOf("off", "on"), reader.calls)
  }
}
