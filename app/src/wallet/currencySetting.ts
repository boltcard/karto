// Settings' Currency row and its list: the choices in order, what
// the row says, and the currency a server that never had one is given: the wallet phone's region's. Then Show
// amounts in: its row's line and its list.
import { CURRENCIES, isCode, rated, type CurrencyCode, type Fiat } from '../money/fiat';
import type { Unit } from '../money/view';

export type CurrencyChoice = { value: CurrencyCode | 'none'; name: string };

/** None, then the seven in Settings' order, each with its symbol: "Pound £", "Swiss franc CHF". */
export const CURRENCY_CHOICES: readonly CurrencyChoice[] = [
  { value: 'none', name: 'None' },
  ...CURRENCIES.map((c) => ({ value: c.code, name: `${c.name} ${c.symbol.trim()}` })),
];

/**
 * The Currency row's line, and whether it is off. wallet: the watch's last wallet answer (null: none yet, or the
 * server can't be read now); fiat: what the view holds (the choice just made, before a wallet answer says it).
 */
export function currencyRow(wallet: { fiat?: Fiat } | null, fiat: Fiat | null): { line: string; off: boolean } {
  if (wallet && wallet.fiat === undefined) return { line: 'Needs a server update', off: true };
  const said = fiat ?? wallet?.fiat ?? null;
  if (!said) return { line: 'Checking…', off: true };
  const off = wallet === null;
  if (said.currency === null) return { line: 'Not set yet', off };
  if (said.currency === 'none') return { line: 'None', off };
  return { line: rated(said) ? said.currency : `${said.currency} · no rate yet`, off };
}

/** The phone's region currency (expo-localization's currencyCode), or none when it isn't one of the seven. */
export const regionCurrency = (code: string | null | undefined): CurrencyCode | 'none' => (code && isCode(code) ? code : 'none');

const fiatCode = (fiat: Fiat | null): CurrencyCode | null => (fiat?.currency && fiat.currency !== 'none' ? fiat.currency : null);

/** Show amounts in's line: the unit kept, the currency by its code ("GBP") as the Currency row says it. */
export function unitRow(unit: Unit, fiat: Fiat | null): string {
  return unit === 'fiat' ? (fiatCode(fiat) ?? 'Currency') : unit;
}

/**
 * Show amounts in's list: the server's currency ("Pound £"), sat and msat. The currency is off while the server has
 * none, or none is known yet (no answer, an older cardd); one whose rate is still coming may be chosen (sat shows
 * until it comes).
 */
export function unitChoices(fiat: Fiat | null): { value: Unit; name: string; off: boolean }[] {
  const code = fiatCode(fiat);
  const named = code && CURRENCY_CHOICES.find((c) => c.value === code);
  return [
    { value: 'fiat', name: named ? named.name : 'Currency', off: !named },
    { value: 'sat', name: 'sat', off: false },
    { value: 'msat', name: 'msat', off: false },
  ];
}
