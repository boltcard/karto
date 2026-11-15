/// What the Keychain's answers mean for the phone's key. The app takes "no key" to mean the wallet must be paired again, so only the Keychain saying the key
/// is not there may be reported so: a phone not yet unlocked since it was started answers differently, and its key
/// is still there. The statuses are Apple's OSStatus values (Security's errSec… constants), as plain numbers so
/// this file builds where Security is not.
public enum KeyRule {
  /// errSecSuccess.
  public static let success: Int32 = 0
  /// errSecItemNotFound.
  public static let notFound: Int32 = -25300
  /// errSecInteractionNotAllowed: the Keychain cannot be read now (before the first unlock).
  public static let interactionNotAllowed: Int32 = -25308

  public enum Lookup: Equatable, Sendable {
    case found
    /// The Keychain says there is no such key: the one answer reported as ERR_NO_DEVICE_KEY.
    case absent
    /// Anything else: reported as ERR_DEVICE_KEY with the status, never as "no key".
    case failed(Int32)
  }

  public static func lookup(status: Int32) -> Lookup {
    switch status {
    case success: return .found
    case notFound: return .absent
    default: return .failed(status)
    }
  }

  public enum Deleted: Equatable, Sendable {
    /// The key went, or was never there.
    case done
    case failed(Int32)
  }

  public static func deleted(status: Int32) -> Deleted {
    status == success || status == notFound ? .done : .failed(status)
  }

  /// The sentence a failure is rejected with.
  public static func words(_ what: String, status: Int32) -> String {
    if status == interactionNotAllowed {
      return "\(what) failed: the Keychain cannot be read until this phone has been unlocked once (status \(status))"
    }
    return "\(what) failed: the Keychain answered with status \(status)"
  }
}
