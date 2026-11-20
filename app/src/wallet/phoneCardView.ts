// What the screens say of the phone as a card, and when:
// the Wallet page's button and its notice of a removed card, Add card's first question, the pay screen's words
// for each of its moments, and the More sheet's rows. The screens draw these; nothing here is React.
import { CarddError, type CardState, type WalletCard } from '../cardd/client';
import { isNetworkFailure } from '../lightning/lightning';
import { minorText, type Rated } from '../money/fiat';
import { feeViewText, viewText, type Unit, type View } from '../money/view';
import { thousands } from '../money/words';
import type { NfcState } from '../native/nfc';
import { CounterSpent, phoneCardId, phonesCardsWide } from '../phoneCard/id';
import type { Removed } from '../phoneCard/keep';
import type { PayView } from '../phoneCard/pay';
import { RecordUnreadable } from '../phoneCard/record';
import { AlreadyACard } from '../phoneCard/setup';
import { limitsLine, wipeLine } from './accountView';

/** The ids of the phones' cards among the server's, and of this phone's own (from its record, listed or not). */
export function phonesAmong(issuer: Uint8Array, cards: readonly { id: string }[], record: { n: number } | null): { ids: Set<string>; own: string | null } {
  return { ids: new Set(phonesCardsWide(issuer, cards).map((p) => p.card.id)), own: record ? phoneCardId(issuer, record.n) : null };
}

type OwnCard = { id: string; name: string; state: CardState };
/** The Wallet page's Pay with this phone: the card it pays with; off, with the line that says why. */
export type PayButton = { card: OwnCard; off: boolean; line: string | null };

/**
 * The button is there while this phone has a card of its own that is listed, or remembered while the server can't
 * be reached, as active or frozen; not while that card is being removed, and never on a phone the server has
 * unpaired, whatever it remembers. own: this phone's card as the list has it.
 */
export function payButton(o: { supported: boolean; revoked: boolean; removing: boolean; nfc: NfcState | null; own: OwnCard | undefined }): PayButton | null {
  if (!o.supported || o.revoked || o.removing || !o.own || (o.own.state !== 'active' && o.own.state !== 'frozen')) return null;
  const off = o.nfc === 'off';
  return { card: o.own, off, line: off ? 'NFC is off. Turn it on to pay with this phone.' : null };
}

/** Add card first asks what is being added only where this phone can be a card and is not one. */
export const asksWhatToAdd = (o: { supported: boolean; hasRecord: boolean }): boolean => o.supported && !o.hasRecord;

/** Add card's first question, and its two answers. */
export const WHAT_TO_ADD = {
  lead: 'What are you adding?',
  card: { name: 'A Bolt Card', line: 'A plastic card you hold to this phone' },
  phone: { name: 'This phone', line: 'Pay by holding the phone to a till' },
} as const;

/** The set-up page: what it means, said once, here. */
export const SET_UP = {
  title: 'This phone as a card',
  lines: [
    'Tills that take Bolt Cards will read this phone as one. It gets its own balance and limits, like your other cards.',
    'It answers a till only while Pay is open, after your screen lock.',
  ],
  button: 'Set up',
} as const;

/** Whether Set up can be pressed: a name of one line, at most 40 characters as the server takes it. */
export const canSetUp = (name: string, busy: boolean): boolean => !busy && name.trim().length > 0 && [...name.trim()].length <= 40 && !/[\r\n]/.test(name);

/** Once it is set up: the card is empty until money is moved onto it. */
export const setUpDone = (name: string) => ({ title: `${name} is a card`, line: 'It has no money yet. Move some onto it to pay with this phone.', move: 'Move money onto it' });

