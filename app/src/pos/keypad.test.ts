import { describe, expect, it } from 'vitest';
import { minorSpoken, type Rated } from '../money/fiat';
import { chargeLabel, chargeOf, figureText, keypad, KEYS, MAX_SALE_SAT, priceKeypad, retarget, startTyped, tillNote, typeKey } from './keypad';

// '<' is delete and 'D' the 00 key.
const key = (k: string) => (k === '<' ? 'delete' : k === 'D' ? '00' : k);
const type = (start: number, keys: string) => [...keys].reduce((sat, k) => keypad(sat, key(k)), start);

// A figure and a pad of twelve keys.
describe('keypad', () => {
  it('appends a digit, and a 0 that leads is nothing', () => {
    expect(type(0, '2500')).toBe(2500);
    expect(type(0, '0')).toBe(0);
    expect(type(0, '007')).toBe(7);
    for (const d of '123456789') expect(keypad(0, d)).toBe(Number(d));
  });

  it('takes the last digit with delete, down to 0 and no further', () => {
    expect(type(2500, '<')).toBe(250);
    expect(type(7, '<')).toBe(0);
    expect(type(0, '<')).toBe(0);
    expect(type(0, '12<3<<<')).toBe(0);
  });

  it('puts two 0s after the amount with the 00 key, and nothing before any digit', () => {
    expect(type(0, '5D')).toBe(500);
    expect(type(0, '25DD')).toBe(250_000);
    expect(type(0, 'D')).toBe(0);
    expect(type(0, 'D7')).toBe(7);
    expect(type(0, '5D<')).toBe(50);
  });

  it("ignores a digit that would pass cardd's limit for a sale, 2,000,000 sat", () => {
    expect(MAX_SALE_SAT).toBe(2_000_000);
    expect(type(0, '2000000')).toBe(2_000_000);
    expect(type(2_000_000, '0')).toBe(2_000_000);
    expect(type(200_000, '1')).toBe(200_000);
    expect(type(200_000, '0')).toBe(2_000_000);
    expect(type(199_999, '9')).toBe(1_999_999);
    expect(type(1_999_999, '9')).toBe(1_999_999);
    for (const d of '0123456789') expect(keypad(2_000_000, d)).toBe(2_000_000);
    expect(type(2_000_000, '<')).toBe(200_000);
    // 00 whole or not at all: 200,000 then 00 would be 20,000,000.
    expect(type(20_000, 'D')).toBe(2_000_000);
    expect(type(200_000, 'D')).toBe(200_000);
  });

  it('ignores anything that is no key', () => {
    for (const k of ['', 'a', '10', '000', '-', '.', ' ']) expect(keypad(25, k)).toBe(25);
  });

  it('lays the pad out as twelve keys in three columns: 1 to 9, 00, 0 and delete', () => {
    expect(KEYS).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'delete']);
  });
});

// With a currency set, the keypad types it.
const NOW = 1_792_037_404;
const GBP: Rated = { currency: 'GBP', price: 61_352, time: NOW };
const JPY: Rated = { currency: 'JPY', price: 12_780_023, time: NOW };
const typeP = (r: Rated, keys: string, start = 0) => [...keys].reduce((m, k) => priceKeypad(m, key(k), r), start);

// A price is typed from its last digit, as on a cash register: 1 then 2 is £0.12, then 5 is £1.25.
describe('priceKeypad', () => {
  it('types a price in minor units, each digit coming in at the pence end; a 0 that leads is nothing', () => {
    expect(typeP(GBP, '1')).toBe(1);
    expect(typeP(GBP, '12')).toBe(12);
    expect(typeP(GBP, '125')).toBe(125);
    expect(typeP(GBP, '250')).toBe(250);
    expect(typeP(GBP, '007')).toBe(7);
    expect(typeP(GBP, '0')).toBe(0);
  });

  it('takes the last digit with delete, down to nothing', () => {
    expect(typeP(GBP, '125<')).toBe(12);
    expect(typeP(GBP, '12<<<')).toBe(0);
  });

  it('puts two 0s after the price with the 00 key: 5 then 00 is £5.00', () => {
    expect(typeP(GBP, '5D')).toBe(500);
    expect(typeP(GBP, 'D')).toBe(0);
    expect(typeP(JPY, '48D')).toBe(4800);
  });

  it("ignores a key whose price, at the till's rate, would pass 2,000,000 sat", () => {
    // 1 BTC = £61,352: £1,227.04 is 2,000,000 sat exactly; a penny more is over.
    expect(typeP(GBP, '122704')).toBe(122_704);
    expect(typeP(GBP, '122705')).toBe(12_270);
    expect(typeP(GBP, '1227D')).toBe(122_700);
    expect(typeP(GBP, '1228D')).toBe(1228);
    expect(typeP(GBP, '122D')).toBe(12_200);
    // 1 BTC = ¥12,780,023: ¥255,600 is under 2,000,000 sat, ¥255,601 over.
    expect(typeP(JPY, '255600')).toBe(255_600);
    expect(typeP(JPY, '255601')).toBe(25_560);
  });

  it('ignores anything that is no key, the old point among them', () => {
    for (const k of ['', 'a', '10', '000', '-', '.', ' ']) expect(priceKeypad(250, k, GBP)).toBe(250);
  });
});

