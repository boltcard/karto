// Amounts in a currency: the seven currencies mempool.space
// prices, an msat amount in one at the rate cardd read, the words a screen reader says for it, a price typed in one,
// and cardd's own conversions of a price or a limit to sats. A leaf both apps use: it imports only words.ts, and no
// Intl (Hermes's Intl depends on how it was built). Every amount here is the amount's size: a sign is the caller's.
import { thousands } from './words';

export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'CAD' | 'CHF' | 'AUD' | 'JPY';
/**
 * What cardd says of its currency (GET /api/v1/wallet's and GET /api/v1/pos/fiat's `fiat`): currency null when
 * the server never had one, 'none', or a code; price (whole units of it per BTC) and time (the rate's: cardd's clock at the round when Coinbase or
 * Kraken is among its sources, mempool.space's own time when it is alone; Unix seconds) only when currency is a code and cardd has a rate.
 */
export type Fiat = { currency: CurrencyCode | 'none' | null; price?: number; time?: number };
/** A currency with its rate: what every conversion needs. */
export type Rated = { currency: CurrencyCode; price: number; time: number };
/** symbol: as written before a figure ("CHF " keeps its space); major and minor: the spoken names, plural. */
export type Currency = { code: CurrencyCode; symbol: string; decimals: 0 | 2; name: string; major: string; minor: string };

/** In Settings' order. */
export const CURRENCIES: readonly Currency[] = [
  { code: 'USD', symbol: '$', decimals: 2, name: 'US dollar', major: 'dollars', minor: 'cents' },
  { code: 'EUR', symbol: '€', decimals: 2, name: 'Euro', major: 'euros', minor: 'cents' },
  { code: 'GBP', symbol: '£', decimals: 2, name: 'Pound', major: 'pounds', minor: 'pence' },
  { code: 'CAD', symbol: 'CA$', decimals: 2, name: 'Canadian dollar', major: 'dollars', minor: 'cents' },
  { code: 'CHF', symbol: 'CHF ', decimals: 2, name: 'Swiss franc', major: 'Swiss francs', minor: 'centimes' },
  { code: 'AUD', symbol: 'A$', decimals: 2, name: 'Australian dollar', major: 'dollars', minor: 'cents' },
  { code: 'JPY', symbol: '¥', decimals: 0, name: 'Yen', major: 'yen', minor: '' },
];

/** The most minor units cardd takes for a price or a limit (its MaxMinor): 10^10, £100 million. */
export const MAX_MINOR = 10_000_000_000;

export const isCode = (s: string): s is CurrencyCode => CURRENCIES.some((c) => c.code === s);
export const currencyOf = (code: CurrencyCode): Currency => CURRENCIES.find((c) => c.code === code)!;
export const symbol = (code: CurrencyCode): string => currencyOf(code).symbol;

/** The currency and its rate, when cardd gave a currency, a price and the price's time; else null (no £ anywhere). */
export function rated(f: Fiat | null | undefined): Rated | null {
  if (!f || typeof f.currency !== 'string' || !isCode(f.currency)) return null;
  if (typeof f.price !== 'number' || !(f.price > 0) || typeof f.time !== 'number') return null;
  return { currency: f.currency, price: f.price, time: f.time };
}

// Exact arithmetic in BigInt: an msat amount times a price passes 2^53 long before an amount anyone has.
const MSAT_PER_BTC = 100_000_000_000n;
const SAT_PER_BTC = 100_000_000n;
/** Minor units in one unit: 100, or 1 for yen. */
const scale = (code: CurrencyCode): bigint => 10n ** BigInt(currencyOf(code).decimals);
/** num / den rounded half up (both positive). */
const halfUp = (num: bigint, den: bigint): bigint => (2n * num + den) / (2n * den);
const size = (n: number): bigint => BigInt(Math.trunc(Math.abs(n)));
/** An msat amount at a rate, in minor units times MSAT_PER_BTC: exact. */
const exact = (msat: number, r: Rated): bigint => size(msat) * BigInt(r.price) * scale(r.currency);

/** minor units as figures with the currency's decimals and the thousands split: "1,227.04", "480". */
function figures(minor: bigint, code: CurrencyCode): string {
  const d = currencyOf(code).decimals;
  if (d === 0) return thousands(Number(minor));
  const s = scale(code);
  return `${thousands(Number(minor / s))}.${String(minor % s).padStart(d, '0')}`;
}

/** An msat amount in minor units at a rate, rounded half up. */
export const fiatMinor = (msat: number, r: Rated): number => Number(halfUp(exact(msat, r), MSAT_PER_BTC));

/**
 * The number alone, for an amount drawn with its unit after it (ui/money.tsx Amount): "8.15". Below one minor unit
 * (but more than nothing) it is that one unit and under is true: "< 0.01", never "0.00".
 */
export function fiatNumber(msat: number, r: Rated): { text: string; under: boolean } {
  const x = exact(msat, r);
  if (x > 0n && x < MSAT_PER_BTC) return { text: figures(1n, r.currency), under: true };
  return { text: figures(halfUp(x, MSAT_PER_BTC), r.currency), under: false };
}

/** An amount in a sentence: "£3.07", "¥521", "CHF 4.20", "under £0.01". */
export function fiatText(msat: number, r: Rated): string {
  const n = fiatNumber(msat, r);
  return `${n.under ? 'under ' : ''}${symbol(r.currency)}${n.text}`;
}

