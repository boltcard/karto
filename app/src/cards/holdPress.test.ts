import { describe, expect, it } from 'vitest';
import { holdPress, isHoldPress } from './holdPress';

// A link (karto://card?…) can open the hold screen; only a press in the app lets it open Apple's sheet by itself.
describe('the press that leads to the hold screen', () => {
  const bytes = (b: number) => () => new Uint8Array(16).fill(b);

  it('gives a token that the screen it is sent to can show, however often it is asked', () => {
    const press = holdPress(bytes(0xab));
    expect(press).toBe('ab'.repeat(16));
    expect(isHoldPress(press)).toBe(true);
    expect(isHoldPress(press)).toBe(true);
  });
  it('is not shown by a link, which has no token, a guess, or two', () => {
    holdPress(bytes(0xab));
    expect(isHoldPress(undefined)).toBe(false);
    expect(isHoldPress('')).toBe(false);
    expect(isHoldPress('00'.repeat(16))).toBe(false);
    expect(isHoldPress(['ab'.repeat(16), 'ab'.repeat(16)])).toBe(false);
  });
  it('is replaced by the next press: an earlier token no longer counts', () => {
    const first = holdPress(bytes(0x01));
    const second = holdPress(bytes(0x02));
    expect(isHoldPress(first)).toBe(false);
    expect(isHoldPress(second)).toBe(true);
  });
  it('makes a new token at every press, 16 random bytes of it', () => {
    const a = holdPress();
    const b = holdPress();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
