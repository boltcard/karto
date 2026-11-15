// The wallet's read of a tag that is not an NTAG 424: a
// phone that is a card, another chip, or no Bolt Card at all.
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { cardId, deriveCardKeys, k1For } from '../boltcard/cardkeys';
import { buildSun } from '../boltcard/sun';
import type { CardState } from '../cardd/client';
import { TagLostError } from '../ntag424/apdu';
import { Ntag424 } from '../ntag424/card';
import { lnurlwFor, ndefFile, sunOfUrl } from '../ntag424/ndef';
import { phoneCardId, phoneCardUid } from '../phoneCard/id';
import { tapFiles } from '../phoneCard/taps';
import { cardWorld } from '../testing/cardWorld';
import { PhoneCardTag } from '../testing/phoneCardTag';
import { addCard } from './add';
import { adoptCard } from './adopt';
import { checkTap } from './check';
import { CardFlowError } from './deps';
import { identify, NOT_A_CARD, PLAIN_REFUSAL } from './identify';
import { repointCard } from './repoint';
import { wipeCard } from './wipe';

const HOST = 'vm-1.lnvps.cloud';
const FIRST = 400_000;
const fileOf = (url: string) => bytesToHex(ndefFile(url).file);

async function setup() {
  const t = await cardWorld();
  const phone = new PhoneCardTag();
  const id = phoneCardId(t.deps.issuer, 0);
  const register = (state: CardState, o: { id?: string; version?: number } = {}) =>
    t.cardd.cards.set(o.id ?? id, { id: o.id ?? id, version: o.version ?? 0, state, counter: FIRST - 1, name: 'Pixel 8 Pro', created: 0, updated: 0 });
  /** This wallet's phone's card, numbered 0, with taps to give. */
  const load = (o: { issuer?: Uint8Array; version?: number } = {}) =>
    phone.load(tapFiles({ issuer: o.issuer ?? t.deps.issuer, n: 0, version: o.version ?? 0, lnurlw: lnurlwFor(HOST) }, FIRST, 4));
  return { ...t, phone, id, register, load, card: () => new Ntag424(phone.transceive) };
}
/** Nothing but selects and reads reached the tag. */
const onlyRead = (seen: string[]) => seen.every((c) => /^00(a4|b0)/.test(c) || c.startsWith('90'));

describe("a Bolt Card's link", () => {
  it('gives its p and c, for lnurlw and https, whatever else the link carries', () => {
    const p = 'A'.repeat(32);
    const c = 'b'.repeat(16);
    expect(sunOfUrl(`lnurlw://${HOST}/ln?p=${p}&c=${c}`)).toEqual({ p, c });
    expect(sunOfUrl(`https://${HOST}/ln?x=1&c=${c}&p=${p}#frag`)).toEqual({ p, c });
    expect(sunOfUrl(`LNURLW://${HOST}/ln?p=${p}&c=${c}`)).toEqual({ p, c });
  });

  it('is nothing else: no link, another scheme, a p or c that is missing, short or not hex', () => {
    const p = 'a'.repeat(32);
    const c = 'b'.repeat(16);
    for (const url of [null, '', 'https://example.com/', `http://${HOST}/ln?p=${p}&c=${c}`, `lnurlp://${HOST}/ln?p=${p}&c=${c}`, `lnurlw://${HOST}/ln?p=${p}`,
      `lnurlw://${HOST}/ln?p=${p.slice(1)}&c=${c}`, `lnurlw://${HOST}/ln?p=${p}&c=${'z'.repeat(16)}`, `lnurlw:///ln?p=${p}&c=${c}`]) {
      expect(sunOfUrl(url), String(url)).toBeNull();
    }
  });
});

