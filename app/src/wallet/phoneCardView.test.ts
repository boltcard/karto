import { hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { CarddError } from '../cardd/client';
import { CounterSpent, phoneCardId } from '../phoneCard/id';
import { RecordUnreadable } from '../phoneCard/record';
import { AlreadyACard } from '../phoneCard/setup';
import { vectors } from '../testing/vectors';
import {
  asksWhatToAdd, canSetUp, cantWords, overWords, paidWords, payButton, phoneCardError, phoneMoreRows, phonesAmong, readWords, readyWords, removedNotice, SET_UP,
  setUpDone, WHAT_TO_ADD,
} from './phoneCardView';

const issuer = hexToBytes(vectors.phrase.issuerKey);
const id = (n: number) => phoneCardId(issuer, n);
const plastic = 'f'.repeat(32);

// What the screens say, and when.
describe("which cards are phones' cards", () => {
  it("finds them among the server's, past a gap too, and this phone's own by its record", () => {
    const cards = [{ id: plastic }, { id: id(0) }, { id: id(2) }];
    const found = phonesAmong(issuer, cards, { n: 2 });
    expect([...found.ids].sort()).toEqual([id(0), id(2)].sort());
    expect(found.own).toBe(id(2));
    expect(phonesAmong(issuer, cards, null).own).toBeNull();
    // This phone's own is named though the server does not list it yet.
    expect(phonesAmong(issuer, [], { n: 1 })).toEqual({ ids: new Set(), own: id(1) });
  });
});

describe('the Wallet page\'s button', () => {
  const own = { id: id(0), name: 'Pixel 8 Pro', state: 'active' as const };
  const on = { supported: true, revoked: false, removing: false, nfc: 'on' as const, own };

  it("is there while this phone's card is listed active or frozen, and pays with that card", () => {
    expect(payButton(on)).toEqual({ card: own, off: false, line: null });
    expect(payButton({ ...on, own: { ...own, state: 'frozen' } })).toEqual({ card: { ...own, state: 'frozen' }, off: false, line: null });
    // While NFC's state is not yet known it is not said to be off.
    expect(payButton({ ...on, nfc: null })).toEqual({ card: own, off: false, line: null });
  });

  it('is not there on a phone that is no card, whose card is being set up or removed, or that the server has unpaired', () => {
    expect(payButton({ ...on, own: undefined })).toBeNull();
    expect(payButton({ ...on, supported: false })).toBeNull();
    expect(payButton({ ...on, removing: true })).toBeNull();
    expect(payButton({ ...on, revoked: true })).toBeNull();
    for (const state of ['programming', 'wiping', 'reset'] as const) expect(payButton({ ...on, own: { ...own, state } }), state).toBeNull();
  });

  it('is off, and says why, while NFC is off', () => {
    expect(payButton({ ...on, nfc: 'off' })).toEqual({ card: own, off: true, line: 'NFC is off. Turn it on to pay with this phone.' });
  });
});

describe('Add card', () => {
  it('first asks what is being added only where this phone can be a card and is not one', () => {
    expect(asksWhatToAdd({ supported: true, hasRecord: false })).toBe(true);
    expect(asksWhatToAdd({ supported: true, hasRecord: true })).toBe(false);
    expect(asksWhatToAdd({ supported: false, hasRecord: false })).toBe(false);
  });
});

describe('setting this phone up', () => {
  it('asks a plastic card or this phone, and says once what a phone as a card is', () => {
    expect(WHAT_TO_ADD).toEqual({
      lead: 'What are you adding?',
      card: { name: 'A Bolt Card', line: 'A plastic card you hold to this phone' },
      phone: { name: 'This phone', line: 'Pay by holding the phone to a till' },
    });
    expect(SET_UP.lines).toEqual([
      'Tills that take Bolt Cards will read this phone as one. It gets its own balance and limits, like your other cards.',
      'It answers a till only while Pay is open, after your screen lock.',
    ]);
    expect([SET_UP.title, SET_UP.button]).toEqual(['This phone as a card', 'Set up']);
  });

  it('can be pressed with a name of one line of at most 40 characters, and not while it runs', () => {
    expect(canSetUp('Pixel 8 Pro', false)).toBe(true);
    expect(canSetUp('  Pixel 8 Pro  ', false)).toBe(true);
    expect(canSetUp('x'.repeat(40), false)).toBe(true);
    for (const name of ['', '   ', 'x'.repeat(41), 'two\nlines']) expect(canSetUp(name, false), JSON.stringify(name)).toBe(false);
    expect(canSetUp('Pixel 8 Pro', true)).toBe(false);
  });

  it('says it is a card with no money yet, and offers to move some onto it', () => {
    expect(setUpDone('Pixel 8 Pro')).toEqual({ title: 'Pixel 8 Pro is a card', line: 'It has no money yet. Move some onto it to pay with this phone.', move: 'Move money onto it' });
  });

  it('says why a set-up or a removal stopped', () => {
    expect(phoneCardError(new AlreadyACard())).toBe('This phone is already a card.');
    expect(phoneCardError(new CounterSpent())).toBe("This phone's card has used up its counter. Check the phone's date.");
    expect(phoneCardError(new RecordUnreadable())).toBe("This phone couldn't read what it keeps of its card. Unlock the phone and try again.");
    expect(phoneCardError(new TypeError('fetch failed: no answer from vm-1.lnvps.cloud in 30 s'))).toBe("Can't reach your server. This needs it.");
    expect(phoneCardError(new CarddError(409, 'conflict', 'store: conflicting state: a payment is in progress on this card'))).toBe(
      'Your server refused: store: conflicting state: a payment is in progress on this card',
    );
    expect(phoneCardError(new Error('boom'))).toBe('boom');
  });
});

describe('the pay screen', () => {
  const card = { name: 'Pixel 8 Pro', availableMsat: 6_000_400, perTapSat: 20_000 };

  it('ready: says to hold the phone to the till, how long is left, what is available, and that the till sets the amount', () => {
    expect(readyWords({ at: 'ready', left: 52, server: true }, card)).toEqual({
      lead: 'Hold the back of this phone to the till', wait: 'Ready · 0:52 left', label: 'Pixel 8 Pro · available', amount: '6,000 sat',
      small: 'The till sets the amount. Up to 20,000 sat a payment.', warning: null,
    });
    expect(readyWords({ at: 'ready', left: 60, server: true }, card).wait).toBe('Ready · 1:00 left');
    expect(readyWords({ at: 'ready', left: 5, server: true }, card).wait).toBe('Ready · 0:05 left');
  });

  it('ready: leaves out what it does not know', () => {
    const w = readyWords({ at: 'ready', left: 52, server: true }, { name: 'Pixel 8 Pro', availableMsat: null, perTapSat: null });
    expect([w.amount, w.small]).toEqual([null, 'The till sets the amount.']);
  });

  it("ready, without the server: says the till can still take a payment, in the small line's place", () => {
    const w = readyWords({ at: 'ready', left: 47, server: false }, card);
    expect(w.warning).toBe("Your server can't be reached from this phone. The till can still take a payment.");
    expect(w.small).toBeNull();
  });

  it('read: says so, that the phone can be taken away, and what it is waiting for', () => {
    expect(readWords({ at: 'read', left: 40, server: true })).toEqual({ title: 'Read by the till', lines: ['You can take the phone away.', 'Asking your server what was paid…'] });
    expect(readWords({ at: 'read', left: null, server: true })).toEqual({ title: 'Read by the till', lines: ['This phone has stopped being a card.', 'Asking your server what was paid…'] });
    expect(readWords({ at: 'read', left: 40, server: false })).toEqual({ title: 'Read by the till', lines: ['You can take the phone away.', "This screen can't reach your server: look at the till, and at this card's history later, to see what was paid."] });
  });

  it('paid: the amount, the fee if any, the card, and what is left when it is known', () => {
    expect(paidWords({ at: 'paid', amountMsat: 2_500_000, feeMsat: 12_000, leftMsat: 3_488_000 }, 'Pixel 8 Pro')).toEqual({ title: 'Paid', amount: '2,500 sat', lines: ['fee 12 sat', 'From Pixel 8 Pro', '3,488 sat left'] });
    expect(paidWords({ at: 'paid', amountMsat: 2_500_000, feeMsat: 0, leftMsat: null }, 'Pixel 8 Pro')).toEqual({ title: 'Paid', amount: '2,500 sat', lines: ['From Pixel 8 Pro'] });
    // A fee with a part of a sat is said as under the next whole sat, as the card's history says it.
    expect(paidWords({ at: 'paid', amountMsat: 21_000, feeMsat: 4_084, leftMsat: 274_916 }, 'Pixel 8 Pro').lines).toEqual(['fee under 5 sat', 'From Pixel 8 Pro', '275 sat left']);
    // The amount in the view: the nearest whole sat, or exactly in msat.
    expect(paidWords({ at: 'paid', amountMsat: 2_500_600, feeMsat: 1_500, leftMsat: 0 }, 'P').amount).toBe('2,501 sat');
    expect(paidWords({ at: 'paid', amountMsat: 2_500_600, feeMsat: 1_500, leftMsat: 0 }, 'P', 'msat', null)).toEqual({ title: 'Paid', amount: '2,500,600 msat', lines: ['fee 1,500 msat', 'From P', '0 msat left'] });
  });

  it('over: says nothing was taken only when it can tell, and never when it cannot', () => {
    expect(overWords({ at: 'over', read: false, server: true })).toEqual({ title: 'Nothing has been taken', lines: ['No till read this phone, and it has stopped being a card.'] });
    expect(overWords({ at: 'over', read: true, server: true })).toEqual({
      title: 'Nothing has been taken so far', lines: ['The till read this phone. If it still completes the payment, it will show in this card\'s history.'],
    });
    expect(overWords({ at: 'over', read: true, server: false })).toEqual({
      title: 'Read by the till', lines: ["This screen couldn't reach your server. Look at the till, and at this card's history later, to see what was paid."],
    });
    expect(overWords({ at: 'over', read: false, server: false })).toEqual({ title: 'This phone has stopped being a card', lines: ['No till read it.'] });
  });

  it("can't: says why, and what to do about it where there is something", () => {
    expect(cantWords('frozen', 'Pixel 8 Pro')).toEqual({ title: 'Pixel 8 Pro is frozen.', line: 'A till would be refused. Unfreeze the card to pay with this phone.', openCard: true });
    expect(cantWords('gone', 'Pixel 8 Pro')).toEqual({ title: "Pixel 8 Pro can't pay just now.", line: 'Your server no longer lists it as a card that can pay. The Wallet page shows how it stands.', openCard: false });
    expect(cantWords('no-record', 'Pixel 8 Pro')).toEqual({ title: "This phone isn't set up as a card.", line: 'Add it under + Add card on the Wallet page.', openCard: false });
    expect(cantWords('counter', 'Pixel 8 Pro')).toEqual({ title: "This phone's card has used up its counter.", line: "Check the phone's date.", openCard: false });
    expect(cantWords('refused', 'Pixel 8 Pro')).toEqual({ title: "This phone can't be a card just now.", line: "Android didn't give this app the reader. Another app set to answer payments may be keeping it.", openCard: false });
  });
});

describe('the More sheet for this phone\'s card', () => {
  const c = { state: 'active' as const, version: 0, perTapSat: 20_000, dailySat: 50_000, balanceMsat: 6_000_000, heldMsat: 0 };

  it('has Remove in the place of Wipe, with where the balance goes, and no photo', () => {
    expect(phoneMoreRows(c, true)).toEqual({
      limits: '20,000 per payment · 50,000 a day', remove: { line: 'Its 6,000 sat move to Pool; this phone stops being a card.', disabled: false }, foot: 'Active · this phone',
    });
    expect(phoneMoreRows({ ...c, balanceMsat: 999, state: 'frozen' }, true)).toMatchObject({ remove: { line: 'This phone stops being a card.', disabled: false }, foot: 'Frozen · this phone' });
  });

  it('has Remove off while a payment holds some of the balance, as Wipe is', () => {
    expect(phoneMoreRows({ ...c, heldMsat: 5 }, true).remove).toEqual({ line: 'Wait for the payment in progress', disabled: true });
  });

  it("offers no removal of another phone's card: the wallet removes that by itself", () => {
    expect(phoneMoreRows(c, false)).toEqual({ limits: '20,000 per payment · 50,000 a day', remove: null, foot: 'Active · a phone' });
  });
});

describe('the notice of a removed card', () => {
  it('says whose it was and where its money is, once for each', () => {
    expect(removedNotice([{ name: 'Pixel 8 Pro', amountMsat: 6_000_000 }], false)).toEqual({
      text: "Pixel 8 Pro's card was removed. It was the card of the phone this wallet was on before. Its 6,000 sat are in Pool.", add: null,
    });
  });

  it('leaves the money out when there was none, or the server would not say', () => {
    for (const amountMsat of [0, 999, null]) {
      expect(removedNotice([{ name: 'Pixel 8 Pro', amountMsat }], false)!.text).toBe("Pixel 8 Pro's card was removed. It was the card of the phone this wallet was on before.");
    }
  });

  it('says how to pay with this phone where it can be a card and is not one', () => {
    expect(removedNotice([{ name: 'Pixel 8 Pro', amountMsat: 0 }], true)!.add).toBe('To pay with this phone, add it under + Add card.');
  });

  it('says several in one notice', () => {
    expect(removedNotice([{ name: 'Pixel 8 Pro', amountMsat: 6_000_000 }, { name: 'Old phone', amountMsat: null }, { name: 'Tablet', amountMsat: 1_000 }], false)!.text).toBe(
      'The cards of 3 phones this wallet was on before were removed: Pixel 8 Pro, Old phone and Tablet. What they held is in Pool.',
    );
  });

  it('is nothing when nothing was removed', () => {
    expect(removedNotice([], true)).toBeNull();
  });
});

// The pay screen confirms money (in sat while ***, so the screen passes confirmView); a card limited in pounds
// says its limit in pounds; the More rows and the removed notice in the view.
describe("the phone's card in the app's view", () => {
  const GBP = { currency: 'GBP' as const, price: 61_352, time: 1_792_037_404 };
  const limits = { currency: 'GBP' as const, perTapMinor: 500, dailyMinor: 2000 };

  it("says what is available in the view, and a limit set in pounds in pounds", () => {
    const w = readyWords({ at: 'ready', left: 52, server: true }, { name: 'Pixel 8 Pro', availableMsat: 6_000_000, perTapSat: 8_150, limits }, 'fiat', GBP);
    expect([w.amount, w.small]).toEqual(['£3.68', 'The till sets the amount. Up to £5.00 a payment.']);
  });

  it('says a payment in the view', () => {
    expect(paidWords({ at: 'paid', amountMsat: 2_500_000, feeMsat: 4_412, leftMsat: 3_488_000 }, 'Pixel 8 Pro', 'fiat', GBP)).toEqual({
      title: 'Paid', amount: '£1.53', lines: ['fee under £0.01', 'From Pixel 8 Pro', '£2.14 left'],
    });
  });

  it("hides the limits in ***, keeps Remove's money in sat, and hides the removed card's money on Home", () => {
    const c = { state: 'active' as const, version: 0, perTapSat: 20_000, dailySat: 50_000, balanceMsat: 6_000_000, heldMsat: 0 };
    expect(phoneMoreRows(c, true, 'hidden', GBP)).toMatchObject({
      limits: '*** per payment · *** a day', remove: { line: 'Its 6,000 sat move to Pool; this phone stops being a card.', disabled: false },
    });
    expect(phoneMoreRows({ ...c, limits }, false).limits).toBe('£5.00 per payment · £20.00 a day');
    expect(removedNotice([{ name: 'Pixel 8 Pro', amountMsat: 6_000_000 }], false, 'fiat', GBP)!.text).toBe("Pixel 8 Pro's card was removed. It was the card of the phone this wallet was on before. Its £3.68 are in Pool.");
    expect(removedNotice([{ name: 'Pixel 8 Pro', amountMsat: 6_000_000 }], false, 'hidden', GBP)!.text).toBe("Pixel 8 Pro's card was removed. It was the card of the phone this wallet was on before. Its *** are in Pool.");
  });
});
