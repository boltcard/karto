import { describe, expect, it } from 'vitest';
import type { Wallet, WalletCard } from '../cardd/client';
import { cardColour } from './colours';
import { stackOrder, stripTag, type Row } from './stack';

const HOST = 'vm-1001.lnvps.cloud';
const row = (id: string, o: Partial<Row> = {}): Row => ({ id, name: id, state: 'active', version: 1, host: HOST, created: 1_790_000_000, ...o });
const account = (balanceMsat: number, heldMsat = 0) => ({ balanceMsat, heldMsat, address: 'x@vm-1001.lnvps.cloud' });
const walletCard = (id: string, balanceMsat: number, heldMsat = 0): WalletCard => ({
  id, name: id, state: 'active', version: 1, ...account(balanceMsat, heldMsat), spent24hMsat: 0, perTapSat: 20_000, dailySat: 50_000,
});
const wallet = (cards: WalletCard[]): Wallet => ({
  cards, pool: account(0), hosting: account(0), paused: false, pausedReason: '', liquidity: null, restore: null,
});
const ids = (cards: Row[]) => stackOrder(cards, null, HOST).map((e) => e.id);

// The first card added at the back, the newest in front.
describe('stackOrder', () => {
  it('stacks the cards in the order they were added, back first', () => {
    expect(ids([row('c', { created: 30 }), row('a', { created: 10 }), row('b', { created: 20 })])).toEqual(['a', 'b', 'c']);
  });

  it('orders cards added in the same second by id', () => {
    expect(ids([row('b', { created: 10 }), row('a', { created: 10 }), row('c', { created: 5 })])).toEqual(['c', 'a', 'b']);
  });

  // The phone's cache, while the server can't be reached, knows no created.
  it('puts cards without created after the others, in name order, then by id', () => {
    const cached = (id: string, name: string): Row => ({ id, name, state: 'active', version: 1 });
    expect(ids([cached('x', 'Travel'), row('a', { created: 10 }), cached('z', 'Daily'), cached('y', 'Daily')])).toEqual(['a', 'y', 'z', 'x']);
  });

  it('leaves out wiped cards', () => {
    expect(ids([row('a'), row('b', { state: 'reset' })])).toEqual(['a']);
  });

  it('shows nothing for no cards', () => {
    expect(stackOrder([], null, HOST)).toEqual([]);
    expect(stackOrder([], wallet([]), HOST)).toEqual([]);
  });

  it('gives the cards different colours', () => {
    const same: string[] = [];
    for (let i = 0; same.length < 2; i++) if (cardColour(`c${i}`) === cardColour('c0')) same.push(`c${i}`);
    const [a, b] = stackOrder([row(same[0], { created: 1 }), row(same[1], { created: 2 })], null, HOST);
    expect(a.colour).toBe(cardColour(same[0]));
    expect(b.colour).not.toBe(a.colour);
  });

  it('labels each state, with a part-way card offering to finish', () => {
    const states = ['active', 'frozen', 'programming', 'wiping'] as const;
    const stack = stackOrder(states.map((state, i) => row(state, { state, created: i })), null, HOST);
    expect(stack.map((e) => [e.state, e.label, e.partWay])).toEqual([
      ['active', 'Active', null],
      ['frozen', 'Frozen', null],
      ['programming', 'Finish setup', 'add'],
      ['wiping', 'Finish wipe', 'wipe'],
    ]);
  });

  it('gives each card its name, colour, version and counter', () => {
    const [e] = stackOrder([row('7f3a9c01', { name: 'Daily', version: 2, counter: 14 })], null, HOST);
    expect(e).toEqual({
      id: '7f3a9c01', name: 'Daily', colour: cardColour('7f3a9c01'), state: 'active', label: 'Active', partWay: null,
      repoint: false, check: false, availableMsat: null, version: 2, counter: 14, phone: null,
    });
    expect(stackOrder([row('a', { name: '' })], null, HOST)[0].name).toBe('Unnamed card');
  });

  // A phone's card is a card in the sleeve, marked as a phone's.
  describe("a phone's card", () => {
    const phones = { ids: new Set(['mine', 'theirs']), own: 'mine' };
    const of = (o: Partial<Row>, id = 'mine') => stackOrder([row(id, o)], null, HOST, phones)[0];

    it("is marked as this phone's own or another's, and a plastic card as neither", () => {
      const stack = stackOrder([row('a', { created: 1 }), row('mine', { created: 2 }), row('theirs', { created: 3 })], null, HOST, phones);
      expect(stack.map((e) => e.phone)).toEqual([null, 'own', 'other']);
      expect(stackOrder([row('mine')], null, HOST)[0].phone).toBeNull();
    });

    it('part-way through being set up or removed, opens no hold-the-card screen: the wallet finishes it', () => {
      expect([of({ state: 'programming' }).label, of({ state: 'programming' }).partWay]).toEqual(['Being set up', null]);
      expect([of({ state: 'wiping' }, 'theirs').label, of({ state: 'wiping' }, 'theirs').partWay]).toEqual(['Being removed', null]);
      expect(stripTag(of({ state: 'programming' }))).toEqual({ text: 'Being set up', tone: 'plain' });
      expect(stripTag(of({ state: 'wiping' }))).toEqual({ text: 'Being removed', tone: 'plain' });
      expect(stripTag(of({ state: 'frozen' }))).toEqual({ text: 'Frozen', tone: 'plain' });
      expect(stripTag(of({}))).toBeNull();
    });

    it('is never one to re-point, though the server records it at another host', () => {
      expect(of({ host: 'vm-1012.lnvps.cloud' }).repoint).toBe(false);
      expect(stripTag(of({ host: 'vm-1012.lnvps.cloud' }))).toBeNull();
      // The plastic card beside it still is.
      expect(stackOrder([row('a', { host: 'vm-1012.lnvps.cloud' }), row('mine')], null, HOST, phones).find((e) => e.id === 'a')!.repoint).toBe(true);
    });
  });

  // As cardsToRepoint decides: a cardd from before hosts says nothing, and '' is another server.
  it('marks the cards whose URL points at another server', () => {
    const stack = stackOrder(
      [row('a', { created: 1 }), row('b', { created: 2, host: 'vm-1012.lnvps.cloud' }), row('c', { created: 3, host: undefined }), row('d', { created: 4, host: '' })],
      null,
      HOST,
    );
    expect(stack.map((e) => e.repoint)).toEqual([false, true, false, true]);
  });

  // A restore leaves each card needing its owner's check: its strip says to hold it to the phone, unless it is
  // to be re-pointed, which checks it.
  it('marks the cards a restore left needing a check', () => {
    const stack = stackOrder(
      [row('a', { created: 1, needsCheck: true }), row('b', { created: 2, needsCheck: true, host: 'vm-1012.lnvps.cloud' }), row('c', { created: 3 }),
        row('d', { created: 4, needsCheck: true, state: 'frozen' })],
      null,
      HOST,
    );
    expect(stack.map((e) => e.check)).toEqual([true, false, false, true]);
    expect(stack.map(stripTag)).toEqual([
      { text: 'hold to phone', tone: 'warn' },
      { text: 're-point', tone: 'warn' },
      null,
      { text: 'hold to phone', tone: 'warn' },
    ]);
    // A phone's card is checked by the wallet itself.
    const phones = { ids: new Set(['a']), own: 'a' };
    expect(stackOrder([row('a', { needsCheck: true })], null, HOST, phones)[0].check).toBe(false);
  });

  it("shows each card's available balance from the wallet, null where the wallet doesn't list it", () => {
    const stack = stackOrder([row('a', { created: 1 }), row('b', { created: 2 })], wallet([walletCard('a', 25_000_000, 4_000_500)]), HOST);
    expect(stack.map((e) => e.availableMsat)).toEqual([20_999_500, null]);
    expect(stackOrder([row('a')], null, HOST)[0].availableMsat).toBeNull();
  });
});

