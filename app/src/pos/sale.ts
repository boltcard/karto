// The sale screen's states and the ended sales still watched, as pure functions:
// the screen in pos-app/ holds the timers, the card reader and the calls, and asks these what each event makes
// of it.
import { currencyOf, minorSpoken, minorText, type CurrencyCode } from '../money/fiat';
import { satText, thousands, whenText } from '../money/words';
import type { ChargeOutcome } from './charge';
import type { PosSale } from './client';

/** How long Card read holds the person before it offers a way out: the card's server may take that long to pay. */
export const CARD_WAIT_MS = 30_000;
/** How long the sale screen asks the shop to hold its answer about the sale: under the 10 seconds a request may take. */
export const SALE_WAIT_S = 8;
/**
 * Whether the sale screen reads its sale again the moment an answer comes: yes after one that took a second or
 * more (the shop held it), so no payment arrives between two reads; after a quick one the next second's read is
 * soon enough, and a shop that doesn't hold is asked no more than once a second.
 */
export const readsAgainAtOnce = (startedMs: number, nowMs: number): boolean => nowMs - startedMs >= 1000;
/** An ended sale is read until this long past its invoice's end, in seconds. */
export const WATCH_PAST_S = 15;

const NOT_A_CARD = "That isn't a Bolt Card that can pay.";

/** How a sale that had ended came to be paid: said under "Paid". */
export type PaidHow = '' | 'after-cancel' | 'after-ran-out';

/**
 * Where the sale screen stands. waiting: the code and the card row; note is an amber line about the last card
 * held, online false while the shop's server doesn't answer. card-read: a card's server took the invoice at
 * `since` (ms); canLeave once CARD_WAIT_MS has passed. refused: the red panel; said: reason is the card's server's
 * own words. paid and ran-out: pages that stay until the person leaves them.
 */
export type SaleState =
  | { at: 'waiting'; sale: PosSale; note: string; online: boolean }
  | { at: 'card-read'; sale: PosSale; since: number; canLeave: boolean }
  | { at: 'refused'; sale: PosSale; said: boolean; reason: string }
  | { at: 'paid'; sale: PosSale; how: PaidHow }
  | { at: 'ran-out'; sale: PosSale; cancelled: boolean };

/** What a card held to the till came to: chargeCard's outcome, or the reading itself failing. */
export type CardOutcome = ChargeOutcome | { kind: 'not-a-card' } | { kind: 'moved-away' };

export type SaleEvent =
  /** The sale as the shop's server just answered it (each second). */
  | { kind: 'read'; sale: PosSale }
  /** No answer from the shop's server. */
  | { kind: 'offline' }
  /** A card touched the till: the last card's note is cleared while this one is read. */
  | { kind: 'card-held' }
  /** What became of a card held to the sale saleId: its server may answer after the person has moved on to another sale. */
  | { kind: 'card'; saleId: string; outcome: CardOutcome; nowMs: number }
  | { kind: 'tick'; nowMs: number }
  /** Card read's buttons, once it offers them. */
  | { kind: 'stop-waiting' }
  | { kind: 'back-to-sale' }
  /** Cancel sale. */
  | { kind: 'cancel' }
  /** ← in the band, Android's Back, and a page's own way back to the till (New sale). */
  | { kind: 'back' }
  /** On an iPhone, Apple's sheet ended with an error of iOS's own: its words go in the note. */
  | { kind: 'sheet-error'; text: string };

/**
 * What the screen does beside drawing the state: tell-card (tell the shop a card was read, not waited for),
 * cancel (ask the shop to cancel, not waited for), buzz-refused (two short buzzes), paid (the buzz and the chime),
 * and watch-…: keep reading this sale after leaving, and why.
 */
export type SaleEffect = 'tell-card' | 'cancel' | 'buzz-refused' | 'paid' | 'watch-cancelled' | 'watch-ran-out' | 'watch-stopped';

export const saleStart = (sale: PosSale): SaleState => ({ at: 'waiting', sale, note: '', online: true });

