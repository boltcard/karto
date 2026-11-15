import Crypto
import Foundation
import NIOSSH

/// Key-format helpers, as android/.../KeyEncoding.kt has them for the JVM.
public enum KeyEncoding {
  /// The phrase's SSH seed was not 32 bytes of hex.
  public struct BadSeed: Error, CustomStringConvertible {
    public let description = "the SSH key's seed is not 32 bytes of hex"
  }

  /// The phrase-derived SSH key (keys.sshEd25519Seed) as the SSH library wants it.
  public static func ed25519PrivateKey(seed: [UInt8]) throws -> NIOSSHPrivateKey {
    guard seed.count == 32 else { throw BadSeed() }
    return NIOSSHPrivateKey(ed25519Key: try Curve25519.Signing.PrivateKey(rawRepresentation: Data(seed)))
  }

  /// "ssh-ed25519" and the base64 blob, exactly as LNVPS's host_ssh_keys and known_hosts show them.
  public static func sshKeyTypeAndBlob(_ key: NIOSSHPublicKey) -> (type: String, blob: String) {
    let parts = String(openSSHPublicKey: key).split(separator: " ", maxSplits: 1)
    return (String(parts[0]), parts.count > 1 ? String(parts[1]) : "")
  }
}
