// The wallet's one view of every amount: the currency,
// sat, msat or hidden, set in Settings (and hidden by the Wallet page's eye). Pure: what an amount shows in each
// view, the figure under a large one, a fee's words and the rate's age line. A leaf: it imports fiat.ts and words.ts
// alone, so Karto PoS may use it. sat is the nearest whole sat: a figure shown, never one checked
// against a balance, which compare msat.
import { fiatNumber, fiatSpoken, fiatText, rateAge, symbol, type Rated } from './fiat';
import { thousands } from './words';

export type View = 'fiat' | 'sat' | 'msat' | 'hidden';
/** An amount as Amount draws it: the number, its unit after it ('' when hidden), and its words for a screen reader. */
export type Shown = { number: string; unit: string; spoken: string };

const ORDER: readonly View[] = ['fiat', 'sat', 'msat', 'hidden'];

export const isView = (x: unknown): x is View => typeof x === 'string' && (ORDER as readonly string[]).includes(x);

/** The unit amounts are shown in, chosen in Settings: hidden is kept apart from it, so showing again comes back to it. */
export type Unit = 'fiat' | 'sat' | 'msat';
export const isUnit = (x: unknown): x is Unit => x === 'fiat' || x === 'sat' || x === 'msat';

const satFigure = (msat: number) => thousands(Math.round(Math.abs(msat) / 1000));
const msatFigure = (msat: number) => thousands(Math.abs(msat));
/** The view an amount is drawn in: £ with no rate is sat. */
const drawn = (v: View, r: Rated | null): View => (v === 'fiat' && !r ? 'sat' : v);

/** An amount in a view: sat to the nearest whole sat, msat exact, £ at the rate ("< 0.01" below a penny), *** with no unit. */
export function shown(msat: number, v: View, r: Rated | null): Shown {
  const view = drawn(v, r);
  if (view === 'hidden') return { number: '***', unit: '', spoken: 'amount hidden' };
  if (view === 'fiat') {
    const n = fiatNumber(msat, r!);
    return { number: `${n.under ? '< ' : ''}${n.text}`, unit: r!.currency, spoken: `${fiatSpoken(msat, r!)} at today's rate` };
  }
  if (view === 'msat') return { number: msatFigure(msat), unit: 'msat', spoken: `${msatFigure(msat)} millisat` };
  return { number: satFigure(msat), unit: 'sat', spoken: `${satFigure(msat)} sat` };
}

/** An amount inside a sentence: "4,075 sat", "£2.50", "4,075,000 msat", "***". */
export function viewText(msat: number, v: View, r: Rated | null): string {
  const view = drawn(v, r);
  if (view === 'hidden') return '***';
  if (view === 'fiat') return fiatText(msat, r!);
  return view === 'msat' ? `${msatFigure(msat)} msat` : `${satFigure(msat)} sat`;
}

/** The small figure under a large one: "≈ £8.15" under sat or msat, "13,291 sat" under £; none when hidden or with no rate. */
export function altText(msat: number, v: View, r: Rated | null): string | null {
  const view = drawn(v, r);
  if (view === 'hidden' || !r) return null;
  return view === 'fiat' ? `${satFigure(msat)} sat` : `≈ ${fiatText(msat, r)}`;
}

/** A fee in the view: "fee under 5 sat" (a budget's under, as money/format.ts feeText), "fee 4,412 msat", "fee under £0.01", "fee ***". */
export function feeViewText(msat: number, v: View, r: Rated | null): string {
  const view = drawn(v, r);
  if (view === 'hidden') return 'fee ***';
  if (view === 'fiat') return `fee ${fiatText(msat, r!)}`;
  if (view === 'msat') return `fee ${msatFigure(msat)} msat`;
  return msat % 1000 ? `fee under ${thousands(Math.ceil(msat / 1000))} sat` : `fee ${thousands(msat / 1000)} sat`;
}

/** The line at the top of a page while a £ figure can be on it and the rate is over an hour old: "£ at a rate 2 h old". */
export function ageLine(r: Rated | null, v: View, nowS: number): string | null {
  if (!r || v === 'hidden') return null;
  const age = rateAge(r, nowS);
  return age && `${symbol(r.currency).trim()} at a rate ${age}`;
}

/**
 * The view where money is being confirmed: Send out, Move, Renew, a wipe and the pay screen show their
 * amounts once you are on them, so *** shows sat there; the other views stand.
 */
export const confirmView = (v: View): View => (v === 'hidden' ? 'sat' : v);

/** An estimate in the view: "about 9 sat", "about £28.99"; one already under the smallest unit stays "under £0.01". */
export function aboutText(msat: number, v: View, r: Rated | null): string {
  const t = viewText(msat, v, r);
  return t.startsWith('under ') ? t : `about ${t}`;
}

/**
 * Two figures a problem line compares ("Pool has A; this needs up to B"), in the view; when they would read the same
 * (rounding hides a shortfall), both exactly in msat. Hidden stays hidden.
 */
export function apartText(a: number, b: number, v: View, r: Rated | null): [string, string] {
  const ta = viewText(a, v, r);
  const tb = viewText(b, v, r);
  return ta === tb && v !== 'hidden' ? [viewText(a, 'msat', r), viewText(b, 'msat', r)] : [ta, tb];
}