/** A name for one: "penny" for pence, else the plural without its s ("Swiss francs", "cents"). */
const one = (plural: string): string => (plural === 'pence' ? 'penny' : plural.replace(/s$/, ''));

/** minor units in words: "3 pounds 7", "1 pound", "5 pence", "1 penny", "521 yen". */
function spoken(minor: bigint, code: CurrencyCode): string {
  const c = currencyOf(code);
  if (c.decimals === 0) return `${thousands(Number(minor))} ${c.major}`;
  const s = scale(code);
  const major = Number(minor / s);
  const rest = Number(minor % s);
  if (major === 0) return rest === 0 ? `0 ${c.major}` : `${rest} ${rest === 1 ? one(c.minor) : c.minor}`;
  const majorWords = `${thousands(major)} ${major === 1 ? one(c.major) : c.major}`;
  return rest === 0 ? majorWords : `${majorWords} ${rest}`;
}

/** An amount in words, for a screen reader: "3 pounds 7", "521 yen", "under 1 penny". */
export function fiatSpoken(msat: number, r: Rated): string {
  const x = exact(msat, r);
  if (x > 0n && x < MSAT_PER_BTC) {
    const c = currencyOf(r.currency);
    return `under 1 ${c.decimals === 0 ? c.major : one(c.minor)}`;
  }
  return spoken(halfUp(x, MSAT_PER_BTC), r.currency);
}

/** A price or limit kept in minor units: "£2.50", "¥480". whole: a whole amount without its ".00" ("£20"). */
export function minorText(minor: number, code: CurrencyCode, o: { whole?: boolean } = {}): string {
  const n = size(minor);
  const s = scale(code);
  return `${symbol(code)}${o.whole && n % s === 0n ? thousands(Number(n / s)) : figures(n, code)}`;
}

/** A price kept in minor units as figures alone, its decimals always shown: "0.12", "1,227.04", "480". */
export const minorFigures = (minor: number, code: CurrencyCode): string => figures(size(minor), code);

/** A price kept in minor units, in words: "2 pounds 50", "480 yen". */
export const minorSpoken = (minor: number, code: CurrencyCode): string => spoken(size(minor), code);

/** minor units as a field is filled with them: "2.50", "1227.04", "480" (no symbol, no thousands). */
export function minorInputText(minor: number, code: CurrencyCode): string {
  const d = currencyOf(code).decimals;
  if (d === 0) return String(Math.trunc(minor));
  const s = 10 ** d;
  return `${Math.floor(minor / s)}.${String(minor % s).padStart(d, '0')}`;
}

/**
 * A price typed in the currency, as minor units: "2.50", "2.5", "2,50" and "2" (and "2." while the decimals are
 * still to come). Null for anything else: more decimals than the currency has (any for yen), nothing, zero, a sign,
 * thousands separators, or more than cardd takes (MAX_MINOR).
 */
export function fiatInput(text: string, code: CurrencyCode): number | null {
  const m = /^([0-9]+)(?:([.,])([0-9]*))?$/.exec(text.trim());
  if (!m) return null;
  const d = currencyOf(code).decimals;
  const frac = m[3] ?? '';
  if ((m[2] !== undefined && d === 0) || frac.length > d) return null;
  const minor = Number(m[1]) * 10 ** d + Number(frac.padEnd(d, '0') || '0');
  return Number.isSafeInteger(minor) && minor > 0 && minor <= MAX_MINOR ? minor : null;
}

/**
 * A price in whole sats, as msat: cardd's conversion of a sale (SatForMinor), sat = minor × 10^8 /
 * (price × 10^decimals) rounded half up. The phone's preview of it, and what Send out and Move send.
 */
export function minorToMsat(minor: number, r: Rated): number {
  return Number(halfUp(size(minor) * SAT_PER_BTC, BigInt(r.price) * scale(r.currency))) * 1000;
}

/** A limit in msat: cardd's conversion at a tap, half up to the whole sat as a sale's, so a sale at a limit fits it. */
export function limitToMsat(minor: number, r: Rated): number {
  return minorToMsat(minor, r);
}

/**
 * The rate's age: null under an hour, then "2 h old", "3 days old". The rate's
 * time against the phone's clock: a phone with a wrong clock says a wrong age, and one behind says none.
 */
export function rateAge(r: Rated, nowS: number): string | null {
  const age = Math.floor(nowS - r.time);
  if (age < 3600) return null;
  if (age < 86_400) return `${Math.floor(age / 3600)} h old`;
  const days = Math.floor(age / 86_400);
  return `${days} ${days === 1 ? 'day' : 'days'} old`;
}

/** The rate as the field's line says it: "1 BTC = £61,352". */
export const rateText = (r: Rated): string => `1 BTC = ${symbol(r.currency)}${thousands(r.price)}`;

/** The line under a field typed in the currency: "≈ 8,150 sat at 1 BTC = £61,352"; the rate alone until a price is typed. */
export function typedFiatLine(text: string, r: Rated): string {
  const minor = fiatInput(text, r.currency);
  return minor === null ? rateText(r) : `≈ ${thousands(minorToMsat(minor, r) / 1000)} sat at ${rateText(r)}`;
}
