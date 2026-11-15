import { describe, expect, it } from 'vitest';
import { p256 } from '@noble/curves/nist.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { authHeader, canonical, keyId } from './deviceauth';
import { vectors } from '../testing/vectors';

const d = vectors.deviceAuth;

describe('deviceauth', () => {
  it('builds the canonical string from the vector', () => {
    expect(canonical(d.method, d.path, d.ts, d.body)).toBe(d.canonical);
  });
  it('computes the key id', () => {
    expect(keyId(hexToBytes(d.publicKey))).toBe(d.keyId);
  });
  it('vector signature verifies over the canonical string', () => {
    expect(p256.verify(hexToBytes(d.signatureDer), utf8ToBytes(d.canonical), hexToBytes(d.publicKey), { format: 'der' })).toBe(true);
  });
  it('formats the header', () => {
    expect(authHeader(d.keyId, d.ts, hexToBytes(d.signatureDer))).toBe(`Device ${d.keyId}.${d.ts}.${d.signatureDer}`);
  });
});
