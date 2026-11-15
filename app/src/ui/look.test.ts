import { describe, expect, it } from 'vitest';
import { BESIDE_DOT, buttonColours, detailsLabelWidth, partLook, rowColours, rowEnd, rowLabel, statusBarGround, toneColour, wordNumberWidth } from './look';
import { contrast, themeFor } from './theme';

const SCHEMES = ['light', 'dark'] as const;

// A disabled orange button faded to 50% read at 1.8:1 in dark mode.
describe('buttonColours', () => {
  for (const scheme of SCHEMES) {
    it(`${scheme}: a disabled button of any kind is muted text on surface, readable at 4.5:1`, () => {
      const t = themeFor(scheme);
      for (const kind of ['primary', 'secondary', 'danger'] as const) {
        const c = buttonColours(kind, true, t);
        expect(c).toEqual({ fill: t.surface, border: t.line, text: t.muted });
        expect(contrast(c.text, c.fill)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("gives each kind its colours when it can be pressed: orange, outlined, outlined in red", () => {
    const t = themeFor('light');
    expect(buttonColours('primary', false, t)).toEqual({ fill: t.accent, border: t.accent, text: t.onAccent });
    expect(buttonColours('secondary', false, t)).toEqual({ fill: 'transparent', border: t.outline, text: t.outlineText });
    expect(buttonColours('danger', false, t)).toEqual({ fill: 'transparent', border: t.error, text: t.error });
  });
});

// A solid sheet (the tap sheet) drew the page's light background under the status bar,
// whose icons are light on every screen, so in light mode they vanished.
describe('statusBarGround', () => {
  for (const scheme of SCHEMES) {
    it(`${scheme}: keeps the status bar's light icons readable over a solid sheet`, () => {
      const t = themeFor(scheme);
      expect(statusBarGround(t)).toBe(t.header);
      expect(contrast('#ffffff', statusBarGround(t))).toBeGreaterThanOrEqual(3);
    });
  }
});

// Rows and panels: the dot and a coloured line in their tone's colour, readable on the panels they sit on.
describe('toneColour', () => {
  for (const scheme of SCHEMES) {
    it(`${scheme}: ok, warn and error are their tokens, none has no colour, and each reads on surface and on its own panel`, () => {
      const t = themeFor(scheme);
      expect([toneColour('ok', t), toneColour('warn', t), toneColour('error', t), toneColour('none', t)]).toEqual([t.ok, t.warn, t.error, null]);
      for (const c of [t.ok, t.warn, t.error]) expect(contrast(c, t.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.warn, t.warnBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.error, t.errorBg)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

// Seen on the Pixel 8 Pro at font scale 1.3: in a column 20 dp wide whatever the font, "10",
// "11" and "12" broke onto two lines, and their rows stood lower than the left column's.
describe('wordNumberWidth', () => {
  it("grows the recovery words' number column with the font, so two figures keep one line", () => {
    expect(wordNumberWidth(1)).toBe(20);
    expect(wordNumberWidth(1.15)).toBe(23);
    expect(wordNumberWidth(1.3)).toBe(26);
    expect(wordNumberWidth(2)).toBe(40);
    // Never narrower than at the standard size.
    expect(wordNumberWidth(0.85)).toBe(20);
  });
});

describe('rowLabel', () => {
  it('reads a row out as its name, its line and its tag', () => {
    expect(rowLabel('Server', 'Running', 'Update ready')).toBe('Server, Running, Update ready');
    expect(rowLabel('Backups', 'Last one today at 11:24')).toBe('Backups, Last one today at 11:24');
  });

  // Your country's rows have no line, and say their VAT at the row's end.
  it('reads a row with no line by its name and its end text', () => {
    expect(rowLabel('Germany', undefined, undefined, 'VAT 19%')).toBe('Germany, VAT 19%');
    expect(rowLabel('United Kingdom', undefined, undefined, 'no VAT')).toBe('United Kingdom, no VAT');
    expect(rowLabel('VM 1009', 'Paid until 17 Oct')).toBe('VM 1009, Paid until 17 Oct');
    expect(rowLabel('Server', 'Running', 'Update ready', 'now')).toBe('Server, Running, now, Update ready');
    expect(rowLabel('Alone')).toBe('Alone');
  });
});

// A greyed row (Rebuild server while the server work runs) was faded to half opacity,
// 2.1:1 to 2.6:1, below the 4.5:1 its words need, as the disabled buttons were.
describe('rowColours', () => {
  for (const scheme of SCHEMES) {
    it(`${scheme}: a greyed row is muted at full strength, readable at 4.5:1, with no dot`, () => {
      const t = themeFor(scheme);
      for (const tone of ['ok', 'warn', 'error', 'none'] as const) {
        const c = rowColours(tone, true, true, t);
        expect(c).toEqual({ icon: t.muted, name: t.muted, line: t.muted, dot: null });
        expect(contrast(c.name, t.surface)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('draws a row its tone and its danger when it can be pressed', () => {
    const t = themeFor('light');
    expect(rowColours('ok', false, false, t)).toEqual({ icon: t.muted, name: t.text, line: t.muted, dot: t.ok });
    expect(rowColours('warn', false, false, t)).toEqual({ icon: t.muted, name: t.text, line: t.warn, dot: t.warn });
    expect(rowColours('none', false, true, t)).toEqual({ icon: t.error, name: t.error, line: t.muted, dot: null });
  });
});

// A dotted line longer than its row dropped under its dot, leaving the dot alone on the
// first line (the Rebuild row's suggestion; any red line at a large font). The dot stays out of the wrapping: the
// line and its tag wrap inside a box that takes the rest of the row, so a word never breaks to fit the tag.
describe('BESIDE_DOT', () => {
  it('is a box that takes the rest of the row, its line and tag wrapping inside it', () => {
    expect(BESIDE_DOT).toEqual({ flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 });
  });
});

// At font scale 1.3 "Hosted by" broke over two lines in Details' fixed 84 dp column.
describe('detailsLabelWidth', () => {
  it("grows Details' label column with the phone's font scale, and never shrinks it", () => {
    expect(detailsLabelWidth(1)).toBe(84);
    expect(detailsLabelWidth(1.3)).toBe(110);
    expect(detailsLabelWidth(2)).toBe(168);
    expect(detailsLabelWidth(0.85)).toBe(84);
  });
});

// The progress bar of a hold that stopped.
describe('partLook', () => {
  const bar = (n: number, of: number, stopped: boolean) => Array.from({ length: of }, (_, i) => partLook(i, n, stopped));
  it('fills the parts up to the current step', () => {
    expect(bar(4, 7, false)).toEqual(['done', 'done', 'done', 'done', 'todo', 'todo', 'todo']);
    expect(bar(1, 3, false)).toEqual(['done', 'todo', 'todo']);
  });
  it('marks the step a hold stopped at, after the steps it finished', () => {
    expect(bar(4, 7, true)).toEqual(['done', 'done', 'done', 'stopped', 'todo', 'todo', 'todo']);
    expect(bar(1, 3, true)).toEqual(['stopped', 'todo', 'todo']);
  });
});

// A row that acts at once (Remove photo) opens nothing, so it has no ›.
describe('rowEnd', () => {
  it('ends a row that opens something in ›, one of a set to choose from in its tick, and one that acts at once in nothing', () => {
    expect(rowEnd({ choice: false, acts: false })).toBe('chevron');
    expect(rowEnd({ choice: true, acts: false })).toBe('tick');
    expect(rowEnd({ choice: false, acts: true })).toBe('none');
    expect(rowEnd({ choice: true, acts: true })).toBe('tick');
  });
});
