import { describe, expect, it } from 'vitest';
import {
  CURRENCIES, currencyOf, fiatInput, fiatMinor, fiatNumber, fiatSpoken, fiatText, isCode, MAX_MINOR, minorInputText, minorSpoken, minorText, minorToMsat,
  limitToMsat, rated, rateAge, rateText, symbol, typedFiatLine, type CurrencyCode, type Rated,
} from './fiat';

// mempool.space's prices of 15 Oct 2026: whole units per BTC.
const T = 1_792_037_404;
const at = (currency: CurrencyCode, price: number): Rated => ({ currency, price, time: T });
const GBP = at('GBP', 61_352);
const JPY = at('JPY', 12_780_023);
// A round price, for the rounding's edges: 1 msat is a ten-thousandth of a penny.
const ROUND = (currency: CurrencyCode) => at(currency, 100_000);

describe('the currencies', () => {
  it("are mempool.space's seven, in Settings' order, with their symbols, decimals and spoken names", () => {
    expect(CURRENCIES.map((c) => [c.code, c.symbol, c.decimals, c.name, c.major, c.minor])).toEqual([
      ['USD', '$', 2, 'US dollar', 'dollars', 'cents'],
      ['EUR', '€', 2, 'Euro', 'euros', 'cents'],
      ['GBP', '£', 2, 'Pound', 'pounds', 'pence'],
      ['CAD', 'CA$', 2, 'Canadian dollar', 'dollars', 'cents'],
      ['CHF', 'CHF ', 2, 'Swiss franc', 'Swiss francs', 'centimes'],
      ['AUD', 'A$', 2, 'Australian dollar', 'dollars', 'cents'],
      ['JPY', '¥', 0, 'Yen', 'yen', ''],
    ]);
    expect(MAX_MINOR).toBe(10_000_000_000);
  });

  it('knows a code by its exact letters, and finds its symbol', () => {
    for (const c of ['USD', 'EUR', 'GBP', 'CAD', 'CHF', 'AUD', 'JPY']) expect(isCode(c)).toBe(true);
    for (const c of ['gbp', 'SEK', 'none', '', 'GBP ']) expect(isCode(c)).toBe(false);
    expect(symbol('CHF')).toBe('CHF ');
    expect(currencyOf('JPY').decimals).toBe(0);
  });
});

describe('rated', () => {
  it('is the currency with its rate, only when cardd gave a currency and a price and its time', () => {
    expect(rated({ currency: 'GBP', price: 61_352, time: T })).toEqual(GBP);
    expect(rated({ currency: 'GBP' })).toBeNull();
    expect(rated({ currency: 'GBP', price: 61_352 })).toBeNull();
    expect(rated({ currency: 'GBP', price: 0, time: T })).toBeNull();
    expect(rated({ currency: 'none' })).toBeNull();
    expect(rated({ currency: null })).toBeNull();
    expect(rated({ currency: 'SEK' as CurrencyCode, price: 1, time: T })).toBeNull();
    expect(rated(null)).toBeNull();
    expect(rated(undefined)).toBeNull();
  });
});

describe('fiatText and fiatNumber', () => {
  it("says an amount in each currency at its rate, with the currency's decimals and the thousands split", () => {
    expect(fiatText(5_000_000, GBP)).toBe('£3.07');
    expect(fiatText(2_000_000_000, GBP)).toBe('£1,227.04');
    expect(fiatText(4_076_700, JPY)).toBe('¥521');
    expect(fiatText(6_265_664, at('CHF', 67_032))).toBe('CHF 4.20');
    expect(fiatText(100_000_000, at('USD', 80_854))).toBe('$80.85');
    expect(fiatText(100_000_000, at('EUR', 72_070))).toBe('€72.07');
    expect(fiatText(100_000_000, at('CAD', 114_850))).toBe('CA$114.85');
    expect(fiatText(100_000_000, at('AUD', 116_376))).toBe('A$116.38');
    expect(fiatText(0, GBP)).toBe('£0.00');
  });

  it('says "under £0.01" below one minor unit, never £0.00, and rounds half up from there', () => {
    expect(fiatText(10_000, GBP)).toBe('under £0.01');
    expect(fiatText(1_000, JPY)).toBe('under ¥1');
    const r = ROUND('GBP');
    expect(fiatText(9_999, r)).toBe('under £0.01');
    expect(fiatText(10_000, r)).toBe('£0.01');
    expect(fiatText(14_999, r)).toBe('£0.01');
    expect(fiatText(15_000, r)).toBe('£0.02');
  });

  it('gives the number alone for an amount drawn with its unit after it, and whether it is under one minor unit', () => {
    expect(fiatNumber(13_291_204, GBP)).toEqual({ text: '8.15', under: false });
    expect(fiatNumber(10_000, GBP)).toEqual({ text: '0.01', under: true });
    expect(fiatNumber(1_000, JPY)).toEqual({ text: '1', under: true });
    expect(fiatMinor(13_291_204, GBP)).toBe(815);
  });

  it("works on the amount's size: a sign is the caller's", () => {
    expect(fiatText(-5_000_000, GBP)).toBe('£3.07');
  });
});

