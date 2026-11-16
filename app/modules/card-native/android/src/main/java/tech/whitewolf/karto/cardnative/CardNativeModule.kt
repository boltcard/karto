package tech.whitewolf.karto.cardnative

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.cardemulation.CardEmulation
import android.nfc.tech.IsoDep
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import androidx.core.app.NotificationManagerCompat
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.UnifiedPush.VapidNotValidException

class HostKeyMismatchException(message: String) : CodedException("ERR_HOST_KEY_MISMATCH", message, null)
class SshAuthException(message: String) : CodedException("ERR_SSH_AUTH", message, null)
class UploadRefusedException(message: String) : CodedException("ERR_UPLOAD_REFUSED", message, null)
class NoDeviceKeyException : CodedException("ERR_NO_DEVICE_KEY", "this phone has no device key", null)
class CardTagLostException(message: String) : CodedException("ERR_TAG_LOST", message, null)
class PhoneCardRefusedException(message: String) : CodedException("ERR_PHONE_CARD_REFUSED", message, null)
class NoDistributorException : CodedException("ERR_NO_DISTRIBUTOR", "no UnifiedPush distributor is chosen", null)
class BadVapidKeyException : CodedException("ERR_BAD_VAPID", "the server's VAPID key is not an uncompressed P-256 key in base64url", null)

/** ntfy's package: the distributor Google-free phones use. */
private const val NTFY = "io.heckel.ntfy"

private class IsoDepConnection(private val iso: IsoDep) : TagConnection {
  override fun transceive(apdu: ByteArray): ByteArray = iso.transceive(apdu)
  override fun close() = iso.close()
}

/**
 * Reader mode's flags: NFC-A only, Android's NDEF check skipped, and with quiet its tag sound off
 * (https://developer.android.com/reference/android/nfc/NfcAdapter#FLAG_READER_NO_PLATFORM_SOUNDS).
 */
internal object ReaderFlags {
  fun of(quiet: Boolean): Int =
    NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or (if (quiet) NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS else 0)
}

/** JS bindings: src/native/deviceKey.ts, src/native/ssh.ts, src/native/nfc.ts, src/native/phoneCard.ts, src/native/qrScanner.tsx, src/native/cardCamera.tsx and the alerts' (src/native/api.ts). */
class CardNativeModule : Module() {
  private val ssh by lazy { SshSessions() }
  private val deviceKey by lazy { DeviceKey(appContext.reactContext ?: throw IllegalStateException("no context")) }

  private val nfcTags = NfcTags()
  /** Android's tag sound off: set by nfcQuiet while the app's claim in front drops its taps. */
  @Volatile private var readerQuiet = false

  private fun context(): Context = appContext.reactContext ?: throw IllegalStateException("no context")

  private fun nfcAdapter(): NfcAdapter? = appContext.reactContext?.let { NfcAdapter.getDefaultAdapter(it) }

  // Reader mode while a card screen is in front: NFC-A only, Android's own NDEF
  // check skipped, so no other app gets the tap, and its tag sound off while
  // readerQuiet. Android turns it off when the activity pauses and on when it
  // resumes; the keeper turns it on again where Android drops it unasked.
  private val reader = object : ReaderKeeper.Switch {
    override fun on() {
      val activity = appContext.currentActivity ?: return
      val adapter = nfcAdapter() ?: return
      val extras = Bundle().apply { putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 1000) }
      adapter.enableReaderMode(activity, { tag -> onTag(tag) }, ReaderFlags.of(readerQuiet), extras)
    }