/** What an event makes of the sale screen. leave 'till': go back to the till, its amount cleared. */
export function saleStep(s: SaleState, e: SaleEvent): { state: SaleState; effects: SaleEffect[]; leave: null | 'till' } {
  const to = (state: SaleState, effects: SaleEffect[] = [], leave: null | 'till' = null) => ({ state, effects, leave });
  switch (e.kind) {
    case 'read': {
      if (e.sale.id !== s.sale.id || s.at === 'paid') return to(s);
      if (e.sale.state === 'paid') return to({ at: 'paid', sale: e.sale, how: s.at === 'ran-out' ? (s.cancelled ? 'after-cancel' : 'after-ran-out') : '' }, ['paid']);
      if (s.at === 'ran-out') return to(s);
      if (e.sale.state !== 'open') return to({ at: 'ran-out', sale: e.sale, cancelled: e.sale.state === 'cancelled' });
      return to(s.at === 'waiting' ? { ...s, sale: e.sale, online: true } : s);
    }
    case 'offline':
      return to(s.at === 'waiting' ? { ...s, online: false } : s);
    case 'card-held':
      return to(s.at === 'waiting' && s.note !== '' ? { ...s, note: '' } : s);
    case 'card': {
      // Cards held while one is being paid, on a panel, or once the sale is over are ignored; so is an outcome for another sale.
      if (s.at !== 'waiting' || e.saleId !== s.sale.id) return to(s);
      const o = e.outcome;
      if (o.kind === 'accepted') return to({ at: 'card-read', sale: s.sale, since: e.nowMs, canLeave: false }, ['tell-card']);
      if (o.kind === 'refused' && !(o.reason === NOT_A_CARD && !o.said)) return to({ at: 'refused', sale: s.sale, said: o.said, reason: o.reason }, ['buzz-refused']);
      const note = o.kind === 'moved-away' ? 'The card moved away. Hold it still.' : o.kind === 'unreachable' ? "Can't reach that card's server." : NOT_A_CARD;
      return to({ ...s, note });
    }
    case 'tick':
      return to(s.at === 'card-read' && !s.canLeave && e.nowMs - s.since >= CARD_WAIT_MS ? { ...s, canLeave: true } : s);
    case 'stop-waiting':
      // The sale is left open, so it shows in Sales if it is paid.
      return s.at === 'card-read' && s.canLeave ? to(s, ['watch-stopped'], 'till') : to(s);
    case 'back-to-sale':
      return (s.at === 'card-read' && s.canLeave) || s.at === 'refused' ? to(saleStart(s.sale)) : to(s);
    case 'cancel':
      return s.at === 'waiting' || s.at === 'refused' ? to(s, ['cancel', 'watch-cancelled'], 'till') : to(s);
    case 'back':
      if (s.at === 'waiting') return to(s, ['cancel', 'watch-cancelled'], 'till');
      if (s.at === 'refused') return to(saleStart(s.sale));
      // Card read holds: its two buttons, when they come, are the ways out.
      if (s.at === 'card-read') return to(s);
      if (s.at === 'ran-out') return to(s, [s.cancelled ? 'watch-cancelled' : 'watch-ran-out'], 'till');
      return to(s, [], 'till');
    case 'sheet-error':
      return to(s.at === 'waiting' ? { ...s, note: e.text } : s);
  }
}

/**
 * Whether the sale screen and the watched sales are read now. On an iPhone Apple's sheet may put the app in
 * 'inactive' while it is up, and a payment by the code must still show:
 * so under a sheet (up, or on its way out) only 'background' stops the reads.
 */
export const readsNow = (appState: string | null | undefined, sheetUp: boolean): boolean => appState === 'active' || (sheetUp && appState === 'inactive');

/** Beside the dot on the sale screen: the time left to pay, or that the shop's server isn't answering. */
export function waitingLine(sale: Pick<PosSale, 'expires'>, nowS: number, online: boolean): string {
  if (!online) return 'No connection: still checking.';
  const left = Math.max(0, Math.floor(sale.expires - nowS));
  return `Waiting for payment · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`;
}

/** The sale's code as a wallet scans it: lightning: and the invoice, all in capitals, which makes a smaller code. */
export const saleQr = (invoice: string): string => `LIGHTNING:${invoice.toUpperCase()}`;

/** A price's number without its symbol, as a sale's figure shows it over its unit: "2.50", "1,227.04", "480". */
function priceNumber(minor: number, code: CurrencyCode): string {
  const d = currencyOf(code).decimals;
  if (d === 0) return thousands(minor);
  const unit = 10 ** d;
  return `${thousands(Math.floor(minor / unit))}.${String(minor % unit).padStart(d, '0')}`;
}

/**
 * A sale's figure over its pages: a price rung up in a currency large
 * with its unit ("2.50" GBP) and cardd's sats under it ("4,075 sat"), or the sats large. label: what TalkBack reads.
 */
export function saleFigure(sale: Pick<PosSale, 'amountMsat' | 'price'>): { figure: string; unit: string; under: string | null; label: string } {
  const sats = satText(sale.amountMsat);
  if (!sale.price) return { figure: thousands(Math.floor(sale.amountMsat / 1000)), unit: 'sat', under: null, label: sats };
  const { currency, minor } = sale.price;
  return { figure: priceNumber(minor, currency), unit: currency, under: sats, label: `${minorSpoken(minor, currency)}, ${sats}` };
}

