import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cardId, deriveCardKeys, k1For } from '../boltcard/cardkeys';
import { decryptPicc, parseSun, verifySun } from '../boltcard/sun';
import { urlOf } from '../ntag424/ndef';
import { PHONE_CARD_VECTORS, phoneCardVectors, type PhoneCardVectors } from '../testing/vectors';
import { COUNTER_MAX, CounterSpent, phoneCardId, phoneCardUid } from './id';
import { BATCH, tapFiles, tapUrls, type TapCard } from './taps';

const ISSUER = '00000000000000000000000000000001';
const card: TapCard = { issuer: hexToBytes(ISSUER), n: 0, version: 0, lnurlw: 'lnurlw://vm-1.lnvps.cloud/ln' };
const FIRST = 412_345;
const fixed = () => hexToBytes('0102030405');

/** A link's tap, as the server reads it: null unless p opens under K1 and c verifies under the card's K2. */
function tapOf(url: string, c: TapCard) {
  const m = /^(.*)\?p=([0-9A-F]{32})&c=([0-9A-F]{16})$/.exec(url);
  const parsed = m && parseSun(m[2], m[3]);
  const picc = parsed && decryptPicc(k1For(c.issuer), parsed.p);
  if (!m || !parsed || !picc) return null;
  const ok = verifySun(deriveCardKeys(c.issuer, picc.uid, c.version).k2, picc, parsed.c);
  return ok ? { lnurlw: m[1], uid: bytesToHex(picc.uid), counter: picc.counter, id: bytesToHex(cardId(c.issuer, picc.uid)) } : null;
}

// PHONE_CARD_WRITE_VECTORS=1 npx vitest run src/phoneCard/taps.test.ts writes testvectors/phonecard.json afresh.
it.runIf(process.env.PHONE_CARD_WRITE_VECTORS)('writes the vectors', () => {
  const out: PhoneCardVectors = {
    issuerKey: ISSUER,
    lnurlw: card.lnurlw,
    cards: [0, 1].map((n) => ({ n, uid: bytesToHex(phoneCardUid(card.issuer, n)), id: phoneCardId(card.issuer, n) })),
    random: '0102030405',
    first: FIRST,
    batch: tapUrls(card, FIRST, BATCH, fixed),
    nextBatchFirst: tapUrls(card, FIRST + BATCH, 1, fixed)[0],
  };
  writeFileSync(PHONE_CARD_VECTORS, `${JSON.stringify(out, null, 2)}\n`);
});

describe('a batch of taps', () => {
  it("matches the vectors: 16 links from the first counter, and the next batch's first", () => {
    const v = phoneCardVectors();
    const c: TapCard = { issuer: hexToBytes(v.issuerKey), n: 0, version: 0, lnurlw: v.lnurlw };
    const random = () => hexToBytes(v.random);
    expect(BATCH).toBe(16);
    expect(v.batch).toHaveLength(16);
    expect(tapUrls(c, v.first, BATCH, random)).toEqual(v.batch);
    expect(tapUrls(c, v.first + BATCH, 1, random)).toEqual([v.nextBatchFirst]);
  });

  it("is links the app's own check accepts, the counters in order", () => {
    const urls = tapUrls(card, FIRST);
    expect(urls).toHaveLength(BATCH);
    urls.forEach((url, i) => {
      expect(tapOf(url, card)).toEqual({ lnurlw: card.lnurlw, uid: bytesToHex(phoneCardUid(card.issuer, 0)), counter: FIRST + i, id: phoneCardId(card.issuer, 0) });
    });
  });

  it("is the card's own: another number, another version or another issuer does not verify as it", () => {
    const [url] = tapUrls({ ...card, n: 1 }, FIRST, 1);
    expect(tapOf(url, card)?.id).toBe(phoneCardId(card.issuer, 1));
    expect(tapOf(tapUrls({ ...card, version: 1 }, FIRST, 1)[0], card)).toBeNull();
    expect(tapOf(tapUrls({ ...card, issuer: hexToBytes('00000000000000000000000000000002') }, FIRST, 1)[0], card)).toBeNull();
  });

  it('gives each tap random bytes of its own', () => {
    const p = (url: string) => /p=([0-9A-F]+)/.exec(url)![1];
    const [a, b] = [tapUrls(card, FIRST, 1)[0], tapUrls(card, FIRST, 1)[0]];
    expect(p(a)).not.toBe(p(b));
    expect(tapOf(a, card)).toEqual(tapOf(b, card));
  });

  it('as files, is the NDEF file of each link', () => {
    const files = tapFiles(card, FIRST, 3, fixed);
    expect(files.map((f) => urlOf(hexToBytes(f)))).toEqual(tapUrls(card, FIRST, 3, fixed));
    expect(files[0]).toMatch(/^[0-9a-f]+$/);
  });

  it("refuses a batch that would pass the counter's end, and makes none of it", () => {
    expect(tapUrls(card, COUNTER_MAX - 15)).toHaveLength(16);
    expect(() => tapUrls(card, COUNTER_MAX - 14)).toThrow(CounterSpent);
    expect(() => tapFiles(card, COUNTER_MAX, 2)).toThrow(CounterSpent);
  });
});
