// NTAG 424 DNA secure messaging against AN12196's EV2First example and values
// computed independently with Python's `cryptography`.
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  authReply, authTi, cmdMac, decryptRsp, encryptCmd, jamcrc32, pad, rotl, rspMac, sessionKeys, unpad, ZERO_KEY, type Session,
} from './crypto';

const H = (b: Uint8Array) => bytesToHex(b).toUpperCase();
const rndA = hexToBytes('13C5DB8A5930439FC3DEF9A4C675360F');
const rndB = hexToBytes('B9E2FC789B64BF237CCCAA20EC7E6E48');
const session = (): Session => ({
  keyNo: 0,
  enc: hexToBytes('1309C877509E5A215007FF0ED19CA564'),
  mac: hexToBytes('4C6626F5E72EA694202139295C7A7FC7'),
  ti: hexToBytes('9D00C4DF'),
  ctr: 0,
});

describe('EV2First', () => {
  it('derives AN12196 session keys', () => {
    const k = sessionKeys(ZERO_KEY, rndA, rndB);
    expect(H(k.enc)).toBe('1309C877509E5A215007FF0ED19CA564');
    expect(H(k.mac)).toBe('4C6626F5E72EA694202139295C7A7FC7');
  });
  it('answers the card\'s RndB with E(K, RndA || RndB\')', () => {
    const r = authReply(ZERO_KEY, rndA, hexToBytes('A04C124213C186F22399D33AC2A30215'));
    expect(H(r.rndB)).toBe(H(rndB));
    expect(H(r.message)).toBe('35C3E05A752E0144BAC0DE51C1F22C56B34408A23D8AEA266CAB947EA8E0118D');
  });
  it('reads TI once the card proves it rotated RndA', () => {
    const reply = hexToBytes('3FA64DB5446D1F34CD6EA311167F5E4985B89690C04A05F17FA7AB2F08120663');
    expect(H(authTi(ZERO_KEY, rndA, reply))).toBe('9D00C4DF');
    const other = rndA.slice();
    other[0] ^= 1;
    expect(() => authTi(ZERO_KEY, other, reply)).toThrow('the card did not prove it knows the key');
  });
  it('rotates left by one byte', () => {
    expect(H(rotl(rndB))).toBe('E2FC789B64BF237CCCAA20EC7E6E48B9');
  });
});

describe('MAC and encryption', () => {
  it('MACs a command: GetCardUID at counter 0', () => {
    expect(H(cmdMac(session(), 0, 0x51, new Uint8Array(0)))).toBe('39D419D352B63856');
  });
  it('MACs an empty response at counter 1', () => {
    expect(H(rspMac(session(), 1, new Uint8Array(0)))).toBe('FC222E5F7A542452');
  });
  it('encrypts ChangeKey 1 at counter 3 (ChangeKey data for 000102…0F, version 1)', () => {
    const newKey = hexToBytes('000102030405060708090A0B0C0D0E0F');
    const data = new Uint8Array([...newKey, 0x01, ...jamcrc32(newKey)]);
    // The table's APDU is 90C40000 29 | 01 (key) | these 32 bytes | MACt 88E0987043FBAE16 | 00.
    expect(H(encryptCmd(session(), 3, data))).toBe('016A4C57EC3543653627877AAAC77E19895075AE51E29499A2143FE1F2A5CD8D');
    expect(H(cmdMac(session(), 3, 0xc4, hexToBytes('01016A4C57EC3543653627877AAAC77E19895075AE51E29499A2143FE1F2A5CD8D')))).toBe('88E0987043FBAE16');
  });
  it('decrypts GetCardUID\'s answer at counter 1', () => {
    const enc = hexToBytes('D21E1B2F95F8219DA0A25C72470020BB');
    expect(H(decryptRsp(session(), 1, enc))).toBe('04A39493CC8680');
  });
  it('pads by ISO/IEC 9797-1 method 2 and strips it again', () => {
    expect(H(pad(Uint8Array.of(1, 2, 3)))).toBe('01020380000000000000000000000000');
    expect(pad(new Uint8Array(16)).length).toBe(32);
    expect(H(unpad(hexToBytes('01800000000000000000000000000000')))).toBe('01');
    expect(() => unpad(new Uint8Array(16))).toThrow('bad padding');
  });
});

describe('jamcrc32', () => {
  it('is CRC32 without the final XOR, little-endian', () => {
    expect(H(jamcrc32(utf8ToBytes('123456789')))).toBe('D9C60B34');
    expect(H(jamcrc32(hexToBytes('000102030405060708090A0B0C0D0E0F')))).toBe('771D3131');
  });
});
