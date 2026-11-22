import { describe, expect, it } from 'vitest';
import type { HostingStatus } from '../cardd/client';
import { cardLimits, checkLine, gaveUpNotice, giveUpLine, headerNote, hostingCard, limitText, moreRows, wipeLine } from './accountView';

const NOW = 1_790_000_000; // 2026-09-21 14:13 UTC
const card = { state: 'active' as const, version: 1, perTapSat: 20_000, dailySat: 50_000, spent24hMsat: 2_950_400, balanceMsat: 13_291_000, heldMsat: 0 };
const GBP = { currency: 'GBP' as const, price: 61_352, time: 1_792_037_404 };
const inPounds = { ...card, limits: { currency: 'GBP' as const, perTapMinor: 500, dailyMinor: 2000 } };

describe('cardLimits', () => {
  it("gives a card's limits and what it used in 24 hours as rows, in whole sats", () => {
    expect(cardLimits(card)).toEqual([
      ['Per payment', '20,000 sat'],
      ['Per 24 hours', '50,000 sat'],
      ['Used in 24 hours', '2,950 sat'],
    ]);
    expect(cardLimits({ ...card, spent24hMsat: 0 })[2]).toEqual(['Used in 24 hours', '0 sat']);
  });
});

describe('headerNote', () => {
  it('tags a frozen card, names a part-way state, and says nothing of an active card', () => {
    expect(headerNote('active')).toBeNull();
    expect(headerNote('frozen')).toEqual({ tag: true, text: 'Frozen' });
    expect(headerNote('programming')).toEqual({ tag: false, text: 'Being added' });
    expect(headerNote('wiping')).toEqual({ tag: false, text: 'Being wiped' });
  });

  // The line under the balance says "This phone".
  it("says a phone's card is one, this phone's or another's, in every state", () => {
    expect(headerNote('active', 'own')).toEqual({ tag: false, text: 'This phone' });
    expect(headerNote('active', 'other')).toEqual({ tag: false, text: 'A phone' });
    expect(headerNote('frozen', 'own')).toEqual({ tag: true, text: 'Frozen · this phone' });
    expect(headerNote('programming', 'own')).toEqual({ tag: false, text: 'This phone · being set up' });
    expect(headerNote('wiping', 'other')).toEqual({ tag: false, text: 'A phone · being removed' });
    expect(headerNote('active', null)).toBeNull();
  });
});

describe('moreRows', () => {
  it("gives Limits its limits, Change photo its line and the foot the card's state and version", () => {
    const rows = moreRows(card, true);
    expect(rows.limits).toBe('20,000 per payment · 50,000 a day');
    expect(rows.photo).toBe('Take a new picture of the card');
    expect(rows.foot).toBe('Active · version 1');
    expect(moreRows(card, false).photo).toBe('Take a picture of the card');
    expect(moreRows({ ...card, state: 'frozen', version: 2 }, true).foot).toBe('Frozen · version 2');
  });

  it("says where a wipe's balance goes, or only that the card is blank again with none", () => {
    expect(moreRows(card, true).wipe).toEqual({ line: 'Its 13,291 sat move to Pool; the card is blank again.', disabled: false });
    expect(moreRows({ ...card, balanceMsat: 0 }, true).wipe).toEqual({ line: 'The card is blank again.', disabled: false });
    expect(moreRows({ ...card, balanceMsat: 400 }, true).wipe).toEqual({ line: 'The card is blank again.', disabled: false });
  });

  it("says a wipe's and a give-up's money in the chosen unit while amounts are hidden; sat when no unit is given", () => {
    const hidden = moreRows(card, true, 'hidden', GBP, 'fiat');
    expect(hidden.wipe.line).toBe('Its £8.15 move to Pool; the card is blank again.');
    expect(hidden.giveUp.line).toBe('Its £8.15 move to Pool; taps of it are refused.');
    expect(moreRows(card, true, 'hidden', GBP).wipe.line).toBe('Its 13,291 sat move to Pool; the card is blank again.');
  });

  it('greys Wipe while a payment holds some of the balance: cardd refuses it', () => {
    expect(moreRows({ ...card, heldMsat: 2_105_000 }, true).wipe).toEqual({ line: 'Wait for the payment in progress', disabled: true });
  });
});

