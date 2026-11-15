// Each card's photo on the phone:
// cardd keeps the thumbnails; the phone keeps a copy of each in AppStore,
// which the faces draw from, brought up to date by each card list cardd
// answers.
import { CarddError, type CardInfo, type CarddClient } from '../cardd/client';
import type { AppStore } from '../store/store';

export type PhotoCache = Pick<AppStore, 'photos' | 'savePhoto' | 'dropPhoto'>;

/** The data: URI an <Image> draws a cached photo (base64 JPEG) from. */
export const photoUri = (jpeg: string) => `data:image/jpeg;base64,${jpeg}`;

/**
 * Brings the cache to a list cardd answered (never the phone's own cache of
 * cards): each photo whose tag differs is fetched, one at a time, and kept;
 * a photo the card no longer has, or whose card the list no longer has, is
 * dropped. A card whose entry has no photo field (an older cardd, without
 * card photos) is left alone. A fetch that fails keeps the old photo, for the next
 * list to try again; a 404 means cardd has none now. onPhoto hears each
 * change, as a data: URI or null.
 */
export async function syncPhotos(
  list: CardInfo[],
  cardd: Pick<CarddClient, 'cardPhoto'>,
  cache: PhotoCache,
  onPhoto: (id: string, uri: string | null) => void,
): Promise<void> {
  const cached = await cache.photos();
  const drop = async (id: string) => {
    await cache.dropPhoto(id);
    onPhoto(id, null);
  };
  for (const card of list) {
    const tag = card.photo;
    if (tag === undefined || cached[card.id]?.tag === tag) continue;
    if (tag === '') {
      if (cached[card.id]) await drop(card.id);
      continue;
    }
    try {
      const { jpeg, photo } = await cardd.cardPhoto(card.id);
      await cache.savePhoto(card.id, { tag: photo, jpeg });
      onPhoto(card.id, photoUri(jpeg));
    } catch (e) {
      if (e instanceof CarddError && e.status === 404 && e.code === 'not_found') await drop(card.id);
    }
  }
  const listed = new Set(list.map((c) => c.id));
  for (const id of Object.keys(cached)) if (!listed.has(id)) await drop(id);
}
