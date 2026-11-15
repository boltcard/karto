import { describe, expect, it } from 'vitest';
import { posBuildLabel } from './build';

const NOW = 1_790_000_000; // 2026-09-21 14:13:20 UTC

// The build label is "Karto PoS <commit>, built …", under This PoS.
describe('posBuildLabel', () => {
  it('says the commit and when it was built, in the phone\'s time zone', () => {
    expect(posBuildLabel('8571926', String(Date.UTC(2026, 8, 21, 10, 11) / 1000), NOW, 0)).toBe('Karto PoS 8571926, built today at 10:11');
    expect(posBuildLabel('8571926', String(Date.UTC(2026, 8, 20, 22, 52) / 1000), NOW, 60)).toBe('Karto PoS 8571926, built yesterday at 23:52');
  });

  it("says so when the build carries none, or its time isn't one", () => {
    expect(posBuildLabel(undefined, undefined, NOW, 0)).toBe('Karto PoS build unknown');
    expect(posBuildLabel('', '1', NOW, 0)).toBe('Karto PoS build unknown');
    expect(posBuildLabel('8571926', 'soon', NOW, 0)).toBe('Karto PoS 8571926');
    expect(posBuildLabel('8571926', undefined, NOW, 0)).toBe('Karto PoS 8571926');
  });
});