// "I no longer have this card": the money that moves, said in the chosen unit even while amounts are hidden, as Wipe's is.
describe('giveUpLine', () => {
  it('names the money that moves to Pool, and that taps of the card are refused', () => {
    expect(giveUpLine({ balanceMsat: 5_000_000, heldMsat: 0 })).toEqual({ line: 'Its 5,000 sat move to Pool; taps of it are refused.', disabled: false });
    expect(giveUpLine({ balanceMsat: 5_000_000, heldMsat: 0 }, 'fiat', GBP)).toEqual({ line: 'Its £3.07 move to Pool; taps of it are refused.', disabled: false });
  });
  it('says only that taps are refused with under a sat on the card', () => {
    expect(giveUpLine({ balanceMsat: 0, heldMsat: 0 })).toEqual({ line: 'Taps of it are refused.', disabled: false });
    expect(giveUpLine({ balanceMsat: 999, heldMsat: 0 })).toEqual({ line: 'Taps of it are refused.', disabled: false });
  });
  it('is off while a payment holds some of the balance: the server refuses it', () => {
    expect(giveUpLine({ balanceMsat: 5_000_000, heldMsat: 1 })).toEqual({ line: 'Wait for the payment in progress', disabled: true });
  });
  it("is More's row", () => {
    expect(moreRows(card, true).giveUp).toEqual(giveUpLine(card));
    expect(moreRows(card, true, 'hidden').giveUp).toEqual(giveUpLine(card, 'sat'));
    expect(moreRows(card, true, 'hidden', GBP, 'fiat').giveUp).toEqual(giveUpLine(card, 'fiat', GBP));
  });
});

// The sheet for a card held to the phone has the same row.
describe('wipeLine', () => {
  it("is More's own line for a card the wallet lists, and off while a payment holds some of its balance", () => {
    expect(wipeLine(card)).toEqual({ line: 'Its 13,291 sat move to Pool; the card is blank again.', disabled: false });
    expect(wipeLine({ ...card, balanceMsat: 400 })).toEqual({ line: 'The card is blank again.', disabled: false });
    expect(wipeLine({ ...card, heldMsat: 1 })).toEqual({ line: 'Wait for the payment in progress', disabled: true });
  });
  it('says only that the card is blank again for one the wallet does not list', () => {
    expect(wipeLine(undefined)).toEqual({ line: 'The card is blank again.', disabled: false });
  });
});