describe('fiatSpoken and minorSpoken', () => {
  it('says the pounds and the pence apart, and yen whole', () => {
    expect(fiatSpoken(5_000_000, GBP)).toBe('3 pounds 7');
    expect(fiatSpoken(4_076_700, JPY)).toBe('521 yen');
    const r = ROUND('GBP');
    expect(fiatSpoken(1_000_000_000, r)).toBe('1,000 pounds');
    expect(fiatSpoken(1_010_000, r)).toBe('1 pound 1');
    expect(fiatSpoken(50_000, r)).toBe('5 pence');
    expect(fiatSpoken(10_000, r)).toBe('1 penny');
    expect(fiatSpoken(9_999, r)).toBe('under 1 penny');
    expect(fiatSpoken(0, r)).toBe('0 pounds');
  });

  it("uses each currency's own names, one or many", () => {
    expect(fiatSpoken(10_000, ROUND('EUR'))).toBe('1 cent');
    expect(fiatSpoken(20_000, ROUND('EUR'))).toBe('2 cents');
    expect(fiatSpoken(9_999, ROUND('EUR'))).toBe('under 1 cent');
    expect(fiatSpoken(250_000, ROUND('CHF'))).toBe('25 centimes');
    expect(fiatSpoken(1_050_000, ROUND('CHF'))).toBe('1 Swiss franc 5');
    expect(fiatSpoken(1_000, JPY)).toBe('under 1 yen');
    expect(minorSpoken(250, 'GBP')).toBe('2 pounds 50');
    expect(minorSpoken(480, 'JPY')).toBe('480 yen');
    expect(minorSpoken(100, 'USD')).toBe('1 dollar');
    expect(minorSpoken(1, 'EUR')).toBe('1 cent');
    expect(minorSpoken(5, 'CAD')).toBe('5 cents');
  });
});

describe('minorText and minorInputText', () => {
  it('says a price kept in minor units, as a sale or a limit keeps it', () => {
    expect(minorText(250, 'GBP')).toBe('£2.50');
    expect(minorText(480, 'JPY')).toBe('¥480');
    expect(minorText(420, 'CHF')).toBe('CHF 4.20');
    expect(minorText(122_704, 'GBP')).toBe('£1,227.04');
    expect(minorText(150_000, 'USD')).toBe('$1,500.00');
    expect(minorText(0, 'GBP')).toBe('£0.00');
  });

  it('leaves off ".00" from a whole amount when asked, as a limit is said ("£20 a day")', () => {
    expect(minorText(2_000, 'GBP', { whole: true })).toBe('£20');
    expect(minorText(2_050, 'GBP', { whole: true })).toBe('£20.50');
    expect(minorText(480, 'JPY', { whole: true })).toBe('¥480');
    expect(minorText(200_000, 'EUR', { whole: true })).toBe('€2,000');
  });

  it('fills a field with the figure as it would be typed: no symbol, no thousands', () => {
    expect(minorInputText(250, 'GBP')).toBe('2.50');
    expect(minorInputText(122_704, 'GBP')).toBe('1227.04');
    expect(minorInputText(5, 'EUR')).toBe('0.05');
    expect(minorInputText(480, 'JPY')).toBe('480');
  });
});

