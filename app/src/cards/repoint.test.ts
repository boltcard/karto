// Re-pointing a card at this server, and tap to check.
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { cardId } from '../boltcard/cardkeys';
import { TagLostError } from '../ntag424/apdu';
import { urlHost } from '../ntag424/ndef';
import { cardAt, cardWorld } from '../testing/cardWorld';
import { checkTap } from './check';
import { identify } from './identify';
import { readCard } from './read';
import { repointCard, REPOINT_STEPS, type RepointStep } from './repoint';

const UID = hexToBytes('04a39493cc8680');

/** A card whose URL points at host, which cardd records too (cardHost: what cardd says, if not host). */
async function onOtherServer(host: string, cardHost = host) {
  const t = await cardWorld();
  t.use(cardAt(t.deps.issuer, 0, { host }));
  const id = bytesToHex(cardId(t.deps.issuer, UID));
  t.cardd.cards.set(id, { id, version: 0, state: 'active', counter: 0, name: 'Daily', host: cardHost, created: 0, updated: 0 });
  return { ...t, id };
}

describe('repointCard', () => {
  it('writes this server\'s URL and new offsets, keeping the keys, and cardd accepts the next tap', async () => {
    const t = await onOtherServer('vm-9.lnvps.cloud');
    const keysBefore = t.sim.keys.map((k) => bytesToHex(k));
    const steps: RepointStep[] = [];
    expect(await repointCard(t.tap().card, t.deps, { onStep: (s) => steps.push(s) })).toMatchObject({ id: t.id, state: 'active' });
    expect(steps).toEqual(REPOINT_STEPS);
    expect(t.cardd.cards.get(t.id)!.host).toBe('vm-1.lnvps.cloud');
    const r = await readCard(t.tap().card);
    expect(urlHost(r.url!)).toBe('vm-1.lnvps.cloud');
    expect(t.sim.keys.map((k) => bytesToHex(k))).toEqual(keysBefore);
    expect((await identify(t.tap().card, t.deps)).needsRepoint).toBe(false);
  });

  // A restore leaves the card needing its owner's check before it can pay: the re-point's check is that check.
  it("clears a restore's need for a check", async () => {
    const t = await onOtherServer('vm-9.lnvps.cloud');
    t.cardd.cards.get(t.id)!.needsCheck = true;
    expect((await repointCard(t.tap().card, t.deps)).needsCheck).toBeUndefined();
    expect(t.cardd.cards.get(t.id)!.needsCheck).toBeUndefined();
  });

  // Cut between the URL and the offsets, from a longer host (old offsets reach past the new URL).
  it('finishes a re-point lifted between the URL and the offsets', async () => {
    const base = await onOtherServer('vm-10090.lnvps.cloud');
    await repointCard(base.tap().card, base.deps);
    const at = base.sim.log.indexOf('WriteData');
    const t = await onOtherServer('vm-10090.lnvps.cloud');
    t.sim.lift = { at, when: 'after' };
    await expect(repointCard(t.tap().card, t.deps)).rejects.toBeInstanceOf(TagLostError);
    const i = await identify(t.tap().card, t.deps);
    expect(i).toMatchObject({ kind: 'ours', needsRepoint: true });
    expect(await repointCard(t.tap().card, t.deps)).toMatchObject({ state: 'active' });
    expect((await identify(t.tap().card, t.deps)).needsRepoint).toBe(false);
  });

  // cardd's record of the host is what lists a card.
  it('sets the host of a card whose URL is already this server\'s, writing nothing to the card', async () => {
    const t = await onOtherServer('vm-1.lnvps.cloud', 'vm-9.lnvps.cloud');
    expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'ours', needsRepoint: true });
    expect(await repointCard(t.tap().card, t.deps)).toMatchObject({ id: t.id, host: 'vm-1.lnvps.cloud' });
    expect(t.sim.log.some((c) => /WriteData|ChangeFileSettings/.test(c))).toBe(false);
    expect(t.cardd.cards.get(t.id)!.host).toBe('vm-1.lnvps.cloud');
    expect((await identify(t.tap().card, t.deps)).needsRepoint).toBe(false);
  });

  it('sets no host until the check passes', async () => {
    const t = await onOtherServer('vm-9.lnvps.cloud');
    t.cardd.cards.get(t.id)!.counter = 1_000; // cardd has seen a later tap: the check refuses this one
    await expect(repointCard(t.tap().card, t.deps)).rejects.toMatchObject({ code: 'replayed' });
    expect(t.cardd.cards.get(t.id)!.host).toBe('vm-9.lnvps.cloud');
    expect(t.cardd.http.requests.some((r) => r.url.endsWith('/host'))).toBe(false);
  });
});

describe('checkTap', () => {
  it('checks one of the person\'s cards with cardd, and says why a tap fails', async () => {
    const t = await onOtherServer('vm-1.lnvps.cloud');
    const first = await identify(t.tap().card, t.deps);
    expect(await checkTap(first, t.deps)).toMatchObject({ ok: true, card: { id: t.id } });
    expect(await checkTap(first, t.deps)).toEqual({ ok: false, reason: 'This tap was seen before: the card may have been copied.' });
    t.w.carddDown = true;
    const offline = await identify(t.tap().card, t.deps);
    expect(await checkTap(offline, t.deps)).toEqual({ ok: false, reason: "Can't reach your server to check this tap." });
  });

  // A card held to the phone after a restore onto the same server (nothing to re-point): the tap check is the
  // owner's check the server waits for, and the card can pay again.
  it("clears a restore's need for a check", async () => {
    const t = await onOtherServer('vm-1.lnvps.cloud');
    t.cardd.cards.get(t.id)!.needsCheck = true;
    const i = await identify(t.tap().card, t.deps);
    expect(i.needsRepoint).toBe(false);
    const check = await checkTap(i, t.deps);
    expect(check.ok && check.card.needsCheck).toBeFalsy();
    expect(t.cardd.cards.get(t.id)!.needsCheck).toBeUndefined();
  });
});
