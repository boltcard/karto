// What an account's page says besides its balance:
// a card's limits as rows and the note under its balance, the More sheet's rows, and hosting's server panel. The page
// and its sheets draw these; the words and the colours are decided here.
import type { CardState, HostingStatus, WalletCard } from '../cardd/client';
import { shortDate, thousands, whenText } from '../money/format';
import { minorText, type Rated } from '../money/fiat';
import { coversText, hostingWarnings, paidUntil } from '../money/hosting';
import { viewText, type Unit, type View } from '../money/view';
import type { RowTone } from '../ui/look';

const STATE: Record<string, string> = { active: 'Active', frozen: 'Frozen', programming: 'Being added', wiping: 'Being wiped' };

type Limits = Pick<WalletCard, 'perTapSat' | 'dailySat' | 'limits'>;

/**
 * A card's limit as it was set: in its own currency, never
 * converted ("£5.00"), or in sat ("20,000 sat").
 */
export function limitText(c: Limits, which: 'perTap' | 'daily'): string {
  if (c.limits) return minorText(which === 'perTap' ? c.limits.perTapMinor : c.limits.dailyMinor, c.limits.currency);
  return `${thousands(which === 'perTap' ? c.perTapSat : c.dailySat)} sat`;
}

/** More's Limits line: "20,000 per payment · 50,000 a day", "£5.00 per payment · £20.00 a day"; *** while hidden. */
export function limitsLine(c: Limits, v: View = 'sat'): string {
  if (v === 'hidden') return '*** per payment · *** a day';
  if (c.limits) return `${limitText(c, 'perTap')} per payment · ${limitText(c, 'daily')} a day`;
  return `${thousands(c.perTapSat)} per payment · ${thousands(c.dailySat)} a day`;
}

/**
 * A card's limits under its buttons, a label and a value to a row (three items on one line
 * read as a muddle): per payment, per 24 hours (the limit is a rolling 24 hours, as the Limits sheet says), each in
 * the unit it was set in, and what it has used of that, in the app's view; *** hides all three.
 */
export const cardLimits = (c: Limits & Pick<WalletCard, 'spent24hMsat'>, v: View = 'sat', r: Rated | null = null): [string, string][] => [
  ['Per payment', v === 'hidden' ? '***' : limitText(c, 'perTap')],
  ['Per 24 hours', v === 'hidden' ? '***' : limitText(c, 'daily')],
  ['Used in 24 hours', viewText(c.spent24hMsat, v, r)],
];

/**
 * Under a card's balance: the Frozen tag, a part-way state's name in plain words, or nothing for an active card.
 * phone: the card is a phone's, this phone's own or another's,
 * and the note always says so.
 */
export function headerNote(state: CardState, phone: 'own' | 'other' | null = null): { tag: boolean; text: string } | null {
  if (phone) {
    const whose = phone === 'own' ? 'This phone' : 'A phone';
    if (state === 'frozen') return { tag: true, text: `Frozen · ${whose.toLowerCase()}` };
    return { tag: false, text: state === 'programming' ? `${whose} · being set up` : state === 'wiping' ? `${whose} · being removed` : whose };
  }
  if (state === 'active') return null;
  return { tag: state === 'frozen', text: STATE[state] ?? state };
}

/**
 * The line under a card's limits after a restore (cardd's needsCheck), as Frozen has its own: it can't pay until held
 * to the phone. Never a phone's card: the wallet checks its own itself, and removes another phone's.
 */
export function checkLine(needsCheck: boolean | undefined, phone: 'own' | 'other' | null = null): string | null {
  return needsCheck && !phone ? "After the restore: can't pay until you hold it to the phone; still takes top-ups." : null;
}

export type MoreRows = {
  /** The Limits row's line. */
  limits: string;
  /** The Change photo row's line. */
  photo: string;
  /** The Wipe row's line; disabled while a payment holds some of the balance (cardd refuses the wipe). */
  wipe: { line: string; disabled: boolean };
  /** The I no longer have this card row's line; disabled as Wipe's is. */
  giveUp: { line: string; disabled: boolean };
  /** The sheet's last line: the state and version. */
  foot: string;
};

/**
 * The red Wipe the card row's line, under More and on the sheet for a card held to the phone:
 * where the balance goes; off while a payment holds some of it (cardd refuses the wipe). c: the wallet's record
 * of the card, none when it doesn't list it.
 */
export function wipeLine(c: Pick<WalletCard, 'balanceMsat' | 'heldMsat'> | undefined, v: View = 'sat', r: Rated | null = null): { line: string; disabled: boolean } {
  if (c && c.heldMsat > 0) return { line: 'Wait for the payment in progress', disabled: true };
  return { line: c && c.balanceMsat >= 1000 ? `Its ${viewText(c.balanceMsat, v, r)} move to Pool; the card is blank again.` : 'The card is blank again.', disabled: false };
}