describe('fiatInput', () => {
  it('reads a price typed with a point or a comma, or whole, as minor units', () => {
    expect(fiatInput('2.50', 'GBP')).toBe(250);
    expect(fiatInput('2.5', 'GBP')).toBe(250);
    expect(fiatInput('2,50', 'GBP')).toBe(250);
    expect(fiatInput('2,5', 'EUR')).toBe(250);
    expect(fiatInput('2', 'GBP')).toBe(200);
    expect(fiatInput(' 2.5 ', 'GBP')).toBe(250);
    expect(fiatInput('0.01', 'GBP')).toBe(1);
    // A point just typed, its decimals still to come.
    expect(fiatInput('2.', 'GBP')).toBe(200);
    expect(fiatInput('480', 'JPY')).toBe(480);
  });

  it('is null for more decimals than the currency has, nothing, zero, and anything that is no price', () => {
    for (const bad of ['2.505', '2,505', '', '0', '0.00', 'abc', '-1', '1.2.3', '.5', '1e3', '2 50', '1,000.00', '£2']) {
      expect(fiatInput(bad, 'GBP'), bad).toBeNull();
    }
    for (const bad of ['480.5', '480.', '480,', '4,800']) expect(fiatInput(bad, 'JPY'), bad).toBeNull();
  });

  it("is null over cardd's bound for a price, 10^10 minor units", () => {
    expect(fiatInput('100000000', 'GBP')).toBe(MAX_MINOR);
    expect(fiatInput('100000000.01', 'GBP')).toBeNull();
    expect(fiatInput('9'.repeat(30), 'GBP')).toBeNull();
  });
});

describe('minorToMsat and limitToMsat', () => {
  it("turns a price into whole sats as cardd does for a sale: half up (cardd's SatForMinor)", () => {
    expect(minorToMsat(500, GBP)).toBe(8_150_000);
    expect(minorToMsat(250, GBP)).toBe(4_075_000);
    expect(minorToMsat(480, JPY)).toBe(3_756_000);
    // 1 pence at £80,000 a bitcoin is 12.5 sat exactly: half up.
    expect(minorToMsat(1, at('GBP', 80_000))).toBe(13_000);
    // £1,227.04 is the 2,000,000 sat a sale can be, at this rate.
    expect(minorToMsat(122_704, GBP)).toBe(2_000_000_000);
  });

  it("turns a limit into whole sats half up, as cardd checks a tap: the same as a sale, so a sale at a limit fits it", () => {
    expect(limitToMsat(500, GBP)).toBe(8_150_000);
    expect(limitToMsat(500, GBP)).toBe(minorToMsat(500, GBP));
    expect(limitToMsat(2_000, GBP)).toBe(32_599_000);
    expect(limitToMsat(122_704, GBP)).toBe(2_000_000_000);
    expect(limitToMsat(122_705, GBP)).toBe(2_000_016_000);
  });
});

describe('rateAge', () => {
  it("is nothing under an hour, then the age in hours or days, against the phone's clock", () => {
    const r = GBP;
    expect(rateAge(r, T + 45 * 60)).toBeNull();
    expect(rateAge(r, T + 59 * 60 + 59)).toBeNull();
    expect(rateAge(r, T + 3600)).toBe('1 h old');
    expect(rateAge(r, T + 2 * 3600 + 59 * 60)).toBe('2 h old');
    expect(rateAge(r, T + 86_400)).toBe('1 day old');
    expect(rateAge(r, T + 3 * 86_400 + 5)).toBe('3 days old');
    // A phone whose clock is behind mempool's time: no age to say.
    expect(rateAge(r, T - 600)).toBeNull();
  });
});

describe('rateText and typedFiatLine', () => {
  it('says the rate, and what a price typed in the currency is in sats at it', () => {
    expect(rateText(GBP)).toBe('1 BTC = £61,352');
    expect(rateText(JPY)).toBe('1 BTC = ¥12,780,023');
    expect(typedFiatLine('5.00', GBP)).toBe('≈ 8,150 sat at 1 BTC = £61,352');
    expect(typedFiatLine('5', GBP)).toBe('≈ 8,150 sat at 1 BTC = £61,352');
    expect(typedFiatLine('', GBP)).toBe('1 BTC = £61,352');
    expect(typedFiatLine('2.505', GBP)).toBe('1 BTC = £61,352');
  });
});
