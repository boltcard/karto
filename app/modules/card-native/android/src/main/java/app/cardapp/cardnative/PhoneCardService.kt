package app.cardapp.cardnative

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * The phone as a card: Android hands this service a reader's
 * commands for the NDEF application while Karto Wallet is in front and has named it the preferred service. It
 * only passes them to PhoneCardTag. Karto Wallet's build declares it (app/plugins/withPhoneCard.js); Karto PoS's
 * does not, so there it is never started.
 */
class PhoneCardService : HostApduService() {
  override fun processCommandApdu(apdu: ByteArray, extras: Bundle?): ByteArray = tag.answer(apdu)

  override fun onDeactivated(reason: Int) = tag.deactivated()

  companion object {
    /**
     * The taps to hand out, in the app's process and nowhere else: a service Android starts with the wallet not
     * running finds none, and answers a reader as no Bolt Card.
     */
    val tag = PhoneCardTag()
  }
}
