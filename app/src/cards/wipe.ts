// Wiping a card: the keys go back to zero first, K0
// last, while SUN still shows which card this is; then the factory file
// settings and an empty NDEF file. Works without cardd, from the cache.
// A wipe is for one card: any other card held is refused
// before the server hears of a wipe or the card is written.
import { deriveCardKeys } from '../boltcard/cardkeys';
import { CarddError } from '../cardd/client';
import type { Ntag424 } from '../ntag424/card';
import { ZERO_KEY } from '../ntag424/crypto';
import { FACTORY_FILE_SETTINGS } from '../ntag424/ndef';
import { CardFlowError, isNetworkFailure, type CardDeps } from './deps';
import { identify, refusePlain } from './identify';

export type WipeStep = 'check' | 'server' | 'keys' | 'key0' | 'settings' | 'url' | 'done';
export const WIPE_STEPS: WipeStep[] = ['check', 'server', 'keys', 'key0', 'settings', 'url', 'done'];

/** The card a wipe is for: its id and, for the refusal's words, its name when one is known. */
export type Only = { id: string; name?: string };

/** What a card held for another card's wipe is told. held, wanted: the two cards' names, when known. */
export function wrongCardText(held?: string, wanted?: string): string {
  if (!wanted) return "This isn't the card to wipe. Hold that card.";
  return held ? `This is ${held}, not ${wanted}. Hold ${wanted} to wipe it.` : `This isn't ${wanted}. Hold ${wanted} to wipe it.`;
}

/** A card held for another card's wipe: nothing was told to cardd and nothing written. */
export class WrongCardError extends CardFlowError {
  constructor(held?: string, wanted?: string) {
    super(wrongCardText(held, wanted));
    this.name = 'WrongCardError';
  }
}

/** True once cardd has it (or has no such card); false if cardd can't be reached. */
async function tell(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return true;
  } catch (e) {
    if (isNetworkFailure(e)) return false;
    if (e instanceof CarddError && e.code === 'not_found') return true;
    throw e;
  }
}

/**
 * only: the card this wipe is for. serverTold: cardd has the finished wipe. local: the card's key 0 was already
 * zero and not by this phone, so cardd and the cache were left alone (the phone that began the wipe tells cardd).
 */
export async function wipeCard(card: Ntag424, d: CardDeps, o: { only?: Only; onStep?: (s: WipeStep) => void } = {}): Promise<{ serverTold: boolean; local: boolean }> {
  const step = (s: WipeStep) => o.onStep?.(s);
  const i = await identify(card, d);
  refusePlain(i);
  if (i.kind === 'foreign') throw new CardFlowError("This card belongs to another service, so it can't be wiped here.");
  // Before the blank card's refusal, so "already blank" is said only of the wipe's own card; and before the card
  // proves its key 0, cardd hears anything or a key is changed.
  if (o.only && i.id !== o.only.id) throw new WrongCardError(i.known?.name, o.only.name);
  if (i.kind === 'blank') throw new CardFlowError('This card is already blank.');
  const read = i.read!;
  const id = i.id!;
  if (i.version === undefined && read.versions.some((v) => v !== 0)) {
    throw new CardFlowError("Can't tell which version this card's keys were written at, so it can't be wiped.");
  }
  const version = i.version ?? 0;
  const name = i.known?.name ?? '';
  const keys = deriveCardKeys(d.issuer, i.uid!, version);
  // The card proves it holds this card's K0 before cardd hears of a wipe: a tag that
  // only claims a card's UID must not stop that card spending.
  await card.authenticate(0, read.versions[0] === 0 ? ZERO_KEY : keys.k0);
  step('check');

  // A K0 that is already zero proves nothing about a card cardd has as active or frozen
  // (any tag can answer GetCardUID with that UID), unless this phone zeroed it itself (its
  // wipe is pending in the cache). The phone that did tells cardd through its own catch-up,
  // so this wipe stays on the card: cardd and the cache are left alone.
  const own = (await d.cache.cards())[id]?.pending !== undefined;
  const local = read.versions[0] === 0 && !own && (i.known?.state === 'active' || i.known?.state === 'frozen');
  // Tell cardd first: from here the card can't spend.
  const started = local || i.serverDown ? false : i.known?.state === 'reset' ? true : await tell(() => d.held.wipeCard(id));
  if (!local) await d.cache.saveCard({ id, version, name, state: 'wiping', ...(started ? {} : { pending: 'wipe' as const }) });
  step('server');

  const all = [keys.k0, keys.k1, keys.k2, keys.k3, keys.k4];
  for (let k = 1; k <= 4; k++) if (read.versions[k] !== 0) await card.changeKey(k, all[k], ZERO_KEY, 0);
  step('keys');
  if (read.versions[0] !== 0) await card.changeKey(0, keys.k0, ZERO_KEY, 0);
  step('key0');

  // K0 is zero: SUN can go now. Factory settings (free write), then zero the URL.
  await card.authenticate(0, ZERO_KEY);
  await card.changeFileSettings(FACTORY_FILE_SETTINGS);
  step('settings');
  await card.writeNdef(new Uint8Array(Math.max(2, read.file.length)));
  step('url');

  const finished = started ? await tell(() => d.held.wipedCard(id)) : false;
  if (!local) await d.cache.saveCard({ id, version, name, state: 'reset', ...(finished ? {} : { pending: 'wiped' as const }) });
  step('done');
  return { serverTold: finished, local };
}
