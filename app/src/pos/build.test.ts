import { describe, expect, it } from 'vitest';
import { posBuildLabel } from './build';

const NOW = 1_790_000_000; // 2026-09-21 14:13:20 UTC

// The build label is "Karto PoS <version> (<commit>), built …", under This PoS.
describe('posBuildLabel', () => {
  it('says the commit and when it was built, in the phone\'s time zone', () => {
    expect(posBuildLabel('8571926', String(Date.UTC(2026, 8, 21, 10, 11) / 1000), '1.0.2', NOW, 0)).toBe('Karto PoS 1.0.2 (8571926), built today at 10:11');
    expect(posBuildLabel('8571926', String(Date.UTC(2026, 8, 20, 22, 52) / 1000), '1.0.2', NOW, 60)).toBe('Karto PoS 1.0.2 (8571926), built yesterday at 23:52');
    // No version in the app's config: the commit alone, as before.
    expect(posBuildLabel('8571926', String(Date.UTC(2026, 8, 21, 10, 11) / 1000), undefined, NOW, 0)).toBe('Karto PoS 8571926, built today at 10:11');
  });

  it("says so when the build carries none, or its time isn't one", () => {
    expect(posBuildLabel(undefined, undefined, undefined, NOW, 0)).toBe('Karto PoS build unknown');
    expect(posBuildLabel('', '1', undefined, NOW, 0)).toBe('Karto PoS build unknown');
    expect(posBuildLabel(undefined, undefined, '1.0.2', NOW, 0)).toBe('Karto PoS 1.0.2, build unknown');
    expect(posBuildLabel('8571926', 'soon', undefined, NOW, 0)).toBe('Karto PoS 8571926');
    expect(posBuildLabel('8571926', undefined, undefined, NOW, 0)).toBe('Karto PoS 8571926');
    expect(posBuildLabel('8571926', undefined, '1.0.2', NOW, 0)).toBe('Karto PoS 1.0.2 (8571926)');
  });
});