describe('hostingCard', () => {
  const status = (o: Partial<HostingStatus> = {}): HostingStatus => ({
    synced: true, expires: NOW + 54 * 86400, syncedAt: NOW, daysLeft: 54, msatPerDay: 221_387, fundingDays: 120.4, vatOk: true, willRenew: true,
    problem: '', problemAt: 0, ...o,
  });

  it('is green when the server renews itself and nothing is wrong', () => {
    expect(hostingCard(status(), null, NOW, 0)).toEqual({
      tone: 'ok',
      title: 'Paid until 14 Nov (54 days)',
      lines: ['Renews itself when due.', 'Hosting covers about 120 more days after that'],
      warnings: [],
      problems: [],
    });
  });

  it('says estimated, one day, another year, and expired', () => {
    expect(hostingCard(status({ syncedAt: NOW - 8 * 86400 }), null, NOW, 0).title).toBe('Paid until 14 Nov (54 days), estimated');
    expect(hostingCard(status({ expires: NOW + 1.5 * 86400 }), null, NOW, 0).title).toBe('Paid until 23 Sep (1 day)');
    expect(hostingCard(status({ expires: NOW + 420 * 86400 }), null, NOW, 0).title).toBe('Paid until 15 Nov 2027 (420 days)');
    expect(hostingCard(status({ expires: NOW - 18 * 86400, willRenew: false }), null, NOW, 0).title).toBe('Expired on 3 Sep');
  });

  // A brand-new server's page said three times, twice in red, that Hosting was empty.
  const NO_MONEY = 'Hosting has 0 sat available: not enough for a renewal (at least 100 sat and its routing fee budget).';
  // Amber under 14 days of funding, red under 7, still said once.
  it('says once that Hosting is low: amber under 14 days of funding, red under 7', () => {
    const fresh = hostingCard(status({ expires: NOW + 6.9 * 86400, willRenew: false, fundingDays: 0, problem: NO_MONEY, problemAt: NOW - 600 }), null, NOW, 0);
    expect(fresh).toEqual({
      tone: 'error',
      title: 'Paid until 28 Sep (6 days)',
      lines: [],
      warnings: [],
      problems: ['Hosting covers about 0 more days after 28 Sep: top it up or move from Pool'],
    });
    // Paid weeks ahead with a little in Hosting: the days paid beyond 7 count too, so nothing to say.
    const ahead = hostingCard(status({ fundingDays: 12.4 }), null, NOW, 0);
    expect([ahead.tone, ahead.lines, ahead.warnings, ahead.problems]).toEqual([
      'ok', ['Renews itself when due.', 'Hosting covers about 12 more days after that'], [], [],
    ]);
    // Ten days paid (3 beyond 7) and 8.4 in Hosting: 11.4 days, amber.
    const nearer = hostingCard(status({ expires: NOW + 10 * 86400, fundingDays: 8.4 }), null, NOW, 0);
    expect([nearer.tone, nearer.warnings]).toEqual(['warn', ['Hosting covers about 8 more days after 1 Oct: top it up or move from Pool']]);
  });

  it('keeps the line red under 7 days of funding however close the date, amber from 7', () => {
    const close = hostingCard(status({ expires: NOW + 2 * 86400, willRenew: false, fundingDays: 0, problem: NO_MONEY, problemAt: NOW - 600 }), null, NOW, 0);
    expect([close.tone, close.lines, close.warnings, close.problems]).toEqual(['error', [], [], ['Hosting covers about 0 more days after 23 Sep: top it up or move from Pool']]);
    // Two days paid and ten days of money that will renew it: amber.
    expect(hostingCard(status({ expires: NOW + 2 * 86400, fundingDays: 10 }), null, NOW, 0).tone).toBe('warn');
  });

  it('is red with a renewal problem that is not about money, or the VAT stop, whatever time is left', () => {
    const problem = hostingCard(status({ problem: 'LNVPS refused the payment', problemAt: NOW - 3000 }), null, NOW, 0);
    expect([problem.tone, problem.problems]).toEqual(['error', ['Last renewal problem (today at 13:23): LNVPS refused the payment']]);
    const vat = hostingCard(status({ vatOk: false, willRenew: false }), null, NOW, 0);
    expect(vat.tone).toBe('error');
    expect(vat.problems).toEqual(['Automatic renewal is stopped: LNVPS’s VAT doesn’t match your country. Check your account on LNVPS, or pay LNVPS from any wallet.']);
    // The no-money problem with Hosting funded (the money came since): it is still said, as any problem.
    const stale = hostingCard(status({ willRenew: false, problem: NO_MONEY, problemAt: NOW - 3000 }), null, NOW, 0);
    expect(stale.problems).toEqual([`Last renewal problem (today at 13:23): ${NO_MONEY}`]);
    // Low money and another problem: both show, the money line in its own colour.
    const both = hostingCard(status({ expires: NOW + 7 * 86400, fundingDays: 0, willRenew: false, problem: 'The renewal payment of 4400 sat failed.', problemAt: NOW - 3000 }), null, NOW, 0);
    expect([both.tone, both.warnings, both.problems]).toEqual([
      'error', [], ['Hosting covers about 0 more days after 28 Sep: top it up or move from Pool', 'Last renewal problem (today at 13:23): The renewal payment of 4400 sat failed.'],
    ]);
  });

  it("follows the wallet's paid-until banner when nothing else is wrong: amber with 3 days or more, red under", () => {
    expect(hostingCard(status({ expires: NOW + 2 * 86400, willRenew: false }), null, NOW, 0).tone).toBe('error');
    expect(hostingCard(status({ expires: NOW + 6 * 86400, willRenew: false }), null, NOW, 0).tone).toBe('warn');
  });

  it("says it won't renew itself, in amber, only when nothing else says why", () => {
    const wont = hostingCard(status({ willRenew: false }), null, NOW, 0);
    expect([wont.tone, wont.lines[0]]).toEqual(['warn', "Won't renew itself when due."]);
    // The VAT stop says why: no second line about it.
    expect(hostingCard(status({ vatOk: false, willRenew: false }), null, NOW, 0).lines).toEqual(['Hosting covers about 120 more days after that']);
    // So does the money line.
    expect(hostingCard(status({ expires: NOW + 7 * 86400, fundingDays: 0, willRenew: false }), null, NOW, 0).lines).toEqual([]);
    // Paid 54 days ahead, Hosting empty: no money line yet, so it says it won't renew.
    expect(hostingCard(status({ fundingDays: 0, willRenew: false }), null, NOW, 0).lines).toEqual(["Won't renew itself when due.", 'Hosting covers about 0 more days after that']);
  });

  it("shows no dot before the first sync or without a status: LNVPS's own date when the phone has it", () => {
    expect(hostingCard(null, null, NOW, 0)).toEqual({ tone: 'none', title: 'Checking how long your server is paid for…', lines: [], warnings: [], problems: [] });
    expect(hostingCard(status({ synced: false }), null, NOW, 0).title).toBe('Checking how long your server is paid for…');
    expect(hostingCard(null, NOW + 54 * 86400, NOW, 0)).toEqual({ tone: 'none', title: 'Paid until 14 Nov (54 days)', lines: [], warnings: [], problems: [] });
    // Without cardd's status only a close date warns (red, under 3 days), as the wallet's banner.
    expect(hostingCard(null, NOW + 3 * 86400, NOW, 0).tone).toBe('none');
    expect(hostingCard(null, NOW + 2 * 86400, NOW, 0).tone).toBe('error');
  });

  // The VM is kept at about 7 days and renews itself daily: green while Hosting covers 14 days or more, the
  // funding line in red under 7.
  it('is green for a VM kept at 6 days that renews itself, red when Hosting covers under 7 days', () => {
    const kept = hostingCard(status({ expires: NOW + 6 * 86400, fundingDays: 20 }), null, NOW, 0);
    expect(kept).toMatchObject({ tone: 'ok', lines: ['Renews itself when due.', 'Hosting covers about 20 more days after that'], warnings: [], problems: [] });
    const low = hostingCard(status({ expires: NOW + 6 * 86400, fundingDays: 5 }), null, NOW, 0);
    expect(low).toMatchObject({ tone: 'error', problems: ['Hosting covers about 5 more days after 27 Sep: top it up or move from Pool'], warnings: [] });
  });
});

