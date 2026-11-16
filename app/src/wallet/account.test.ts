import { describe, expect, it } from 'vitest';
import { accountButtons, accountId, fixedName } from './account';

const labels = (bs: { label: string }[]) => bs.map((b) => b.label);
const offs = (bs: { label: string; off: boolean }[]) => bs.filter((b) => b.off).map((b) => b.label);
const CARD = { kind: 'card', state: 'active' } as const;
const FROZEN = { kind: 'card', state: 'frozen' } as const;

// The pill buttons for a card, pool and hosting.
describe('accountButtons', () => {
  it('gives a card Top up, Move and Freeze; a frozen one Unfreeze; More is the band\'s ⋯', () => {
    expect(labels(accountButtons(CARD, false))).toEqual(['Top up', 'Move', 'Freeze']);
    expect(labels(accountButtons(FROZEN, false))).toEqual(['Top up', 'Move', 'Unfreeze']);
  });

  // This phone's own card has Pay as its main pill, before Top up.
  it("gives this phone's own card Pay, its main button, while it can pay or be unfrozen to; and no other card", () => {
    const own = accountButtons({ ...CARD, ownPhone: true }, false);
    expect(labels(own)).toEqual(['Pay', 'Top up', 'Move', 'Freeze']);
    expect(own.filter((b) => b.main).map((b) => b.action)).toEqual(['pay']);
    expect(labels(accountButtons({ ...FROZEN, ownPhone: true }, false))).toEqual(['Pay', 'Top up', 'Move', 'Unfreeze']);
    expect(labels(accountButtons({ kind: 'card', state: 'programming', ownPhone: true }, false))).toEqual(['Top up', 'Move']);
    expect(labels(accountButtons({ ...CARD, ownPhone: false }, false))).toEqual(['Top up', 'Move', 'Freeze']);
    // Paying needs only the till to reach the server: Pay stays on while this phone can't.
    expect(offs(accountButtons({ ...CARD, ownPhone: true }, true))).toEqual(['Move', 'Freeze']);
    // With NFC off the phone can't be a card: Pay is off here as Pay with this phone is on the Wallet page.
    expect(offs(accountButtons({ ...CARD, ownPhone: true, nfcOff: true }, false))).toEqual(['Pay']);
    expect(offs(accountButtons({ ...CARD, ownPhone: true, nfcOff: false }, false))).toEqual([]);
  });

  it('gives a card being added or wiped no Freeze: cardd refuses it', () => {
    expect(labels(accountButtons({ kind: 'card', state: 'programming' }, false))).toEqual(['Top up', 'Move']);
    expect(labels(accountButtons({ kind: 'card', state: 'wiping' }, false))).toEqual(['Top up', 'Move']);
  });

  it('gives pool Top up, Move and Send out, and hosting Top up, Move, Pay LNVPS and Renew now', () => {
    expect(labels(accountButtons({ kind: 'pool' }, false))).toEqual(['Top up', 'Move', 'Send out']);
    expect(labels(accountButtons({ kind: 'hosting' }, false))).toEqual(['Top up', 'Move', 'Pay LNVPS', 'Renew now']);
  });

  it('turns Move, Send out, Freeze or Unfreeze and Renew now off while cardd can not be reached; Top up and Pay LNVPS stay', () => {
    expect(offs(accountButtons(CARD, true))).toEqual(['Move', 'Freeze']);
    expect(offs(accountButtons(FROZEN, true))).toEqual(['Move', 'Unfreeze']);
    expect(offs(accountButtons({ kind: 'pool' }, true))).toEqual(['Move', 'Send out']);
    expect(offs(accountButtons({ kind: 'hosting' }, true))).toEqual(['Move', 'Renew now']);
    for (const a of [CARD, { kind: 'pool' }, { kind: 'hosting' }] as const) {
      expect(offs(accountButtons(a, false))).toEqual([]);
    }
  });

  // Shop is paid by its sales alone.
  it('gives Shop Move, its main button, and PoS phones: no Top up; Move is off while cardd can not be reached', () => {
    expect(accountButtons({ kind: 'shop' }, false).map((b) => [b.action, b.label, b.icon, b.main, b.off])).toEqual([
      ['move', 'Move', 'move', true, false],
      ['pos-phones', 'PoS phones', 'phone', false, false],
    ]);
    expect(offs(accountButtons({ kind: 'shop' }, true))).toEqual(['Move']);
  });

  it('makes Top up the main button, and carries an icon and an action for each', () => {
    const all = [...accountButtons(CARD, false), ...accountButtons(FROZEN, false), ...accountButtons({ kind: 'pool' }, false), ...accountButtons({ kind: 'hosting' }, false)];
    expect(new Set(all.map((b) => b.action))).toEqual(new Set(['top-up', 'move', 'freeze', 'unfreeze', 'send', 'pay-lnvps', 'renew']));
    expect(new Set(all.map((b) => b.icon))).toEqual(new Set(['topup', 'move', 'freeze', 'unfreeze', 'send', 'pay', 'renew']));
    expect(all.filter((b) => b.main).map((b) => b.action)).toEqual(['top-up', 'top-up', 'top-up', 'top-up']);
  });
});

// The account a karto:// link names, and the three that aren't cards.
describe('accountId and fixedName', () => {
  it('takes pool, hosting, shop and a card id, and nothing else', () => {
    for (const id of ['pool', 'hosting', 'shop', '0123456789abcdef0123456789abcdef']) expect(accountId(id)).toBe(id);
    for (const id of [undefined, '', 'Pool', 'shop/', '0123', 'world']) expect(accountId(id)).toBe('');
  });

  it('names Pool, Hosting and Shop; a card has its own name', () => {
    expect(['pool', 'hosting', 'shop'].map(fixedName)).toEqual(['Pool', 'Hosting', 'Shop']);
    expect(fixedName('0123456789abcdef0123456789abcdef')).toBeNull();
  });
});
