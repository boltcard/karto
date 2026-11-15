import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { cardId, deriveCardKeys, k1For } from './cardkeys';
import { buildSun, decryptPicc, parseSun, sunMac, verifySun } from './sun';
import { vectors } from '../testing/vectors';

describe('deriveCardKeys', () => {
  it('matches the DETERMINISTIC.md vector', () => {
    const d = vectors.deterministic;
    const k = deriveCardKeys(hexToBytes(d.issuerKey), hexToBytes(d.uid), d.version);
    const got = Object.fromEntries(Object.entries(k).map(([name, v]) => [name, bytesToHex(v)]));
    expect(got).toEqual(d.expected);
  });
  it('keeps K1 and ID independent of version', () => {
    const issuer = new Uint8Array(16);
    const uid = hexToBytes('04010203040506');
    const a = deriveCardKeys(issuer, uid, 0);
    const b = deriveCardKeys(issuer, uid, 1);
    expect(bytesToHex(a.k0)).not.toBe(bytesToHex(b.k0));
    expect(bytesToHex(a.k1)).toBe(bytesToHex(k1For(issuer)));
    expect(bytesToHex(a.id)).toBe(bytesToHex(b.id));
    expect(bytesToHex(cardId(issuer, uid))).toBe(bytesToHex(a.id));
  });
  it('rejects a UID that is not 7 bytes', () => {
    expect(() => deriveCardKeys(new Uint8Array(16), new Uint8Array(4), 0)).toThrow('uid must be 7 bytes');
  });
});

describe('sun', () => {
  for (const v of vectors.sun) {
    it(`decrypts and verifies ${v.name} (upper-case input)`, () => {
      const parsed = parseSun(v.p.toUpperCase(), v.c.toUpperCase())!;
      const picc = decryptPicc(hexToBytes(v.k1), parsed.p)!;
      expect(bytesToHex(picc.uid)).toBe(v.uid);
      expect(picc.counter).toBe(v.counter);
      expect(verifySun(hexToBytes(v.k2), picc, parsed.c)).toBe(true);
      expect(bytesToHex(sunMac(hexToBytes(v.k2), picc.uid, picc.counter))).toBe(v.c);
    });
  }
  it('builds the tap a card writes: the vector made with random bytes 0102030405, in capitals', () => {
    const v = vectors.sun.find((s) => s.name === 'deterministic-v1-ctr5')!;
    const built = buildSun(hexToBytes(v.k1), hexToBytes(v.k2), hexToBytes(v.uid), v.counter, hexToBytes('0102030405'));
    expect(built).toEqual({ p: v.p.toUpperCase(), c: v.c.toUpperCase() });
  });
  it('builds a tap only from a 7-byte ID, a 24-bit counter and 5 random bytes', () => {
    const k = new Uint8Array(16);
    const uid = hexToBytes('04de5f1eacc040');
    expect(() => buildSun(k, k, uid.subarray(0, 4), 1, new Uint8Array(5))).toThrow('uid must be 7 bytes');
    expect(() => buildSun(k, k, uid, 0x1000000, new Uint8Array(5))).toThrow('counter must be 0 to 16777215');
    expect(() => buildSun(k, k, uid, -1, new Uint8Array(5))).toThrow('counter must be 0 to 16777215');
    expect(() => buildSun(k, k, uid, 1, new Uint8Array(4))).toThrow('5 random bytes');
  });
  it('rejects a tampered MAC', () => {
    const v = vectors.sun[0];
    const parsed = parseSun(v.p, v.c)!;
    parsed.c[0] ^= 1;
    const picc = decryptPicc(hexToBytes(v.k1), parsed.p)!;
    expect(verifySun(hexToBytes(v.k2), picc, parsed.c)).toBe(false);
  });
  it('returns null for another issuer\'s card', () => {
    const v = vectors.sun[0];
    const wrong = new Uint8Array(16);
    wrong[0] = 1;
    expect(decryptPicc(wrong, parseSun(v.p, v.c)!.p)).toBeNull();
  });
  it('returns null for malformed p or c', () => {
    expect(parseSun('ab', '94eed9ee65337086')).toBeNull();
    expect(parseSun('ef963ff7828658a599f3041510671e88', '94eed9ee653370')).toBeNull();
    expect(parseSun('zz963ff7828658a599f3041510671e88', '94eed9ee65337086')).toBeNull();
  });
});
