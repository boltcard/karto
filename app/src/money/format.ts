// How the money screens say amounts:
// in the app's view (money/view.ts), history rows too, with a sale's price as it was set and today's value "now".
import { CarddError, type CardLimits, type SaleDay, type Tx, type Wallet } from '../cardd/client';
import { isNetworkFailure } from '../lightning/lightning';
import {
  currencyOf, fiatInput, fiatMinor, fiatSpoken, fiatText, isCode, MAX_MINOR, minorInputText, minorSpoken, minorText, minorToMsat, limitToMsat, type CurrencyCode, type Rated,
} from './fiat';
import { payerNoteText, quotedPayerNote } from './note';
import type { MoneyRequest, RequestOutcome } from './requests';
import { feeViewText, shown, viewText, type View } from './view';
import { dayStart, dayText, localTime, thousands } from './words';

// The words Karto PoS says too live in words.ts.
export { dayStart, dayText, shortDate, thousands, whenText } from './words';

/** An msat amount exactly: "13,438 sat", "81.204 sat", "-1,004 sat". */
export function msatText(msat: number): string {
  const sign = msat < 0 ? '-' : '';
  const abs = Math.abs(msat);
  const frac = abs % 1000;
  return `${sign}${thousands(Math.floor(abs / 1000))}${frac ? `.${String(frac).padStart(3, '0').replace(/0+$/, '')}` : ''} sat`;
}

/** A fee's words: "fee 12 sat"; one with a part of a sat as under the next whole sat, "fee under 5 sat" for 4.084. */
export function feeText(msat: number): string {
  return msat % 1000 ? `fee under ${thousands(Math.ceil(msat / 1000))} sat` : `fee ${thousands(msat / 1000)} sat`;
}

/** Whole sats typed by the person ("1,234"), as msat; null if it isn't a positive whole number. */
export function satInput(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  return /^[0-9]+$/.test(t) && Number(t) > 0 ? Number(t) * 1000 : null;
}

export const availableMsat = (a: { balanceMsat: number; heldMsat: number }) => a.balanceMsat - a.heldMsat;

/**
 * What an amount field holds, as msat: the whole sats typed, or a
 * price typed in the currency as the whole sats it is at the rate (cardd's half-up conversion, so Check shows what
 * is sent). With no rate a field types sat whatever the phone last typed in. Null for nothing to send.
 */
export function typedMsat(text: string, unit: 'fiat' | 'sat', r: Rated | null): number | null {
  if (unit === 'sat' || !r) return satInput(text);
  const minor = fiatInput(text, r.currency);
  const msat = minor === null ? 0 : minorToMsat(minor, r);
  return msat > 0 ? msat : null;
}

/** What is typed, in the other unit, when the field's chip is tapped: "5.00" → "8150", "8150" → "5.00"; '' when it is no amount. */
export function convertTyped(text: string, to: 'fiat' | 'sat', r: Rated): string {
  if (to === 'sat') {
    const minor = fiatInput(text, r.currency);
    return minor === null ? '' : String(minorToMsat(minor, r) / 1000);
  }
  const msat = satInput(text);
  return msat === null ? '' : minorInputText(fiatMinor(msat, r), r.currency);
}

/** What a move moves: with All, the exact msat available (no dust stays behind); else what is typed, in its unit. */
export const moveAmountMsat = (all: boolean, typed: string, availableMsat: number, unit: 'fiat' | 'sat' = 'sat', r: Rated | null = null) =>
  all ? availableMsat : typedMsat(typed, unit, r);

/**
 * A card's limits as its sheet says them now, in their own unit: "Now £20 a day · £5 a tap", "Now 50,000
 * sat a day · 20,000 sat a tap"; and, for limits kept in a currency that is no longer the server's, a
 * note saying so and what they can be changed in. server: the server's currency, rate or none (a moment without one
 * doesn't make it another's); offer: the currency they can be changed in, the server's while it has a rate, else null.
 */
export function limitsNow(
  c: { perTapSat: number; dailySat: number; limits?: CardLimits }, server: CurrencyCode | null, offer: CurrencyCode | null = server,
): { line: string; note: string | null } {
  const l = c.limits;
  if (!l) return { line: `Now ${thousands(c.dailySat)} sat a day · ${thousands(c.perTapSat)} sat a tap`, note: null };
  const said = (minor: number) => minorText(minor, l.currency, { whole: true });
  const line = `Now ${said(l.dailyMinor)} a day · ${said(l.perTapMinor)} a tap`;
  if (l.currency === server) return { line, note: null };
  return { line, note: `Set in ${currencyOf(l.currency).major}, which is no longer your server's currency: change them in sat${offer ? ` or ${offer}` : ''}.` };
}

