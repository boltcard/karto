// Cards at the till. Karto PoS holds the NFC slot's base claim whenever it is in
// front, as Karto Wallet does, and closes every tap unread: so a card touched to the till on any screen never
// reaches Android's own handling, which this project has seen open another wallet over the app. The sale screen
// claims over it and is the one place a card is read: only its link, with no key.
import type { NfcSlot } from '../cards/nfcSlot';
import type { Tag } from '../native/nfc';
import { TagLostError } from '../ntag424/apdu';
import { Ntag424 } from '../ntag424/card';
import { urlOf } from '../ntag424/ndef';
import { cardLink } from './charge';

/** The till's claim for the app's life: every tap is closed unread, without Android's tag sound. Returns its release. */
export const claimBase = (slot: Pick<NfcSlot, 'claimBase'>): (() => void) => slot.claimBase((tag) => void tag.close(), false);

/** The sale screen's claim, over the base, while it is in front. Returns its release. */
export const claimSale = (slot: Pick<NfcSlot, 'claim'>, onTag: (tag: Tag) => void): (() => void) => slot.claim(onTag);

/** What a card held to the sale read as: a Bolt Card's link with this tap in it, no such card, or one lifted too soon. */
export type Tap = { kind: 'link'; link: string } | { kind: 'not-a-card' } | { kind: 'moved-away' };

/**
 * Reads a tapped card's link and lets the card go. It reads the NDEF file and nothing else:
 * four commands, none of them an NTAG 424's own, so it reads any
 * service's Bolt Card, whatever answers it: an NTAG 424, another chip, a phone.
 */
export async function readTap(tag: Tag): Promise<Tap> {
  try {
    if (!tag.transceive) return { kind: 'not-a-card' };
    const url = urlOf(await new Ntag424(tag.transceive).readNdefFile());
    return url && cardLink(url) ? { kind: 'link', link: url } : { kind: 'not-a-card' };
  } catch (e) {
    return e instanceof TagLostError ? { kind: 'moved-away' } : { kind: 'not-a-card' };
  } finally {
    await tag.close().catch(() => undefined);
  }
}
