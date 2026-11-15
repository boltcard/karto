import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { base64, bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { vectors } from '../testing/vectors';
import { ageDecrypt, ageEncrypt, AgeError, ageRecipientOf } from './age';

/** Files filippo.io/age encrypted to the phrase vector's backup key (server/internal/backup/agevectors_test.go). */
const ages: { recipient: string; files: { length: number; sha256: string; age: string }[] } = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'testvectors', 'age.json'), 'utf8'),
);
const identity = vectors.phrase.backupAgeIdentity;
const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const otherIdentity = bech32.encode('age-secret-key-', bech32.toWords(new Uint8Array(32).fill(7)), false).toUpperCase();

describe('ageDecrypt', () => {
  it("opens filippo.io/age's files with the phrase's backup key", () => {
    expect(ages.recipient).toBe(vectors.phrase.backupAgeRecipient);
    for (const f of ages.files) {
      expect(ageDecrypt(base64.decode(f.age), identity)).toEqual(pattern(f.length));
    }
  });

  // Hermes has no TextDecoder of its own, and Expo's stand-in reads UTF-8
  // only: the header must be read without one.
  it('needs no TextDecoder', () => {
    const real = globalThis.TextDecoder;
    globalThis.TextDecoder = class {
      constructor() {
        throw new RangeError('Unknown encoding: latin1');
      }
    } as unknown as typeof TextDecoder;
    try {
      expect(ageDecrypt(base64.decode(ages.files[1].age), identity)).toEqual(pattern(15));
    } finally {
      globalThis.TextDecoder = real;
    }
  });

  it('refuses another key', () => {
    expect(() => ageDecrypt(base64.decode(ages.files[1].age), otherIdentity)).toThrow(AgeError);
    expect(() => ageDecrypt(base64.decode(ages.files[1].age), otherIdentity)).toThrow('not encrypted to this key');
  });

  it('refuses a changed, cut or extended file', () => {
    const file = base64.decode(ages.files[2].age);
    const flip = (i: number) => {
      const b = file.slice();
      b[i] ^= 1;
      return b;
    };
    const headerEnd = new TextDecoder().decode(file.subarray(0, 300)).indexOf('\n---') + 1;
    expect(() => ageDecrypt(flip(file.length - 1), identity)).toThrow(AgeError); // the last chunk
    expect(() => ageDecrypt(flip(headerEnd + 10), identity)).toThrow(AgeError); // the header's MAC
    expect(() => ageDecrypt(file.slice(0, file.length - 20), identity)).toThrow(AgeError);
    expect(() => ageDecrypt(file.slice(0, file.length - 17), identity)).toThrow(AgeError); // the last chunk gone
    expect(() => ageDecrypt(new Uint8Array([...file, 0]), identity)).toThrow(AgeError);
    expect(() => ageDecrypt(new TextEncoder().encode('not an age file'), identity)).toThrow('not an age file');
  });
});

describe('ageEncrypt', () => {
  it('round-trips across chunk boundaries, to the recipient of the identity', () => {
    expect(ageRecipientOf(identity)).toBe(vectors.phrase.backupAgeRecipient);
    for (const n of [0, 1, 65536, 65537, 200_000]) {
      const file = ageEncrypt(pattern(n), vectors.phrase.backupAgeRecipient);
      expect(ageDecrypt(file, identity)).toEqual(pattern(n));
    }
  });
});
