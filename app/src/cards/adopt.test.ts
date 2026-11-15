// Adding back a card cardd has no record of,
// against the simulated card and a fake cardd.
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { cardId } from '../boltcard/cardkeys';
import { CarddError } from '../cardd/client';
import { TagLostError } from '../ntag424/apdu';
import { urlHost } from '../ntag424/ndef';
import { cardsToRepoint } from '../onboarding/serverPage';
import { cardAt, cardWorld } from '../testing/cardWorld';
import { adoptCard, ADOPT_STEPS, type AdoptStep } from './adopt';
import { CardFlowError } from './deps';
import { identify } from './identify';
import { readCard } from './read';
import { repointCard } from './repoint';

const UID = hexToBytes('04a39493cc8680');

/** A card set up at `version` for the old server, which this one (after a phrase-only rebuild) has never heard of. */
async function unknownCard(version: number) {
  const t = await cardWorld();
  t.use(cardAt(t.deps.issuer, version, { host: 'vm-9.lnvps.cloud' }));
  return { ...t, id: bytesToHex(cardId(t.deps.issuer, UID)) };
}

describe('adoptCard', () => {
  it.each([0, 2])('adds back a card at version %i from its tap, then re-points it and sets its host', async (version) => {
    const t = await unknownCard(version);
    const tapped = (await readCard(t.tap().card)).sun!;
    const steps: AdoptStep[] = [];
    const info = await adoptCard(t.tap().card, t.deps, { name: 'Daily', onStep: (s) => steps.push(s) });
    expect(steps).toEqual(ADOPT_STEPS);
    expect(info).toMatchObject({ id: t.id, version, state: 'active', name: 'Daily', host: 'vm-1.lnvps.cloud' });
    expect(t.cardd.cards.get(t.id)).toMatchObject({ version, state: 'active', host: 'vm-1.lnvps.cloud' });
    expect(urlHost((await readCard(t.tap().card)).url!)).toBe('vm-1.lnvps.cloud');
    expect(await t.cache.cards()).toEqual({ [t.id]: { id: t.id, version, name: 'Daily', state: 'active' } });
    expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'ours', version, needsRepoint: false });
    // cardd adopted it with no host: the re-point's check passed before its host was set.
    const calls = t.cardd.http.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(calls.indexOf('POST /api/v1/cards/adopt')).toBeLessThan(calls.lastIndexOf('POST /api/v1/cards/check'));
    expect(calls.lastIndexOf('POST /api/v1/cards/check')).toBeLessThan(calls.indexOf(`PUT /api/v1/cards/${t.id}/host`));
    // cardd took the adopting tap's counter, so a tap read before it can't be replayed.
    await expect(t.deps.cardd.checkCard(tapped)).rejects.toMatchObject({ code: 'replayed' });
  });

  it('sends cardd the version, the name and the tap, never the UID', async () => {
    const t = await unknownCard(1);
    await adoptCard(t.tap().card, t.deps, { name: 'Kids' });
    const sent = t.cardd.http.requests.find((r) => r.url.endsWith('/api/v1/cards/adopt'))!;
    expect(Object.keys(JSON.parse(sent.body!))).toEqual(['version', 'name', 'p', 'c']);
    expect(JSON.parse(sent.body!)).toMatchObject({ version: 1, name: 'Kids' });
    expect(sent.body).not.toContain(bytesToHex(UID));
  });

  it('refuses a card this server already knows', async () => {
    const t = await unknownCard(0);
    t.use(cardAt(t.deps.issuer, 0));
    t.cardd.cards.set(t.id, { id: t.id, version: 0, state: 'active', counter: 0, name: 'Daily', host: 'vm-1.lnvps.cloud', created: 0, updated: 0 });
    await expect(adoptCard(t.tap().card, t.deps, { name: 'Daily' })).rejects.toEqual(new CardFlowError('This server already knows this card.'));
    expect(t.cardd.http.requests.some((r) => r.url.endsWith('/adopt'))).toBe(false);
  });

  it.each([
    ['bad_mac', "This card's version couldn't be found, so it can't be added back."],
    ['conflict', 'This server already knows this card.'],
    ['not_ours', "This card belongs to another service, so it can't be added back."],
  ])("says what cardd's %s refusal means", async (code, text) => {
    const t = await unknownCard(0);
    const held = Object.assign(Object.create(t.deps.held), {
      adoptCard: () => Promise.reject(new CarddError(code === 'conflict' ? 409 : 422, code, 'refused')),
    });
    await expect(adoptCard(t.tap().card, { ...t.deps, held }, { name: 'Daily' })).rejects.toEqual(new CardFlowError(text));
    expect(t.sim.log.some((c) => /WriteData|ChangeFileSettings/.test(c))).toBe(false);
  });

  it("needs the server: it can't add back a card while cardd can't be reached", async () => {
    const t = await unknownCard(0);
    t.w.carddDown = true;
    await expect(adoptCard(t.tap().card, t.deps, { name: 'Daily' })).rejects.toEqual(new CardFlowError("Can't reach your server. Adding a card back needs it."));
  });

  it('refuses a card whose keys are part-way through a wipe', async () => {
    const t = await unknownCard(0);
    t.use(cardAt(t.deps.issuer, 0, { versions: [1, 0, 0, 1, 1], host: 'vm-9.lnvps.cloud' }));
    await expect(adoptCard(t.tap().card, t.deps, { name: 'Daily' })).rejects.toEqual(
      new CardFlowError('This card is part-way through a wipe, so it can only be wiped: then add it again.'),
    );
    expect(t.cardd.cards.size).toBe(0);
  });

  describe('a hold lost after cardd adopted the card', () => {
    // The card leaves the field at the re-point's first write, after the adopt.
    async function lifted() {
      const t = await unknownCard(1);
      const base = await unknownCard(1);
      await adoptCard(base.tap().card, base.deps, { name: 'Daily' });
      t.sim.lift = { at: base.sim.log.indexOf('WriteData'), when: 'before' };
      await expect(adoptCard(t.tap().card, t.deps, { name: 'Daily' })).rejects.toBeInstanceOf(TagLostError);
      // Adopted with no host: the server page lists it to re-point until a re-point's check sets it.
      expect(t.cardd.cards.get(t.id)).toMatchObject({ state: 'active', host: '' });
      expect(cardsToRepoint([...t.cardd.cards.values()], t.deps.host).map((c) => c.id)).toEqual([t.id]);
      return t;
    }

    it('is offered a re-point, which finishes it', async () => {
      const t = await lifted();
      expect(await identify(t.tap().card, t.deps)).toMatchObject({ kind: 'ours', version: 1, needsRepoint: true });
      expect(await repointCard(t.tap().card, t.deps)).toMatchObject({ id: t.id, state: 'active', host: 'vm-1.lnvps.cloud' });
      expect((await identify(t.tap().card, t.deps)).needsRepoint).toBe(false);
      expect(cardsToRepoint([...t.cardd.cards.values()], t.deps.host)).toEqual([]);
    });

    it('finishes when the card is held again on the same screen', async () => {
      const t = await lifted();
      expect(await adoptCard(t.tap().card, t.deps, { name: 'Daily' })).toMatchObject({ id: t.id, state: 'active', host: 'vm-1.lnvps.cloud' });
      expect(urlHost((await readCard(t.tap().card)).url!)).toBe('vm-1.lnvps.cloud');
      expect(t.cardd.http.requests.filter((r) => r.url.endsWith('/adopt'))).toHaveLength(1);
    });
  });
});
