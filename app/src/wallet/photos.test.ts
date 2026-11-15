import { describe, expect, it } from 'vitest';
import { CarddError, type CardInfo, type CardPhoto } from '../cardd/client';
import type { CachedPhoto } from '../store/store';
import { photoUri, syncPhotos, type PhotoCache } from './photos';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const listed = (id: string, photo?: string): CardInfo => ({ id, version: 0, state: 'active', counter: 1, name: id, created: 1, updated: 1, ...(photo !== undefined && { photo }) });

function fakes(cached: Record<string, CachedPhoto> = {}) {
  const rows = { ...cached };
  const served: Record<string, CardPhoto | Error> = {};
  const fetched: string[] = [];
  const cache: PhotoCache = {
    photos: async () => ({ ...rows }),
    savePhoto: async (id, p) => void (rows[id] = p),
    dropPhoto: async (id) => void delete rows[id],
  };
  const cardd = {
    cardPhoto: async (id: string) => {
      fetched.push(id);
      const p = served[id];
      if (!p) throw new CarddError(404, 'not_found', 'store: not found');
      if (p instanceof Error) throw p;
      return p;
    },
  };
  const shown: [string, string | null][] = [];
  return { rows, served, fetched, cache, cardd, shown, onPhoto: (id: string, uri: string | null) => void shown.push([id, uri]) };
}

describe('photoUri', () => {
  it('makes the data: URI an <Image> draws a JPEG from', () => {
    expect(photoUri('/9j/AAAA')).toBe('data:image/jpeg;base64,/9j/AAAA');
  });
});

// PhotoSync after each card list cardd answered.
describe('syncPhotos', () => {
  it('fetches only the photos whose tag changed, one at a time, and keeps them', async () => {
    const f = fakes({ [A]: { tag: 'aaaa000000000000', jpeg: 'A-old' }, [B]: { tag: 'bbbb000000000000', jpeg: 'B' } });
    f.served[A] = { jpeg: 'A-new', photo: 'aaaa111111111111' };
    f.served[C] = { jpeg: 'C', photo: 'cccc000000000000' };
    await syncPhotos([listed(A, 'aaaa111111111111'), listed(B, 'bbbb000000000000'), listed(C, 'cccc000000000000')], f.cardd, f.cache, f.onPhoto);
    expect(f.fetched).toEqual([A, C]);
    expect(f.rows).toEqual({
      [A]: { tag: 'aaaa111111111111', jpeg: 'A-new' }, [B]: { tag: 'bbbb000000000000', jpeg: 'B' }, [C]: { tag: 'cccc000000000000', jpeg: 'C' },
    });
    expect(f.shown).toEqual([[A, photoUri('A-new')], [C, photoUri('C')]]);
  });

  it('drops a photo the card no longer has, and one whose card the list no longer has', async () => {
    const f = fakes({ [A]: { tag: 'aaaa000000000000', jpeg: 'A' }, [B]: { tag: 'bbbb000000000000', jpeg: 'B' } });
    await syncPhotos([listed(A, '')], f.cardd, f.cache, f.onPhoto);
    expect(f.rows).toEqual({});
    expect(f.fetched).toEqual([]);
    expect(f.shown).toEqual([[A, null], [B, null]]);
  });

  // An older cardd, without card photos, doesn't say: nothing is fetched or dropped for it.
  it('leaves a card whose list entry has no photo field alone', async () => {
    const f = fakes({ [A]: { tag: 'aaaa000000000000', jpeg: 'A' } });
    await syncPhotos([listed(A)], f.cardd, f.cache, f.onPhoto);
    expect(f.rows).toEqual({ [A]: { tag: 'aaaa000000000000', jpeg: 'A' } });
    expect([f.fetched, f.shown]).toEqual([[], []]);
  });

  it('goes on past a fetch that fails, keeping the old photo for the next list to try again', async () => {
    const f = fakes({ [A]: { tag: 'aaaa000000000000', jpeg: 'A' } });
    f.served[A] = new Error('fetch failed: no answer');
    f.served[B] = { jpeg: 'B', photo: 'bbbb000000000000' };
    await syncPhotos([listed(A, 'aaaa111111111111'), listed(B, 'bbbb000000000000')], f.cardd, f.cache, f.onPhoto);
    expect(f.rows).toEqual({ [A]: { tag: 'aaaa000000000000', jpeg: 'A' }, [B]: { tag: 'bbbb000000000000', jpeg: 'B' } });
    expect(f.shown).toEqual([[B, photoUri('B')]]);
    f.served[A] = { jpeg: 'A-new', photo: 'aaaa111111111111' };
    await syncPhotos([listed(A, 'aaaa111111111111'), listed(B, 'bbbb000000000000')], f.cardd, f.cache, f.onPhoto);
    expect(f.rows[A]).toEqual({ tag: 'aaaa111111111111', jpeg: 'A-new' });
  });

  // Removed between the list and the fetch: cardd's 404 means it has none now.
  it('drops a photo cardd no longer has when it is fetched', async () => {
    const f = fakes({ [A]: { tag: 'aaaa000000000000', jpeg: 'A' } });
    await syncPhotos([listed(A, 'aaaa111111111111')], f.cardd, f.cache, f.onPhoto);
    expect(f.rows).toEqual({});
    expect(f.shown).toEqual([[A, null]]);
  });
});