/** The Paid page: the amount (a price with its sats), how and when it was paid and by which phone, and how it came to be paid if the sale had ended. */
export function paidView(sale: PosSale, how: PaidHow, nowS: number, offsetMin: number): { amount: string; line: string; how: string; label: string } {
  const p = sale.price;
  const amount = p ? `${minorText(p.minor, p.currency)} · ${satText(sale.amountMsat)}` : satText(sale.amountMsat);
  const spoken = p ? saleFigure(sale).label : amount;
  const line = `${sale.method === 'card' ? 'By card' : 'By QR code'} · ${whenText(sale.paidAt ?? nowS, nowS, offsetMin)} · ${sale.device.name}`;
  const said = how === 'after-cancel' ? 'after the sale was cancelled' : how === 'after-ran-out' ? 'after the sale ran out' : '';
  return { amount, line, how: said, label: ['Paid', spoken, line, ...(said ? [said] : [])].join(', ') };
}

/**
 * The ran-out page: its lines (nothing of ten minutes after Cancel sale), and the button for the same sale again: at
 * its price when it had one (cardd converts it afresh, so its sats may differ), else the same sats. The page draws
 * the sale's figure itself (pos/parts.tsx SaleAmount).
 */
export function ranOutView(sale: PosSale, cancelled: boolean): { lines: string[]; again: string; charge: { sat: number } | { price: { currency: CurrencyCode; minor: number } } } {
  const sat = Math.floor(sale.amountMsat / 1000);
  const p = sale.price;
  return {
    lines: [...(cancelled ? [] : ['This sale ran out after 10 minutes.']), 'Nothing has been paid.'],
    again: p ? `Charge ${minorText(p.minor, p.currency)} again` : `Charge ${thousands(sat)} sat again`,
    charge: p ? { price: { currency: p.currency, minor: p.minor } } : { sat },
  };
}

/** A sale that ended unpaid and is still read: cancelled, ran out, or left open by Stop waiting. */
/** An ended or left sale still read. host: the shop it was made at; its id is never asked of another server. */
export type Watched = { id: string; expires: number; why: 'cancelled' | 'ran-out' | 'stopped'; host: string };

/**
 * The sale a sale screen leaves to be watched when it is taken away by anything but its own ways out (which watch
 * for themselves): one that can still be paid. A paid one needs no watch; one that ran out or was cancelled is
 * watched already.
 */
export function leftOpen(s: SaleState, host: string): Watched | null {
  return s.at === 'paid' || s.at === 'ran-out' ? null : { id: s.sale.id, expires: s.sale.expires, why: 'stopped', host };
}

/**
 * Where leaving the Paid page of a watched sale goes: back to a sale that is open underneath (it still waits for
 * its own customer, and must not be ended by this), else to the till.
 */
export const afterOverlay = (open: PosSale | null): 'sale' | 'till' => (open ? 'sale' : 'till');

/**
 * Whether a card held now is read for the sale: only while it waits, with no card already being read, and with
 * nothing over the sale screen (covered: Paid for an earlier sale, or Removed, is in front of it). The screen asks
 * this for every tap, whatever the NFC slot's claims are: their order can change while a page is over it.
 */
export const takesCard = (s: SaleState, busy: boolean, covered: boolean): boolean => !covered && !busy && s.at === 'waiting' && !!s.sale.invoice;

export type WatchEvent =
  | { kind: 'add'; sale: Watched }
  /** A watched sale as the shop's server just answered it (every 5 seconds, whatever screen is in front). */
  | { kind: 'read'; sale: PosSale }
  /** Before each round of reads. host: the shop the phone is paired with now. */
  | { kind: 'tick'; nowS: number; host: string }
  /** The shop's server has no such sale. */
  | { kind: 'gone'; id: string }
  /** The phone was unpaired or removed. */
  | { kind: 'clear' };

/**
 * The ended sales still watched, after an event. paid: one of them was paid after all: the Paid page opens over
 * whatever is in front, so a second sale isn't made for a customer who has paid. A sale is dropped when it is
 * paid, WATCH_PAST_S past its invoice's end, gone, or another shop's than the one the phone is paired with now.
 */
export function watched(list: Watched[], e: WatchEvent): { list: Watched[]; paid: { sale: PosSale; how: PaidHow } | null } {
  switch (e.kind) {
    case 'add':
      return { list: [...list.filter((w) => w.id !== e.sale.id), e.sale], paid: null };
    case 'read': {
      const w = list.find((x) => x.id === e.sale.id);
      if (!w || e.sale.state !== 'paid') return { list, paid: null };
      const how: PaidHow = w.why === 'cancelled' ? 'after-cancel' : w.why === 'ran-out' ? 'after-ran-out' : '';
      return { list: list.filter((x) => x !== w), paid: { sale: e.sale, how } };
    }
    case 'tick': {
      const keep = (w: Watched) => w.host === e.host && e.nowS <= w.expires + WATCH_PAST_S;
      return { list: list.every(keep) ? list : list.filter(keep), paid: null };
    }
    case 'gone':
      return { list: list.filter((w) => w.id !== e.id), paid: null };
    case 'clear':
      return { list: [], paid: null };
  }
}
