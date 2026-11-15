import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { cardUrl, EMPTY_NDEF, lnurlwFor, ndefFile, offsetsMatch, readSun, sunFileSettings, urlHost, urlOf } from './ndef';

const URL = 'lnurlw://vm-1009.lnvps.cloud/ln?p=00000000000000000000000000000000&c=0000000000000000';
const FILE = '005AD1015655006C6E75726C773A2F2F766D2D313030392E6C6E7670732E636C6F75642F6C6E3F703D303030303030303030303030303030303030303030303030303030303030303026633D30303030303030303030303030303030';

/** The file as a SUN read returns it: p and c mirrored at the offsets. */
function mirrored(p: string, c: string): Uint8Array {
  const f = hexToBytes(FILE);
  f.set(new TextEncoder().encode(p), 41);
  f.set(new TextEncoder().encode(c), 76);
  return f;
}

describe('ndef', () => {
  it('builds the card URL and its NDEF file, with p at 41 and c at 76', () => {
    expect(cardUrl(lnurlwFor('vm-1009.lnvps.cloud'))).toBe(URL);
    const n = ndefFile(URL);
    expect(bytesToHex(n.file).toUpperCase()).toBe(FILE);
    expect([n.piccOffset, n.macOffset]).toEqual([41, 76]);
  });
  it('builds the SUN file settings: SDM on, read free, key 0 for the rest, p under K1, c under K2', () => {
    expect(bytesToHex(sunFileSettings(41, 76)).toUpperCase()).toBe('4000E0C1FF122900004C00004C0000');
  });
  it('reads p and c at the offsets the file settings give', () => {
    const f = mirrored('EF963FF7828658A599F3041510671E88', '94EED9EE65337086');
    expect(readSun(f, { sdm: true, piccOffset: 41, macOffset: 76 })).toEqual({ p: 'EF963FF7828658A599F3041510671E88', c: '94EED9EE65337086' });
    expect(readSun(f, { sdm: false })).toBeNull();
    expect(readSun(EMPTY_NDEF, { sdm: true, piccOffset: 41, macOffset: 76 })).toBeNull();
    expect(readSun(hexToBytes(FILE), { sdm: true, piccOffset: 40, macOffset: 76 })).toBeNull(); // "=000…" is not hex
  });
  it('reads the URL and its host back', () => {
    expect(urlOf(hexToBytes(FILE))).toBe(URL);
    expect(urlOf(EMPTY_NDEF)).toBeNull();
    expect(urlHost(URL)).toBe('vm-1009.lnvps.cloud');
    expect(urlHost('nonsense')).toBeNull();
  });
  it('notices file settings that don\'t match the URL (a re-point cut halfway)', () => {
    const f = mirrored('EF963FF7828658A599F3041510671E88', '94EED9EE65337086');
    expect(offsetsMatch(f, { sdm: true, piccOffset: 41, macOffset: 76 })).toBe(true);
    const longer = ndefFile(cardUrl(lnurlwFor('vm-10090.lnvps.cloud'))).file;
    expect(offsetsMatch(longer, { sdm: true, piccOffset: 41, macOffset: 76 })).toBe(false);
    expect(offsetsMatch(EMPTY_NDEF, { sdm: false })).toBe(false);
  });
  it('refuses a URL too long for one short record', () => {
    expect(() => ndefFile(`lnurlw://${'x'.repeat(250)}/ln?p=0&c=0`)).toThrow('too long');
  });
});
