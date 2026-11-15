// The request signature cardd checks (server/internal/deviceauth). The signing
// itself happens in the Android Keystore; this module builds what gets signed
// and the header that carries the result.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** method \n path \n ts \n hex(sha256(body)). path includes ?query if present. */
export function canonical(method: string, path: string, ts: number, body: Uint8Array | string): string {
  const bytes = typeof body === 'string' ? utf8ToBytes(body) : body;
  return `${method}\n${path}\n${ts}\n${bytesToHex(sha256(bytes))}`;
}

/** First 16 hex chars of SHA-256 of the uncompressed P-256 public key. */
export function keyId(uncompressedPublicKey: Uint8Array): string {
  return bytesToHex(sha256(uncompressedPublicKey)).slice(0, 16);
}

export function authHeader(keyIdHex: string, ts: number, signatureDer: Uint8Array): string {
  return `Device ${keyIdHex}.${ts}.${bytesToHex(signatureDer)}`;
}