describe('identify, for a tag that is not an NTAG 424', () => {
  it("calls this wallet's phone's card ours when the server lists it active or frozen: no read, its tap, and nothing to re-point", async () => {
    for (const state of ['active', 'frozen'] as const) {
      const t = await setup();
      t.register(state);
      t.load();
      const i = await identify(t.card(), t.deps);
      expect(i).toMatchObject({ kind: 'ours', plain: true, read: null, id: t.id, version: 0, serverDown: false, needsRepoint: false, known: { state, name: 'Pixel 8 Pro' } });
      expect(bytesToHex(i.uid!)).toBe(bytesToHex(phoneCardUid(t.deps.issuer, 0)));
      expect(i.sun).toEqual({ p: expect.stringMatching(/^[0-9A-F]{32}$/), c: expect.stringMatching(/^[0-9A-F]{16}$/) });
      // The NTAG 424's question, refused; then the plain read. One tap is used.
      expect(t.phone.seen).toEqual(['00a4040007d276000085010100', '90640000010000', '00a4040007d276000085010100', '00a4000002e10400', '00b0000002', expect.stringMatching(/^00b00002/)]);
      expect(t.phone.given).toBe(1);
    }
  });

  it("calls it one of the person's the server doesn't list so, for a card the server never heard of, is setting up, or has removed", async () => {
    for (const state of [null, 'programming', 'wiping', 'reset'] as const) {
      const t = await setup();
      if (state) t.register(state);
      t.load();
      expect(await identify(t.card(), t.deps), String(state)).toMatchObject({ kind: 'unknown-ours', plain: true, read: null, id: t.id, version: 0, needsRepoint: false });
    }
  });

  it('finds the key version by trying c, as for a plastic card', async () => {
    const t = await setup();
    t.register('active', { version: 0 });
    t.load({ version: 2 });
    expect(await identify(t.card(), t.deps)).toMatchObject({ kind: 'ours', plain: true, version: 2 });
  });

  it("calls another wallet's phone's card a card from another service", async () => {
    const t = await setup();
    t.load({ issuer: hexToBytes('00000000000000000000000000000002') });
    const i = await identify(t.card(), t.deps);
    expect(i).toEqual({ kind: 'foreign', plain: true, read: null, serverDown: false, needsRepoint: false });
  });

  it('calls a link foreign when its p opens under this K1 but its c does not verify', async () => {
    const t = await setup();
    const uid = phoneCardUid(t.deps.issuer, 0);
    const { p } = buildSun(k1For(t.deps.issuer), new Uint8Array(16), uid, FIRST, new Uint8Array(5));
    t.register('active');
    t.phone.load([fileOf(`lnurlw://${HOST}/ln?p=${p}&c=${'0'.repeat(16)}`)]);
    expect(await identify(t.card(), t.deps)).toMatchObject({ kind: 'foreign', plain: true });
  });

  it("calls a chip of the person's that refuses the NTAG 424's questions ours too, by its link: its ID does not begin 00", async () => {
    const t = await setup();
    const uid = hexToBytes('04a39493cc8680');
    const id = bytesToHex(cardId(t.deps.issuer, uid));
    const k = deriveCardKeys(t.deps.issuer, uid, 1);
    const { p, c } = buildSun(k.k1, k.k2, uid, 7, new Uint8Array(5));
    t.register('active', { id, version: 1 });
    t.phone.load([fileOf(`lnurlw://${HOST}/ln?p=${p}&c=${c}`)]);
    const i = await identify(t.card(), t.deps);
    expect(i).toMatchObject({ kind: 'ours', plain: true, id, version: 1 });
    expect(i.uid![0]).toBe(0x04);
  });

  it('says a tag is not a Bolt Card when it carries no such link, nothing, or refuses the read', async () => {
    const none = { kind: 'not-a-card', plain: true, read: null, serverDown: false, needsRepoint: false };
    const t = await setup();
    t.phone.load([fileOf('https://example.com/?p=&c=')]);
    expect(await identify(t.card(), t.deps)).toEqual(none);
    t.phone.load(['0000']);
    expect(await identify(t.card(), t.deps)).toEqual(none);
    // No NDEF application at all: a bus pass, a bank card.
    expect(await identify(new Ntag424(async () => hexToBytes('6a82')), t.deps)).toEqual(none);
    // The application, but the file refused.
    expect(await identify(new Ntag424(async (apdu) => hexToBytes(apdu[1] === 0xa4 && apdu[2] === 0x04 ? '9000' : '6a82')), t.deps)).toEqual(none);
  });

  it('does not read an NTAG 424 that answers its first questions and then refuses as a plain tag: it is as it was before', async () => {
    const t = await setup();
    t.register('active');
    t.load();
    const sent: string[] = [];
    // Key versions answered (all changed), the file's settings refused.
    const chip = new Ntag424(async (apdu) => {
      sent.push(bytesToHex(apdu));
      if (apdu[0] === 0x90 && apdu[1] === 0x64) return hexToBytes('019100');
      if (apdu[0] === 0x90) return hexToBytes('919d');
      return t.phone.transceive(apdu);
    });
    expect(await identify(chip, t.deps)).toEqual({ kind: 'foreign', read: null, serverDown: false, needsRepoint: false });
    // No plain read followed: the phone's tap was not used.
    expect(sent.filter((c) => c.startsWith('00b0'))).toEqual([]);
    expect(t.phone.given).toBe(0);
  });

  it("uses what the phone remembers when the server can't be reached, and says so", async () => {
    const t = await setup();
    await t.cache.saveCard({ id: t.id, version: 0, name: 'Pixel 8 Pro', state: 'active' });
    t.w.carddDown = true;
    t.load();
    expect(await identify(t.card(), t.deps)).toMatchObject({ kind: 'ours', plain: true, serverDown: true, known: { state: 'active' } });
  });

  it('lets a tag that moved away during the plain read fail as one that moved away', async () => {
    const t = await setup();
    t.load();
    let n = 0;
    const lifted = new Ntag424(async (apdu) => {
      if (++n > 3) throw new TagLostError();
      return t.phone.transceive(apdu);
    });
    await expect(identify(lifted, t.deps)).rejects.toBeInstanceOf(TagLostError);
  });
});

