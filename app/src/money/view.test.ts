import { describe, expect, it } from 'vitest';
import type { Rated } from './fiat';
import { ageLine, altText, aboutText, apartText, feeViewText, isUnit, isView, shown, viewText, type View } from './view';

const T = 1_792_037_404;
const GBP: Rated = { currency: 'GBP', price: 61_352, time: T };

describe('isView and isUnit', () => {
  it('knows a view from anything else kept', () => {
    for (const v of ['fiat', 'sat', 'msat', 'hidden']) expect(isView(v)).toBe(true);
    for (const v of ['pounds', '', null, 3, undefined]) expect(isView(v)).toBe(false);
    for (const v of ['fiat', 'sat', 'msat']) expect(isUnit(v)).toBe(true);
    for (const v of ['hidden', 'pounds', '', null, undefined]) expect(isUnit(v)).toBe(false);
  });
});

// An amount in a view: sat to the nearest whole sat, msat exact, the unit after the number, *** with none.
describe('shown', () => {
  it('draws an amount in each view: the number, its unit after it, and its words', () => {
    expect(shown(13_291_204, 'sat', GBP)).toEqual({ number: '13,291', unit: 'sat', spoken: '13,291 sat' });
    expect(shown(13_291_204, 'msat', GBP)).toEqual({ number: '13,291,204', unit: 'msat', spoken: '13,291,204 millisat' });
    expect(shown(13_291_204, 'fiat', GBP)).toEqual({ number: '8.15', unit: 'GBP', spoken: "8 pounds 15 at today's rate" });
    expect(shown(13_291_204, 'hidden', GBP)).toEqual({ number: '***', unit: '', spoken: 'amount hidden' });
  });

  it('rounds sat to the nearest whole sat, half up, where a balance used to be rounded down', () => {
    expect(shown(13_291_500, 'sat', GBP).number).toBe('13,292');
    expect(shown(13_291_499, 'sat', GBP).number).toBe('13,291');
    expect(shown(400, 'sat', null).number).toBe('0');
  });

  it('marks a £ figure under one penny, and draws £ with no rate as sat', () => {
    expect(shown(10_000, 'fiat', GBP)).toEqual({ number: '< 0.01', unit: 'GBP', spoken: "under 1 penny at today's rate" });
    expect(shown(13_291_204, 'fiat', null)).toEqual({ number: '13,291', unit: 'sat', spoken: '13,291 sat' });
  });

  it("draws the amount's size: a sign is the caller's", () => {
    expect(shown(-5_000_000, 'sat', GBP).number).toBe('5,000');
    expect(shown(-5_000_000, 'fiat', GBP).number).toBe('3.07');
  });
});

describe('viewText, altText and feeViewText', () => {
  it('says an amount inside a sentence in the view', () => {
    expect(viewText(4_075_000, 'sat', GBP)).toBe('4,075 sat');
    expect(viewText(4_075_000, 'fiat', GBP)).toBe('£2.50');
    expect(viewText(4_075_000, 'msat', GBP)).toBe('4,075,000 msat');
    expect(viewText(4_075_000, 'hidden', GBP)).toBe('***');
    expect(viewText(4_075_000, 'fiat', null)).toBe('4,075 sat');
    expect(viewText(10_000, 'fiat', GBP)).toBe('under £0.01');
  });

  it('gives a large figure the other figure under it: £ under sat or msat, sat under £, none when hidden or with no rate', () => {
    expect(altText(13_291_204, 'sat', GBP)).toBe('≈ £8.15');
    expect(altText(13_291_204, 'msat', GBP)).toBe('≈ £8.15');
    expect(altText(13_291_204, 'fiat', GBP)).toBe('13,291 sat');
    expect(altText(10_000, 'sat', GBP)).toBe('≈ under £0.01');
    expect(altText(13_291_204, 'hidden', GBP)).toBeNull();
    expect(altText(13_291_204, 'sat', null)).toBeNull();
    expect(altText(13_291_204, 'fiat', null)).toBeNull();
  });

  it("says a fee in the view, a budget's \"under\" kept in sat", () => {
    expect(feeViewText(4_412, 'sat', GBP)).toBe('fee under 5 sat');
    expect(feeViewText(12_000, 'sat', GBP)).toBe('fee 12 sat');
    expect(feeViewText(4_412, 'msat', GBP)).toBe('fee 4,412 msat');
    expect(feeViewText(4_412, 'fiat', GBP)).toBe('fee under £0.01');
    expect(feeViewText(1_000_000, 'fiat', GBP)).toBe('fee £0.61');
    expect(feeViewText(4_412, 'hidden', GBP)).toBe('fee ***');
    expect(feeViewText(4_412, 'fiat', null)).toBe('fee under 5 sat');
  });
});

describe('ageLine', () => {
  it("says the rate's age once it is over an hour, while a £ figure can be on screen", () => {
    expect(ageLine(GBP, 'sat', T + 2 * 3600)).toBe('£ at a rate 2 h old');
    expect(ageLine(GBP, 'fiat', T + 45 * 60)).toBeNull();
    expect(ageLine({ ...GBP, currency: 'CHF' }, 'fiat', T + 2 * 3600)).toBe('CHF at a rate 2 h old');
    expect(ageLine(GBP, 'fiat', T + 60)).toBeNull();
    expect(ageLine(GBP, 'hidden', T + 2 * 3600)).toBeNull();
    expect(ageLine(null, 'sat', T + 2 * 3600)).toBeNull();
  });
});

describe('aboutText', () => {
  const GBP_NOW: Rated = { currency: 'GBP', price: 61_352, time: 1_792_037_404 };

  it('says an estimate as about, but not one already under the smallest unit', () => {
    expect(aboutText(9_000, 'sat', null)).toBe('about 9 sat');
    expect(aboutText(0, 'sat', null)).toBe('about 0 sat');
    expect(aboutText(47_257_000, 'fiat', GBP_NOW)).toBe('about £28.99');
    expect(aboutText(9_000, 'fiat', GBP_NOW)).toBe('under £0.01');
  });
});

describe('apartText', () => {
  it('keeps the view when the two figures differ, and goes to exact msat when they would read the same', () => {
    expect(apartText(5_000_000, 5_009_900, 'sat', null)).toEqual(['5,000 sat', '5,010 sat']);
    expect(apartText(5_009_600, 5_009_900, 'sat', null)).toEqual(['5,009,600 msat', '5,009,900 msat']);
    expect(apartText(5_000_000, 5_009_900, 'fiat', GBP)).toEqual(['5,000,000 msat', '5,009,900 msat']);
    expect(apartText(5_000_000, 6_000_000, 'fiat', GBP)).toEqual(['£3.07', '£3.68']);
    expect(apartText(5_009_600, 5_009_900, 'msat', null)).toEqual(['5,009,600 msat', '5,009,900 msat']);
    expect(apartText(5_009_600, 5_009_900, 'hidden', GBP)).toEqual(['***', '***']);
  });
});
