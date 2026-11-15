// The order cards were added in, which the stack stands them in and the colours are handed out in.

/** What the order needs of a card. */
export type Ordered = { id: string; name?: string; created?: number };

const shownName = (c: Ordered) => c.name || 'Unnamed card';
const byId = (a: Ordered, b: Ordered) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** In the order they were added (ties by id), then the cache's cards, which know no created, in name order. */
export function byAdded(a: Ordered, b: Ordered): number {
  if (a.created !== undefined && b.created !== undefined) return a.created - b.created || byId(a, b);
  if (a.created !== undefined) return -1;
  if (b.created !== undefined) return 1;
  return shownName(a).localeCompare(shownName(b)) || byId(a, b);
}