/** What a hold reserves while a payment is on its way: its amount and fee budget, in the view. */
export const heldLine = (heldMsat: number, v: View = 'sat', r: Rated | null = null) =>
  heldMsat > 0 ? `${viewText(heldMsat, v, r)} held for a payment in progress (including its fee budget)` : '';

/** The warning before a first top-up, in the person's words: empty once phoenixd has a channel. */
export function topUpWarning(liquidity: Wallet['liquidity'], v: View = 'sat', r: Rated | null = null): string {
  if (!liquidity) return "Your server can't check its Lightning channel right now. If this is the first top-up, send over 50,000 sat.";
  if (liquidity.channel) return '';
  return (
    `The first top-up pays ACINQ, who run your server's Lightning channel, to open it: about ${viewText(liquidity.firstChannelFeeSat * 1000, v, r)} at today's fees. ` +
    'Send over 50,000 sat to be sure of an open channel, the remainder will be your initial balance.'
  );
}

/** The most a card's limit can be (cardd's cards.SetLimits), in sat; limits in a currency are held to it at the rate. */
export const LIMIT_CAP_SAT = 2_000_000;

/**
 * A card's limits as cardd checks them when saved: both positive, per payment no more than per 24 hours, none over
 * 2,000,000 sat. In sat; or, with inCurrency, in its minor units, with the cap converted at its rate and rounded
 * half up to the whole sat as cardd converts a limit, so the line
 * stays true.
 */
export function limitsProblem(perTap: number, daily: number, inCurrency?: Rated): string | null {
  if (!(perTap > 0) || !(daily > 0)) return `Limits must be more than ${inCurrency ? minorText(0, inCurrency.currency) : '0 sat'}.`;
  if (perTap > daily) return "The limit per payment can't be more than the 24-hour limit.";
  if (!inCurrency) return daily > LIMIT_CAP_SAT ? 'Limits are up to 2,000,000 sat.' : null;
  const over = daily > MAX_MINOR || limitToMsat(daily, inCurrency) > LIMIT_CAP_SAT * 1000;
  return over ? `Limits are up to 2,000,000 sat (${fiatText(LIMIT_CAP_SAT * 1000, inCurrency)}).` : null;
}

/** A money request's refusal (or failure) in a sentence for the screen. */
export function moneyError(e: unknown): string {
  if (!(e instanceof CarddError)) return isNetworkFailure(e) ? "Can't reach your server." : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
  const after = (prefix: string) => e.message.replace(prefix, '').trim();
  switch (e.code) {
    case 'insufficient':
      return 'There isn’t enough money available.';
    case 'paused':
      return 'Spending is paused until the books add up again (see Settings).';
    case 'payment_in_progress':
      return 'Another payment from this account is still on its way.';
    case 'duplicate_payment':
      return 'This invoice was already paid from your server, or is being paid now.';
    case 'cannot_receive':
      return "That account can't receive money now.";
    case 'bad_invoice':
      return `The invoice can't be paid: ${after("ledger: the invoice can't be paid:")}.`;
    case 'bad_address':
      return `Couldn't get an invoice: ${after("lnaddr: can't get an invoice from this address:")}.`;
    case 'bad_return_link':
      // A refund to this server's own name, in any spelling, that isn't one of its cards' refund links.
      return "That address is your own server's: give the customer's own invoice or address.";
    case 'bad_limits':
      return "Those limits aren't allowed: each is 1 to 2,000,000 sat, and per payment no more than per 24 hours.";
    case 'no_rate':
      return 'Your server has no rate for its currency yet: set the limits in sat, or try again in a few minutes.';
    case 'wrong_currency':
      return "Your server's currency changed meanwhile: start again.";
    case 'not_synced':
      return "The server doesn't have the VM's expiry from LNVPS yet: open the wallet, then try again.";
    case 'vat':
      return 'LNVPS now charges you VAT, so the server doesn’t renew: use Pay LNVPS from any wallet.';
    case 'bad_days':
      return 'Renew for 1 to 365 days.';
    case 'bad_note':
      // cardd's words are the person's: "a note is 200 characters at most".
      return e.message;
    case 'phoenixd_unreachable':
      return "Your server can't reach its Lightning node (phoenixd): try again in a minute.";
    case 'bad_destination':
      // cardd's words are already the person's.
      return e.message;
    case 'not_lnvps':
      return `LNVPS's answer wasn't for this VM (${after("renew: LNVPS's answer isn't for this VM:")}): nothing was paid.`;
  }
  return `The server refused: ${e.message}`;
}

