// The app's look: the palette "Night", as a light and a dark set of the
// same tokens; the colours that stay the same in both modes; the text pairs that must read (4.5:1 or more); and
// Inter's type scale. No React Native code, so its tests run in node: ui/useTheme.ts picks the set from the phone.
import type { TextStyle } from 'react-native';

export type Scheme = 'light' | 'dark';

export const TOKENS = [
  'bg', 'surface', 'header', 'headerText', 'headerMuted', 'text', 'muted', 'line', 'outline', 'outlineText',
  'accent', 'onAccent', 'accentText', 'selected', 'highlight', 'onHighlight', 'ok',
  'warn', 'warnBg', 'warnLine', 'error', 'errorBg', 'errorLine', 'sleeve', 'veil',
] as const;
export type Token = (typeof TOKENS)[number];
export type Theme = Readonly<Record<Token, string>> & { readonly scheme: Scheme };

/** A #rrggbb colour at an opacity (0 to 1), as #rrggbbaa. */
export const alpha = (hex: string, opacity: number): string => `${hex}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;

// accent is a fill only (main buttons, the main round button, the field cursor): orange words are accentText.
const LIGHT = {
  bg: '#f3f4f6', surface: '#ffffff', header: '#24292f', headerText: '#ffffff', headerMuted: '#c9d1d9',
  text: '#16191d', muted: '#5b6470', line: '#dde1e6', outline: '#24292f', outlineText: '#24292f',
  accent: '#f7931a', onAccent: '#16191d', accentText: '#a85500', selected: '#fff1dc', highlight: '#ffe066', onHighlight: '#16191d',
  ok: '#1a7f37', warn: '#7a4a00', warnBg: '#fff4e0', warnLine: '#f0c27a', error: '#cf222e', errorBg: '#ffebe9', errorLine: '#ff8182',
  sleeve: '#24292f', veil: alpha('#f3f4f6', 0.45),
} satisfies Record<Token, string>;

// In dark mode the band is the background, a near-black charcoal.
const DARK = {
  bg: '#1b1f24', surface: '#24292f', header: '#1b1f24', headerText: '#eef1f4', headerMuted: '#9aa4af',
  text: '#eef1f4', muted: '#9aa4af', line: '#343b44', outline: '#4a535e', outlineText: '#eef1f4',
  accent: '#f7931a', onAccent: '#16191d', accentText: '#ffa94d', selected: '#3a2a12', highlight: '#ffe066', onHighlight: '#16191d',
  ok: '#3fb950', warn: '#ffe066', warnBg: '#33290f', warnLine: '#8a6a12', error: '#ff7b72', errorBg: '#3a1d1d', errorLine: '#8e3b37',
  sleeve: '#0e1114', veil: alpha('#1b1f24', 0.45),
} satisfies Record<Token, string>;

const THEMES: Record<Scheme, Theme> = { light: { ...LIGHT, scheme: 'light' }, dark: { ...DARK, scheme: 'dark' } };

/** The set for the phone's setting: dark for 'dark', light for 'light' or no answer. */
export const themeFor = (scheme: string | null | undefined): Theme => THEMES[scheme === 'dark' ? 'dark' : 'light'];

/**
 * The same in both modes: the text on card faces, the photo fade and the dark tags' base, the ground behind
 * every QR code (its quiet zone must stay white to scan), and the amber tag on a card face (re-point), as it was:
 * it sits on the card's own colour, which doesn't change. The cards' own colours are wallet/colours.ts's.
 */
export const FIXED = { onCard: '#ffffff', fade: '#000000', qrTile: '#ffffff', tagText: '#9a6700', tagBg: '#fff8c5' } as const;

const linear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG's relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16);
  return 0.2126 * linear((n >> 16) & 255) + 0.7152 * linear((n >> 8) & 255) + 0.0722 * linear(n & 255);
}

/** WCAG's contrast ratio of two #rrggbb colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every text colour and what it sits on, [text, ground]: each reaches 4.5:1 in both modes (theme.test.ts). */
export const TEXT_PAIRS: readonly (readonly [Token, Token])[] = [
  ['text', 'bg'], ['text', 'surface'], ['muted', 'bg'], ['muted', 'surface'],
  ['accentText', 'bg'], ['accentText', 'surface'], ['ok', 'bg'], ['ok', 'surface'],
  ['error', 'bg'], ['error', 'surface'], ['warn', 'bg'], ['warn', 'surface'],
  ['error', 'errorBg'], ['warn', 'warnBg'], ['text', 'warnBg'], ['text', 'errorBg'], ['muted', 'warnBg'], ['muted', 'errorBg'], ['outlineText', 'errorBg'], ['accentText', 'warnBg'], ['onAccent', 'accent'], ['onHighlight', 'highlight'],
  ['headerText', 'header'], ['headerMuted', 'header'], ['outlineText', 'bg'], ['outlineText', 'surface'], ['text', 'selected'], ['muted', 'selected'], ['warn', 'selected'],
];

const made = new WeakMap<object, Partial<Record<Scheme, unknown>>>();

/** make's styles for t's scheme, made the first time and kept: so a screen redraws in the other mode's colours at once. */
export function stylesFor<T>(make: (t: Theme) => T, t: Theme): T {
  let byScheme = made.get(make);
  if (!byScheme) made.set(make, (byScheme = {}));
  if (!(t.scheme in byScheme)) byScheme[t.scheme] = make(t);
  return byScheme[t.scheme] as T;
}

const INTER = 'Inter';

/**
 * Inter's type scale: app.json's expo-font plugin makes one family, Inter, whose fontWeight picks the file
 * (regular 400, semi-bold 600, bold 700). Every Text style builds on one of these. body and small carry their
 * lineHeight: a style that changes their fontSize sets its own.
 */
export const TYPE = {
  title: { fontFamily: INTER, fontSize: 22, fontWeight: '700' },
  heading: { fontFamily: INTER, fontSize: 18, fontWeight: '600' },
  body: { fontFamily: INTER, fontSize: 15, lineHeight: 21, fontWeight: '400' },
  small: { fontFamily: INTER, fontSize: 13, lineHeight: 18, fontWeight: '400' },
  button: { fontFamily: INTER, fontSize: 16, fontWeight: '600' },
} as const satisfies Record<string, TextStyle>;

/** Figures of one width, so amounts line up. */
export const AMOUNT: TextStyle = { fontVariant: ['tabular-nums'] };

/** A monospaced face for a payment's proof, each phone's own: a style picks one with Platform.select. */
export const MONO = { ios: { fontFamily: 'Menlo' }, default: { fontFamily: 'monospace' } } as const satisfies Record<'ios' | 'default', TextStyle>;
