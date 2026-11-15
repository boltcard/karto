// The simulator, driven through the real client: what a blank card does, and
// what a card set up for SUN returns on a tap.
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { decryptPicc, parseSun, verifySun } from '../boltcard/sun';
import { CardError, TagLostError } from '../ntag424/apdu';
import { Ntag424 } from '../ntag424/card';
import { ZERO_KEY } from '../ntag424/crypto';
import { cardUrl, EMPTY_NDEF, FACTORY_FILE_SETTINGS, lnurlwFor, ndefFile, readSun, sunFileSettings } from '../ntag424/ndef';
import { Ntag424Sim } from './ntag424Sim';

const K = (b: number) => new Uint8Array(16).fill(b);
const URL = cardUrl(lnurlwFor('vm-1009.lnvps.cloud'));

describe('Ntag424Sim', () => {
  it('starts blank: key versions 00, no SUN, the zero key opens it and reports the UID', async () => {
    const sim = new Ntag424Sim();
    const c = new Ntag424(sim.transceive);
    await c.selectApp();
    for (let k = 0; k < 5; k++) expect(await c.getKeyVersion(k)).toBe(0);
    expect(await c.getFileSettings()).toEqual({ sdm: false });
    expect(bytesToHex(await c.readNdefFile())).toBe('0000');
    await c.authenticate(0, ZERO_KEY);
    expect(bytesToHex(await c.getCardUid())).toBe('04a39493cc8680');
    expect(await c.getKeyVersion(2)).toBe(0); // MAC mode inside the session
  });

  it('refuses a wrong key with 91AE and ends the session', async () => {
    const c = new Ntag424(new Ntag424Sim().transceive);
    await expect(c.authenticate(0, K(1))).rejects.toMatchObject({ sw: 0x91ae });
    await expect(c.getCardUid()).rejects.toThrow('needs an authenticated session');
  });

  it('is set up the bolt-card way and then mirrors a fresh, valid p and c on every read', async () => {
    const sim = new Ntag424Sim();
    const c = new Ntag424(sim.transceive);
    const n = ndefFile(URL);
    await c.authenticate(0, ZERO_KEY);
    await c.writeNdef(n.file);
    await c.changeFileSettings(sunFileSettings(n.piccOffset, n.macOffset));
    for (let k = 1; k <= 4; k++) await c.changeKey(k, ZERO_KEY, K(k), 1);
    await c.changeKey(0, ZERO_KEY, K(0xa0), 1);
    expect(sim.versions).toEqual([1, 1, 1, 1, 1]);
    expect(sim.log.slice(-5)).toEqual(['ChangeKey 1', 'ChangeKey 2', 'ChangeKey 3', 'ChangeKey 4', 'ChangeKey 0']);

    const settings = await c.getFileSettings();
    expect(settings).toEqual({ sdm: true, piccOffset: 41, macOffset: 76 });
    const first = readSun(await c.readNdefFile(), settings)!;
    const second = readSun(await c.readNdefFile(), settings)!;
    const picc = (s: { p: string; c: string }) => decryptPicc(K(1), parseSun(s.p, s.c)!.p)!;
    expect(bytesToHex(picc(first).uid)).toBe('04a39493cc8680');
    expect(picc(second).counter).toBeGreaterThan(picc(first).counter);
    expect(verifySun(K(2), picc(second), parseSun(second.p, second.c)!.c)).toBe(true);

    // Write is now key 0's: refused without it, fine with it; the old key no longer opens the card.
    await expect(c.writeNdef(EMPTY_NDEF)).rejects.toMatchObject({ sw: 0x919d });
    await expect(c.authenticate(0, ZERO_KEY)).rejects.toMatchObject({ sw: 0x91ae });
    await c.authenticate(0, K(0xa0));
    await c.changeFileSettings(FACTORY_FILE_SETTINGS);
    expect(await c.getFileSettings()).toEqual({ sdm: false });
  });

  it('turns random UID on: the tag id becomes 4 random bytes starting 08, GetCardUID still gives the real one', async () => {
    const sim = new Ntag424Sim();
    expect(sim.tagId().length).toBe(7);
    const c = new Ntag424(sim.transceive);
    await c.authenticate(0, ZERO_KEY);
    await c.enableRandomUid();
    expect(sim.tagId().length).toBe(4);
    expect(sim.tagId()[0]).toBe(0x08);
    expect(bytesToHex(await c.getCardUid())).toBe('04a39493cc8680');
  });

  it('drops the connection before a command (not applied) or after it (applied, answer lost)', async () => {
    for (const when of ['before', 'after'] as const) {
      const sim = new Ntag424Sim();
      const c = new Ntag424(sim.transceive);
      await c.authenticate(0, ZERO_KEY); // commands 0, 1, 2
      sim.lift = { at: 3, when };
      await expect(c.changeKey(1, ZERO_KEY, K(1), 1)).rejects.toBeInstanceOf(TagLostError);
      expect(sim.versions[1]).toBe(when === 'after' ? 1 : 0);
      // A new tap: the session is gone.
      await expect(new Ntag424(sim.transceive).getCardUid()).rejects.toThrow('needs an authenticated session');
      await new Ntag424(sim.transceive).authenticate(0, ZERO_KEY);
    }
  });

  it('refuses GetCardUID without a session, and a command it doesn\'t know', async () => {
    const sim = new Ntag424Sim();
    await sim.transceive(hexToBytes('00a4040007d276000085010100'));
    expect(bytesToHex(await sim.transceive(hexToBytes('9051000008000000000000000000')))).toBe('919d');
    expect(bytesToHex(await sim.transceive(hexToBytes('90ee000000')))).toBe('911c');
    expect(bytesToHex(await sim.transceive(hexToBytes('00a4040007d276000085010200')))).toBe('6a82');
  });

  it('can be made already programmed, for identify tests', async () => {
    const sim = Ntag424Sim.programmed({ keys: [K(9), K(8), K(7), K(6), K(5)], versions: [1, 1, 1, 1, 1], url: URL });
    const c = new Ntag424(sim.transceive);
    const sun = readSun(await c.readNdefFile(), await c.getFileSettings())!;
    expect(decryptPicc(K(8), parseSun(sun.p, sun.c)!.p)).not.toBeNull();
    expect(sim.snapshot()).toBe(Ntag424Sim.programmed({ keys: [K(9), K(8), K(7), K(6), K(5)], versions: [1, 1, 1, 1, 1], url: URL }).snapshot());
  });

  it('counts errors as CardError with the card\'s status', async () => {
    const c = new Ntag424(new Ntag424Sim().transceive);
    const e = await c.getKeyVersion(7).catch((x) => x);
    expect(e).toBeInstanceOf(CardError);
    expect(e.sw).toBe(0x9140);
  });
});
