import { describe, expect, it } from 'vitest';
import { COUNTRIES, countryByAlpha3, countryRows, defaultCountry, fold, searchCountries } from './countries';

describe('countries', () => {
  it('lists every ISO 3166-1 country once, with alpha-3 codes LNVPS accepts', () => {
    expect(COUNTRIES).toHaveLength(250);
    expect(new Set(COUNTRIES.map((c) => c.alpha3)).size).toBe(250);
    expect(COUNTRIES.every((c) => /^[A-Z]{3}$/.test(c.alpha3) && /^[A-Z]{2}$/.test(c.alpha2))).toBe(true);
    expect(countryByAlpha3('GBR')?.name).toBe('United Kingdom');
  });

  it('defaults from the phone region (alpha-2), in any case', () => {
    expect(defaultCountry('GB')).toBe('GBR');
    expect(defaultCountry('ie')).toBe('IRL');
    expect(defaultCountry(null)).toBeUndefined();
    expect(defaultCountry('419')).toBeUndefined(); // "Latin America": a region, not a country
  });

  it('finds countries by name or code, ignoring case and accents', () => {
    expect(searchCountries('united k').map((c) => c.alpha3)).toEqual(['GBR']);
    expect(searchCountries('irl').map((c) => c.alpha3)).toContain('IRL');
    expect(searchCountries('aland').map((c) => c.alpha3)).toEqual(['ALA']);
    expect(searchCountries('')).toHaveLength(250);
  });

  // Search folds accents itself rather than trusting String.normalize on Hermes.
  it('folds every accented letter in the table', () => {
    expect(COUNTRIES.every((c) => /^[\x20-\x7e]*$/.test(fold(c.name)))).toBe(true);
  });
});

// Your country's rows.
describe('countryRows', () => {
  const codes = (q: string, chosen?: string) => countryRows(q, chosen).rows.map((c) => c.alpha3);

  it('puts the chosen country first with nothing typed, once, then the list in its order', () => {
    const { rows, more } = countryRows('', 'GBR');
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual({ alpha2: 'GB', alpha3: 'GBR', name: 'United Kingdom', chosen: true });
    expect(rows.slice(1).map((c) => c.alpha3)).toEqual(COUNTRIES.filter((c) => c.alpha3 !== 'GBR').slice(0, 7).map((c) => c.alpha3));
    expect(rows.filter((c) => c.chosen)).toHaveLength(1);
    expect(more).toBe(true);
    // Spaces alone are nothing typed.
    expect(codes('   ', 'GBR')).toEqual(rows.map((c) => c.alpha3));
  });

  it('keeps a chosen country that is already among the first where it is first, not twice', () => {
    const first = COUNTRIES[0].alpha3;
    expect(codes('', first)).toEqual(COUNTRIES.slice(0, 8).map((c) => c.alpha3));
    expect(countryRows('', first).rows[0].chosen).toBe(true);
  });

  it('lists the first eight with none chosen, or a code that is no country', () => {
    expect(codes('')).toEqual(COUNTRIES.slice(0, 8).map((c) => c.alpha3));
    expect(codes('', 'XXX')).toEqual(COUNTRIES.slice(0, 8).map((c) => c.alpha3));
    expect(countryRows('', 'XXX').rows.some((c) => c.chosen)).toBe(false);
  });

  it("gives a query's matches as the search does, the chosen one marked where it stands", () => {
    const found = searchCountries('united').map((c) => c.alpha3);
    expect(found.length).toBeGreaterThan(1);
    expect(found.length).toBeLessThanOrEqual(8);
    expect(codes('united', 'GBR')).toEqual(found);
    expect(countryRows('united', 'GBR').rows.filter((c) => c.chosen).map((c) => c.alpha3)).toEqual(['GBR']);
    expect(countryRows('united', 'GBR').more).toBe(false);
    // A chosen country the query doesn't match isn't shown.
    expect(codes('united', 'IRL')).toEqual(found);
    expect(countryRows('united', 'IRL').rows.some((c) => c.chosen)).toBe(false);
  });

  it('shows eight at most and says when more match', () => {
    const found = searchCountries('s');
    expect(found.length).toBeGreaterThan(8);
    expect(codes('s')).toEqual(found.slice(0, 8).map((c) => c.alpha3));
    expect(countryRows('s', undefined).more).toBe(true);
    expect(countryRows('zzzz', 'GBR')).toEqual({ rows: [], more: false });
  });
});
