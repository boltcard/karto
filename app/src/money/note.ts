// The person's note on a payment: cardd keeps 200 characters at most, counted in code points after it
// cleans the note (which only shortens it), and refuses more with bad_note. A field's maxLength counts UTF-16 units,
// so an emoji counted two and a note of emoji stopped at 100: the fields cut by code points instead.
//
// A top-up's payer's note: the payer's words, cleaned and cut
// by cardd; the app cuts again in case an older or odd cardd sends more, and never makes it a link.

import type { Tx } from '../cardd/client';

/** The most a note keeps, in code points (cardd's lnaddr.MaxText). */
export const NOTE_MAX = 200;

/**
 * The most of a payer's note shown, in code points: cardd's 140 (lnurl's maxPayerNote) and the … it puts after a cut
 * one. A cut at 140 here would take that … off.
 */
export const PAYER_NOTE_MAX = 141;

/** text cut to limit code points (NOTE_MAX unless given). A cut may split a cluster drawn as one (a ZWJ emoji, a flag): accepted. */
export function cutNote(text: string, limit = NOTE_MAX): string {
  const points = [...text];
  return points.length > limit ? points.slice(0, limit).join('') : text;
}

/** A line's payer's note as it is read out: plain, cut; '' for none. */
export function payerNoteText(t: Tx): string {
  return cutNote(t.payerNote ?? '', PAYER_NOTE_MAX);
}

/** A line's payer's note as it is shown: in curly quotes, as someone else's words; '' for none. */
export function quotedPayerNote(t: Tx): string {
  const text = payerNoteText(t);
  return text === '' ? '' : `“${text}”`;
}