// Limits in their own unit, never converted; what
// was used in the app's view; *** hides them all on a card's page; Wipe's line, which confirms money, in sat then.
describe("a card's amounts in the app's view", () => {
  it('says a limit as it was set: in its currency, or in sat', () => {
    expect([limitText(card, 'perTap'), limitText(card, 'daily')]).toEqual(['20,000 sat', '50,000 sat']);
    expect([limitText(inPounds, 'perTap'), limitText(inPounds, 'daily')]).toEqual(['£5.00', '£20.00']);
  });

  it('gives the rows in the view, the limits in their own unit and *** when hidden', () => {
    expect(cardLimits(inPounds, 'sat', GBP)).toEqual([['Per payment', '£5.00'], ['Per 24 hours', '£20.00'], ['Used in 24 hours', '2,950 sat']]);
    expect(cardLimits(card, 'fiat', GBP)).toEqual([['Per payment', '20,000 sat'], ['Per 24 hours', '50,000 sat'], ['Used in 24 hours', '£1.81']]);
    expect(cardLimits(card, 'msat', null)[2]).toEqual(['Used in 24 hours', '2,950,400 msat']);
    expect(cardLimits(inPounds, 'hidden', GBP)).toEqual([['Per payment', '***'], ['Per 24 hours', '***'], ['Used in 24 hours', '***']]);
  });

  it("says More's Limits line in the limits' unit, hides it in ***, and keeps Wipe's money in sat then", () => {
    expect(moreRows(inPounds, true).limits).toBe('£5.00 per payment · £20.00 a day');
    expect(moreRows(card, true, 'hidden', GBP)).toMatchObject({
      limits: '*** per payment · *** a day',
      wipe: { line: 'Its 13,291 sat move to Pool; the card is blank again.', disabled: false },
    });
    expect(moreRows(card, true, 'fiat', GBP).wipe.line).toBe('Its £8.15 move to Pool; the card is blank again.');
    expect(wipeLine(card, 'msat', null).line).toBe('Its 13,291,000 msat move to Pool; the card is blank again.');
  });
});

// After a restore a card shows Active but can't pay until it is held to the phone: its page says so, as Frozen's does.
describe('checkLine', () => {
  it("says a card can't pay until it is held to the phone, only when the server says it needs the check", () => {
    expect(checkLine(true)).toBe("After the restore: can't pay until you hold it to the phone; still takes top-ups.");
    expect(checkLine(false)).toBeNull();
    expect(checkLine(undefined)).toBeNull();
  });

  it("says nothing for a phone's card: the wallet checks its own itself, and removes another phone's", () => {
    expect(checkLine(true, 'own')).toBeNull();
    expect(checkLine(true, 'other')).toBeNull();
  });
});

// The Wallet page's line after a card was given up, until it is dismissed. No figure: the server moves the balance it
// has at the start, which a top-up or a tap during the screen lock can have changed from the one on the card's page;
// Pool's history holds the exact amount.
describe('gaveUpNotice', () => {
  it('says each card given up was removed, and that its balance moved to Pool when it had one', () => {
    expect(gaveUpNotice([{ name: 'Daily', hadBalance: true, pending: false }])).toEqual(['Daily was removed: its balance moved to Pool.']);
    expect(gaveUpNotice([{ name: 'Daily', hadBalance: false, pending: false }])).toEqual(['Daily was removed.']);
    expect(gaveUpNotice([
      { name: 'Daily', hadBalance: true, pending: false },
      { name: 'Old', hadBalance: false, pending: true },
    ])).toEqual(['Daily was removed: its balance moved to Pool.', 'Old was removed. Your server will be told when it answers.']);
  });

  it('says nothing when none was given up', () => {
    expect(gaveUpNotice([])).toEqual([]);
  });
});
