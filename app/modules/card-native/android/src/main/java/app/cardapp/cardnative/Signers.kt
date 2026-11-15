package app.cardapp.cardnative

import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest

/**
 * Who an app on this phone is signed by now, and whether two apps are signed by the same key (deploy/signing/README.md
 * says how the apps are signed). Android's own
 * PackageManager.checkSignatures is not used: from Android 11, when two apps' signers differ and either has a
 * signing history, it compares the oldest certificate of the history, and our apps' histories start from the React
 * Native template's debug key, which everyone has. So only the certificates an app is signed with now are read:
 * never its certificate history.
 */
object Signers {
  /** 'same' when both are signed, and by the very same certificates; else 'other'. */
  fun compare(mine: List<ByteArray>, theirs: List<ByteArray>): String {
    if (mine.isEmpty() || theirs.isEmpty()) return "other"
    val digests = { certs: List<ByteArray> -> certs.map { KeyEncoding.hex(MessageDigest.getInstance("SHA-256").digest(it)) }.toSet() }
    return if (digests(mine) == digests(theirs)) "same" else "other"
  }

  /**
   * The certificates a package is signed with now; PackageManager.NameNotFoundException when there is no such
   * package (or it isn't visible). Below Android 9 there is no key rotation: what such a phone reports is the
   * older scheme's signer, the debug key, for our apps and for anyone's who signs with it. So there it answers
   * with none, and compare says 'other': the wallet hands its code to no other app on such a phone.
   */
  fun now(pm: PackageManager, packageName: String): List<ByteArray> {
    val info = pm.getPackageInfo(packageName, if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else 0)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return emptyList()
    return info.signingInfo?.apkContentsSigners?.map { it.toByteArray() } ?: emptyList()
  }
}
