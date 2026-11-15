// The till's pad: the amount of a
// sale in whole sats, or with a shop currency and its rate its price in that currency, typed on twelve keys. A price
// is typed from its last digit, as on a cash register: 1 then 2 is £0.12.
// Everything here is arithmetic on what the till holds: nothing waits on the rate.
import { isCode, MAX_MINOR, minorFigures, minorSpoken, minorText, minorToMsat, rated, rateAge, symbol, type CurrencyCode, type Fiat, type Rated } from '../money/fiat';
import { thousands } from '../money/words';

/** The most cardd takes for one sale, in sat. */
export const MAX_SALE_SAT = 2_000_000;
export { MAX_MINOR };

/** The pad's twelve keys, row by row in three columns: '00' puts two 0s after the amount, 'delete' is ⌫. */
export const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'delete'] as const;

/** n after a key, in whole units of its last place: a digit or 00 goes after it, delete takes the last; null for no key. */
function shifted(n: number, key: string): number | null {
  if (key === 'delete') return Math.floor(n / 10);
  if (!/^(?:[0-9]|00)$/.test(key)) return null;
  return n * 10 ** key.length + Number(key);
}

/**
 * The amount after a key. A digit (or 00) goes after it, unless it would pass the most a sale can be: then the key is
 * ignored, 00 whole. delete takes the last digit. A 0 can't lead (0 then 0 is still 0), and anything that is no key
 * changes nothing.
 */
export function keypad(sat: number, key: string): number {
  const next = shifted(sat, key);
  return next === null || next > MAX_SALE_SAT ? sat : next;
}

/** What the pad holds: whole sats, or a price in the shop's currency's minor units (pence). */
export type Typed = { unit: 'sat'; sat: number } | { unit: CurrencyCode; minor: number };

/**
 * The price after a key, at the till's rate, in minor units: each digit comes in at the pence end, as keypad's does at
 * the sats' (yen have no pence, so a digit is a yen). A key whose price would pass the most a sale can be (2,000,000
 * sat at this rate, or cardd's bound on minor units) is ignored, as keypad's is. cardd's refusal is the backstop when
 * its rate differs.
 */
export function priceKeypad(minor: number, key: string, r: Rated): number {
  const next = shifted(minor, key);
  return next === null || next > MAX_MINOR || minorToMsat(next, r) > MAX_SALE_SAT * 1000 ? minor : next;
}

/** A key on the pad in use. A price takes keys only at its own currency's rate. */
export function typeKey(t: Typed, key: string, r: Rated | null): Typed {
  if (t.unit === 'sat') return { unit: 'sat', sat: keypad(t.sat, key) };
  return r && r.currency === t.unit ? { unit: t.unit, minor: priceKeypad(t.minor, key, r) } : t;
}

/** A sale starts in the shop's currency when the till has its rate (the next sale after a sat-key one too), else in sat. */
export const startTyped = (r: Rated | null): Typed => (r ? { unit: r.currency, minor: 0 } : { unit: 'sat', sat: 0 });

/**
 * The pad after the rate changed: a rate that arrives before anything is typed takes it to the currency, unless the
 * sat key was pressed for this sale; a price in a currency that is no longer the shop's, or with no rate now, starts
 * again.
 */
export function retarget(t: Typed, r: Rated | null, satKey: boolean): Typed {
  if (t.unit === 'sat') return !satKey && r && t.sat === 0 ? startTyped(r) : t;
  return r && r.currency === t.unit ? t : startTyped(r);
}

/**
 * The figure as the till shows it (a price with its decimals from the start: "0.00", "0.12"), its unit after it, what TalkBack reads, and in a currency the sats it comes to at
 * the till's rate ("≈ 4,075 sat"), which cardd's own conversion may differ from by its rate.
 */
export function figureText(t: Typed, r: Rated | null): { figure: string; unit: string; label: string; under: string | null } {
  if (t.unit === 'sat') return { figure: thousands(t.sat), unit: 'sat', label: `${thousands(t.sat)} sat`, under: null };
  const { minor } = t;
  const sat = r && r.currency === t.unit && minor > 0 ? minorToMsat(minor, r) / 1000 : null;
  return {
    figure: minorFigures(minor, t.unit),
    unit: t.unit,
    label: minorSpoken(minor, t.unit),
    under: sat === null ? null : `≈ ${thousands(sat)} sat`,
  };
}

/** The Charge button: named by the amount or the price, and off at nothing. */
export function chargeLabel(t: Typed): { title: string; off: boolean } {
  if (t.unit === 'sat') return t.sat > 0 ? { title: `Charge ${thousands(t.sat)} sat`, off: false } : { title: 'Charge', off: true };
  return t.minor > 0 ? { title: `Charge ${minorText(t.minor, t.unit)}`, off: false } : { title: 'Charge', off: true };
}

/** What Charge asks cardd for (POST /api/v1/pos/sales): the sats, or the price, which cardd converts at its rate. */
export const chargeOf = (t: Typed): { sat: number } | { price: { currency: CurrencyCode; minor: number } } =>
  t.unit === 'sat' ? { sat: t.sat } : { price: { currency: t.unit, minor: t.minor } };

/**
 * The line under the figure: with a currency but no rate ever, cardd's own words ("No £ rate yet: type the price in
 * sat."); with a rate over an hour old, its age ("£ at a rate 2 h old"); else nothing.
 */
export function tillNote(fiat: Fiat | null, nowS: number): string | null {
  const code = fiat?.currency;
  if (!code || !isCode(code)) return null;
  const sym = symbol(code).trim();
  const r = rated(fiat);
  if (!r) return `No ${sym} rate yet: type the price in sat.`;
  const age = rateAge(r, nowS);
  return age ? `${sym} at a rate ${age}` : null;
}
