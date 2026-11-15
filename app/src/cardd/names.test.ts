import { describe, expect, it } from 'vitest';
import { isName, NAME_MAX } from './names';

// A name as cardd keeps it and a till shows it: a PoS phone's, and the wallet's.
describe('isName', () => {
  it('takes a trimmed name of 1 to 24 characters, counted as characters', () => {
    expect(NAME_MAX).toBe(24);
    for (const ok of ['Pixel 9a', 'a', 'é'.repeat(24), '😀'.repeat(24)]) expect(isName(ok), ok).toBe(true);
  });

  it('refuses an empty, untrimmed, long or hidden-character name, and what is no string', () => {
    for (const bad of ['', ' a', 'a ', 'a'.repeat(25), 'a\u200bb', 'a\u202eb', 'a\u2066b', 'a\ufeffb', 'a\u061cb', 'a\nb', 'a\u0085b', 7, null, undefined]) {
      expect(isName(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
