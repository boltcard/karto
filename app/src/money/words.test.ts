import { describe, expect, it } from 'vitest';
import { fullTime } from './words';

describe('fullTime', () => {
  it("the date with its year and the time to the second, in the phone's zone", () => {
    expect(fullTime(Date.UTC(2026, 9, 15, 7, 1, 12) / 1000, 60)).toBe('15 Oct 2026, 08:01:12');
  });

  it('west of UTC, half-hour zones, and across midnight and the year', () => {
    expect(fullTime(Date.UTC(2026, 9, 15, 3, 4, 5) / 1000, -300)).toBe('14 Oct 2026, 22:04:05');
    expect(fullTime(Date.UTC(2026, 9, 15, 20, 0, 0) / 1000, 330)).toBe('16 Oct 2026, 01:30:00');
    expect(fullTime(Date.UTC(2026, 11, 31, 23, 30, 0) / 1000, 60)).toBe('1 Jan 2027, 00:30:00');
    expect(fullTime(Date.UTC(2027, 0, 1, 0, 30, 0) / 1000, -60)).toBe('31 Dec 2026, 23:30:00');
  });
});
