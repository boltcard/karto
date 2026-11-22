// The VAT the country picker shows next to each country. LNVPS has no public
// rate table: an account's VAT comes from its declared (and IP-derived)
// country once set, and the country step checks that it is the chosen
// country's, or none (vatGuard). This table only tells the person beforehand:
// LNVPS charges EU buyers their own country's standard rate (OSS) and no VAT
// outside the EU; the rate charged is LNVPS's own.
// EU standard rates as of 2026 (European Commission figures).
import { countryByAlpha3 } from './countries';

export const EU_VAT: Readonly<Record<string, number>> = {
  AUT: 20, BEL: 21, BGR: 20, HRV: 25, CYP: 19, CZE: 21, DNK: 25, EST: 24, FIN: 25.5,
  FRA: 20, DEU: 19, GRC: 24, HUN: 27, IRL: 23, ITA: 22, LVA: 21, LTU: 21, LUX: 17,
  MLT: 18, NLD: 21, POL: 23, PRT: 23, ROU: 21, SVK: 23, SVN: 22, ESP: 21, SWE: 25,
};

/** The VAT rate (percent) LNVPS is expected to charge for this country. */
export const expectedVat = (alpha3: string): number => EU_VAT[alpha3] ?? 0;

export const vatLabel = (rate: number): string => (rate === 0 ? 'no VAT' : `VAT ${rate}%`);

/** The country screen's button: the choice and its VAT, so the person sees it before going on. */
export function continueLabel(alpha3: string | undefined): string {
  const country = alpha3 ? countryByAlpha3(alpha3) : undefined;
  return country ? `Continue with ${country.name} (${vatLabel(expectedVat(country.alpha3))})` : 'Choose a country';
}
