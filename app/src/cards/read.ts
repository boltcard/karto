// One tap's reading of a card, needing no key: the key versions, file 2's
// settings, and the NDEF file with p and c mirrored in. Every card flow starts here.
import type { Sun } from '../cardd/client';
import type { FileSettings, Ntag424 } from '../ntag424/card';
import { readSun, urlOf } from '../ntag424/ndef';

export type CardRead = {
  /** Key versions 0–4: 0 is still the zero key, 1 has been changed. */
  versions: number[];
  settings: FileSettings;
  /** The NDEF file, NLEN first: the offsets in settings index it. */
  file: Uint8Array;
  /** This read's p and c, when SUN is on. */
  sun: Sun | null;
  url: string | null;
};

export async function readCard(card: Ntag424): Promise<CardRead> {
  await card.selectApp();
  const versions: number[] = [];
  for (let k = 0; k < 5; k++) versions.push(await card.getKeyVersion(k));
  const settings = await card.getFileSettings();
  // Far enough to reach p and c where the settings put them, even past a shorter URL.
  const reach = settings.sdm ? Math.max((settings.piccOffset ?? 0) + 32, (settings.macOffset ?? 0) + 16) : 0;
  const file = await card.readNdefFile(reach);
  return { versions, settings, file, sun: readSun(file, settings), url: urlOf(file) };
}
