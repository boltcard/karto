// The country picker's table: defaults from the
// phone's region, sends LNVPS the ISO alpha-3 code.
import { COUNTRY_ROWS } from './countryData';

export type Country = { alpha2: string; alpha3: string; name: string };

export const COUNTRIES: readonly Country[] = COUNTRY_ROWS.map(([alpha2, alpha3, name]) => ({ alpha2, alpha3, name }));

export const countryByAlpha3 = (alpha3: string): Country | undefined => COUNTRIES.find((c) => c.alpha3 === alpha3);

/** The alpha-3 code for the phone's region (expo-localization's regionCode, alpha-2), if it is a country. */
export function defaultCountry(regionCode: string | null | undefined): string | undefined {
  const a2 = (regionCode ?? '').toUpperCase();
  return COUNTRIES.find((c) => c.alpha2 === a2)?.alpha3;
}

// Every accented letter in COUNTRY_ROWS (a test keeps this complete).
const ACCENTS: Record<string, string> = { å: 'a', ç: 'c', é: 'e', ü: 'u' };

/** Lower case without accents, for matching what the user types. */
export const fold = (s: string): string => s.toLowerCase().replace(/[^\x20-\x7e]/g, (ch) => ACCENTS[ch] ?? ch);

export function searchCountries(query: string): Country[] {
  const q = fold(query.trim());
  if (!q) return [...COUNTRIES];
  // Match from the start of a word: "aland" is Åland, not New Zealand.
  return COUNTRIES.filter((c) => ` ${fold(c.name)}`.includes(` ${q}`) || c.alpha3.toLowerCase() === q || c.alpha2.toLowerCase() === q);
}

/** Your country shows this many rows at most. */
export const COUNTRIES_SHOWN = 8;

/**
 * Your country's rows: with nothing typed, the chosen country first and then the list in its order without it, so
 * the phone's own country shows without a search; with a query, its matches. more: more match than are shown.
 */
export function countryRows(query: string, chosen: string | undefined): { rows: (Country & { chosen: boolean })[]; more: boolean } {
  const mine = query.trim() ? undefined : chosen && countryByAlpha3(chosen);
  const all = mine ? [mine, ...COUNTRIES.filter((c) => c !== mine)] : searchCountries(query);
  return { rows: all.slice(0, COUNTRIES_SHOWN).map((c) => ({ ...c, chosen: c.alpha3 === chosen })), more: all.length > COUNTRIES_SHOWN };
}
