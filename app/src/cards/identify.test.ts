// What a tapped card is, read from the card itself.
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { cardId, deriveCardKeys } from '../boltcard/cardkeys';
import { Ntag424 } from '../ntag424/card';
import { cardUrl, lnurlwFor } from '../ntag424/ndef';
import { cardAt, cardWorld } from '../testing/cardWorld';
import { Ntag424Sim } from '../testing/ntag424Sim';
import { classify, identify, versionSearch } from './identify';
import { readCard } from './read';
import { decryptPicc, parseSun } from '../boltcard/sun';

const WRITES = /ChangeKey|ChangeFileSettings|SetConfiguration|WriteData|UpdateBinary/;
const UID = hexToBytes('04a39493cc8680');

async function setup() {
  const t = await cardWorld();
  const id = bytesToHex(cardId(t.deps.issuer, UID));
  const register = (state: 'programming' | 'active' | 'frozen' | 'wiping' | 'reset', version = 0) =>
    t.cardd.cards.set(id, { id, version, state, counter: -1, name: 'Daily', created: 0, updated: 0 });
  return { ...t, id, register };
}

describe('classify: the resume table', () => {
  const cases: [number[], boolean, Parameters<typeof classify>[2], string][] = [
    [[0, 0, 0, 0, 0], false, null, 'blank'],
    [[0, 0, 0, 0, 0], false, 'programming', 'blank'],
    [[0, 0, 0, 0, 0], false, 'reset', 'blank'],
    [[0, 0, 0, 0, 0], true, 'programming', 'half-added'],
    [[0, 1, 1, 0, 0], true, 'programming', 'half-added'],
    [[1, 1, 1, 1, 1], true, 'programming', 'half-added'],
    [[1, 1, 1, 1, 1], true, 'active', 'ours'],
    [[1, 1, 1, 1, 1], true, 'frozen', 'ours'],
    [[1, 1, 1, 1, 1], true, 'wiping', 'half-wiped'],
    [[1, 0, 0, 1, 1], true, 'wiping', 'half-wiped'],
    [[0, 0, 0, 0, 0], true, 'wiping', 'half-wiped'],
    [[0, 0, 0, 0, 0], false, 'wiping', 'half-wiped'],
    [[0, 0, 0, 0, 0], false, 'active', 'half-wiped'],
    [[1, 1, 1, 1, 1], true, null, 'unknown-ours'],
  ];
  it.each(cases)('K versions %j, SUN %s, cardd %s → %s', (versions, sdm, state, kind) => {
    expect(classify(versions, sdm, state)).toBe(kind);
  });
});

