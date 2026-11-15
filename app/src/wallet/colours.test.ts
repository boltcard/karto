import { describe, expect, it } from 'vitest';
import { CARD_COLOURS, cardColour, colourOf, walletColours } from './colours';

// WCAG 2's contrast ratio of a colour against white.
function contrastWithWhite(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const l = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return 1.05 / (l + 0.05);
}

// A colour blended with 14% white, as the stripes are.
function striped(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((c) => Math.round(c + 0.14 * (255 - c)));
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// From a hash of the card's id, never stored.
describe('cardColour', () => {
  it('has the palette it is meant to have', () => {
    // Pinned once, so a reorder or an unnoticed change fails here (the hash picks by position).
    expect(CARD_COLOURS).toEqual(['#0861c9', '#7740dc', '#177131', '#af347e', '#aa4500', '#0d6b85', '#6639ba', '#855900']);
  });

  it('gives a card the same colour every time', () => {
    expect(cardColour('7f3a9c01')).toBe(cardColour('7f3a9c01'));
    // FNV-1a of "a" is 0xe40c292c, which is 4 mod 8.
    expect(cardColour('a')).toBe(CARD_COLOURS[4]);
  });

  it('reaches all 8 colours across many cards', () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => cardColour(`c${i}`)));
    expect(seen.size).toBe(8);
  });

  it('colours an empty id without throwing', () => {
    // FNV-1a of nothing is its offset basis, 2166136261, which is 5 mod 8.
    expect(cardColour('')).toBe(CARD_COLOURS[5]);
  });

  it('keeps white text readable on every colour, plain and under the 14% white stripes', () => {
    expect(CARD_COLOURS).toHaveLength(8);
    for (const c of CARD_COLOURS) {
      expect(contrastWithWhite(c), c).toBeGreaterThanOrEqual(4.5);
      expect(contrastWithWhite(striped(c)), `${c} striped`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// Each card differs from every older card in the wallet.
describe('walletColours', () => {
  const card = (id: string, created: number, state = 'active') => ({ id, created, state });
  // Cards whose ids hash to the same colour, found by search so the test doesn't rest on hand-worked hashes.
  const same = (n: number) => {
    const ids: string[] = [];
    for (let i = 0; ids.length < n; i++) if (cardColour(`c${i}`) === cardColour('c0')) ids.push(`c${i}`);
    return ids;
  };

  it('gives cards that hash alike different colours, the older keeping its own', () => {
    const [a, b] = same(2);
    const m = walletColours([card(b, 2), card(a, 1)]);
    expect(m[a]).toBe(cardColour(a));
    expect(m[b]).not.toBe(m[a]);
    expect(CARD_COLOURS).toContain(m[b]);
  });

  it('takes the next free colour in order, wrapping', () => {
    const [a, b] = same(2);
    const i = CARD_COLOURS.indexOf(cardColour(a));
    expect(walletColours([card(a, 1), card(b, 2)])[b]).toBe(CARD_COLOURS[(i + 1) % 8]);
  });

  it('never changes an older card when a newer one is added', () => {
    // Ids that share a hash colour, so each newer card takes the next free colour.
    const ids = same(8);
    for (let n = 1; n < 8; n++) {
      const before = walletColours(ids.slice(0, n).map((id, i) => card(id, i)));
      const after = walletColours(ids.slice(0, n + 1).map((id, i) => card(id, i)));
      for (const id of ids.slice(0, n)) expect(after[id]).toBe(before[id]);
    }
  });

  it('gives 8 cards 8 different colours', () => {
    const m = walletColours(same(8).map((id, i) => card(id, i)));
    expect(new Set(Object.values(m)).size).toBe(8);
  });

  it('ignores a wiped card', () => {
    const [a, b] = same(2);
    const m = walletColours([card(a, 1, 'reset'), card(b, 2)]);
    expect(m[a]).toBeUndefined();
    expect(m[b]).toBe(cardColour(b));
  });

  it('repeats colours past 8 cards without throwing', () => {
    const ids = same(12);
    const m = walletColours(ids.map((id, i) => card(id, i)));
    expect(Object.keys(m)).toHaveLength(12);
    expect(m[ids[8]]).toBe(cardColour(ids[8]));
  });

  it('orders cards without created after the others, by name', () => {
    const [a, b] = same(2);
    const m = walletColours([{ id: b, state: 'active' }, { id: a, created: 5, state: 'active' }]);
    expect(m[a]).toBe(cardColour(a));
    expect(m[b]).not.toBe(m[a]);
  });

  it('colours no cards', () => {
    expect(walletColours([])).toEqual({});
  });
});

// A card the wallet doesn't list yet (the photo step of an add, a just-added card on the tap sheet) gets the colour the wallet will give it.
describe('colourOf', () => {
  const card = (id: string, created: number) => ({ id, created, state: 'active' });
  const same = (n: number) => {
    const ids: string[] = [];
    for (let i = 0; ids.length < n; i++) if (cardColour(`c${i}`) === cardColour('c0')) ids.push(`c${i}`);
    return ids;
  };

  it('gives a listed card its wallet colour', () => {
    const [a, b] = same(2);
    expect(colourOf([card(a, 1), card(b, 2)], b)).toBe(walletColours([card(a, 1), card(b, 2)])[b]);
  });

  it('gives an unlisted card the colour it will have as the newest card', () => {
    const [a, b] = same(2);
    const colour = colourOf([card(a, 1)], b);
    expect(colour).not.toBe(cardColour(a));
    expect(colour).toBe(walletColours([card(a, 1), card(b, 2)])[b]);
  });

  it('gives an unlisted card its own colour in an empty wallet', () => {
    expect(colourOf([], 'c0')).toBe(cardColour('c0'));
  });

  it('colours a wiped card that is listed as a newly added one', () => {
    const [a, b] = same(2);
    expect(colourOf([card(a, 1), { id: b, created: 2, state: 'reset' }], b)).not.toBe(cardColour(a));
  });
});