describe('typeKey', () => {
  it('sends each key to the pad in use; a price keeps no key without its own rate', () => {
    expect(typeKey({ unit: 'sat', sat: 25 }, '0', GBP)).toEqual({ unit: 'sat', sat: 250 });
    expect(typeKey({ unit: 'GBP', minor: 12 }, '5', GBP)).toEqual({ unit: 'GBP', minor: 125 });
    expect(typeKey({ unit: 'GBP', minor: 2 }, '5', null)).toEqual({ unit: 'GBP', minor: 2 });
    expect(typeKey({ unit: 'GBP', minor: 2 }, '5', JPY)).toEqual({ unit: 'GBP', minor: 2 });
  });
});

describe('startTyped and retarget', () => {
  it('starts a sale in the currency when there is a rate, else in sat', () => {
    expect(startTyped(GBP)).toEqual({ unit: 'GBP', minor: 0 });
    expect(startTyped(null)).toEqual({ unit: 'sat', sat: 0 });
  });

  it('follows the rate: one that arrives before anything is typed takes the pad to the currency, unless the sat key was pressed', () => {
    expect(retarget({ unit: 'sat', sat: 0 }, GBP, false)).toEqual({ unit: 'GBP', minor: 0 });
    expect(retarget({ unit: 'sat', sat: 0 }, GBP, true)).toEqual({ unit: 'sat', sat: 0 });
    expect(retarget({ unit: 'sat', sat: 2500 }, GBP, false)).toEqual({ unit: 'sat', sat: 2500 });
  });

  it('starts again when the currency changes or its rate goes', () => {
    expect(retarget({ unit: 'GBP', minor: 250 }, GBP, false)).toEqual({ unit: 'GBP', minor: 250 });
    expect(retarget({ unit: 'GBP', minor: 250 }, JPY, false)).toEqual({ unit: 'JPY', minor: 0 });
    expect(retarget({ unit: 'GBP', minor: 250 }, null, false)).toEqual({ unit: 'sat', sat: 0 });
  });
});

describe('figureText, chargeLabel and chargeOf', () => {
  it('says the figure with its thousands and its unit, and reads it aloud', () => {
    expect(figureText({ unit: 'sat', sat: 0 }, GBP)).toEqual({ figure: '0', unit: 'sat', label: '0 sat', under: null });
    expect(figureText({ unit: 'sat', sat: 2500 }, null)).toEqual({ figure: '2,500', unit: 'sat', label: '2,500 sat', under: null });
    expect(figureText({ unit: 'sat', sat: 2_000_000 }, null)).toEqual({ figure: '2,000,000', unit: 'sat', label: '2,000,000 sat', under: null });
  });

  it("says a price with its currency's decimals from the start, and the sats it comes to at the rate under it", () => {
    expect(figureText({ unit: 'GBP', minor: 250 }, GBP)).toEqual({ figure: '2.50', unit: 'GBP', label: minorSpoken(250, 'GBP'), under: '≈ 4,075 sat' });
    expect(figureText({ unit: 'GBP', minor: 0 }, GBP)).toEqual({ figure: '0.00', unit: 'GBP', label: minorSpoken(0, 'GBP'), under: null });
    expect(figureText({ unit: 'GBP', minor: 12 }, GBP)).toMatchObject({ figure: '0.12', label: '12 pence' });
    expect(figureText({ unit: 'GBP', minor: 122_704 }, GBP)).toMatchObject({ figure: '1,227.04', under: '≈ 2,000,000 sat' });
    expect(figureText({ unit: 'JPY', minor: 480 }, JPY)).toEqual({ figure: '480', unit: 'JPY', label: minorSpoken(480, 'JPY'), under: '≈ 3,756 sat' });
    expect(figureText({ unit: 'JPY', minor: 0 }, JPY)).toMatchObject({ figure: '0' });
  });

  it('names the button by the amount or the price, and is off at nothing', () => {
    expect(chargeLabel({ unit: 'sat', sat: 0 })).toEqual({ title: 'Charge', off: true });
    expect(chargeLabel({ unit: 'sat', sat: 2500 })).toEqual({ title: 'Charge 2,500 sat', off: false });
    expect(chargeLabel({ unit: 'GBP', minor: 250 })).toEqual({ title: 'Charge £2.50', off: false });
    expect(chargeLabel({ unit: 'GBP', minor: 12 })).toEqual({ title: 'Charge £0.12', off: false });
    expect(chargeLabel({ unit: 'GBP', minor: 0 })).toEqual({ title: 'Charge', off: true });
  });

  it('asks cardd for the sats, or for the price in minor units', () => {
    expect(chargeOf({ unit: 'sat', sat: 2500 })).toEqual({ sat: 2500 });
    expect(chargeOf({ unit: 'GBP', minor: 250 })).toEqual({ price: { currency: 'GBP', minor: 250 } });
  });
});

describe('tillNote', () => {
  it('says nothing with no currency, or a fresh rate', () => {
    for (const f of [null, { currency: null }, { currency: 'none' as const }, { currency: 'GBP' as const, price: 61_352, time: NOW }]) expect(tillNote(f, NOW + 60)).toBeNull();
  });

  it("says there is no rate yet, in the shop's cardd's words, and an old rate's age", () => {
    expect(tillNote({ currency: 'GBP' }, NOW)).toBe('No £ rate yet: type the price in sat.');
    expect(tillNote({ currency: 'CHF' }, NOW)).toBe('No CHF rate yet: type the price in sat.');
    expect(tillNote({ currency: 'GBP', price: 61_352, time: NOW - 2 * 3600 }, NOW)).toBe('£ at a rate 2 h old');
    expect(tillNote({ currency: 'GBP', price: 61_352, time: NOW - 45 * 60 }, NOW)).toBeNull();
  });
});