// Every card is a strip, its state a small tag.
describe('stripTag', () => {
  const tagOf = (o: Partial<Row>) => stripTag(stackOrder([row('a', o)], null, HOST)[0]);
  // A card whose URL points at another server.
  const away = { host: 'vm-1012.lnvps.cloud' };

  it('has no tag for a plain active card', () => {
    expect(tagOf({})).toBeNull();
  });

  it('tags a part-way card with what finishes it, in the amber style', () => {
    expect(tagOf({ state: 'programming' })).toEqual({ text: 'Finish setup', tone: 'warn' });
    expect(tagOf({ state: 'wiping' })).toEqual({ text: 'Finish wipe', tone: 'warn' });
  });

  it('tags a card to re-point, in the amber style', () => {
    expect(tagOf(away)).toEqual({ text: 're-point', tone: 'warn' });
  });

  it('tags a frozen card in the plain style', () => {
    expect(tagOf({ state: 'frozen' })).toEqual({ text: 'Frozen', tone: 'plain' });
  });

  it('puts a part-way card to re-point under its part-way tag, and a frozen one under re-point', () => {
    expect(tagOf({ state: 'programming', ...away })).toEqual({ text: 'Finish setup', tone: 'warn' });
    expect(tagOf({ state: 'frozen', ...away })).toEqual({ text: 're-point', tone: 'warn' });
  });
});
