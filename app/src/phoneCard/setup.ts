// Making this phone a card, and removing its card. Nothing is
// held to the phone: it has its own keys. The record is written before the server is asked, so a set-up or a
// removal cut off anywhere is finished by the keeping-in-step job (phoneCard/keep.ts).
import type { CardInfo, CarddClient } from '../cardd/client';
import { checkCounters, firstCounter, lowestFree, phoneCardId } from './id';
import type { KeepDeps } from './keep';
import { RecordUnreadable } from './record';
import { tapSuns } from './taps';

export type SetupDeps = Pick<KeepDeps, 'issuer' | 'record' | 'now' | 'random'> & {
  cardd: Pick<CarddClient, 'cards' | 'reserveCard' | 'confirmCard' | 'wipeCard' | 'wipedCard'>;
};

export class AlreadyACard extends Error {
  constructor() {
    super('This phone is already a card.');
    this.name = 'AlreadyACard';
  }
}

/**
 * Sets this phone up as a card named `name`: the lowest number the server does not list, a first counter from the
 * clock, the record, then reserve and confirm. Throws AlreadyACard, RecordUnreadable or CounterSpent before the
 * server hears of it; a network failure or the server's refusal after.
 */
export async function setUpPhoneCard(d: SetupDeps, name: string): Promise<CardInfo> {
  const read = await d.record.read();
  if (!read.ok) throw new RecordUnreadable();
  if (read.record) throw new AlreadyACard();
  const n = lowestFree(d.issuer, await d.cardd.cards());
  const first = firstCounter(undefined, d.now());
  checkCounters(first, 1);
  await d.record.update((r) => {
    if (r) throw new AlreadyACard();
    return { n, version: 0, next: first + 1 };
  });
  const id = phoneCardId(d.issuer, n);
  const reserved = await d.cardd.reserveCard(id, name);
  if (reserved.version !== 0) await d.record.update((r) => r && { ...r, version: reserved.version });
  return d.cardd.confirmCard(id, tapSuns({ issuer: d.issuer, n, version: reserved.version }, first, 1, d.random)[0]);
}

/**
 * Removes this phone's card: the record says so first, then the card is wiped, its balance moving to Pool as any
 * wipe's does, and the record deleted. Does nothing on a phone with no record. The screen asks for the lock first.
 */
export async function removePhoneCard(d: SetupDeps): Promise<void> {
  const rec = await d.record.update((r) => r && { ...r, removing: true });
  if (!rec) return;
  const id = phoneCardId(d.issuer, rec.n);
  await d.cardd.wipeCard(id);
  await d.cardd.wipedCard(id);
  await d.record.update(() => null);
}
