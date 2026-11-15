import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { colourLeaks, fontLeaks, type Leak } from './sourceScan';

/** app/src/ */
const SRC = new URL('../', import.meta.url);
/** Colours' own homes: the theme, the cards' colours, the Bolt Card mark, and the card camera (always dark, over the camera). */
const COLOURS_ALLOWED = ['ui/theme.ts', 'wallet/colours.ts', 'ui/BoltCardLogo.tsx', 'cardphoto/CardCamera.tsx'];
/** Fonts' own home. */
const FONTS_ALLOWED = ['ui/theme.ts'];
/** Every source file under src/, as a path relative to it: no tests, nothing in testing/. */
const FILES = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith('testing/'))
  .sort();
const read = (f: string) => readFileSync(new URL(f, SRC), 'utf8');
const leaks = (f: string): Leak[] => [
  ...(COLOURS_ALLOWED.includes(f) ? [] : colourLeaks(read(f))),
  ...(FONTS_ALLOWED.includes(f) ? [] : fontLeaks(read(f))),
];
const at = (f: string, found: Leak[]) => found.map((l) => `${f}:${l.line} ${l.text}`);

describe('colourLeaks', () => {
  it('finds hex, rgb() and rgba() colours, with their lines', () => {
    expect(colourLeaks("const a = '#fff';\nconst b = { color: '#1f2328' };\nconst c = 'rgba(0, 0, 0, 0.3)';\nconst d = 'rgb(1,2,3)';\nconst e = '#ffffff80';")).toEqual([
      { line: 1, text: '#fff' },
      { line: 2, text: '#1f2328' },
      { line: 3, text: 'rgba(' },
      { line: 4, text: 'rgb(' },
      { line: 5, text: '#ffffff80' },
    ]);
  });

  it("finds a named colour as a colour key's value, in a style or an SVG attribute", () => {
    expect(colourLeaks("const s = { color: 'white', backgroundColor: \"red\" };\n<Rect fill=\"black\" stroke='blue' />\n<Stop stopColor=\"white\" />\n<X tintColor={'green'} />")).toEqual([
      { line: 1, text: 'color white' },
      { line: 1, text: 'backgroundColor red' },
      { line: 2, text: 'fill black' },
      { line: 2, text: 'stroke blue' },
      { line: 3, text: 'stopColor white' },
      { line: 4, text: 'tintColor green' },
    ]);
  });

  it("leaves SVG references to an id, the absence of a colour, and words that aren't colours", () => {
    const source = [
      '<Rect x="0" y="0" width="1" height="1" fill="url(#fade)" />',
      "const s = { backgroundColor: 'transparent' };",
      '<Path fill="none" />',
      "export type Tone = 'red' | 'amber';",
      "const banner = { tone: 'red', text: 'Cash' };",
      "<Rect fill=\"url(#stripes)\" />",
      'const t = theme.text; // colour from the theme',
    ].join('\n');
    expect(colourLeaks(source)).toEqual([]);
  });
});

describe('fontLeaks', () => {
  it('finds any fontFamily', () => {
    expect(fontLeaks("const s = { fontFamily: 'Inter' };")).toEqual([{ line: 1, text: 'fontFamily' }]);
  });

  it('finds a fontSize that does not build on a TYPE style', () => {
    expect(fontLeaks('const s = {\n  title: { fontSize: 24, color: c },\n};')).toEqual([{ line: 2, text: 'fontSize' }]);
  });

  it('passes a fontSize over a TYPE style on the same line', () => {
    expect(fontLeaks('const s = { field: { ...TYPE.body, fontSize: 18, lineHeight: 24 } };')).toEqual([]);
  });
});

describe("the app's source", () => {
  it('reads the source files', () => {
    expect(FILES).toContain('ui/ui.tsx');
    expect(FILES).toContain('app/home.tsx');
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('takes every colour from ui/theme.ts and every font from its TYPE styles', () => {
    expect(FILES.flatMap((f) => at(f, leaks(f)))).toEqual([]);
  });
});