/** A time as "2026-10-05 14:07" in the phone's time zone (offsetMin: minutes east of UTC; no Intl, which Hermes may lack). */
export function dateText(unixS: number, offsetMin: number): string {
  const d = new Date(unixS * 1000 + offsetMin * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** The icon of a history row's kind (ui/icons.tsx draws each). */
export type HistoryIcon = 'in' | 'spend' | 'out' | 'move' | 'wipe' | 'renew' | 'fee' | 'books' | 'sale' | 'dot';
/**
 * line: the time and any fee; amount: the figure in the view with its sign ("+2,500", "+2.69", "***"); msat: its size,
 * for the Amount that draws it; sign: '' for nothing in or out, and while hidden; now: the figure is today's value
 * (£ view: "now" under it); incoming: drawn green; label: what TalkBack reads; payerNote: a top-up's payer's note in
 * curly quotes, '' for none: a third line; comment: the person's note, '' for none: a line after it.
 */
export type HistoryRow = {
  id: number; icon: HistoryIcon; name: string; line: string; amount: string; msat: number; sign: '+' | '−' | ''; now: boolean; incoming: boolean; label: string;
  payerNote: string;
  comment: string;
  /** A till sale refunded from this wallet: drawn with its tag and its amount struck through. Absent otherwise. */
  refunded?: true;
};
export type HistoryDay = { day: string; rows: HistoryRow[] };

/**
 * What historyRows knows beside the entries: the wallet's cards, to name a move's card; on Shop's page, the sales
 * counted by day; and the app's view with the rate (ui/amountView.tsx), sat with no rate when not given.
 */
export type HistoryMore = { cards?: { id: string; name: string }[]; days?: SaleDay[]; view?: View; rated?: Rated | null };

/** A move's other account as its row names it: a card by its name in the wallet, "a card" when it has none or isn't listed. */
export function otherName(other: string, cards: NonNullable<HistoryMore['cards']>): string {
  if (other === 'pool' || other === 'hosting' || other === 'shop') return other[0].toUpperCase() + other.slice(1);
  return cards.find((c) => c.id === other)?.name || 'a card';
}

/**
 * A kind's name and icon by its leg's sign: a move is named for its other account when cardd gives it (an older
 * server doesn't), and a wipe has a leg on the card and one on pool.
 */
export function kindOf(t: Tx, cards: NonNullable<HistoryMore['cards']>): { name: string; icon: HistoryIcon } {
  const incoming = t.amountMsat > 0;
  switch (t.kind) {
    case 'topup':
      // Through one of this server's refund links: a shop gave a sale back.
      return { name: t.via === 'refund' ? 'Refund' : 'Top-up', icon: 'in' };
    case 'spend':
      return { name: 'Spent at a terminal', icon: 'spend' };
    case 'send':
      return { name: 'Sent out', icon: 'out' };
    case 'move':
      if (t.other) return { name: `Moved ${incoming ? 'from' : 'to'} ${otherName(t.other, cards)}`, icon: 'move' };
      return { name: incoming ? 'Moved in' : 'Moved out', icon: 'move' };
    case 'sale':
      return { name: 'Sale', icon: 'sale' };
    case 'refund':
      // The receiving card's line of an own-card refund is money in.
      return { name: 'Refund', icon: incoming ? 'in' : 'out' };
    case 'wipe':
      return incoming ? { name: 'From a wiped card', icon: 'in' } : { name: 'Wiped', icon: 'wipe' };
    case 'renew':
      return { name: 'Renewed the VM', icon: 'renew' };
    case 'fee-adjust':
      return { name: 'Routing fee over budget', icon: 'fee' };
    case 'adjust':
      return { name: 'Books set', icon: 'books' };
  }
  return { name: t.kind, icon: 'dot' };
}

/**
 * A sale's line after the time: how it was paid, the phone that took it, its price when it was rung up in a currency
 * ("priced £2.50", in the currency it was rung up in and never converted; none for a currency this app doesn't
 * know, as pos/salesView.ts), and where the rest went when Shop was credited less than the price, in £ view today's
 * value marked "now". said: the same for a screen reader.
 */
function saleFacts(t: Tx, v: View, r: Rated | null): { shown: string[]; said: string[] } {
  if (!t.sale) return { shown: [], said: [] };
  const how = [t.sale.method === 'card' ? 'Card' : 'QR', t.sale.device];
  const p = t.sale.price && isCode(t.sale.price.currency) ? t.sale.price : null;
  const priced = !p ? [] : v === 'hidden' ? [['priced ***', 'price hidden']] : [[`priced ${minorText(p.minor, p.currency)}`, `priced ${minorSpoken(p.minor, p.currency)}`]];
  const short = t.sale.priceMsat - t.amountMsat;
  // [shown, said]: in £ view today's value of what went to fees, marked "now" as every £ figure of the past is.
  const lost = v === 'fiat' && r ? [`${fiatText(short, r)} now`, `${fiatSpoken(short, r)} now`] : [viewText(short, v, r), viewText(short, v, r)];
  const fees = short > 0 ? [lost.map((s) => `${s} to channel fees`)] : [];
  return { shown: [...how, ...priced.map(([s]) => s), ...fees.map(([s]) => s)], said: [...how, ...priced.map(([, s]) => s), ...fees.map(([, s]) => s)] };
}

/** A refund's line after the time: "for the sale of 13:02", the sale it gave back. */
function refundFacts(t: Tx, nowS: number, offsetMin: number): { shown: string[]; said: string[] } {
  if (!t.sale?.paidAt) return { shown: [], said: [] };
  const words = `for the sale of ${localTime(t.sale.paidAt, nowS, offsetMin).time}`;
  return { shown: [words], said: [words] };
}

/**
 * A day heading's total of Shop's sales in the view, with today's value "now" beside the sats when there is a rate:
 * the total the heading shows (sales/days' totalMsat), converted, never a
 * sum of the rows loaded, so the two agree after Load more.
 */
function dayTotal(msat: number, v: View, r: Rated | null): string {
  if (v === 'hidden') return '***';
  if (v === 'fiat' && r) return `${fiatText(msat, r)} now`;
  return r ? `${viewText(msat, v, r)} · ${fiatText(msat, r)} now` : viewText(msat, v, r);
}

/**
 * A line's figure as its row shows it: a spend, a send and a renewal without their routing fee (the fee is on the line
 * under); anything else this account's amount. plus: drawn as money in, and always for a sale and a top-up (which may
 * have reached the account as nothing).
 */
export function lineAmount(t: Tx): { msat: number; plus: boolean } {
  const charge = t.kind === 'spend' || t.kind === 'send' || t.kind === 'renew' || t.kind === 'refund';
  const msat = charge ? t.amountMsat + t.feeMsat : t.amountMsat;
  return { msat, plus: msat > 0 || t.kind === 'sale' || t.kind === 'topup' };
}

/**
 * An account's history as its page shows it: the entries, newest first
 * as cardd gives them, grouped by the phone's day. A spend, a send and a renewal show the charge without its routing
 * fee, the fee on the line under (a top-up's fee is the channel's, said as "N sat to ACINQ for the channel");
 * anything else this account's amount (lineAmount); a sale's and a top-up's with its plus even when nothing of it
 * reached the account. The figure is in the app's view: the nearest whole sat, exact msat, today's value in £ marked
 * "now", or ***, which hides fees and "priced" too. The entry's note is cardd's own record ("paid <hash>") and isn't
 * shown; a top-up's payer's note is, in quotes as a third line and in the label after the worth; the person's
 * own note (comment) is, as a line after it and last in the label. The hidden view hides figures, not notes. With more.days (Shop's page) a
 * day cardd counted sales for says them in its heading: their number and their prices, which a row's amount can be
 * under by a channel fee, and their value now.
 */
export function historyRows(txs: Tx[], nowS: number, offsetMin: number, more: HistoryMore = {}): HistoryDay[] {
  const r = more.rated ?? null;
  // A £ view needs a rate: the provider settles the view (money/view.ts settleView); this keeps a row from ever being empty.
  const v: View = more.view === 'fiat' && !r ? 'sat' : (more.view ?? 'sat');
  const days: HistoryDay[] = [];
  let lastStart = NaN;
  for (const t of txs) {
    const { msat, plus } = lineAmount(t);
    const size = Math.abs(msat);
    const figure = shown(size, v, r);
    // A top-up's fee is the channel's, paid to ACINQ for the room it bought; any other kind's is a routing fee.
    const fee = !t.feeMsat ? '' : t.kind === 'topup' ? `${feeViewText(t.feeMsat, v, r).replace(/^fee /, '')} to ACINQ for the channel` : feeViewText(t.feeMsat, v, r);
    const { time } = localTime(t.created, nowS, offsetMin);
    const { name, icon } = kindOf(t, more.cards ?? []);
    const minus = !plus && msat < 0;
    // A top-up the books credited nothing of, with no fee, went to phoenixd's fee credit.
    const nothing = t.kind === 'topup' && msat === 0 && !t.feeMsat ? ['to fee credit'] : [];
    // A refund names the sale it gave back by its time; a sale its own facts.
    const facts = t.kind === 'refund' ? refundFacts(t, nowS, offsetMin) : saleFacts(t, v, r);
    const refunded = t.kind === 'sale' && t.sale?.refund?.state === 'paid';
    const under = [time, ...facts.shown, ...nothing, ...(fee ? [fee] : [])];
    const said = [time, ...facts.said, ...nothing, ...(fee ? [fee] : [])];
    const sign = v === 'hidden' ? '' : plus ? '+' : minus ? '−' : '';
    const worth =
      v === 'hidden' ? 'amount hidden' : v === 'fiat' && r ? `worth ${fiatSpoken(size, r)} at today's rate` : `${plus ? 'plus ' : minus ? 'minus ' : ''}${figure.number} ${figure.unit}`;
    const row: HistoryRow = {
      id: t.id,
      icon,
      name,
      line: under.join(' · '),
      // A figure under one minor unit reads "< 0.01"; with a sign in front it is "−under 0.01", never "−< 0.01" (ui/money.tsx Amount does the same).
      amount: `${sign}${sign && figure.number.startsWith('< ') ? `under ${figure.number.slice(2)}` : figure.number}`,
      msat: size,
      sign,
      now: v === 'fiat',
      incoming: plus,
      payerNote: quotedPayerNote(t),
      comment: t.comment ?? '',
      label: [name, ...said, worth, ...(payerNoteText(t) ? [`note from the payer, ${payerNoteText(t)}`] : []), ...(t.comment ? [t.comment] : []), ...(refunded ? ['refunded'] : [])].join(', '),
      ...(refunded ? { refunded: true as const } : {}),
    };
    // An entry a moment ahead of the phone's clock is today's (dayText), so it joins today's rows and heading.
    const start = Math.min(dayStart(t.created, offsetMin), dayStart(nowS, offsetMin));
    if (start === lastStart) {
      days[days.length - 1].rows.push(row);
      continue;
    }
    lastStart = start;
    const sold = more.days?.find((d) => d.day === start);
    const counted = sold ? ` · ${sold.count} ${sold.count === 1 ? 'sale' : 'sales'} · ${dayTotal(sold.totalMsat, v, r)}` : '';
    days.push({ day: dayText(t.created, nowS, offsetMin) + counted, rows: [row] });
  }
  return days;
}

/** What became of each move, send or renewal left from before (src/money/requests.ts resumePending), one line each. */
export function resumeNotice(done: { req: MoneyRequest; outcome: RequestOutcome }[]): string[] {
  return done.map(({ req, outcome }) => {
    const what =
      req.kind === 'move'
        ? `A move of ${msatText(req.amountMsat)}`
        : req.kind === 'send'
          ? `A send of ${msatText(req.amountMsat ?? 0)} to ${req.to}`
          : `A renewal of ${req.days} ${req.days === 1 ? 'day' : 'days'}`;
    switch (outcome.at) {
      case 'answered':
        return `${what} from before is done.`;
      case 'refused':
        return `${what} from before was refused: ${moneyError(outcome.error)}`;
      case 'unknown':
        return `${what} from before isn't confirmed yet: the history will show it.`;
      case 'dropped':
        return req.kind === 'renew'
          ? `${what} from before wasn't confirmed. Before renewing again, check hosting: a “Renewed the VM” line in its history means it went; nothing held and no line means it didn't.`
          : `${what} from before wasn't confirmed. Before sending it again, check pool: a “Sent out” line in its history means it went; nothing held and no line means it didn't.`;
    }
  });
}
