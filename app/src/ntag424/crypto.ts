// NTAG 424 DNA secure messaging (NXP NT4H2421Gx datasheet, AN12196): the
// EV2First session keys, the truncated MAC, and CommMode.Full encryption.
// bolt-card-programmer's app/class/NTag424.tsx (MIT) was the reference.
import { cbc, cmac, ecb } from '@noble/ciphers/aes.js';
import { concatBytes } from '@noble/hashes/utils.js';

export const ZERO_KEY = new Uint8Array(16);
const ZERO_IV = new Uint8Array(16);

/** An authenticated session: EV2First's keys, the transaction id, and the command counter. */
export type Session = { keyNo: number; enc: Uint8Array; mac: Uint8Array; ti: Uint8Array; ctr: number };

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Rotates left by one byte: RndB' = rotl(RndB). */
export const rotl = (b: Uint8Array): Uint8Array => concatBytes(b.subarray(1), b.subarray(0, 1));
export const le16 = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff);
export const le24 = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff);

/** ISO/IEC 9797-1 method 2: 0x80, then zeros to a whole block. Always adds at least one byte. */
export function pad(data: Uint8Array): Uint8Array {
  const out = new Uint8Array((Math.floor(data.length / 16) + 1) * 16);
  out.set(data);
  out[data.length] = 0x80;
  return out;
}

export function unpad(data: Uint8Array): Uint8Array {
  let i = data.length - 1;
  while (i >= 0 && data[i] === 0) i--;
  if (i < 0 || data[i] !== 0x80) throw new Error('bad padding');
  return data.subarray(0, i);
}

const cbcNoPad = (key: Uint8Array, iv: Uint8Array) => cbc(key, iv, { disablePadding: true });

/** SV1/SV2 = A55A|5AA5 0001 0080 || RndA[15..14] || (RndA[13..8] xor RndB[15..10]) || RndB[9..0] || RndA[7..0]. */
export function sessionKeys(key: Uint8Array, rndA: Uint8Array, rndB: Uint8Array): { enc: Uint8Array; mac: Uint8Array } {
  const mixed = rndA.subarray(2, 8).map((v, i) => v ^ rndB[i]);
  const tail = concatBytes(rndA.subarray(0, 2), mixed, rndB.subarray(6, 16), rndA.subarray(8, 16));
  return {
    enc: cmac(concatBytes(Uint8Array.of(0xa5, 0x5a, 0x00, 0x01, 0x00, 0x80), tail), key),
    mac: cmac(concatBytes(Uint8Array.of(0x5a, 0xa5, 0x00, 0x01, 0x00, 0x80), tail), key),
  };
}

/** EV2First part 2: decrypt the card's RndB, answer E(K, RndA || rotl(RndB)). */
export function authReply(key: Uint8Array, rndA: Uint8Array, encRndB: Uint8Array): { rndB: Uint8Array; message: Uint8Array } {
  const rndB = cbcNoPad(key, ZERO_IV).decrypt(encRndB);
  return { rndB, message: cbcNoPad(key, ZERO_IV).encrypt(concatBytes(rndA, rotl(rndB))) };
}

/** The card's last EV2First answer is E(K, TI || rotl(RndA) || PDcap2 || PCDcap2): check RndA, return TI. */
export function authTi(key: Uint8Array, rndA: Uint8Array, cardReply: Uint8Array): Uint8Array {
  const d = cbcNoPad(key, ZERO_IV).decrypt(cardReply);
  if (!equalBytes(d.subarray(4, 20), rotl(rndA))) throw new Error('the card did not prove it knows the key');
  return d.slice(0, 4);
}

/** CMAC truncated to its odd-indexed bytes (MACt, 8 bytes). */
export function macT(key: Uint8Array, message: Uint8Array): Uint8Array {
  const full = cmac(message, key);
  return Uint8Array.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => full[i]));
}

export const cmdMac = (s: Session, ctr: number, ins: number, data: Uint8Array) =>
  macT(s.mac, concatBytes(Uint8Array.of(ins), le16(ctr), s.ti, data));
export const rspMac = (s: Session, ctr: number, data: Uint8Array) =>
  macT(s.mac, concatBytes(Uint8Array.of(0x00), le16(ctr), s.ti, data));

function iv(s: Session, label: [number, number], ctr: number): Uint8Array {
  const block = concatBytes(Uint8Array.of(...label), s.ti, le16(ctr), new Uint8Array(8));
  return ecb(s.enc, { disablePadding: true }).encrypt(block);
}

export const encryptCmd = (s: Session, ctr: number, data: Uint8Array) => cbcNoPad(s.enc, iv(s, [0xa5, 0x5a], ctr)).encrypt(pad(data));
export const decryptCmd = (s: Session, ctr: number, data: Uint8Array) => unpad(cbcNoPad(s.enc, iv(s, [0xa5, 0x5a], ctr)).decrypt(data));
export const encryptRsp = (s: Session, ctr: number, data: Uint8Array) => cbcNoPad(s.enc, iv(s, [0x5a, 0xa5], ctr)).encrypt(pad(data));
export const decryptRsp = (s: Session, ctr: number, data: Uint8Array) => unpad(cbcNoPad(s.enc, iv(s, [0x5a, 0xa5], ctr)).decrypt(data));

/** CRC32 without the final XOR (JAMCRC), little-endian: ChangeKey's check on a new key. */
export function jamcrc32(data: Uint8Array): Uint8Array {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return Uint8Array.of(c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff);
}
