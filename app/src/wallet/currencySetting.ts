// Settings' Currency row and its list: the choices in order, what
// the row says, and the currency a server that never had one is given: the wallet phone's region's.
import { CURRENCIES, isCode, rated, type CurrencyCode, type Fiat } from '../money/fiat';

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
