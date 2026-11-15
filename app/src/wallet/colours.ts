// A card's colour until it has a photo:
// one of 8 fixed colours, from a hash of the card's id, except that
// each card's colour differs from every older card's in the wallet. Nothing
// is stored.
import { byAdded, type Ordered } from './order';

/** The card's name and balance are white on each: every one contrasts 4.5:1 or more with it, plain and under the cards' faint white stripes (14% white). */
export const CARD_COLOURS: readonly string[] = ['#0861c9', '#7740dc', '#177131', '#af347e', '#aa4500', '#0d6b85', '#6639ba', '#855900'];

/** FNV-1a, 32 bits, over the string's UTF-16 code units, unsigned. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export const cardColour = (id: string): string => CARD_COLOURS[fnv1a(id) % CARD_COLOURS.length];

/**
 * Every card's colour in the wallet, wiped cards left out. In the order the
 * cards were added, each takes its own hash colour unless an older card has
 * it, then the next colour (wrapping) no older card has; past 8 cards, its own
 * again. So a newer card never changes an older one's colour.
 */
export function walletColours(cards: (Ordered & { state: string })[]): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set<string>();
  for (const c of cards.filter((x) => x.state !== 'reset').sort(byAdded)) {
    const own = cardColour(c.id);
    let colour = own;
    if (taken.has(own) && taken.size < CARD_COLOURS.length) {
      const start = CARD_COLOURS.indexOf(own);
      for (let i = 1; i < CARD_COLOURS.length; i++) {
        const next = CARD_COLOURS[(start + i) % CARD_COLOURS.length];
        if (!taken.has(next)) { colour = next; break; }
      }
    }
    taken.add(colour);
    out[c.id] = colour;
  }
  return out;
}

/**
 * A card's colour in the wallet. A card the list doesn't hold yet (the photo
 * step of an add, a just-added card on the tap sheet) gets the colour the
 * wallet will give it: as the newest card, still being programmed.
 */
export function colourOf(cards: (Ordered & { state: string })[], id: string): string {
  const listed = walletColours(cards)[id];
  if (listed) return listed;
  const others = cards.filter((c) => c.id !== id);
  return walletColours([...others, { id, state: 'programming', created: Number.MAX_SAFE_INTEGER }])[id];
}
