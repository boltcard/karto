package tech.whitewolf.karto.cardnative

import android.content.Context
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * Where the phone's distributor (ntfy, or the Play build's embedded one) reaches Karto Wallet, through UnifiedPush's connector, which decrypts each message with
 * its own keys. An alert arrives with the wallet's JavaScript not running, so it is composed and posted here. A new
 * endpoint is kept (AlertEndpoint) and told to the app when it runs, which hands it to cardd. Karto Wallet's build
 * declares this service (app/plugins/withAlerts.js); Karto PoS's does not.
 */
class AlertService : PushService() {
  override fun onMessage(message: PushMessage, instance: String) {
    AlertNotifier.post(this, if (message.decrypted) AlertWords.of(message.content) else AlertWords.FALLBACK)
  }

  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    val keys = endpoint.pubKeySet
    when {
      // A fallback distributor's, used while the chosen one's server is down: never handed to cardd. The app keeps
      // the endpoint it has and waits for the chosen distributor's.
      endpoint.temporary -> AlertEndpoint.failed("temporary")
      keys == null -> AlertEndpoint.failed("no-keys")
      else -> AlertEndpoint.save(this, AlertEndpoint.Saved(endpoint.url, keys.pubKey, keys.auth))
    }
  }

  /** "network", "action-required", "vapid-required" or "internal-error". */
  override fun onRegistrationFailed(reason: FailedReason, instance: String) =
    AlertEndpoint.failed(reason.name.lowercase().replace('_', '-'))

  override fun onUnregistered(instance: String) {
    // A fresh registration's own unregister of the old one: not the end of alerts, and the endpoint saved may
    // already be the new registration's.
    if (AlertEndpoint.expectedUnregisters.take(instance)) return
    AlertEndpoint.drop(this)
    AlertEndpoint.failed("unregistered")
  }
}

/**
 * The unregisters a fresh registration makes itself (CardNativeModule's pushRegister), by instance: the next
 * onUnregistered of each within windowMs is that one, and is swallowed. The connector already drops a distributor's
 * UNREGISTERED for a token it no longer has; this is for one that arrives otherwise. The window keeps a distributor
 * that never answers from swallowing a real unregister later.
 */
internal class ExpectedUnregisters(private val now: () -> Long = System::currentTimeMillis, private val windowMs: Long = 60_000) {
  private val until = HashMap<String, Long>()

  @Synchronized fun expect(instance: String) {
    until[instance] = now() + windowMs
  }

  /** Whether this onUnregistered is one expected: true at most once per expect, and only within the window. */
  @Synchronized fun take(instance: String): Boolean {
    val deadline = until.remove(instance) ?: return false
    return now() <= deadline
  }
}

/**
 * The endpoint the distributor gave, with its Web Push keys (base64url, unpadded, as cardd takes them): kept in the
 * app's SharedPreferences "alerts", so the app reads one that came while it was closed, and told to it at once
 * (onPushEndpoint, onPushFailed) while it runs.
 */
internal object AlertEndpoint {
  data class Saved(val endpoint: String, val p256dh: String, val auth: String) {
    fun toMap() = mapOf("endpoint" to endpoint, "p256dh" to p256dh, "auth" to auth)
  }

  /** A fresh registration's own unregisters, which onUnregistered swallows. */
  val expectedUnregisters = ExpectedUnregisters()

  /** The module's events while the app's JavaScript runs: set by CardNativeModule. */
  @Volatile var listener: ((event: String, body: Map<String, Any?>) -> Unit)? = null

  private fun prefs(context: Context) = context.applicationContext.getSharedPreferences("alerts", Context.MODE_PRIVATE)

  fun saved(context: Context): Saved? {
    val p = prefs(context)
    return Saved(p.getString("endpoint", null) ?: return null, p.getString("p256dh", null) ?: return null, p.getString("auth", null) ?: return null)
  }

  fun save(context: Context, s: Saved) {
    prefs(context).edit().putString("endpoint", s.endpoint).putString("p256dh", s.p256dh).putString("auth", s.auth).commit()
    listener?.invoke("onPushEndpoint", s.toMap())
  }

  fun drop(context: Context) {
    prefs(context).edit().clear().commit()
  }

  fun failed(reason: String) {
    listener?.invoke("onPushFailed", mapOf("reason" to reason))
  }
}
