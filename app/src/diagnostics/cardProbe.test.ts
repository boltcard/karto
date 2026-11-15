import { describe, expect, it } from 'vitest';
import { cardUrl, lnurlwFor } from '../ntag424/ndef';
import { Ntag424Sim } from '../testing/ntag424Sim';
import { probeCard } from './cardProbe';

const WRITES = /ChangeKey|ChangeFileSettings|SetConfiguration|WriteData|UpdateBinary/;

describe('probeCard', () => {
  it('passes every check on a blank card, and writes nothing', async () => {
    const sim = new Ntag424Sim();
    const r = await probeCard(sim.transceive, sim.tagId());
    expect(r.filter((x) => !x.ok)).toEqual([]);
    expect(r.map((x) => x.name)).toEqual(['tag', 'select', 'get-version', 'key-versions', 'file-settings', 'ndef', 'auth-zero', 'card-uid', 'plain-in-session']);
    expect(sim.log.some((c) => WRITES.test(c))).toBe(false);
  });

  it('says a card that isn\'t blank is not blank, still without writing', async () => {
    const K = (b: number) => new Uint8Array(16).fill(b);
    const sim = Ntag424Sim.programmed({ keys: [K(9), K(8), K(7), K(6), K(5)], versions: [1, 1, 1, 1, 1], url: cardUrl(lnurlwFor('example.com')) });
    const r = await probeCard(sim.transceive, sim.tagId());
    expect(r.find((x) => x.name === 'key-versions')).toMatchObject({ ok: true, detail: 'without authentication: 1 1 1 1 1' });
    expect(r.find((x) => x.name === 'auth-zero')).toMatchObject({ ok: false });
    expect(sim.log.some((c) => WRITES.test(c))).toBe(false);
  });

  it('never prints the card\'s UID', async () => {
    const sim = new Ntag424Sim();
    const r = await probeCard(sim.transceive, sim.tagId());
    expect(JSON.stringify(r)).not.toMatch(/04a39493cc8680/i);
  });
});
