import { describe, expect, it } from 'vitest';
import { alpha, AMOUNT, contrast, FIXED, stylesFor, TEXT_PAIRS, themeFor, TOKENS, TYPE, type Theme } from './theme';

describe('themeFor', () => {
  it('gives the dark set for dark, and the light set for light or no answer', () => {
    expect(themeFor('dark').scheme).toBe('dark');
    expect(themeFor('light').scheme).toBe('light');
    expect(themeFor(null).scheme).toBe('light');
    expect(themeFor(undefined).scheme).toBe('light');
    expect(themeFor('unspecified').scheme).toBe('light');
  });

  it('has every token in both sets, and nothing else', () => {
    for (const s of ['light', 'dark']) expect(Object.keys(themeFor(s)).sort()).toEqual([...TOKENS, 'scheme'].sort());
  });

  it("holds palette B's values", () => {
    const l = themeFor('light');
    const d = themeFor('dark');
    expect([l.bg, l.surface, l.header, l.text, l.accent, l.highlight, l.sleeve]).toEqual(['#f3f4f6', '#ffffff', '#24292f', '#16191d', '#f7931a', '#ffe066', '#24292f']);
    expect([d.bg, d.surface, d.header, d.text, d.accent, d.highlight, d.sleeve]).toEqual(['#1b1f24', '#24292f', '#1b1f24', '#eef1f4', '#f7931a', '#ffe066', '#0e1114']);
    expect([l.veil, d.veil]).toEqual(['#f3f4f673', '#1b1f2473']);
  });
});

describe('alpha', () => {
  it('adds the opacity as a fourth byte', () => {
    expect(alpha('#000000', 0.55)).toBe('#0000008c');
    expect(alpha('#f3f4f6', 0.45)).toBe('#f3f4f673');
    expect(alpha('#ffffff', 1)).toBe('#ffffffff');
    expect(alpha('#ffffff', 0)).toBe('#ffffff00');
  });
});

describe('contrast', () => {
  it('gives the known ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#767676')).toBeCloseTo(4.54, 2);
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrast('#123456', '#123456')).toBe(1);
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const [fg, ground] of TEXT_PAIRS) {
      it(`${scheme}: ${fg} on ${ground} reaches 4.5:1`, () => {
        const t = themeFor(scheme);
        expect(contrast(t[fg], t[ground])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  // A chosen row (Your country, a rebuild's choices) keeps its line and its VAT readable on its tint.
  it("declares a chosen row's texts on its ground", () => {
    const pairs = TEXT_PAIRS.map(([fg, ground]) => `${fg} on ${ground}`);
    for (const fg of ['text', 'muted', 'warn']) expect(pairs).toContain(`${fg} on selected`);
  });

  it('declares every text colour the shared parts use', () => {
    const texts = new Set(TEXT_PAIRS.map(([fg]) => fg));
    for (const fg of ['text', 'muted', 'accentText', 'ok', 'error', 'warn', 'onAccent', 'onHighlight', 'headerText', 'headerMuted', 'outlineText'] as const) {
      expect(texts.has(fg)).toBe(true);
    }
  });
});

describe('FIXED', () => {
  it('keeps the colours that are the same in both modes', () => {
    expect(FIXED).toEqual({ onCard: '#ffffff', fade: '#000000', qrTile: '#ffffff', tagText: '#9a6700', tagBg: '#fff8c5' });
  });

  it("keeps the card tag's text readable on its own ground", () => {
    expect(contrast(FIXED.tagText, FIXED.tagBg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('stylesFor', () => {
  it("makes a scheme's styles once and keeps them", () => {
    let calls = 0;
    const make = (t: Theme) => {
      calls++;
      return { page: { backgroundColor: t.bg } };
    };
    const light = stylesFor(make, themeFor('light'));
    expect(stylesFor(make, themeFor('light'))).toBe(light);
    const dark = stylesFor(make, themeFor('dark'));
    expect(dark).not.toBe(light);
    expect([light.page.backgroundColor, dark.page.backgroundColor]).toEqual(['#f3f4f6', '#1b1f24']);
    expect(stylesFor(make, themeFor('dark'))).toBe(dark);
    expect(calls).toBe(2);
  });

  it("keeps each function's styles apart", () => {
    const a = (t: Theme) => ({ c: t.text });
    const b = (t: Theme) => ({ c: t.muted });
    expect(stylesFor(a, themeFor('light')).c).toBe('#16191d');
    expect(stylesFor(b, themeFor('light')).c).toBe('#5b6470');
  });
});

describe('TYPE', () => {
  it("sets Inter on every style, at the design's sizes and weights", () => {
    for (const s of Object.values(TYPE)) expect(s.fontFamily).toBe('Inter');
    expect(TYPE.title).toMatchObject({ fontSize: 22, fontWeight: '700' });
    expect(TYPE.heading).toMatchObject({ fontSize: 18, fontWeight: '600' });
    expect(TYPE.body).toMatchObject({ fontSize: 15, fontWeight: '400' });
    expect(TYPE.small).toMatchObject({ fontSize: 13, fontWeight: '400' });
    expect(TYPE.button).toMatchObject({ fontSize: 16, fontWeight: '600' });
    expect(AMOUNT.fontVariant).toEqual(['tabular-nums']);
  });
});

// Panels: body and muted text on the amber and red panels, a secondary button in a red one, the Backups
// page's link in an amber one.
describe('TEXT_PAIRS', () => {
  it("declares the panels' text pairs", () => {
    for (const pair of [['text', 'warnBg'], ['text', 'errorBg'], ['muted', 'warnBg'], ['muted', 'errorBg'], ['outlineText', 'errorBg'], ['accentText', 'warnBg']]) {
      expect(TEXT_PAIRS.some(([a, b]) => a === pair[0] && b === pair[1])).toBe(true);
    }
  });
});
