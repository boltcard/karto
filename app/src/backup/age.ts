// age (https://age-encryption.org/v1), the X25519 recipient and STREAM
// payload only, on the @noble libraries the app already has: snapshots are
// encrypted by cardd with filippo.io/age to the phrase's backup key.
// The age-encryption package isn't used: it reaches for
// Web Crypto, which React Native only half provides. ageEncrypt is for tests
// and the phone diagnostics.
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64nopad, bech32 } from '@scure/base';

export class AgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgeError';
  }
}

const VERSION = 'age-encryption.org/v1';
const CHUNK = 64 * 1024;
const TAG = 16;

function bech32Bytes(s: string, hrp: string): Uint8Array {
  const d = bech32.decode(s.toLowerCase() as `${string}1${string}`, 1023);
  if (d.prefix !== hrp) throw new AgeError(`not an age ${hrp === 'age' ? 'recipient' : 'identity'}`);
  const b = bech32.fromWords(d.words);
  if (b.length !== 32) throw new AgeError('an age key is 32 bytes');
  return Uint8Array.from(b);
}

/** The recipient (age1…) of an identity (AGE-SECRET-KEY-1…). */
export function ageRecipientOf(identity: string): string {
  return bech32.encode('age', bech32.toWords(x25519.getPublicKey(bech32Bytes(identity, 'age-secret-key-'))), false);
}

const wrapKey = (shared: Uint8Array, share: Uint8Array, recipient: Uint8Array) =>
  hkdf(sha256, shared, concatBytes(share, recipient), utf8ToBytes('age-encryption.org/v1/X25519'), 32);
const zeroNonce = new Uint8Array(12);
const macKey = (fileKey: Uint8Array) => hkdf(sha256, fileKey, new Uint8Array(0), utf8ToBytes('header'), 32);
const payloadKey = (fileKey: Uint8Array, nonce: Uint8Array) => hkdf(sha256, fileKey, nonce, utf8ToBytes('payload'), 32);

/** STREAM's nonce: an 11-byte big-endian counter and the last-chunk flag. */
function chunkNonce(counter: number, last: boolean): Uint8Array {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setUint32(7, counter);
  n[11] = last ? 1 : 0;
  return n;
}

/**
 * Bytes as a string, one character per byte. Not TextDecoder: Hermes has
 * none, and Expo's stand-in reads UTF-8 only (it throws for 'latin1').
 */
function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Decrypts an age file encrypted to identity's X25519 recipient; throws AgeError if it can't. */
export function ageDecrypt(file: Uint8Array, identity: string): Uint8Array {
  const secret = bech32Bytes(identity, 'age-secret-key-');
  const ours = x25519.getPublicKey(secret);
  // The header is text up to "\n--- <MAC>\n"; the MAC covers it up to "---".
  const head = latin1(file.subarray(0, Math.min(file.length, 64 * 1024)));
  const end = head.indexOf('\n--- ');
  const macEnd = end < 0 ? -1 : head.indexOf('\n', end + 1);
  if (!head.startsWith(VERSION + '\n') || end < 0 || macEnd < 0) throw new AgeError('not an age file');
  const lines = head.slice(VERSION.length + 1, end).split('\n');
  let fileKey: Uint8Array | null = null;
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].startsWith('-> ')) throw new AgeError('not an age file: bad stanza');
    const args = lines[i].slice(3).split(' ');
    const body: string[] = [];
    for (i++; ; i++) {
      if (i >= lines.length) throw new AgeError('not an age file: unfinished stanza');
      body.push(lines[i]);
      if (lines[i].length < 64) break;
    }
    i++;
    if (args[0] !== 'X25519' || args.length !== 2 || fileKey) continue; // another kind of recipient, or grease
    try {
      const share = base64nopad.decode(args[1]);
      const shared = x25519.getSharedSecret(secret, share);
      if (shared.every((b) => b === 0)) continue;
      fileKey = chacha20poly1305(wrapKey(shared, share, ours), zeroNonce).decrypt(base64nopad.decode(body.join('')));
    } catch {
      // not for this identity
    }
  }
  if (!fileKey || fileKey.length !== 16) throw new AgeError('this backup is not encrypted to this key');
  let mac: Uint8Array;
  try {
    mac = base64nopad.decode(head.slice(end + 5, macEnd));
  } catch {
    throw new AgeError('not an age file: bad MAC');
  }
  if (!equal(hmac(sha256, macKey(fileKey), file.subarray(0, end + 4)), mac)) throw new AgeError('the backup header was changed');
  const payload = file.subarray(macEnd + 1);
  if (payload.length < 16 + TAG) throw new AgeError('the backup is cut short');
  const key = payloadKey(fileKey, payload.subarray(0, 16));
  const out: Uint8Array[] = [];
  let rest = payload.subarray(16);
  for (let counter = 0; ; counter++) {
    const last = rest.length <= CHUNK + TAG;
    try {
      const plain = chacha20poly1305(key, chunkNonce(counter, last)).decrypt(rest.subarray(0, last ? rest.length : CHUNK + TAG));
      if (last && plain.length === 0 && counter > 0) throw new Error('empty last chunk');
      out.push(plain);
    } catch {
      throw new AgeError('the backup was changed or cut short');
    }
    if (last) return concatBytes(...out);
    rest = rest.subarray(CHUNK + TAG);
  }
}

/** Encrypts plain to an age X25519 recipient (age1…), as filippo.io/age does. */
export function ageEncrypt(plain: Uint8Array, recipient: string, random: (n: number) => Uint8Array = randomBytes): Uint8Array {
  const to = bech32Bytes(recipient, 'age');
  const fileKey = random(16);
  const eph = random(32);
  const share = x25519.getPublicKey(eph);
  const body = chacha20poly1305(wrapKey(x25519.getSharedSecret(eph, to), share, to), zeroNonce).encrypt(fileKey);
  const header = utf8ToBytes(`${VERSION}\n-> X25519 ${base64nopad.encode(share)}\n${base64nopad.encode(body)}\n---`);
  const mac = hmac(sha256, macKey(fileKey), header);
  const nonce = random(16);
  const key = payloadKey(fileKey, nonce);
  const chunks: Uint8Array[] = [];
  const count = Math.max(1, Math.ceil(plain.length / CHUNK));
  for (let i = 0; i < count; i++) {
    chunks.push(chacha20poly1305(key, chunkNonce(i, i === count - 1)).encrypt(plain.subarray(i * CHUNK, (i + 1) * CHUNK)));
  }
  return concatBytes(header, utf8ToBytes(` ${base64nopad.encode(mac)}\n`), nonce, ...chunks);
}
