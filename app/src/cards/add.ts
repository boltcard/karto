// Adding a card in one hold, carrying on from
// wherever an earlier hold stopped: where that was is read from the card.
// K0 changes last, and only once the keys already on the card are this version's.
import { deriveCardKeys } from '../boltcard/cardkeys';
import { decryptPicc, parseSun, verifySun } from '../boltcard/sun';
import { CarddError, type CardInfo } from '../cardd/client';
import type { Ntag424 } from '../ntag424/card';
import { ZERO_KEY } from '../ntag424/crypto';
import { cardUrl, ndefFile, sunFileSettings } from '../ntag424/ndef';
import { CardFlowError, type CardDeps } from './deps';
import { identify, refusePlain } from './identify';
import { readCard } from './read';

export type AddStep = 'check' | 'random-uid' | 'reserve' | 'url' | 'keys' | 'key0' | 'confirm';
export const ADD_STEPS: AddStep[] = ['check', 'random-uid', 'reserve', 'url', 'keys', 'key0', 'confirm'];

/**
 * onStep: each step as it is done, with the card's id. confirming: the id of the card whose add, on this screen,
 * stopped at its last call: should the server turn out to
 * have made that card active, its confirm's answer was lost, and the add ends as added.
 */
export type AddOptions = { name: string; randomUid: boolean; onStep?: (step: AddStep, id: string) => void; confirming?: string };

export async function addCard(card: Ntag424, tagUid: Uint8Array, d: CardDeps, o: AddOptions): Promise<CardInfo> {
  const i = await identify(card, d);
  refusePlain(i);
  const step = (s: AddStep) => o.onStep?.(s, i.id!);
  switch (i.kind) {
    case 'foreign':
      throw new CardFlowError("This card belongs to another service, so it can't be added.");
    case 'ours': {
      const added = o.confirming !== undefined && i.id === o.confirming && i.known?.state === 'active' && !i.serverDown ? await confirmed(d, i.id) : null;
      if (!added) throw new CardFlowError('This card is already one of yours.');
      step('confirm');
      return added;
    }
    case 'half-wiped':
      throw new CardFlowError('This card is part-way through a wipe. Finish the wipe first.');
    case 'unknown-ours':
      throw new CardFlowError("This card was set up with your recovery phrase, but this server doesn't know it. Wipe it, then add it again.");
  }
  if (i.serverDown) throw new CardFlowError("Can't reach your server. Adding a card needs it.");
  const read = i.read!;
  const uid = i.uid!;
  const id = i.id!;
  step('check');

  // identify left a session with the zero K0 open if K0 is still zero.
  const k0Zero = read.versions[0] === 0;
  if (k0Zero && o.randomUid && tagUid.length === 7) await card.enableRandomUid();
  step('random-uid');

  const r = await d.held.reserveCard(id, o.name);
  await d.cache.saveCard({ id, version: r.version, name: r.name, state: 'programming' });
  const keys = deriveCardKeys(d.issuer, uid, r.version);
  step('reserve');

  if (k0Zero) {
    const keysStarted = read.versions.slice(1).some((v) => v !== 0);
    if (!keysStarted) {
      const n = ndefFile(cardUrl(r.lnurlw));
      await card.writeNdef(n.file);
      await card.changeFileSettings(sunFileSettings(n.piccOffset, n.macOffset));
    }
    step('url');
    // Keys written by an earlier hold must be this version's, or K0 would lock in a mismatch.
    if (read.versions[2] !== 0 && read.sun) {
      const parsed = parseSun(read.sun.p, read.sun.c)!;
      const picc = decryptPicc(keys.k1, parsed.p);
      if (!picc || !verifySun(keys.k2, picc, parsed.c)) {
        throw new CardFlowError('The keys on this card were written for another version than your server has. Wipe the card, then add it again.');
      }
    }
    const all = [keys.k0, keys.k1, keys.k2, keys.k3, keys.k4];
    for (let k = 1; k <= 4; k++) if (read.versions[k] === 0) await card.changeKey(k, ZERO_KEY, all[k], 1);
    step('keys');
    await card.changeKey(0, ZERO_KEY, keys.k0, 1);
  } else {
    step('url');
    step('keys');
  }
  step('key0');

  // The end-to-end check: a fresh p and c, checked here, then by cardd's own derivation.
  const after = await readCard(card);
  const parsed = after.sun && parseSun(after.sun.p, after.sun.c);
  const picc = parsed && decryptPicc(keys.k1, parsed.p);
  if (!after.sun || !parsed || !picc || !verifySun(keys.k2, picc, parsed.c)) {
    throw new CardFlowError("The card didn't pass its own check against the keys just written. Wipe the card, then add it again.");
  }
  const info = await confirm(d, id, after.sun);
  step('confirm');
  await d.cache.saveCard({ id, version: info.version, name: info.name, state: info.state });
  return info;
}

/** The card an earlier hold's confirm made active, its answer lost: saved as that hold would have saved it. Null if cardd no longer has it so. */
async function confirmed(d: CardDeps, id: string): Promise<CardInfo | null> {
  const info = (await d.held.cards()).find((c) => c.id === id);
  if (info?.state !== 'active') return null;
  await d.cache.saveCard({ id, version: info.version, name: info.name, state: info.state });
  return info;
}

/** A confirm whose answer was lost the first time: cardd already made the card active. */
async function confirm(d: CardDeps, id: string, sun: { p: string; c: string }): Promise<CardInfo> {
  try {
    return await d.held.confirmCard(id, sun);
  } catch (e) {
    if (!(e instanceof CarddError) || e.code !== 'conflict') throw e;
    const card = (await d.held.cards()).find((c) => c.id === id);
    if (card?.state !== 'active') throw e;
    return card;
  }
}
