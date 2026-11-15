import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { cardId } from '../boltcard/cardkeys';
import { phoneCardVectors } from '../testing/vectors';
import { COUNTER_MAX, CounterSpent, PAST_A_GAP, checkCounters, firstCounter, isPhoneUid, lowestFree, phoneCardId, phoneCardUid, phonesCards, phonesCardsWide } from './id';

const v = phoneCardVectors();
const issuer = hexToBytes(v.issuerKey);
const id = (n: number) => phoneCardId(issuer, n);
const START_2026 = Date.UTC(2026, 0, 1);

describe("a phone's card's ID", () => {
  it('matches the vectors for numbers 0 and 1', () => {
    for (const c of v.cards) {
      expect(bytesToHex(phoneCardUid(issuer, c.n))).toBe(c.uid);
      expect(id(c.n)).toBe(c.id);
    }
    expect(v.cards.map((c) => c.n)).toEqual([0, 1]);
  });

  it("is 7 bytes and begins 00, as no chip's does", () => {
    for (const n of [0, 1, 2, 255, 256, 0xffffffff]) {
      const uid = phoneCardUid(issuer, n);
      expect(uid.length).toBe(7);
      expect(uid[0]).toBe(0);
      expect(isPhoneUid(uid)).toBe(true);
    }
    expect(isPhoneUid(hexToBytes('04a39493cc8680'))).toBe(false);
    expect(isPhoneUid(hexToBytes('08a39493'))).toBe(false);
  });

  it("differs by number, by issuer, and from a plastic card's", () => {
    const other = hexToBytes('00000000000000000000000000000002');
    const ids = [id(0), id(1), id(2), id(256), phoneCardId(other, 0), bytesToHex(cardId(issuer, hexToBytes('04a39493cc8680')))];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses a number that is not a whole one from 0', () => {
    for (const n of [-1, 0.5, Number.NaN, 2 ** 32]) expect(() => phoneCardUid(issuer, n)).toThrow("a phone's card has a whole number from 0");
  });
});

describe("the phones' cards among a server's", () => {
  const plastic = { id: bytesToHex(cardId(issuer, hexToBytes('04a39493cc8680'))), name: 'Daily' };

  it("are found by number, in order, whatever the list's order and whatever else it holds", () => {
    const list = [{ id: id(1), name: 'B' }, plastic, { id: id(0), name: 'A' }];
    expect(phonesCards(issuer, list)).toEqual([{ n: 0, card: list[2] }, { n: 1, card: list[0] }]);
  });

  it('stop at the first number the server does not list', () => {
    expect(phonesCards(issuer, [{ id: id(1) }, { id: id(2) }])).toEqual([]);
    expect(phonesCards(issuer, [{ id: id(0) }, { id: id(2) }]).map((p) => p.n)).toEqual([0]);
    expect(phonesCards(issuer, [])).toEqual([]);
  });

  it('are found past a gap by the wider look, up to eight numbers past the last one found', () => {
    expect(PAST_A_GAP).toBe(8);
    expect(phonesCardsWide(issuer, [{ id: id(1) }, { id: id(2) }, plastic]).map((p) => p.n)).toEqual([1, 2]);
    expect(phonesCardsWide(issuer, [{ id: id(0) }, { id: id(8) }, { id: id(16) }]).map((p) => p.n)).toEqual([0, 8, 16]);
    // Nine numbers on from the last one found is out of sight.
    expect(phonesCardsWide(issuer, [{ id: id(0) }, { id: id(9) }]).map((p) => p.n)).toEqual([0]);
    expect(phonesCardsWide(issuer, [{ id: id(8) }])).toEqual([]);
    expect(phonesCardsWide(issuer, [])).toEqual([]);
  });

  it('give the lowest free number, a wiped row still counting', () => {
    expect(lowestFree(issuer, [])).toBe(0);
    expect(lowestFree(issuer, [plastic])).toBe(0);
    const listed = [{ id: id(0), state: 'reset' }, { id: id(1), state: 'active' }];
    expect(lowestFree(issuer, listed)).toBe(2);
  });
});

describe("a card's first counter", () => {
  it('is the minutes since the start of 2026 by the clock', () => {
    expect(firstCounter(undefined, START_2026)).toBe(0);
    expect(firstCounter(undefined, START_2026 + 59_999)).toBe(0);
    expect(firstCounter(undefined, START_2026 + 60_000)).toBe(1);
    expect(firstCounter(undefined, Date.UTC(2026, 9, 12, 12, 0))).toBe(284 * 1440 + 720);
  });

  it("is the record's next when that is higher", () => {
    expect(firstCounter(500, START_2026 + 60_000 * 499)).toBe(500);
    expect(firstCounter(500, START_2026 + 60_000 * 500)).toBe(500);
    expect(firstCounter(500, START_2026 + 60_000 * 501)).toBe(501);
  });

  it('is next alone, or 0, for a clock before 2026', () => {
    expect(firstCounter(undefined, Date.UTC(2020, 0, 1))).toBe(0);
    expect(firstCounter(7, Date.UTC(2020, 0, 1))).toBe(7);
  });

  it('refuses counters that would pass 16,777,215', () => {
    expect(COUNTER_MAX).toBe(16_777_215);
    expect(() => checkCounters(COUNTER_MAX, 1)).not.toThrow();
    expect(() => checkCounters(COUNTER_MAX - 15, 16)).not.toThrow();
    expect(() => checkCounters(COUNTER_MAX - 14, 16)).toThrow(CounterSpent);
    expect(() => checkCounters(COUNTER_MAX + 1, 1)).toThrow(CounterSpent);
    // The clock in 2058: the counter's 24 bits are spent.
    expect(() => checkCounters(firstCounter(undefined, Date.UTC(2058, 0, 1)), 1)).toThrow("This phone's card has used up its counter. Check the phone's date.");
  });
});
