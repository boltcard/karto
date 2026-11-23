import { describe, expect, it } from 'vitest';
import type { DiskAnswer } from '../cardd/client';
import { bytesText, diskBanner, diskCard } from './diskWords';

// The phones' one rule (cardd's alert vectors check Android's): GB with one decimal once it rounds to 1.0 GB
// (950,000,000 bytes), else whole MB.
describe('bytesText', () => {
  it('says GB with one decimal from 950,000,000 bytes, else whole MB, to the nearest', () => {
    expect(bytesText(1_400_000_000)).toBe('1.4 GB');
    expect(bytesText(1_450_000_000)).toBe('1.5 GB');
    expect(bytesText(10_700_000_000)).toBe('10.7 GB');
    expect(bytesText(999_600_000)).toBe('1.0 GB');
    expect(bytesText(999_500_000)).toBe('1.0 GB');
    expect(bytesText(950_000_000)).toBe('1.0 GB');
    expect(bytesText(949_999_999)).toBe('950 MB');
    expect(bytesText(400_000_000)).toBe('400 MB');
    expect(bytesText(0)).toBe('0 MB');
  });
});

const low: DiskAnswer = { freeBytes: 1_400_000_000, totalBytes: 10_700_000_000, freeableBytes: 3_000_000_000, rebuildHelps: true, level: 'low' };
const critical: DiskAnswer = { ...low, freeBytes: 400_000_000, level: 'critical' };

describe('diskBanner', () => {
  it('is amber when low and red when critical, and none with room', () => {
    expect(diskBanner(low)).toEqual({ tone: 'amber', text: "Your server's disk is nearly full: 1.4 GB left" });
    expect(diskBanner(critical)).toEqual({ tone: 'red', text: "Your server's disk is almost full: 400 MB left" });
    expect(diskBanner({ ...low, level: undefined })).toBeNull();
    expect(diskBanner(undefined)).toBeNull();
  });
});

describe('diskCard', () => {
  it('explains and offers Rebuild server when a rebuild frees enough', () => {
    expect(diskCard(low)).toEqual({
      title: 'The disk is nearly full',
      text:
        '1.4 GB of 10.7 GB is left. phoenixd, the Lightning wallet on your server, keeps a record of every invoice it has made and has no way to delete them. ' +
        'Rebuild server sets the server up again, in place on this VM while it is paid or on a new one (paid for), and leaves those records behind: your cards, money and notes come with you. ' +
        'Each card then needs a tap.',
      rebuild: true,
    });
    expect(diskCard(critical)).toMatchObject({ title: 'The disk is almost full: rebuild now', rebuild: true });
  });
  it("doesn't promise a rebuild that would free too little", () => {
    const other = { ...low, freeableBytes: 300_000_000, rebuildHelps: false };
    expect(diskCard(other)).toEqual({
      title: 'The disk is nearly full',
      text:
        "1.4 GB of 10.7 GB is left, and a rebuild would free only 300 MB: something other than Karto's own data is filling the disk. " +
        'Ask for help on GitHub: github.com/boltcard/karto/issues.',
      rebuild: false,
    });
    expect(diskCard({ ...other, level: 'critical', freeBytes: 400_000_000 })).toMatchObject({ title: 'The disk is almost full', rebuild: false });
  });
  it('offers Rebuild server when what it frees is unknown', () => {
    const unknown: DiskAnswer = { freeBytes: 1_400_000_000, totalBytes: 10_700_000_000, level: 'low' };
    expect(diskCard(unknown)).toEqual({
      title: 'The disk is nearly full',
      text: '1.4 GB of 10.7 GB is left. Rebuilding the server usually frees the most room: phoenixd, the Lightning wallet on it, keeps a record of every invoice it has made.',
      rebuild: true,
    });
  });
  it("doesn't say rebuild now when cardd can't tell whether a rebuild helps", () => {
    expect(diskCard({ freeBytes: 400_000_000, totalBytes: 10_700_000_000, level: 'critical' })).toMatchObject({ title: 'The disk is almost full', rebuild: true });
  });
  it('is none with room or no reading', () => {
    expect(diskCard({ ...low, level: undefined })).toBeNull();
    expect(diskCard(undefined)).toBeNull();
  });
});