/**
 * The red I no longer have this card row's line, and its confirm's: where the balance goes (in the chosen unit while amounts
 * are hidden, as a wipe's), and that taps of the card are refused; off while a payment holds some of it.
 */
export function giveUpLine(c: Pick<WalletCard, 'balanceMsat' | 'heldMsat'>, unit: Unit = 'sat', r: Rated | null = null): { line: string; disabled: boolean } {
  if (c.heldMsat > 0) return { line: 'Wait for the payment in progress', disabled: true };
  const refused = 'taps of it are refused.';
  return { line: c.balanceMsat >= 1000 ? `Its ${viewText(c.balanceMsat, unit, r)} move to Pool; ${refused}` : `Taps of it are refused.`, disabled: false };
}

/** A card given up on its page, for the Wallet page: its name, the balance that moved to Pool, and whether the server's finish is still to come (the catch-up makes it). */
export type GaveUp = { name: string; amountMsat: number; pending: boolean };

/** The Wallet page's lines for the cards given up, one each, in the page's own view (hidden stays hidden). */
export function gaveUpNotice(g: readonly GaveUp[], v: View = 'sat', r: Rated | null = null): string[] {
  return g.map(({ name, amountMsat, pending }) => {
    const moved = amountMsat >= 1000 ? `${name} was removed: its ${viewText(amountMsat, v, r)} moved to Pool.` : `${name} was removed.`;
    return pending ? `${moved} Your server will be told when it answers.` : moved;
  });
}

/** The More sheet's rows for a card. hasPhoto: the phone holds its photo. Wipe's line confirms money: in the chosen unit while *** (unit; sat when not given and hidden). */
export function moreRows(c: Pick<WalletCard, 'state' | 'version' | 'perTapSat' | 'dailySat' | 'limits' | 'balanceMsat' | 'heldMsat'>, hasPhoto: boolean, v: View = 'sat', r: Rated | null = null, unit: Unit = v === 'hidden' ? 'sat' : v): MoreRows {
  return {
    limits: limitsLine(c, v),
    photo: hasPhoto ? 'Take a new picture of the card' : 'Take a picture of the card',
    wipe: wipeLine(c, unit, r),
    giveUp: giveUpLine(c, unit, r),
    foot: `${STATE[c.state] ?? c.state} · version ${c.version}`,
  };
}

/** Hosting's server panel: its dot, its title, the muted lines under it, the amber ones and the red ones. */
export type HostingCard = { tone: RowTone; title: string; lines: string[]; warnings: string[]; problems: string[] };

/** cardd's renewal problem when Hosting held too little (server/internal/renew/job.go): the funding line already says it. */
const noMoney = (problem: string) => problem.includes('not enough for a renewal');

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * How long the server is paid for and whether it renews itself. Red with the last
 * renewal problem, the VAT stop, or the funding line or the wallet's paid-until banner when those are red (funding
 * under 7 days, the date under 3); amber with the funding line or that banner in amber, or when it won't renew itself and nothing says why; green otherwise; no dot before cardd's first sync or without its status (the date
 * is then LNVPS's own, when the phone has it).
 */
export function hostingCard(status: HostingStatus | null, lnvpsExpires: number | null, nowS: number, offsetMin = -new Date(nowS * 1000).getTimezoneOffset()): HostingCard {
  const synced = status?.synced ? status : null;
  const p = paidUntil(status, lnvpsExpires, nowS);
  const w = hostingWarnings(status, lnvpsExpires, nowS, offsetMin);
  const title = !p
    ? 'Checking how long your server is paid for…'
    : p.days < 0
      ? `Expired on ${shortDate(p.expires, nowS, offsetMin)}`
      : `Paid until ${shortDate(p.expires, nowS, offsetMin)} (${plural(Math.floor(p.days), 'day')})${p.estimated ? ', estimated' : ''}`;
  // Hosting being low is said once, in the funding line's own colour: the coverage line and a renewal that failed
  // for want of money say the same thing.
  const problem = synced?.problem && !(w.funding && noMoney(synced.problem)) ? `Last renewal problem (${whenText(synced.problemAt, nowS, offsetMin)}): ${synced.problem}` : null;
  const warnings = w.funding && w.fundingTone === 'amber' ? [w.funding] : [];
  const problems = [...(w.funding && w.fundingTone === 'red' ? [w.funding] : []), ...(problem ? [problem] : []), ...(w.vat ? [w.vat] : [])];
  const said = warnings.length > 0 || problems.length > 0;
  const lines = synced
    ? [...(synced.willRenew ? ['Renews itself when due.'] : said ? [] : ["Won't renew itself when due."]), ...(w.funding ? [] : [coversText(synced)])]
    : [];
  // The wallet's paid-until banner colours the dot as it is itself: red under 3 days, amber before.
  const tone: RowTone = problems.length > 0 || w.banner?.tone === 'red' ? 'error' : warnings.length > 0 || w.banner ? 'warn' : !synced ? 'none' : synced.willRenew ? 'ok' : 'warn';
  return { tone, title, lines, warnings, problems };
}
