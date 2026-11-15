// SUN (AN12196): decrypt p= and check c= from a Bolt Card URL. Must match server/internal/sun.
import { cbc, cmac } from '@noble/ciphers/aes.js';
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js';

export type Picc = { uid: Uint8Array; counter: number };

const zeroIv = new Uint8Array(16);

/** Decodes p (32 hex) and c (16 hex), any case. Returns null if malformed. */
export function parseSun(p: string, c: string): { p: Uint8Array; c: Uint8Array } | null {
  if (!/^[0-9a-fA-F]{32}$/.test(p) || !/^[0-9a-fA-F]{16}$/.test(c)) return null;
  return { p: hexToBytes(p.toLowerCase()), c: hexToBytes(c.toLowerCase()) };
}

/** Decrypts PICCData with K1. Returns null if it is not ours (tag byte is not 0xc7). */
export function decryptPicc(k1: Uint8Array, p: Uint8Array): Picc | null {
  const d = cbc(k1, zeroIv, { disablePadding: true }).decrypt(p);
  if (d[0] !== 0xc7) return null;
  return { uid: d.slice(1, 8), counter: d[8] | (d[9] << 8) | (d[10] << 16) };
}

export function sunMac(k2: Uint8Array, uid: Uint8Array, counter: number): Uint8Array {
  const ctr = Uint8Array.of(counter & 0xff, (counter >> 8) & 0xff, (counter >> 16) & 0xff);
  const session = cmac(concatBytes(hexToBytes('3cc300010080'), uid, ctr), k2);
  const full = cmac(new Uint8Array(0), session);
  return Uint8Array.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => full[i]));
}

const hexCaps = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

/**
 * A tap's p and c as a card writes them, in capitals: PICCData (C7, the ID, the counter, 5 random bytes) under K1,
 * and the SUN MAC under K2. A phone that is a card makes its own.
 * Must match server/internal/sun's Build.
 */
export function buildSun(k1: Uint8Array, k2: Uint8Array, uid: Uint8Array, counter: number, random: Uint8Array): { p: string; c: string } {
  if (uid.length !== 7) throw new Error(`uid must be 7 bytes, got ${uid.length}`);
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffffff) throw new Error(`counter must be 0 to 16777215, got ${counter}`);
  if (random.length !== 5) throw new Error(`a tap takes 5 random bytes, got ${random.length}`);
  const picc = concatBytes(Uint8Array.of(0xc7), uid, Uint8Array.of(counter & 0xff, (counter >> 8) & 0xff, (counter >> 16) & 0xff), random);
  return { p: hexCaps(cbc(k1, zeroIv, { disablePadding: true }).encrypt(picc)), c: hexCaps(sunMac(k2, uid, counter)) };
}

export function verifySun(k2: Uint8Array, picc: Picc, c: Uint8Array): boolean {
  const want = sunMac(k2, picc.uid, picc.counter);
  let diff = want.length ^ c.length;
  for (let i = 0; i < want.length; i++) diff |= want[i] ^ (c[i] ?? 0);
  return diff === 0;
}
