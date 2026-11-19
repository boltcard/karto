// The wallet's card stack: which cards it
// shows, in what order, and what each card's strip and face say.
import type { CardInfo, CardState, Wallet } from '../cardd/client';
import { availableMsat } from '../money/format';
import { cardsToCheck, cardsToRepoint } from '../onboarding/serverPage';
import { walletColours } from './colours';
import { byAdded } from './order';

/** A card as cardd lists it, or as the phone's cache remembers it (no created, no host). host: from cardd's list only. */
export type Row = Pick<CardInfo, 'id' | 'name' | 'state' | 'version' | 'host' | 'needsCheck'> & { counter?: number; created?: number };

/** The phones' cards among the cards: their ids, and this phone's own. */
export type Phones = { ids: ReadonlySet<string>; own: string | null };
const NO_PHONES: Phones = { ids: new Set(), own: null };

/** One card in the stack. availableMsat: null when the wallet doesn't list the card (being added, or the server is down). */
export type StackEntry = {
  id: string; name: string; colour: string; state: CardState;
  label: 'Active' | 'Frozen' | 'Finish setup' | 'Finish wipe' | 'Being set up' | 'Being removed';
  /** A card part-way through being added or wiped opens the hold-the-card screen to finish. Never a phone's: the wallet finishes that itself. */
  partWay: 'add' | 'wipe' | null;
  repoint: boolean;
  /** A restore left it needing a check before it can pay: it is to be held to the phone (not one to re-point). */
  check: boolean;
  availableMsat: number | null; version: number; counter?: number;
  /** A phone that is a card, this phone or another: drawn with a phone before its name, with no photo. */
  phone: 'own' | 'other' | null;
};

const FACE: Record<Exclude<CardState, 'reset'>, Pick<StackEntry, 'label' | 'partWay'>> = {
  active: { label: 'Active', partWay: null },
  frozen: { label: 'Frozen', partWay: null },
  programming: { label: 'Finish setup', partWay: 'add' },
  wiping: { label: 'Finish wipe', partWay: 'wipe' },
};
/** A phone's card is never held to anything: part-way, it only waits for the wallet (phoneCard/keep.ts). */
const PHONE_FACE: typeof FACE = {
  ...FACE,
  programming: { label: 'Being set up', partWay: null },
  wiping: { label: 'Being removed', partWay: null },
};

const shownName = (c: Row) => c.name || 'Unnamed card';

/** The stack, back first and front last, without wiped cards; host: this server's. */
export function stackOrder(cards: Row[], wallet: Wallet | null, host: string, phones: Phones = NO_PHONES): StackEntry[] {
  const colours = walletColours(cards);
  const repoint = new Set(cardsToRepoint(cards, host, phones.ids).map((c) => c.id));
  const check = new Set(cardsToCheck(cards, host, phones.ids).map((c) => c.id));
  return cards
    .filter((c): c is Row & { state: Exclude<CardState, 'reset'> } => c.state !== 'reset')
    .sort(byAdded)
    .map((c) => {
      const w = wallet?.cards.find((x) => x.id === c.id);
      const phone = c.id === phones.own ? 'own' : phones.ids.has(c.id) ? 'other' : null;
      return {
        id: c.id, name: shownName(c), colour: colours[c.id], state: c.state, ...(phone ? PHONE_FACE : FACE)[c.state],
        repoint: repoint.has(c.id), check: check.has(c.id), availableMsat: w ? availableMsat(w) : null, version: c.version, counter: c.counter, phone,
      };
    });
}

/** The small tag on a card's strip: warn (amber) for what needs the person, plain for Frozen; none for a plain active card. */
export function stripTag(e: StackEntry): { text: string; tone: 'warn' | 'plain' } | null {
  if (e.partWay) return { text: e.label, tone: 'warn' };
  // A phone's card part-way needs nothing of the person.
  if (e.phone && (e.state === 'programming' || e.state === 'wiping')) return { text: e.label, tone: 'plain' };
  if (e.repoint) return { text: 're-point', tone: 'warn' };
  if (e.check) return { text: 'hold to phone', tone: 'warn' };
  if (e.state === 'frozen') return { text: 'Frozen', tone: 'plain' };
  return null;
}

/** A card's button's accessible name: its name, its state, and its strip's tag when that says more ("Daily, Active, hold to phone"). */
export function stripLabel(e: StackEntry): string {
  const tag = stripTag(e)?.text;
  return [e.name, e.label, ...(tag && tag !== e.label ? [tag] : [])].join(', ');
}
