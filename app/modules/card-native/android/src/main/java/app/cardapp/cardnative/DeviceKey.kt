package app.cardapp.cardnative

import android.content.pm.PackageManager
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

class NoDeviceKey : Exception("this phone has no device key")

/**
 * The phone's device key: a P-256 key made in the Android
 * Keystore that can never leave it. It signs every request to cardd.
 * StrongBox (the Titan M2 on a Pixel) is used when the phone has one.
 */
class DeviceKey(private val context: Context) {
  companion object {
    const val ALIAS = "card-app-device-key"
  }

  private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  /** Makes the key if there is none yet; returns the public key as uncompressed hex. */
  @Synchronized
  fun create(): String {
    if (!keyStore().containsAlias(ALIAS)) generate()
    return publicKeyHex()
  }

  /**
   * The public key as uncompressed hex. Never makes one: Keystore keys aren't in
   * Android's backup, so a restored app must find out it has no key, not get a new one.
   */
  fun publicKeyHex(): String {
    val cert = keyStore().getCertificate(ALIAS) ?: throw NoDeviceKey()
    val pub = cert.publicKey as ECPublicKey
    return KeyEncoding.hex(KeyEncoding.uncompressedPoint(pub.w.affineX, pub.w.affineY))
  }

  fun isStrongBox(): Boolean {
    val ks = keyStore()
    if (!ks.containsAlias(ALIAS)) return false
    val key = ks.getKey(ALIAS, null) as PrivateKey
    val info = java.security.KeyFactory.getInstance(key.algorithm, "AndroidKeyStore")
      .getKeySpec(key, android.security.keystore.KeyInfo::class.java)
    return if (android.os.Build.VERSION.SDK_INT >= 31) {
      info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX
    } else false
  }

  /** SHA256withECDSA over the UTF-8 message; returns the DER signature as hex. */
  fun sign(message: String): String {
    val key = keyStore().getKey(ALIAS, null) as? PrivateKey ?: throw NoDeviceKey()
    val sig = Signature.getInstance("SHA256withECDSA")
    sig.initSign(key)
    sig.update(message.toByteArray(Charsets.UTF_8))
    return KeyEncoding.hex(sig.sign())
  }

  private fun generate() {
    fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setIsStrongBoxBacked(strongBox)
      .build()
    val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
    val hasStrongBox = context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
    try {
      gen.initialize(spec(hasStrongBox))
      gen.generateKeyPair()
    } catch (e: StrongBoxUnavailableException) {
      gen.initialize(spec(false))
      gen.generateKeyPair()
    }
  }
}
