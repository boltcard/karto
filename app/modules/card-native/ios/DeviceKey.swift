import CardLogic
import ExpoModulesCore
import Foundation
import Security

/// The phone's device key (P-256), as android/.../DeviceKey.kt: made once, never exported, signs every request
/// to cardd. On a phone it is in the Secure Enclave or it is not made at all; only the simulator, which has
/// none, gets a plain Keychain key, and which of the two is built is settled when the app is compiled. Usable
/// after the first unlock, so the background backup check can sign with the phone locked, and never copied to
/// another device.
///
/// What the Keychain's answers mean is CardLogic's KeyRule, tested on Linux: only "not found" is no key.
/// Every call comes on `queue`, one after another: the Keychain would keep two keys under one tag.
///
/// The key outlives the app on an iPhone (the Keychain keeps it when the app is deleted). Nothing here deletes
/// it by itself: the app asks, in removeWallet.
enum DeviceKey {
  static let queue = DispatchQueue(label: "tech.whitewolf.karto.device-key")
  private static let tag = Data("card-app-device-key".utf8)

  static func noKey() -> Exception {
    Exception(name: "NoDeviceKeyException", description: "this phone has no device key", code: "ERR_NO_DEVICE_KEY")
  }

  private static func failed(_ what: String, status: OSStatus) -> Exception {
    Exception(name: "DeviceKeyException", description: KeyRule.words(what, status: status), code: "ERR_DEVICE_KEY")
  }

  private static func failed(_ what: String, _ error: Unmanaged<CFError>?) -> Exception {
    guard let e = error?.takeRetainedValue() else {
      return Exception(name: "DeviceKeyException", description: "\(what) failed", code: "ERR_DEVICE_KEY")
    }
    return failed(what, status: OSStatus(truncatingIfNeeded: CFErrorGetCode(e)))
  }

  private static var query: [String: Any] {
    [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    ]
  }

  /// The key; nil when the Keychain says there is none. Any other answer of the Keychain throws: a phone not
  /// unlocked since it was started must not be told it has no key.
  private static func find() throws -> SecKey? {
    var q = query
    q[kSecReturnRef as String] = true
    var item: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &item)
    switch KeyRule.lookup(status: status) {
    case .absent:
      return nil
    case .failed(let status):
      throw failed("reading the key", status: status)
    case .found:
      guard let item, CFGetTypeID(item) == SecKeyGetTypeID() else { throw failed("reading the key", status: status) }
      return (item as! SecKey)
    }
  }

  private static func generate(secureEnclave: Bool) throws -> SecKey {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, secureEnclave ? .privateKeyUsage : [], &error
    ) else { throw failed("making the key's access rule", error) }
    var attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag,
        kSecAttrAccessControl as String: access,
      ] as [String: Any],
    ]
    if secureEnclave { attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave }
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else { throw failed("making the key", error) }
    return key
  }

  private static func publicHex(_ key: SecKey) throws -> String {
    var error: Unmanaged<CFError>?
    guard let pub = SecKeyCopyPublicKey(key), let data = SecKeyCopyExternalRepresentation(pub, &error) as Data? else {
      throw failed("reading the public key", error)
    }
    // ANSI X9.63: 04 || X || Y, as cardd wants it.
    return Hex.encode(data)
  }

  /// Makes the key if there is none; returns its public key (uncompressed hex).
  static func create() throws -> String {
    if let key = try find() { return try publicHex(key) }
    // No quiet fallback on a phone: a Secure Enclave that fails must fail the call, not hand back a weaker key
    // that looks the same from outside.
    #if targetEnvironment(simulator)
    let key = try generate(secureEnclave: false)
    #else
    let key = try generate(secureEnclave: true)
    #endif
    return try publicHex(key)
  }

  static func publicKeyHex() throws -> String {
    guard let key = try find() else { throw noKey() }
    return try publicHex(key)
  }

  /// Android's name for it; here, whether the key is in the Secure Enclave. false when there is no key.
  static func isSecureEnclave() throws -> Bool {
    guard let key = try find(), let attrs = SecKeyCopyAttributes(key) as? [String: Any] else { return false }
    return (attrs[kSecAttrTokenID as String] as? String) == (kSecAttrTokenIDSecureEnclave as String)
  }

  /// ECDSA over SHA-256 of the UTF-8 message, DER, hex.
  static func sign(_ message: String) throws -> String {
    guard let key = try find() else { throw noKey() }
    var error: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, Data(message.utf8) as CFData, &error) as Data? else {
      throw failed("signing", error)
    }
    return Hex.encode(sig)
  }

  /// Removes every key under the tag. None there counts as done; any other failure throws, so the app never
  /// records a removal that did not happen.
  static func delete() throws {
    let status = SecItemDelete(query as CFDictionary)
    if case .failed(let status) = KeyRule.deleted(status: status) { throw failed("deleting the key", status: status) }
  }
}
