import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import type { CardInfo } from '../cardd/client';
import { PROBE_JPEG_BASE64 } from './probePhoto';
import { probePhotos, WHOLE, type PhotoProbeDeps } from './photoProbe';

const probe = base64.decode(PROBE_JPEG_BASE64);
/** A JPEG-shaped thumbnail: SOI, a 428×270 frame header, start of scan. */
const thumb = (w = 428, h = 270, exif = false) =>
  new Uint8Array([
    0xff, 0xd8,
    ...(exif ? [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00] : []),
    0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x02, 0xff, 0xd9,
  ]);
const A = 'a'.repeat(32);
const card = (id: string, photo: string): CardInfo => ({ id, version: 0, state: 'active', counter: 1, name: 'A', created: 1, updated: 1, photo });

function deps(o: Partial<PhotoProbeDeps> = {}): PhotoProbeDeps & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    appFiles: async () => [
      { path: 'files/SQLite/card-app.db', size: 81_920, jpeg: false },
      { path: 'cache/http-cache/journal', size: 12, jpeg: false },
    ],
    thumbnail: async (jpeg, corners) => (log.push(`thumbnail ${base64.decode(jpeg).length} ${corners.join(',')}`), base64.encode(thumb())),
    cards: async () => [card(A, '0123456789abcdef')],
    cardPhoto: async () => ({ jpeg: base64.encode(thumb()), photo: '0123456789abcdef' }),
    newestSnapshot: async () => ({ created: 1_790_000_000, plain: new Uint8Array([1]) }),
    photoRows: async () => [A],
    ...o,
  };
}

const byName = (r: { name: string; ok: boolean; detail: string }[]) => Object.fromEntries(r.map((x) => [x.name, x]));

// The probe build's checks.
describe('probePhotos', () => {
  it('passes when no JPEG file is in the app, the thumbnail has no EXIF, and the photos are stored and backed up', async () => {
    const d = deps();
    const r = byName(await probePhotos(probe, d));
    expect(Object.values(r).every((x) => x.ok)).toBe(true);
    expect(Object.keys(r)).toEqual(['files', 'probe-exif', 'thumbnail', 'stored', 'snapshot']);
    expect(r.files.detail).toBe('no JPEG among 2 file(s): files/SQLite/card-app.db 81920, cache/http-cache/journal 12');
    expect(r.thumbnail.detail).toMatch(/^428×270, \d+ bytes, no EXIF$/);
    // The test JPEG, whole, through the camera's thumbnail step.
    expect(d.log).toEqual([`thumbnail ${probe.length} ${WHOLE.join(',')}`]);
  });

  it('fails on any JPEG file in the cache or files, and names it', async () => {
    const r = byName(await probePhotos(probe, deps({ appFiles: async () => [{ path: 'cache/shot.jpg', size: 2_000_000, jpeg: true }] })));
    expect(r.files).toEqual({ name: 'files', ok: false, detail: 'JPEG file(s): cache/shot.jpg' });
  });

  it('fails a thumbnail with EXIF or of the wrong size', async () => {
    const exif = byName(await probePhotos(probe, deps({ thumbnail: async () => base64.encode(thumb(428, 270, true)) })));
    expect(exif.thumbnail).toMatchObject({ ok: false, detail: expect.stringContaining('EXIF') });
    const size = byName(await probePhotos(probe, deps({ thumbnail: async () => base64.encode(thumb(428, 269)) })));
    expect(size.thumbnail).toMatchObject({ ok: false, detail: expect.stringContaining('428×269') });
  });

  it('fails when no card has a photo yet, or a stored one carries EXIF', async () => {
    expect(byName(await probePhotos(probe, deps({ cards: async () => [card(A, '')] }))).stored).toMatchObject({ ok: false, detail: 'no card has a photo yet' });
    const r = byName(await probePhotos(probe, deps({ cardPhoto: async () => ({ jpeg: base64.encode(thumb(428, 270, true)), photo: 'x' }) })));
    expect(r.stored).toMatchObject({ ok: false, detail: expect.stringContaining('EXIF') });
  });

  it("fails while the newest snapshot on the phone doesn't hold every photo, saying to wait for the next", async () => {
    const r = byName(await probePhotos(probe, deps({ photoRows: async () => [] })));
    expect(r.snapshot).toMatchObject({ ok: false, detail: expect.stringContaining('wait for the next hourly snapshot') });
    expect(byName(await probePhotos(probe, deps({ newestSnapshot: async () => null }))).snapshot).toMatchObject({ ok: false });
  });

  // Before the first snapshot after Update server, the newest is from the old cardd: no card_photos at all.
  it('says to wait when the newest snapshot is from before this cardd', async () => {
    const old = deps({ photoRows: async () => Promise.reject(new Error('Calling the getAllAsync function has failed: no such table: card_photos')) });
    expect(byName(await probePhotos(probe, old)).snapshot).toMatchObject({ ok: false, detail: expect.stringContaining('wait for the next hourly snapshot') });
  });
});
