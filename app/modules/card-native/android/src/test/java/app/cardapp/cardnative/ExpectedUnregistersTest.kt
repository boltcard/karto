package app.cardapp.cardnative

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// A fresh registration unregisters the old one first (CardNativeModule's pushRegister): the onUnregistered that may
// bring is swallowed, once, within its window, and only for its instance.
class ExpectedUnregistersTest {
  private var nowMs = 1_000L
  private val expected = ExpectedUnregisters(now = { nowMs }, windowMs = 60_000)

  @Test
  fun anUnregisterNotExpectedIsARealOne() {
    assertFalse(expected.take("default"))
  }

  @Test
  fun theExpectedOneIsSwallowedOnceAndTheNextIsReal() {
    expected.expect("default")
    assertTrue(expected.take("default"))
    assertFalse(expected.take("default"))
  }

  @Test
  fun anotherInstancesUnregisterIsReal() {
    expected.expect("default")
    assertFalse(expected.take("other"))
    assertTrue(expected.take("default"))
  }

  @Test
  fun pastTheWindowItIsRealAgain() {
    expected.expect("default")
    nowMs += 60_000
    assertTrue(expected.take("default"))
    expected.expect("default")
    nowMs += 60_001
    assertFalse(expected.take("default"))
  }
}