describe('a plain tag and the card jobs', () => {
  it("has its tap checked by the server as any card's is", async () => {
    const t = await setup();
    t.register('active');
    t.load();
    const i = await identify(t.card(), t.deps);
    expect(await checkTap(i, t.deps)).toMatchObject({ ok: true, card: { id: t.id, counter: FIRST } });
    // The same tap again is used up.
    expect(await checkTap(i, t.deps)).toMatchObject({ ok: false });
  });

  it('is refused by add, wipe, re-point and add back, whatever it is, with nothing written to it', async () => {
    for (const state of ['active', null] as const) {
      const t = await setup();
      if (state) t.register(state);
      t.load();
      const jobs = [
        () => addCard(t.card(), new Uint8Array(7), t.deps, { name: 'X', randomUid: true }),
        () => wipeCard(t.card(), t.deps),
        () => wipeCard(t.card(), t.deps, { only: { id: t.id, name: 'Pixel 8 Pro' } }),
        () => repointCard(t.card(), t.deps),
        () => adoptCard(t.card(), t.deps, { name: 'X' }),
      ];
      for (const job of jobs) {
        t.phone.load(tapFiles({ issuer: t.deps.issuer, n: 0, version: 0, lnurlw: lnurlwFor(HOST) }, FIRST, 1));
        const e = await job().catch((x) => x);
        expect(e).toBeInstanceOf(CardFlowError);
        expect((e as Error).message).toBe(PLAIN_REFUSAL);
      }
      expect(onlyRead(t.phone.seen)).toBe(true);
      expect([...t.cardd.cards.values()].map((c) => c.state)).toEqual(state ? [state] : []);
    }
  });

  it('refuses a tag that is no Bolt Card in its own words', async () => {
    const t = await setup();
    const bus = () => new Ntag424(async () => hexToBytes('6a82'));
    for (const job of [() => addCard(bus(), new Uint8Array(7), t.deps, { name: 'X', randomUid: true }), () => wipeCard(bus(), t.deps), () => repointCard(bus(), t.deps), () => adoptCard(bus(), t.deps, { name: 'X' })]) {
      const e = await job().catch((x) => x);
      expect(e).toBeInstanceOf(CardFlowError);
      expect((e as Error).message).toBe(NOT_A_CARD);
    }
  });
});
