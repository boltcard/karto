// Checks on the app's own source: a colour written into a file
// instead of taken from ui/theme.ts, and a font set outside theme.ts's type styles. sourceScan.test.ts runs them
// over src/**/*.{ts,tsx}.

/** One thing found: its line (from 1) and what it is. */
export type Leak = { line: number; text: string };

/** Values of a colour key that aren't a colour of the app's: see-through, no fill. */
const NOT_COLOURS = new Set(['transparent', 'none', 'currentColor']);
/** A hex colour, but not an SVG reference to an id (fill="url(#fade)"). */
const HEX = /(?<!url\()#[0-9a-fA-F]{3,8}\b/g;
const RGB = /\brgba?\(/g;
/** A named colour as a colour key's value: color: 'white', fill="black", tintColor={'green'}. */
const NAMED = /\b(\w*[cC]olor|fill|stroke)\s*[:=]\s*\{?\s*['"]([A-Za-z]+)['"]/g;

/** Colours written into the source: hex and rgb()/rgba() anywhere, a named colour only as a colour key's value. */
export function colourLeaks(source: string): Leak[] {
  const out: Leak[] = [];
  source.split('\n').forEach((text, i) => {
    for (const m of text.matchAll(HEX)) out.push({ line: i + 1, text: m[0] });
    for (const m of text.matchAll(RGB)) out.push({ line: i + 1, text: m[0] });
    for (const m of text.matchAll(NAMED)) if (!NOT_COLOURS.has(m[2])) out.push({ line: i + 1, text: `${m[1]} ${m[2]}` });
  });
  return out;
}

/** Fonts set outside the type styles: any fontFamily, and a fontSize on a line that doesn't spread a TYPE style. */
export function fontLeaks(source: string): Leak[] {
  const out: Leak[] = [];
  source.split('\n').forEach((text, i) => {
    if (/\bfontFamily\s*:/.test(text)) out.push({ line: i + 1, text: 'fontFamily' });
    if (/\bfontSize\s*:/.test(text) && !/\.\.\.TYPE\.\w+/.test(text)) out.push({ line: i + 1, text: 'fontSize' });
  });
  return out;
}
