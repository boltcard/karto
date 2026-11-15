import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { deriveCardKeys } from '../boltcard/cardkeys';
import { holdTaps, NfcSlot } from '../cards/nfcSlot';
import type { Nfc, Tag } from '../native/nfc';
import { TagLostError } from '../ntag424/apdu';
import { cardUrl, lnurlwFor, ndefFile } from '../ntag424/ndef';
import { tapFiles, tapUrls } from '../phoneCard/taps';
import { Ntag424Sim } from '../testing/ntag424Sim';
import { PhoneCardTag } from '../testing/phoneCardTag';
import { vectors } from '../testing/vectors';
import { claimBase, claimSale, readTap } from './nfc';

function fakeNfc() {
  let emit: ((t: Tag) => void) | undefined;
  const calls: string[] = [];
  const quiets: boolean[] = [];
  const nfc: Nfc = {
    mode: 'always', session: null, state: async () => 'on', openSettings: async () => {},
    start: async () => void calls.push('start'), stop: async () => void calls.push('stop'), quiet: (on) => void quiets.push(on),
    onTag: (fn) => ((emit = fn), { remove: () => void (emit = undefined) }),
  };
  const closed: number[] = [];
  const tag = (n: number): Tag => ({ uid: Uint8Array.of(n), transceive: null, close: async () => void closed.push(n) });
  return { nfc, calls, quiets, closed, tap: (n: number) => emit?.(tag(n)) };
}

const UID = hexToBytes('04a39493cc8680');
/** A Bolt Card of some server, as a tap of it reads. */
function boltCard(host = 'vm-1.lnvps.cloud') {
  const k = deriveCardKeys(hexToBytes(vectors.phrase.issuerKey), UID, 1);
  return Ntag424Sim.programmed({ keys: [k.k0, k.k1, k.k2, k.k3, k.k4], versions: [1, 1, 1, 1, 1], url: cardUrl(lnurlwFor(host)), uid: UID });
}
const tagOf = (transceive: Tag['transceive']) => {
  const t = { uid: UID, transceive, closed: 0, close: async () => void t.closed++ };
  return t;
};

// Karto PoS holds the NFC slot's base claim whenever it is in front and closes every
// tap unread; the sale screen claims over it and is the one place a card is read.
describe("the till's two claims", () => {
  it('closes a tap unread on every screen but the sale: reader mode is on, so Android opens nothing over the till', () => {
    const f = fakeNfc();
    const release = claimBase(new NfcSlot(f.nfc));
    expect(f.calls).toEqual(['start']);
    f.tap(1);
    f.tap(2);
    expect(f.closed).toEqual([1, 2]);
    release();
    expect(f.calls).toEqual(['start', 'stop']);
  });

  // A page that opens over the sale screen (Paid for an earlier sale, Removed) holds the taps: the sale screen
  // underneath would charge a card held then, and say Paid where nobody could see it.
  it('closes a tap unread while a page is over the sale screen, and gives the sale its taps again after', () => {
    const f = fakeNfc();
    const slot = new NfcSlot(f.nfc);
    claimBase(slot);
    const held: number[] = [];
    claimSale(slot, (t) => held.push(t.uid[0]));
    const release = holdTaps(slot);
    f.tap(1);
    expect([held, f.closed]).toEqual([[], [1]]);
    release();
    f.tap(2);
    expect([held, f.closed]).toEqual([[2], [1]]);
  });

  // Android's tag sound: a card the till closes unread makes none, a card the sale reads still beeps as it is taken.
  it("silences Android's tag sound on every screen but the sale", () => {
    const f = fakeNfc();
    const slot = new NfcSlot(f.nfc);
    claimBase(slot);
    expect(f.quiets).toEqual([true]);
    const release = claimSale(slot, () => {});
    expect(f.quiets).toEqual([true, false]);
    const hold = holdTaps(slot);
    hold();
    release();
    expect(f.quiets).toEqual([true, false, true, false, true]);
  });

  it('gives the sale screen the taps while it is in front, and the base again after', () => {
    const f = fakeNfc();
    const slot = new NfcSlot(f.nfc);
    claimBase(slot);
    const held: number[] = [];
    const release = claimSale(slot, (t) => held.push(t.uid[0]));
    f.tap(1);
    expect([held, f.closed]).toEqual([[1], []]);
    release();
    f.tap(2);
    expect([held, f.closed]).toEqual([[1], [2]]);
    // Reader mode stayed on throughout: the base holds it.
    expect(f.calls).toEqual(['start']);
  });
});

