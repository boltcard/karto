// Tells cardd about wipes the phone did while it couldn't be reached.
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
      await d.cache.saveCard({ id: s.id, version: s.version, name: s.name, state: s.state });
      continue;
    }
    if (s && s.state !== 'wiping' && s.state !== 'reset') await d.cardd.wipeCard(c.id);
    if (s && c.pending === 'wiped' && s.state !== 'reset') await d.cardd.wipedCard(c.id);
    const { pending: _, ...rest } = c;
    await d.cache.saveCard({ ...rest, state: c.pending === 'wiped' ? 'reset' : 'wiping' });
  }
  return pending.length;
}

/** Keeps the phone's cache in step with cardd's list, without touching a card whose wipe cardd hasn't heard about. */
export async function rememberCards(cache: CardDeps['cache'], list: CardInfo[]): Promise<void> {
  const cached = await cache.cards();
  for (const c of list) {
    if (!cached[c.id]?.pending) await cache.saveCard({ id: c.id, version: c.version, name: c.name, state: c.state });
  }
}
