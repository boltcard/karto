import { describe, expect, it } from 'vitest';
import type { Fiat } from '../money/fiat';
import { CURRENCY_CHOICES, currencyRow, regionCurrency, unitChoices, unitRow } from './currencySetting';

const GBP: Fiat = { currency: 'GBP', price: 61_352, time: 1_792_037_404 };

// Settings' Currency row, its list, and the region's currency.
describe('CURRENCY_CHOICES', () => {
  it('lists None, then the seven currencies in their order, each with its symbol', () => {
    expect(CURRENCY_CHOICES.map((c) => c.name)).toEqual(['None', 'US dollar $', 'Euro €', 'Pound £', 'Canadian dollar CA$', 'Swiss franc CHF', 'Australian dollar A$', 'Yen ¥']);
    expect(CURRENCY_CHOICES.map((c) => c.value)).toEqual(['none', 'USD', 'EUR', 'GBP', 'CAD', 'CHF', 'AUD', 'JPY']);
  });
});

describe('currencyRow', () => {
  it("says the server's currency, and whether it has a rate yet", () => {
    expect(currencyRow({ fiat: GBP }, GBP)).toEqual({ line: 'GBP', off: false });
    expect(currencyRow({ fiat: { currency: 'GBP' } }, { currency: 'GBP' })).toEqual({ line: 'GBP · no rate yet', off: false });
    expect(currencyRow({ fiat: { currency: 'none' } }, { currency: 'none' })).toEqual({ line: 'None', off: false });
    expect(currencyRow({ fiat: { currency: null } }, { currency: null })).toEqual({ line: 'Not set yet', off: false });
  });

  it("says the choice just made before the wallet says it", () => {
    expect(currencyRow({ fiat: { currency: null } }, { currency: 'EUR' })).toEqual({ line: 'EUR · no rate yet', off: false });
  });

  it("can't be tapped before the wallet answers, while the server can't be read, or on a server not yet updated", () => {
    expect(currencyRow(null, null)).toEqual({ line: 'Checking…', off: true });
    expect(currencyRow(null, GBP)).toEqual({ line: 'GBP', off: true });
    expect(currencyRow({}, null)).toEqual({ line: 'Needs a server update', off: true });
  });
});

describe('regionCurrency', () => {
  it("is the phone's region currency when it is one of the seven, else none", () => {
    expect(regionCurrency('GBP')).toBe('GBP');
    expect(regionCurrency('JPY')).toBe('JPY');
    expect(regionCurrency('SEK')).toBe('none');
    expect(regionCurrency(null)).toBe('none');
    expect(regionCurrency(undefined)).toBe('none');
  });
});

// Settings' Show amounts in: the row's line, and the list's three, £ off with no currency to show in.
describe('unitRow and unitChoices', () => {
  it("names the unit kept: the currency's code, sat or msat", () => {
    expect(unitRow('fiat', GBP)).toBe('GBP');
    expect(unitRow('fiat', { currency: 'GBP' })).toBe('GBP');
    expect(unitRow('sat', GBP)).toBe('sat');
    expect(unitRow('msat', null)).toBe('msat');
  });

  it("lists the server's currency, sat and msat; the currency off while there is none, or none known", () => {
    expect(unitChoices(GBP)).toEqual([
      { value: 'fiat', name: 'Pound £', off: false }, { value: 'sat', name: 'sat', off: false }, { value: 'msat', name: 'msat', off: false },
    ]);
    // A currency whose rate is still coming may be chosen: amounts show sat until it comes.
    expect(unitChoices({ currency: 'EUR' })[0]).toEqual({ value: 'fiat', name: 'Euro €', off: false });
    for (const f of [null, { currency: 'none' as const }, { currency: null }]) expect(unitChoices(f)[0]).toEqual({ value: 'fiat', name: 'Currency', off: true });
  });
});
