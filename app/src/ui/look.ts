// The shared parts' colours that depend on their state: a button by its kind and
// whether it can be pressed, and what a solid sheet draws under the status bar. No React Native code, so the
// tests run in node; ui.tsx draws with them.
import type { Theme } from './theme';

export type ButtonKind = 'primary' | 'secondary' | 'danger';
export type ButtonColours = { fill: string; border: string; text: string };

/** How a row, a panel or a line stands: green, amber, red, or nothing to say (no dot). */
export type RowTone = 'ok' | 'warn' | 'error' | 'none';

/** A tone's dot and coloured line: its token, or none for nothing to say. */
export const toneColour = (tone: RowTone, t: Theme): string | null =>
  tone === 'ok' ? t.ok : tone === 'warn' ? t.warn : tone === 'error' ? t.error : null;

/**
 * After a dot, the box holding a row's line or a panel's title and its tag: it takes the rest of the row and they
 * wrap inside it, so a long line stays beside the dot instead of dropping under it, and a word never breaks to make
 * room for the tag.
 */
export const BESIDE_DOT = { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 } as const;

export type RowColours = { icon: string; name: string; line: string; dot: string | null };

/**
 * A row's colours. Greyed (disabled), everything is muted at full strength, 4.5:1 on surface, not faded: half
 * opacity left the words at 2.1:1, as the disabled buttons were. danger: the name and
 * icon in red (Rebuild server); a warning's or an error's line in its tone's colour.
 */
export function rowColours(tone: RowTone, disabled: boolean, danger: boolean, t: Theme): RowColours {
  if (disabled) return { icon: t.muted, name: t.muted, line: t.muted, dot: null };
  const dot = toneColour(tone, t);
  return { icon: danger ? t.error : t.muted, name: danger ? t.error : t.text, line: tone === 'warn' || tone === 'error' ? dot! : t.muted, dot };
}

/**
 * The width of Details' label column on the Server page, in dp: 84 at the phone's normal font size, growing with a
 * larger one so "Hosted by" keeps one line, never narrower for a smaller one.
 */
export const detailsLabelWidth = (fontScale: number): number => Math.ceil(84 * Math.max(1, fontScale));

/**
 * The recovery words' number column, in dp: 20 at the standard font, wider with a larger one, so "10", "11" and
 * "12" keep one line (at a fixed 20 they broke in two at font scale 1.3, seen on the Pixel 8 Pro).
 */
export const wordNumberWidth = (fontScale: number): number => Math.ceil(20 * Math.max(1, fontScale));

/**
 * One part of a progress bar (ui/setup.tsx Progress): the parts up to the current step n (from 1) are done; when
 * the run stopped at n (a hold whose card moved away), that part is where it stopped and the ones before are done.
 */
export const partLook = (i: number, n: number, stopped: boolean): 'done' | 'stopped' | 'todo' => (i < n - 1 ? 'done' : i === n - 1 ? (stopped ? 'stopped' : 'done') : 'todo');

/**
 * What stands at a pressable row's end: its tick's place for one of a set to choose from, nothing for a row that
 * acts at once and opens nothing (Remove photo), › for a row that opens something.
 */
export const rowEnd = (o: { choice: boolean; acts: boolean }): 'tick' | 'chevron' | 'none' => (o.choice ? 'tick' : o.acts ? 'none' : 'chevron');

/** What TalkBack reads for a row: its name, its line, its end text and its tag, those it has. */
export const rowLabel = (name: string, line?: string, tag?: string, end?: string): string => [name, line, end, tag].filter(Boolean).join(', ');

/**
 * A button's fill, border and text. Disabled, every kind is muted text on surface with a line border (4.5:1 in
 * both modes): fading the orange to 50% left its label at 1.8:1 on the dark page.
 */
export function buttonColours(kind: ButtonKind, disabled: boolean, t: Theme): ButtonColours {
  if (disabled) return { fill: t.surface, border: t.line, text: t.muted };
  if (kind === 'primary') return { fill: t.accent, border: t.accent, text: t.onAccent };
  if (kind === 'danger') return { fill: 'transparent', border: t.error, text: t.error };
  return { fill: 'transparent', border: t.outline, text: t.outlineText };
}

/** Under the status bar, whose icons are light on every screen: the band's colour, also above a solid sheet. */
export const statusBarGround = (t: Theme): string => t.header;