describe('readTap', () => {
  it("reads a Bolt Card's link, with this tap's p and c, and lets the card go", async () => {
    const tag = tagOf(boltCard().transceive);
    const tap = await readTap(tag);
    expect(tap).toEqual({ kind: 'link', link: expect.stringMatching(/^lnurlw:\/\/vm-1\.lnvps\.cloud\/ln\?p=[0-9A-F]{32}&c=[0-9A-F]{16}$/i) });
    expect(tag.closed).toBe(1);
  });

  // The till reads only the link, so it takes any Bolt Card that
  // gives a proper one, whatever answers it.
  it('reads an NTAG 424 in four commands, asking for no key version and no settings', async () => {
    const sim = boltCard();
    const sent: string[] = [];
    const tag = tagOf(async (apdu) => (sent.push(bytesToHex(apdu)), sim.transceive(apdu)));
    expect((await readTap(tag)).kind).toBe('link');
    expect(sent).toEqual(['00a4040007d276000085010100', '00a4000002e10400', '00b0000002', expect.stringMatching(/^00b00002[0-9a-f]{2}$/)]);
  });

  it("reads a phone's card, which is no NTAG 424: its link, and at the next tap the next one", async () => {
    const phone = new PhoneCardTag();
    const card = { issuer: hexToBytes(vectors.phrase.issuerKey), n: 0, version: 0, lnurlw: lnurlwFor('vm-1.lnvps.cloud') };
    const fixed = () => hexToBytes('0102030405');
    const urls = tapUrls(card, 500, 2, fixed);
    phone.load(tapFiles(card, 500, 2, fixed));
    expect(await readTap(tagOf(phone.transceive))).toEqual({ kind: 'link', link: urls[0] });
    expect(phone.seen).toHaveLength(4);
    phone.deactivated();
    expect(await readTap(tagOf(phone.transceive))).toEqual({ kind: 'link', link: urls[1] });
    // With no tap left to give, it reads as no card.
    phone.deactivated();
    expect(await readTap(tagOf(phone.transceive))).toEqual({ kind: 'not-a-card' });
  });

  it("says a tag that carries some other link is no card that can pay", async () => {
    const page = new PhoneCardTag();
    page.load([bytesToHex(ndefFile('https://example.com/?p=&c=').file)]);
    expect(await readTap(tagOf(page.transceive))).toEqual({ kind: 'not-a-card' });
  });

  it("says a tag isn't a card when the phone can't talk to it, or it isn't a Bolt Card's chip", async () => {
    expect(await readTap(tagOf(null))).toEqual({ kind: 'not-a-card' });
    const other = tagOf(async () => Uint8Array.of(0x6a, 0x82));
    expect(await readTap(other)).toEqual({ kind: 'not-a-card' });
    expect(other.closed).toBe(1);
  });

  it('says a blank card is no card that can pay', async () => {
    expect(await readTap(tagOf(new Ntag424Sim().transceive))).toEqual({ kind: 'not-a-card' });
  });

  it('says the card moved away when it left before it was read', async () => {
    const sim = boltCard();
    let n = 0;
    const lifted = tagOf(async (apdu) => {
      if (++n > 3) throw new TagLostError();
      return sim.transceive(apdu);
    });
    expect(await readTap(lifted)).toEqual({ kind: 'moved-away' });
    expect(lifted.closed).toBe(1);
  });
});