describe('identify', () => {
  it('calls a blank card blank, from the zero K0 and GetCardUID, and writes nothing', async () => {
    const t = await setup();
    const i = await identify(t.tap().card, t.deps);
    expect(i).toMatchObject({ kind: 'blank', id: t.id, serverDown: false, needsRepoint: false });
    expect(bytesToHex(i.uid!)).toBe('04a39493cc8680');
    expect(t.sim.log.some((c) => WRITES.test(c))).toBe(false);
  });

  it('calls one of the person\'s cards ours, with its version, and needs no re-point on this server', async () => {
    const t = await setup();
    t.use(cardAt(t.deps.issuer, 2));
    t.register('active', 2);
    expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'ours', id: t.id, version: 2, needsRepoint: false, known: { name: 'Daily' } });
  });

  it('offers a re-point for a card that points at another server', async () => {
    const t = await setup();
    t.use(cardAt(t.deps.issuer, 0, { host: 'vm-9.lnvps.cloud' }));
    t.register('active');
    expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'ours', needsRepoint: true });
  });

  it('offers a re-point for a card cardd records at another server, though its URL is this one\'s', async () => {
    const t = await setup();
    t.use(cardAt(t.deps.issuer, 0));
    t.register('active');
    t.cardd.cards.get(t.id)!.host = 'vm-9.lnvps.cloud';
    expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'ours', needsRepoint: true, known: { host: 'vm-9.lnvps.cloud' } });
    t.cardd.cards.get(t.id)!.host = 'vm-1.lnvps.cloud';
    expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'ours', needsRepoint: false });
  });

  it('calls a card with someone else\'s keys foreign, writing nothing', async () => {
    const t = await setup();
    const K = (b: number) => new Uint8Array(16).fill(b);
    t.use(Ntag424Sim.programmed({ keys: [K(9), K(8), K(7), K(6), K(5)], versions: [1, 1, 1, 1, 1], url: cardUrl(lnurlwFor('example.com')) }));
    expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'foreign' });
    expect(t.sim.log.some((c) => WRITES.test(c))).toBe(false);
  });

  // p under our K1 decrypts to C7 by chance once in 256 cards: c must verify as well.
  it('calls a card foreign when p decrypts but c does not verify', async () => {
    const t = await setup();
    const k = deriveCardKeys(t.deps.issuer, UID, 0);
    t.use(Ntag424Sim.programmed({ keys: [k.k0, k.k1, new Uint8Array(16).fill(7), k.k3, k.k4], versions: [1, 1, 1, 1, 1], url: cardUrl(lnurlwFor('vm-1.lnvps.cloud')) }));
    t.register('active');
    expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'foreign' });
  });

  // Until the phone's card this said "foreign", and the sheet
  // "A card from another service", for a tag that is no Bolt Card at all. cards/plain.test.ts has the rest.
  it('says a tag without the NDEF application is not a Bolt Card', async () => {
    const t = await setup();
    const notOurs = new Ntag424(async () => hexToBytes('6a82'));
    expect(await identify(notOurs, t.deps)).toMatchObject({ kind: 'not-a-card', read: null, plain: true });
  });

  it('calls a card half-added while K1–K4 are changing, from the zero K0', async () => {
    const t = await setup();
    t.use(cardAt(t.deps.issuer, 0, { versions: [0, 1, 1, 0, 0] }));
    t.register('programming');
    expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'half-added', version: 0 });
  });

  it('calls a card half-wiped once K1 is back to zero: p decrypts under the zero K1', async () => {
    const t = await setup();
    t.use(cardAt(t.deps.issuer, 0, { versions: [1, 0, 0, 1, 1] }));
    t.register('wiping');
    expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'half-wiped', version: 0 });
  });

  it('finds the version by trying c when cardd has never heard of the card', async () => {
    const t = await setup();
    t.use(cardAt(t.deps.issuer, 3));
    expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'unknown-ours', version: 3 });
  });

  it('uses the phone\'s cache when cardd can\'t be reached', async () => {
    const t = await setup();
    t.use(cardAt(t.deps.issuer, 1));
    await t.cache.saveCard({ id: t.id, version: 1, name: 'Daily', state: 'active' });
    t.w.carddDown = true;
    expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'ours', version: 1, serverDown: true, known: { state: 'active' } });
  });

  it('reads key versions, settings and the URL without any key', async () => {
    const t = await setup();
    t.use(cardAt(t.deps.issuer, 0));
    const r = await readCard(t.tap().card);
    expect(r).toMatchObject({ versions: [1, 1, 1, 1, 1], settings: { sdm: true, piccOffset: 38, macOffset: 73 } });
    expect(r.url).toMatch(/^lnurlw:\/\/vm-1\.lnvps\.cloud\/ln\?p=[0-9A-F]{32}&c=[0-9A-F]{16}$/);
    expect(t.sim.log.some((c) => /Authenticate/.test(c))).toBe(false);
  });

  it('versionSearch returns null past 31', async () => {
    const t = await setup();
    const sim = cardAt(t.deps.issuer, 40);
    const r = await readCard(new Ntag424(sim.transceive));
    const parsed = parseSun(r.sun!.p, r.sun!.c)!;
    const picc = decryptPicc(deriveCardKeys(t.deps.issuer, UID, 40).k1, parsed.p)!;
    expect(versionSearch(t.deps.issuer, UID, picc, parsed.c)).toBeNull();
  });

  // With K0 still zero, changed K1–K4 must prove themselves through p and c.
  it('calls a zero-K0 card with someone else\'s K1–K4 foreign, with SUN on or off, writing nothing', async () => {
    const t = await setup();
    const keys = [new Uint8Array(16), ...[8, 7, 6, 5].map((n) => new Uint8Array(16).fill(n))];
    const sunOn = Ntag424Sim.programmed({ uid: UID, keys, versions: [0, 1, 1, 1, 1], url: cardUrl(lnurlwFor('example.com')) });
    const sunOff = new Ntag424Sim(UID);
    sunOff.keys = keys.map((k) => k.slice());
    sunOff.versions = [0, 1, 1, 1, 1];
    for (const sim of [sunOn, sunOff]) {
      t.use(sim);
      expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'foreign' });
      expect(sim.log.join(' ')).not.toMatch(WRITES);
    }
  });

  // The version a half-added card's keys were written at comes from c, not from cardd.
  it('takes a half-added card\'s version from c when cardd gives another', async () => {
    const t = await setup();
    t.use(cardAt(t.deps.issuer, 1, { versions: [0, 1, 1, 1, 1] }));
    t.register('programming', 0);
    expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'half-added', version: 1 });
  });
});
