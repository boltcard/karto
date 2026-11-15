import { describe, expect, it } from 'vitest';
import { NOTCH_SHARE, sleevePath } from './sleeve';

// The front card stands in a sleeve with a thumb notch.
describe('sleevePath', () => {
  it('cuts a centred semicircle, about a third of the width across, from the top edge', () => {
    // 300 wide: a notch 96 across (radius 48), from 102 to 198, the sweep curving down into the sleeve.
    expect(sleevePath(300, 140)).toBe('M0 0 H102 A48 48 0 0 0 198 0 H300 V140 H0 Z');
  });

  it("keeps the design's proportions", () => {
    const r = (262 * NOTCH_SHARE) / 2;
    expect(Math.abs(r - 42)).toBeLessThan(0.5);
  });

  it('rounds to two decimal places', () => {
    expect(sleevePath(328.4, 158.7)).toBe('M0 0 H111.66 A52.54 52.54 0 0 0 216.74 0 H328.4 V158.7 H0 Z');
  });

  it('never cuts deeper than the sleeve', () => {
    expect(sleevePath(400, 20)).toBe('M0 0 H180 A20 20 0 0 0 220 0 H400 V20 H0 Z');
  });

  it('gives an empty outline, not NaN, for a zero size', () => {
    expect(sleevePath(0, 0)).toBe('M0 0 H0 A0 0 0 0 0 0 0 H0 V0 H0 Z');
  });

  it('centres the notch on the visible width when the sleeve is drawn past the card by an overdraw', () => {
    // 301 wide with 1 of it overdraw: the notch is that of a 300 wide sleeve, the outline still 301 wide.
    expect(sleevePath(301, 141, 1)).toBe('M0 0 H102 A48 48 0 0 0 198 0 H301 V141 H0 Z');
  });
});