/** Why a set-up, or the removal of this phone's card, stopped. */
export function phoneCardError(e: unknown): string {
  if (e instanceof AlreadyACard || e instanceof CounterSpent) return e.message;
  if (e instanceof RecordUnreadable) return "This phone couldn't read what it keeps of its card. Unlock the phone and try again.";
  if (isNetworkFailure(e)) return "Can't reach your server. This needs it.";
  if (e instanceof CarddError) return `Your server refused: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** Seconds as the count shows them: 0:52. */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

type Ready = Extract<PayView, { at: 'ready' }>;
type Read = Extract<PayView, { at: 'read' }>;
type Paid = Extract<PayView, { at: 'paid' }>;
type Over = Extract<PayView, { at: 'over' }>;
type Cant = Extract<PayView, { at: 'cant' }>;

/** The pay screen while the phone is a card no till has read. warning: the amber panel, in the small line's place. mode: the unit, also while amounts are hidden. */
export function readyWords(v: Ready, card: { name: string; availableMsat: number | null; perTapSat: number | null; limits?: WalletCard['limits'] }, mode: View = 'sat', r: Rated | null = null) {
  // A limit set in a currency is said in it.
  const upTo = card.limits ? minorText(card.limits.perTapMinor, card.limits.currency) : card.perTapSat === null ? null : `${thousands(card.perTapSat)} sat`;
  return {
    lead: 'Hold the back of this phone to the till',
    wait: `Ready · ${clock(v.left)} left`,
    label: `${card.name} · available`,
    amount: card.availableMsat === null ? null : viewText(card.availableMsat, mode, r),
    small: !v.server ? null : upTo === null ? 'The till sets the amount.' : `The till sets the amount. Up to ${upTo} a payment.`,
    warning: v.server ? null : "Your server can't be reached from this phone. The till can still take a payment.",
  };
}

/** Once a till has read the phone. */
export function readWords(v: Read): { title: string; lines: string[] } {
  return {
    title: 'Read by the till',
    lines: [
      v.left === null ? 'This phone has stopped being a card.' : 'You can take the phone away.',
      v.server ? 'Asking your server what was paid…' : "This screen can't reach your server: look at the till, and at this card's history later, to see what was paid.",
    ],
  };
}

/** A payment: the amount in the view (the screen's title is "Paid" and it), then the lines under it. */
export function paidWords(v: Paid, name: string, mode: View = 'sat', r: Rated | null = null): { title: string; amount: string; lines: string[] } {
  return {
    title: 'Paid',
    amount: viewText(v.amountMsat, mode, r),
    lines: [...(v.feeMsat ? [feeViewText(v.feeMsat, mode, r)] : []), `From ${name}`, ...(v.leftMsat === null ? [] : [`${viewText(v.leftMsat, mode, r)} left`])],
  };
}

/** It ended with no payment seen. Only a screen the server answered before the arming may say nothing was taken. */
export function overWords(v: Over): { title: string; lines: string[] } {
  if (v.server) {
    return v.read
      ? { title: 'Nothing has been taken so far', lines: ["The till read this phone. If it still completes the payment, it will show in this card's history."] }
      : { title: 'Nothing has been taken', lines: ['No till read this phone, and it has stopped being a card.'] };
  }
  return v.read
    ? { title: 'Read by the till', lines: ["This screen couldn't reach your server. Look at the till, and at this card's history later, to see what was paid."] }
    : { title: 'This phone has stopped being a card', lines: ['No till read it.'] };
}

/** Why the phone was not made a card. openCard: the card's page is where to put it right. */
export function cantWords(why: Cant['why'], name: string): { title: string; line: string; openCard: boolean } {
  switch (why) {
    case 'frozen':
      return { title: `${name} is frozen.`, line: 'A till would be refused. Unfreeze the card to pay with this phone.', openCard: true };
    case 'gone':
      return { title: `${name} can't pay just now.`, line: 'Your server no longer lists it as a card that can pay. The Wallet page shows how it stands.', openCard: false };
    case 'no-record':
      return { title: "This phone isn't set up as a card.", line: 'Add it under + Add card on the Wallet page.', openCard: false };
    case 'counter':
      return { title: "This phone's card has used up its counter.", line: "Check the phone's date.", openCard: false };
    case 'refused':
      return { title: "This phone can't be a card just now.", line: "Android didn't give this app the reader. Another app set to answer payments may be keeping it.", openCard: false };
  }
}

const STATE: Record<string, string> = { active: 'Active', frozen: 'Frozen', programming: 'Being set up', wiping: 'Being removed' };

/**
 * The More sheet's rows for a phone's card: its limits, and Remove this phone's card in the place of Wipe the
 * card, with the wipe's own line about the balance and off as that is. No photo rows. Another phone's card has no
 * Remove: the wallet removes that by itself (phoneCard/keep.ts).
 */
export function phoneMoreRows(c: Pick<WalletCard, 'state' | 'perTapSat' | 'dailySat' | 'limits' | 'balanceMsat' | 'heldMsat'>, own: boolean, mode: View = 'sat', r: Rated | null = null, unit: Unit = mode === 'hidden' ? 'sat' : mode): {
  limits: string; remove: { line: string; disabled: boolean } | null; foot: string;
} {
  const wipe = wipeLine(c, unit, r);
  const line = wipe.disabled ? wipe.line : c.balanceMsat >= 1000 ? `Its ${viewText(c.balanceMsat, unit, r)} move to Pool; this phone stops being a card.` : 'This phone stops being a card.';
  return {
    limits: limitsLine(c, mode),
    remove: own ? { line, disabled: wipe.disabled } : null,
    foot: `${STATE[c.state] ?? c.state} · ${own ? 'this phone' : 'a phone'}`,
  };
}

const listed = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * The Wallet page's notice of the cards the wallet removed because they were another phone's, until it is
 * dismissed. canAdd: this phone can be a card and is not one.
 */
export function removedNotice(removed: readonly Removed[], canAdd: boolean, mode: View = 'sat', r: Rated | null = null): { text: string; add: string | null } | null {
  if (removed.length === 0) return null;
  const add = canAdd ? 'To pay with this phone, add it under + Add card.' : null;
  if (removed.length > 1) {
    return { text: `The cards of ${removed.length} phones this wallet was on before were removed: ${listed(removed.map((r) => r.name))}. What they held is in Pool.`, add };
  }
  const [{ name, amountMsat }] = removed;
  const money = amountMsat !== null && amountMsat >= 1000 ? ` Its ${viewText(amountMsat, mode, r)} are in Pool.` : '';
  return { text: `${name}'s card was removed. It was the card of the phone this wallet was on before.${money}`, add };
}
