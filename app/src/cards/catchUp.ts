// Tells cardd about wipes the phone did while it couldn't be reached. Each save is made only while the card's record
// is still the one read (saveCard's ifStill: its version and pending wipe): a wipe that moved on during the calls to
// cardd (the card reset meanwhile), or a newer wipe of the card added again, is kept for the next catch-up.
import type { CardInfo } from '../cardd/client';
import type { CardDeps } from './deps';

export async function catchUp(d: Pick<CardDeps, 'cardd' | 'cache'>): Promise<number> {
  const pending = Object.values(await d.cache.cards()).filter((c) => c.pending);
  if (pending.length === 0) return 0;
  const server = new Map((await d.cardd.cards()).map((c) => [c.id, c]));
  for (const c of pending) {
    const s = server.get(c.id);
    if (s && s.version !== c.version) {
      // The card was added again since this phone wiped it: that wipe is old news.
      await d.cache.saveCard({ id: s.id, version: s.version, name: s.name, state: s.state }, { ifStill: c });
      continue;
    }
    if (s && s.state !== 'wiping' && s.state !== 'reset') await d.cardd.wipeCard(c.id);
    if (s && c.pending === 'wiped' && s.state !== 'reset') await d.cardd.wipedCard(c.id);
    const { pending: _, ...rest } = c;
    await d.cache.saveCard({ ...rest, state: c.pending === 'wiped' ? 'reset' : 'wiping' }, { ifStill: c });
  }
  return pending.length;
}

/** Keeps the phone's cache in step with cardd's list, without touching a card whose wipe cardd hasn't heard about. */
// Each card's pending wipe is read where it is saved (saveCard's unlessPending), not from a copy taken before: a wipe
// begun while the list is kept stays.
export async function rememberCards(cache: CardDeps['cache'], list: CardInfo[]): Promise<void> {
  for (const c of list) await cache.saveCard({ id: c.id, version: c.version, name: c.name, state: c.state }, { unlessPending: true });
}
