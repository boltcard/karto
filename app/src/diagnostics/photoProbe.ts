// The phone diagnostics' photo check (make phone-photo-probe):
// what a run on a phone can't show on the screen. No
// JPEG file anywhere in the app's cache or files (the shot stays in memory,
// and the thumbnails live in the database); a JPEG with a GPS position comes
// out of the card camera's thumbnail step 428×270, at most 64 KB and without
// EXIF; the photos cardd keeps have none either; and the newest snapshot on
// the phone holds every card's photo.
import { base64 } from '@scure/base';
import type { CardInfo, CardPhoto } from '../cardd/client';
import { hasExif } from '../cardphoto/jpeg';
import { thumbnailFault } from '../cardphoto/take';
import type { CheckResult } from './checks';

/** A file under the app's cache/ or files/: its path from there, its size, and whether it starts as a JPEG does (FF D8 FF). */
export type AppFile = { path: string; size: number; jpeg: boolean };

export type PhotoProbeDeps = {
  /** Every file under the app's cache/ and files/. */
  appFiles(): Promise<AppFile[]>;
  /** The card camera's thumbnail step (CardNative.cardThumbnail): a JPEG, corners as fractions of it. */
  thumbnail(jpeg: string, corners: number[]): Promise<string>;
  cards(): Promise<CardInfo[]>;
  cardPhoto(id: string): Promise<CardPhoto>;
  /** The newest snapshot kept on the phone, decrypted; null with none. */
  newestSnapshot(): Promise<{ created: number; plain: Uint8Array } | null>;
  /** The card ids in a snapshot's card_photos. */
  photoRows(plain: Uint8Array): Promise<string[]>;
};

/** The whole picture, as cardThumbnail's corners: top left, top right, bottom right, bottom left. */
export const WHOLE = [0, 0, 1, 0, 1, 1, 0, 1];

export async function probePhotos(probeJpeg: Uint8Array, d: PhotoProbeDeps): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const check = async (name: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    try {
      out.push({ name, ...(await fn()) });
    } catch (e) {
      out.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  };

  // What the run's shot left: the camera writes no file, so no JPEG may be found.
  await check('files', async () => {
    const all = await d.appFiles();
    const jpegs = all.filter((f) => f.jpeg);
    const listing = all.map((f) => `${f.path} ${f.size}`).join(', ') || 'none';
    return jpegs.length === 0
      ? { ok: true, detail: `no JPEG among ${all.length} file(s): ${listing}` }
      : { ok: false, detail: `JPEG file(s): ${jpegs.map((f) => f.path).join(', ')}` };
  });
  await check('probe-exif', async () =>
    hasExif(probeJpeg) ? { ok: true, detail: 'the test JPEG carries a GPS position' } : { ok: false, detail: 'the test JPEG has no EXIF: nothing to strip' },
  );
  await check('thumbnail', async () => {
    const b = base64.decode(await d.thumbnail(base64.encode(probeJpeg), WHOLE));
    const fault = thumbnailFault(b);
    return fault ? { ok: false, detail: fault } : { ok: true, detail: `428×270, ${b.length} bytes, no EXIF` };
  });
  let withPhoto: CardInfo[] = [];
  await check('stored', async () => {
    withPhoto = (await d.cards()).filter((c) => c.photo);
    if (withPhoto.length === 0) return { ok: false, detail: 'no card has a photo yet' };
    for (const c of withPhoto) {
      const fault = thumbnailFault(base64.decode((await d.cardPhoto(c.id)).jpeg));
      if (fault) return { ok: false, detail: `card ${c.id.slice(0, 8)}: ${fault}` };
    }
    return { ok: true, detail: `${withPhoto.length} photo(s) on the server, none with EXIF` };
  });
  await check('snapshot', async () => {
    const snap = await d.newestSnapshot();
    if (!snap) return { ok: false, detail: 'no snapshot on the phone yet' };
    const when = new Date(snap.created * 1000).toISOString();
    const wait = 'wait for the next hourly snapshot, then open the app and run again';
    let ids: string[];
    try {
      ids = await d.photoRows(snap.plain);
    } catch (e) {
      // A snapshot from an older cardd has no photos table.
      if (/no such table: card_photos/.test(String(e))) return { ok: false, detail: `the newest snapshot (${when}) is from before this server's update: ${wait}` };
      throw e;
    }
    const rows = new Set(ids);
    const missing = withPhoto.filter((c) => !rows.has(c.id));
    if (missing.length > 0) {
      return { ok: false, detail: `the newest snapshot (${when}) lacks ${missing.length} photo(s): ${wait}` };
    }
    return { ok: true, detail: `the newest snapshot (${when}) holds ${rows.size} photo(s)` };
  });
  return out;
}
