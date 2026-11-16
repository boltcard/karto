package tech.whitewolf.karto.cardnative

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** How long after this phone, as a card, handed a reader a tap a card's spend or refusal is taken to be that tap. */
internal const val OWN_TAP_MS = 120_000L

/**
 * A card tap's alert (a spend or a refusal) on the phone that was the card for it: the person is holding the phone
 * to the terminal, and the phone card's screen says how it went. cardd can't tell a phone's card from a plastic one,
 * so this phone goes by when it last handed a reader a tap; the owner's other phones are still told.
 */
internal fun ownTap(alert: Alert, sinceGivenMs: Long?): Boolean =
  alert.channel == AlertWords.CHANNEL_SPENDS && !alert.tag.contains("-hour-") && // an hour's summary is no one tap
    sinceGivenMs != null && sinceGivenMs in 0 until OWN_TAP_MS

/**
 * Posts an alert as a notification: on its channel, which the
 * owner can mute in Android's settings, under its tag, so a refusal's later count replaces its window's
 * notification, and opening the wallet at its page when tapped. Shown with the wallet in front too (payments
 * in and out always buzz), except a card tap's alert on the phone that was that card a moment ago.
 */
internal object AlertNotifier {
  /** One id for every alert: the tag tells them apart. */
  private const val ID = 1
  private const val CHARCOAL = 0xff24292f.toInt()
  private val main = Handler(Looper.getMainLooper())

  /** The two channels, made once (Android keeps them, and the owner's changes to them). */
  fun channels(context: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    manager.createNotificationChannels(
      listOf(
        NotificationChannel(AlertWords.CHANNEL_SPENDS, "Card spends and refused taps", NotificationManager.IMPORTANCE_HIGH),
        NotificationChannel(AlertWords.CHANNEL_RECEIVED, "Money received", NotificationManager.IMPORTANCE_DEFAULT),
      ),
    )
  }

  fun post(context: Context, alert: Alert) {
    val app = context.applicationContext
    main.post {
      if (ownTap(alert, PhoneCardService.tag.sinceGivenMs())) return@post
      val manager = NotificationManagerCompat.from(app)
      if (!manager.areNotificationsEnabled()) return@post
      channels(app)
      val builder = NotificationCompat.Builder(app, alert.channel)
        .setSmallIcon(R.drawable.alert_icon)
        .setColor(CHARCOAL)
        .setContentTitle(alert.title)
        .setContentText(alert.text)
        .setContentIntent(opening(app, alert))
        .setAutoCancel(true)
        // Below Android 8, where there are no channels: the channel's importance.
        .setPriority(if (alert.channel == AlertWords.CHANNEL_SPENDS) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
        // A later count of a refusal window buzzes only when its notification isn't showing (dismissed or never seen).
        .setOnlyAlertOnce(alert.update)
      alert.atMs?.let { builder.setWhen(it).setShowWhen(true) }
      try {
        manager.notify(alert.tag, ID, builder.build())
      } catch (e: SecurityException) {
        // Notifications were refused between the check and the post: nothing to show.
      }
    }
  }

  /** The tap: the alert's page in the wallet, or the wallet itself. */
  private fun opening(context: Context, alert: Alert): PendingIntent? {
    val intent = alert.link?.let { Intent(Intent.ACTION_VIEW, Uri.parse(it)).setPackage(context.packageName) }
      ?: context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: return null
    // A link starts a fresh task: with the wallet's task still in recents but its process gone (Android ended it
    // in the background), bringing that task forward would drop the link and show the page it was left on. An alert
    // with no link (the test, the fallback) brings the wallet forward as it was.
    intent.addFlags(if (alert.link != null) Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK else Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(context, alert.tag.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }
}
