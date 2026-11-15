// The card sleeve the wallet's front card stands in:
// a dark rectangle over the card's lower part with a semicircular
// thumb notch cut from the middle of its top edge.

/** The notch's width as a share of the sleeve's: about a third (84 of 262 in the design). */
export const NOTCH_SHARE = 0.32;

/** Two decimal places: enough for a dp path, and a path that reads cleanly. */
const dp = (x: number) => Math.round(x * 100) / 100;

/**
 * The sleeve's outline in dp, for an SVG Path of width × height: its top edge
 * dips in a semicircle (NOTCH_SHARE of the width across, half that deep),
 * centred, so the card behind shows through. The notch is never deeper than
 * the sleeve. overdraw: how much of the width lies past the card's visible
 * edge (the wallet draws the sleeve 1 dp past it); the notch is sized and
 * centred on the width without it.
 */
export function sleevePath(width: number, height: number, overdraw = 0): string {
  const visible = width - overdraw;
  const r = dp(Math.max(0, Math.min((visible * NOTCH_SHARE) / 2, height)));
  const left = dp(visible / 2 - r);
  const right = dp(visible / 2 + r);
  return `M0 0 H${left} A${r} ${r} 0 0 0 ${right} 0 H${dp(width)} V${dp(height)} H0 Z`;
}