    override fun off() {
      appContext.currentActivity?.let { nfcAdapter()?.disableReaderMode(it) }
    }
  }
  private val mainThread = Handler(Looper.getMainLooper())
  private val keeper = ReaderKeeper(reader, { ms, run ->
    val job = Runnable(run)
    mainThread.postDelayed(job, ms)
    ({ mainThread.removeCallbacks(job) })
  }) { !nfcTags.isEmpty() }

  // Apps installed, updated or removed: the ones Android lets this app see (Karto Wallet sees Karto PoS).
  private val packages = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = keeper.packagesChanged()
  }

  // The phone as a card. Armed: PhoneCardService has taps to
  // hand out and is the service Android gives a reader's commands to while this activity is in front.
  @Volatile private var phoneCardArmed = false

  private fun phoneCardComponent(context: Context) = ComponentName(context, PhoneCardService::class.java)

  /** Host card emulation and NFC on this phone, and a build that declares the service: Karto PoS's does not. */
  private fun phoneCardSupported(): Boolean {
    val context = appContext.reactContext ?: return false
    if (nfcAdapter() == null || !context.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION)) return false
    return try {
      context.packageManager.getServiceInfo(phoneCardComponent(context), 0)
      true
    } catch (e: PackageManager.NameNotFoundException) {
      false
    }
  }

  /** Empties the service, gives up the preference, and answers how many taps a reader was handed. */
  private fun phoneCardDisarm(): Int {
    phoneCardArmed = false
    val given = PhoneCardService.tag.clear()
    try {
      appContext.currentActivity?.let { activity -> nfcAdapter()?.let { CardEmulation.getInstance(it).unsetPreferredService(activity) } }
    } catch (e: RuntimeException) {
      // The activity is no longer in front: Android has dropped the preference itself.
    }
    return given
  }

  private fun onTag(tag: Tag) {
    val iso = IsoDep.get(tag)
    if (iso == null) {
      sendEvent("nfcTag", mapOf("handle" to -1, "uid" to tag.id.toHex()))
      return
    }
    try {
      iso.connect()
      iso.timeout = 2000
    } catch (e: IOException) {
      return // gone before we could talk to it; the next tap tries again
    }
    sendEvent("nfcTag", mapOf("handle" to nfcTags.add(IsoDepConnection(iso)), "uid" to tag.id.toHex()))
  }

  override fun definition() = ModuleDefinition {
    Name("CardNative")
    Events("sshUploadProgress", "nfcTag", "phoneCardRead", "phoneCardEnded", "onPushEndpoint", "onPushFailed")

    // Each tap handed to a reader is told to the pay screen. Nothing of a tap goes to the phone's log.
    // The taps outlive this module (they are the process's): a module made again, after the app's JavaScript is
    // loaded afresh, starts with none, and one that goes leaves none behind.
    OnCreate {
      PhoneCardService.tag.clear()
      PhoneCardService.tag.onGiven = { given, left -> sendEvent("phoneCardRead", mapOf("given" to given, "left" to left)) }
      AlertEndpoint.listener = { event, body -> sendEvent(event, body) }
      val filter = IntentFilter().apply {
        addAction(Intent.ACTION_PACKAGE_ADDED)
        addAction(Intent.ACTION_PACKAGE_REPLACED)
        addAction(Intent.ACTION_PACKAGE_REMOVED)
        addDataScheme("package")
      }
      appContext.reactContext?.let {
        // The system's broadcasts reach a receiver not exported to other apps.
        if (Build.VERSION.SDK_INT >= 33) it.registerReceiver(packages, filter, Context.RECEIVER_NOT_EXPORTED) else it.registerReceiver(packages, filter)
      }
    }
    OnDestroy {
      PhoneCardService.tag.onGiven = null
      PhoneCardService.tag.clear()
      AlertEndpoint.listener = null
      runCatching { appContext.reactContext?.unregisterReceiver(packages) }
      keeper.stop()
    }

    // The QR scanner on Send out (src/native/qrScanner.tsx).
    View(QrScannerView::class) {
      Events("onCode")
    }

    // The card camera on the photo screen (src/native/cardCamera.tsx): JS names it CardCameraView.
    View(CardCameraView::class) {
      Events("onFound", "onError")
      Prop("frameWidth") { view: CardCameraView, fraction: Double -> view.frameWidth = fraction }
      Prop("frameCentreY") { view: CardCameraView, fraction: Double -> view.frameCentreY = fraction }
      AsyncFunction("takePhoto") Coroutine { view: CardCameraView -> view.takePhoto() }
    }

    // The photo probe's: the thumbnail CardThumb makes from a JPEG, corners as fractions of it.
    AsyncFunction("cardThumbnail") Coroutine { jpeg: String, corners: List<Double> ->
      withContext(Dispatchers.Default) {
        Base64.encodeToString(CardThumb.fromJpeg(Base64.decode(jpeg, Base64.NO_WRAP), corners), Base64.NO_WRAP)
      }
    }

    AsyncFunction("deviceKeyCreate") { deviceKey.create() }
    AsyncFunction("devicePublicKey") { noKeyCoded { deviceKey.publicKeyHex() } }
    AsyncFunction("deviceKeyIsStrongBox") { deviceKey.isStrongBox() }
    AsyncFunction("deviceSign") { message: String -> noKeyCoded { deviceKey.sign(message) } }

    // Whether another app on the phone is signed by the key this app is signed by now, for Karto Wallet before it
    // hands Karto PoS a pairing code (src/wallet/posLaunch.ts). The signers the two apps have now are compared
    // (Signers.kt says why checkSignatures is not asked). A package this app's <queries> doesn't name reads as absent.
    AsyncFunction("signedLikeThisApp") { packageName: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("no context")
      val pm = context.packageManager
      val theirs = try {
        Signers.now(pm, packageName)
      } catch (e: PackageManager.NameNotFoundException) {
        return@AsyncFunction "absent"
      }
      Signers.compare(Signers.now(pm, context.packageName), theirs)
    }

    // SSH calls can run for minutes (install.sh system, the 11 MB upload). Plain AsyncFunctions share
    // one queue with every other module's, so these run as coroutines on the IO pool instead.
    // A text file from the APK's assets (the server bundle's manifest.json).
    AsyncFunction("readAssetText") Coroutine { path: String ->
      withContext(Dispatchers.IO) {
        val assets = (appContext.reactContext ?: throw IllegalStateException("no context")).assets
        assets.open(path).bufferedReader().use { it.readText() }
      }
    }

    AsyncFunction("sshScanHostKey") Coroutine { host: String, port: Int ->
      withContext(Dispatchers.IO) {
        val (type, blob) = ssh.scanHostKey(host, port)
        mapOf("keyType" to type, "publicKey" to blob)
      }
    }

    AsyncFunction("sshConnect") Coroutine { host: String, port: Int, user: String, hostKeyType: String, hostKeyBlob: String, seedHex: String ->
      withContext(Dispatchers.IO) {
        try {
          ssh.connect(host, port, user, hostKeyType, hostKeyBlob, seedHex)
        } catch (e: HostKeyMismatch) {
          throw HostKeyMismatchException(e.message ?: "host key mismatch")
        } catch (e: SshAuthFailed) {
          throw SshAuthException(e.message ?: "the server refused the key")
        }
      }
    }
    AsyncFunction("sshExec") Coroutine { id: Int, command: String, stdin: String? ->
      withContext(Dispatchers.IO) {
        val r = ssh.exec(id, command, stdin)
        mapOf("code" to r.code, "stdout" to r.stdout, "stderr" to r.stderr)
      }
    }
    AsyncFunction("sshUploadBytes") Coroutine { id: Int, remotePath: String, base64: String, mode: Int ->
      withContext(Dispatchers.IO) {
        val data = Base64.decode(base64, Base64.NO_WRAP)
        refusalCoded { ssh.upload(id, remotePath, data.size.toLong(), { data.inputStream() }, mode) }
      }
    }
    // Files bundled in the APK's assets (the cardd binary and deploy/), streamed without passing through JS.
    // The size comes from the bundle manifest: compressed assets can't report their length.
    AsyncFunction("sshUploadAsset") Coroutine { id: Int, remotePath: String, asset: String, size: Double, mode: Int ->
      withContext(Dispatchers.IO) {
        val assets = (appContext.reactContext ?: throw IllegalStateException("no context")).assets
        refusalCoded {
          ssh.upload(id, remotePath, size.toLong(), { assets.open(asset) }, mode) { sent ->
            sendEvent("sshUploadProgress", mapOf("id" to id, "remotePath" to remotePath, "sent" to sent.toDouble()))
          }
        }
      }
    }
    AsyncFunction("sshClose") Coroutine { id: Int -> withContext(Dispatchers.IO) { ssh.close(id) } }
    AsyncFunction("nfcState") {
      val adapter = nfcAdapter()
      when {
        adapter == null -> "unsupported"
        !adapter.isEnabled -> "off"
        else -> "on"
      }
    }
    AsyncFunction("nfcSettings") {
      val activity = appContext.currentActivity ?: throw IllegalStateException("no activity")
      activity.startActivity(Intent(Settings.ACTION_NFC_SETTINGS))
    }
    // A phone answers a reader as a card only while it reads no cards itself: the keeper waits while armed.
    AsyncFunction("nfcStart") { keeper.start() }.runOnQueue(Queues.MAIN)
    // Reader mode turned on again with the new flags if it is on: the sound is Android's, played as it finds a tag.
    AsyncFunction("nfcQuiet") { quiet: Boolean ->
      if (readerQuiet != quiet) {
        readerQuiet = quiet
        keeper.changed()
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("nfcStop") {
      keeper.stop()
      nfcTags.closeAll()
    }.runOnQueue(Queues.MAIN)
    // Each command waits on the card (up to IsoDep's 2 s timeout): off the module queue.
    AsyncFunction("nfcTransceive") Coroutine { handle: Int, apduHex: String ->
      withContext(Dispatchers.IO) {
        try {
          nfcTags.transceive(handle, apduHex.hexToBytes()).toHex()
        } catch (e: TagGone) {
          throw CardTagLostException(e.message ?: "the card was moved away")
        }
      }
    }
    AsyncFunction("nfcClose") { handle: Int -> nfcTags.close(handle) }
    AsyncFunction("phoneCardSupported") { phoneCardSupported() }
    // files: the NDEF file of each tap, in hex. Refused, with nothing kept, unless the activity is in front and
    // Android answers yes to the preference: it says no when the phone's payment app claims the application too
    // and its owner has disallowed apps in front from overriding it.
    AsyncFunction("phoneCardArm") { files: List<String> ->
      val activity = appContext.currentActivity ?: throw PhoneCardRefusedException("the app is not in front")
      val adapter = nfcAdapter()
      if (adapter == null || !phoneCardSupported()) throw PhoneCardRefusedException("this phone can't be a card")
      keeper.arm()
      PhoneCardService.tag.load(files.map { it.hexToBytes() })
      val preferred = try {
        CardEmulation.getInstance(adapter).setPreferredService(activity, phoneCardComponent(activity))
      } catch (e: RuntimeException) {
        false
      }
      if (!preferred) {
        PhoneCardService.tag.clear()
        keeper.disarm()
        throw PhoneCardRefusedException("Android didn't give this app the reader")
      }
      phoneCardArmed = true
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("phoneCardAdd") { files: List<String> ->
      if (phoneCardArmed) PhoneCardService.tag.add(files.map { it.hexToBytes() })
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("phoneCardDisarm") {
      val given = phoneCardDisarm()
      keeper.disarm()
      given
    }.runOnQueue(Queues.MAIN)
    // Alerts with the app closed, through UnifiedPush's
    // connector: AlertService gets the endpoint and the alerts. The distributors installed (the app's own when the
    // Play build's embedded one has Play Services to ask), and the one chosen.
    Function("pushDistributors") { UnifiedPush.getDistributors(context()) }
    Function("pushDistributor") { UnifiedPush.getSavedDistributor(context()) }
    // The Play build's embedded distributor, this app's own package, when it is listed: null on a Google-free build
    // and on a Play build without Play Services. An installed distributor such as ntfy is chosen before it.
    Function("pushEmbeddedDistributor") { context().packageName.takeIf { it in UnifiedPush.getDistributors(context()) } }
    // distributor: null for the one chosen before. fresh: a new registration, with a new token and keys, so ntfy
    // hands it to the server it now has as its default. The connector forgets the distributor when its last
    // registration goes, so it is saved after that. The endpoint comes later, as onPushEndpoint.
    AsyncFunction("pushRegister") { vapidPublicKey: String, distributor: String?, fresh: Boolean ->
      val context = context()
      val chosen = distributor ?: UnifiedPush.getSavedDistributor(context) ?: throw NoDistributorException()
      if (fresh) {
        // Its onUnregistered, should one come, is this unregister's: AlertService swallows it, and the app waits on.
        AlertEndpoint.expectedUnregisters.expect(INSTANCE_DEFAULT)
        UnifiedPush.unregister(context)
        AlertEndpoint.drop(context)
      }
      UnifiedPush.saveDistributor(context, chosen)
      try {
        UnifiedPush.register(context, vapid = vapidPublicKey)
      } catch (e: VapidNotValidException) {
        throw BadVapidKeyException()
      }
    }
    AsyncFunction("pushUnregister") {
      val context = context()
      UnifiedPush.unregister(context)
      AlertEndpoint.drop(context)
    }
    // The last endpoint the distributor gave, for an app opened after one came while it was closed.
    Function("pushEndpoint") { AlertEndpoint.saved(context())?.toMap() }
    Function("notificationsAllowed") { NotificationManagerCompat.from(context()).areNotificationsEnabled() }
    // Android 13 asks the person; below it notifications are allowed unless the person blocked them in Settings.
    AsyncFunction("requestNotifications") { promise: Promise ->
      val context = context()
      AlertNotifier.channels(context)
      val allowed = { NotificationManagerCompat.from(context).areNotificationsEnabled() }
      val permissions = appContext.permissions
      if (allowed() || Build.VERSION.SDK_INT < 33 || permissions == null) {
        promise.resolve(allowed())
      } else {
        permissions.askForPermissions({ result ->
          promise.resolve(result[Manifest.permission.POST_NOTIFICATIONS]?.status == PermissionsStatus.GRANTED && allowed())
        }, Manifest.permission.POST_NOTIFICATIONS)
      }
    }
    // Whether Doze leaves an app's connection alone (ntfy's).
    Function("ignoringBatteryOptimizations") { packageName: String ->
      context().getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName) ?: false
    }
    // ntfy itself, for its default server; its store page when it isn't installed.
    Function("openNtfySettings") {
      val context = context()
      val store = listOf("market://details?id=$NTFY", "https://f-droid.org/packages/$NTFY/").map { Intent(Intent.ACTION_VIEW, Uri.parse(it)) }
      val intents = listOfNotNull(context.packageManager.getLaunchIntentForPackage(NTFY)) + store
      val opened = intents.any { intent ->
        try {
          context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
          true
        } catch (e: ActivityNotFoundException) {
          false
        }
      }
      if (!opened) throw IllegalStateException("nothing on this phone opens ntfy or its store page")
    }

    OnActivityEntersForeground { keeper.front() }
    // The activity's pause: the preference is the activity's while it is in front, so the phone stops being a
    // card here, and the app is told how many taps had been handed out.
    OnActivityEntersBackground {
      keeper.back()
      nfcTags.closeAll()
      if (phoneCardArmed) sendEvent("phoneCardEnded", mapOf("given" to phoneCardDisarm()))
      keeper.disarm()
    }
  }
}

/** An upload the server refused reaches JS with a code (src/native/ssh.ts), so it is not taken for a dropped connection. */
private inline fun <T> refusalCoded(block: () -> T): T =
  try {
    block()
  } catch (e: UploadRefused) {
    throw UploadRefusedException(e.message ?: "the server refused the upload")
  }

private inline fun <T> noKeyCoded(block: () -> T): T =
  try {
    block()
  } catch (e: NoDeviceKey) {
    throw NoDeviceKeyException()
  }
