import { describe, expect, it } from 'vitest';
import { CarddError, type Tx } from '../cardd/client';
import { fiatSpoken, minorSpoken, type Rated } from './fiat';
import {
  convertTyped, dayStart, dayText, feeText, heldLine, historyRows, limitsNow, limitsProblem, limitsRaise, limitsText, lineAmount, moneyError, moveAmountMsat, msatText, resumeNotice, satInput,
  shortDate, topUpWarning, typedMsat, whenText,
} from './format';

describe('msatText', () => {
  it('shows whole sats plainly and the rest exactly', () => {
    expect(msatText(13_438_000)).toBe('13,438 sat');
    expect(msatText(81_204)).toBe('81.204 sat');
    expect(msatText(81_200)).toBe('81.2 sat');
    expect(msatText(-1_004_000)).toBe('-1,004 sat');
  });
});

describe('feeText', () => {
  it('says a whole fee as it is, and one with a part of a sat as under the next whole sat', () => {
    expect(feeText(12_000)).toBe('fee 12 sat');
    expect(feeText(1_000_000)).toBe('fee 1,000 sat');
    expect(feeText(4_084)).toBe('fee under 5 sat');
    expect(feeText(81_204)).toBe('fee under 82 sat');
    expect(feeText(84)).toBe('fee under 1 sat');
  });
});

describe('satInput', () => {
  it('reads whole sats, with or without separators, as msat', () => {
    expect(satInput('1,234')).toBe(1_234_000);
    expect(satInput(' 500 ')).toBe(500_000);
    for (const bad of ['', '0', '-5', '1.5', 'abc']) expect(satInput(bad)).toBeNull();
  });
});

describe('heldLine', () => {
  it('says what is held, fee budget included', () => {
    expect(heldLine(5_060_000)).toBe('5,060 sat held for a payment in progress (including its fee budget)');
    expect(heldLine(0)).toBe('');
    expect(heldLine(5_060_000, 'fiat', { currency: 'GBP', price: 61_352, time: 1_792_037_404 })).toBe('£3.10 held for a payment in progress (including its fee budget)');
    expect(heldLine(5_060_000, 'hidden', null)).toBe('*** held for a payment in progress (including its fee budget)');
  });
});

describe('topUpWarning', () => {
  it('warns before the first top-up, says nothing once there is a channel', () => {
    expect(topUpWarning({ channel: false, usable: false, inboundSat: 0, feeCreditSat: 0, firstChannelFeeSat: 21_411 })).toBe(
      "The first top-up pays ACINQ, who run your server's Lightning channel, to open it: about 21,411 sat at today's fees. Send over 50,000 sat to be sure of an open channel, the remainder will be your initial balance.",
    );
    expect(topUpWarning({ channel: true, usable: true, inboundSat: 1_900_000, feeCreditSat: 0, firstChannelFeeSat: 0 })).toBe('');
    const GBP = { currency: 'GBP' as const, price: 61_352, time: 1_792_037_404 };
    const first = { channel: false, usable: false, inboundSat: 0, feeCreditSat: 0, firstChannelFeeSat: 21_411 };
    expect(topUpWarning(first, 'fiat', GBP)).toMatch(/to open it: about £13\.14 at today's fees\. Send over/);
    expect(topUpWarning(first, 'hidden', GBP)).toMatch(/to open it: about \*\*\* at today's fees\. Send over/);
    expect(topUpWarning(null)).toBe("Your server can't check its Lightning channel right now. If this is the first top-up, send over 50,000 sat.");
  });
});

describe('limitsProblem', () => {
  it("needs positive limits, per payment no more than per 24 hours, and none over cardd's 2,000,000 sat", () => {
    expect(limitsProblem(20_000, 50_000)).toBeNull();
    expect(limitsProblem(0, 50_000)).toBe('Limits must be more than 0 sat.');
    expect(limitsProblem(60_000, 50_000)).toBe("The limit per payment can't be more than the 24-hour limit.");
    expect(limitsProblem(20_000, 2_000_000)).toBeNull();
    expect(limitsProblem(20_000, 2_000_001)).toBe('Limits are up to 2,000,000 sat.');
  });

  it('says the same of limits in a currency, in minor units, with the cap at the rate', () => {
    const GBP = { currency: 'GBP' as const, price: 61_352, time: 1_792_037_404 };
    expect(limitsProblem(500, 2_000, GBP)).toBeNull();
    expect(limitsProblem(0, 2_000, GBP)).toBe('Limits must be more than £0.00.');
    expect(limitsProblem(3_000, 2_000, GBP)).toBe("The limit per payment can't be more than the 24-hour limit.");
    expect(limitsProblem(500, 122_704, GBP)).toBeNull();
    expect(limitsProblem(500, 122_705, GBP)).toBe('Limits are up to 2,000,000 sat (£1,227.04).');
    expect(limitsProblem(500, 10_000_000_001, GBP)).toBe('Limits are up to 2,000,000 sat (£1,227.04).');
  });
});

describe('limitsRaise', () => {
  const GBP = { currency: 'GBP' as const, price: 61_352, time: 1_792_037_404 };
  const inSat = { perTapSat: 20_000, dailySat: 50_000 };
  // £5 a tap and £20 a day are 8,150 and 32,599 sat at the rate, as cardd reports them.
  const inGbp = { perTapSat: 8_150, dailySat: 32_599, limits: { currency: 'GBP' as const, perTapMinor: 500, dailyMinor: 2_000 } };

  it('is a raise when either limit goes up in sat, and not when both stay or go down', () => {
    expect(limitsRaise(inSat, { perTapSat: 25_000, dailySat: 50_000 }, null)).toBe(true);
    expect(limitsRaise(inSat, { perTapSat: 20_000, dailySat: 50_001 }, null)).toBe(true);
    expect(limitsRaise(inSat, { perTapSat: 20_000, dailySat: 50_000 }, null)).toBe(false);
    expect(limitsRaise(inSat, { perTapSat: 10_000, dailySat: 40_000 }, null)).toBe(false);
    // One down and the other up is still a raise.
    expect(limitsRaise(inSat, { perTapSat: 5_000, dailySat: 60_000 }, null)).toBe(true);
  });

  it('compares limits kept in the same currency in it', () => {
    expect(limitsRaise(inGbp, { currency: 'GBP', perTapMinor: 600, dailyMinor: 2_000 }, GBP)).toBe(true);
    expect(limitsRaise(inGbp, { currency: 'GBP', perTapMinor: 500, dailyMinor: 1_500 }, GBP)).toBe(false);
  });

  it("compares a change of unit in sat: the card's at the last rate, the new ones at this one", () => {
    // £12.27 and £30.68 are 19,999 and 50,007 sat: the daily limit goes up.
    expect(limitsRaise(inSat, { currency: 'GBP', perTapMinor: 1_227, dailyMinor: 3_068 }, GBP)).toBe(true);
    expect(limitsRaise(inSat, { currency: 'GBP', perTapMinor: 1_000, dailyMinor: 3_000 }, GBP)).toBe(false);
    expect(limitsRaise(inGbp, { perTapSat: 8_150, dailySat: 32_599 }, GBP)).toBe(false);
    expect(limitsRaise(inGbp, { perTapSat: 8_151, dailySat: 32_599 }, GBP)).toBe(true);
    // Limits in another currency than the card's, compared in sat too.
    expect(limitsRaise({ ...inGbp, limits: { currency: 'EUR', perTapMinor: 500, dailyMinor: 2_000 } }, { currency: 'GBP', perTapMinor: 500, dailyMinor: 2_000 }, GBP)).toBe(false);
  });

  it("counts limits in a currency it has no rate for as a raise: it can't tell", () => {
    expect(limitsRaise(inSat, { currency: 'GBP', perTapMinor: 1, dailyMinor: 2 }, null)).toBe(true);
  });
});

describe('limitsText', () => {
  it('says limits in their own unit, the day first, as the sheet says them now', () => {
    expect(limitsText({ perTapSat: 20_000, dailySat: 50_000 })).toBe('50,000 sat a day · 20,000 sat a tap');
    expect(limitsText({ currency: 'GBP', perTapMinor: 500, dailyMinor: 2_050 })).toBe('£20.50 a day · £5 a tap');
  });
});

describe('moneyError and the currency', () => {
  it("says cardd's limits rule whole, and the currency's two refusals", () => {
    expect(moneyError(new CarddError(400, 'bad_limits', 'cards: limits are 1 to 2,000,000 sat, and the 24-hour limit is at least the per-tap one'))).toBe(
      "Those limits aren't allowed: each is 1 to 2,000,000 sat, and per payment no more than per 24 hours.",
    );
    expect(moneyError(new CarddError(409, 'no_rate', 'No £ rate yet: set the limits in sat.'))).toBe(
      'Your server has no rate for its currency yet: set the limits in sat, or try again in a few minutes.',
    );
    expect(moneyError(new CarddError(409, 'wrong_currency', "The shop's currency changed: start the sale again."))).toBe(
      "Your server's currency changed meanwhile: start again.",
    );
  });

  // A refund to this server's own address showed cardd's raw words.
  it("says plainly that a refund's address is this server's own", () => {
    expect(moneyError(new CarddError(409, 'bad_return_link', "api: a link to this server that isn't one of its refund links"))).toBe(
      "That address is your own server's: give the customer's own invoice or address.",
    );
  });

  it("says plainly when the server can't reach phoenixd, not phoenixd's own text", () => {
    expect(moneyError(new CarddError(503, 'phoenixd_unreachable', 'phoenixd: 500 {"message":"x"}'))).toBe(
      "Your server can't reach its Lightning node (phoenixd): try again in a minute.",
    );
  });
});

describe('moneyError', () => {
  it('gives a lookup refusal as cardd words it', () => {
    const e = new CarddError(400, 'bad_destination', '₿bob@example.com doesn’t exist: example.com has no BIP353 record for bob.');
    expect(moneyError(e)).toBe(e.message);
  });

  it("says a refusal plainly, keeping cardd's own reason where it is the useful part", () => {
    expect(moneyError(new CarddError(409, 'insufficient', 'store: not enough money available'))).toBe('There isn’t enough money available.');
    expect(moneyError(new CarddError(503, 'paused', 'ledger: spending is paused until the books add up again'))).toBe(
      'Spending is paused until the books add up again (see Settings).',
    );
    expect(moneyError(new CarddError(400, 'bad_invoice', "ledger: the invoice can't be paid: it has expired"))).toBe("The invoice can't be paid: it has expired.");
    expect(moneyError(new CarddError(400, 'bad_address', `lnaddr: can't get an invoice from this address: the address's server says "account closed"`))).toBe(
      `Couldn't get an invoice: the address's server says "account closed".`,
    );
    expect(moneyError(new CarddError(400, 'bad_note', 'a note is 200 characters at most'))).toBe('a note is 200 characters at most');
    expect(moneyError(new CarddError(409, 'payment_in_progress', 'store: a payment is already in progress'))).toBe('Another payment from this account is still on its way.');
    expect(moneyError(new CarddError(409, 'duplicate_payment', 'store: this invoice was already paid or is being paid'))).toBe(
      'This invoice was already paid from your server, or is being paid now.',
    );
    expect(moneyError(new CarddError(409, 'not_synced', "renew: the app hasn't synced the VM's expiry from LNVPS yet"))).toBe(
      "The server doesn't have the VM's expiry from LNVPS yet: open the wallet, then try again.",
    );
    expect(moneyError(new CarddError(409, 'vat', "renew: LNVPS's VAT doesn't match this account's country"))).toBe(
      'LNVPS’s VAT doesn’t match your country, so the server doesn’t renew: use Pay LNVPS from any wallet.',
    );
    expect(moneyError(new CarddError(400, 'bad_days', 'renew: days must be a whole number from 1 to 365'))).toBe('Renew for 1 to 365 days.');
    expect(moneyError(new CarddError(502, 'not_lnvps', "renew: LNVPS's answer isn't for this VM: its invoice is not for VM 1009"))).toBe(
      "LNVPS's answer wasn't for this VM (its invoice is not for VM 1009): nothing was paid.",
    );
    expect(moneyError(new CarddError(418, 'teapot', 'odd'))).toBe('The server refused: odd');
    expect(moneyError(new Error('fetch failed: offline'))).toBe("Can't reach your server.");
  });
});

describe('moveAmountMsat', () => {
  it('moves the exact msat available for All, so no dust stays behind; whole sats otherwise', () => {
    expect(moveAmountMsat(true, '', 13_438_796)).toBe(13_438_796);
    expect(moveAmountMsat(false, '1,000', 13_438_796)).toBe(1_000_000);
    expect(moveAmountMsat(false, '', 13_438_796)).toBeNull();
  });
});

describe('resumeNotice', () => {
  it('says what became of each move or send left from before', () => {
    const move = { kind: 'move' as const, id: 'm', from: 'pool', to: 'hosting', amountMsat: 1_000_000, started: 0 };
    const send = { kind: 'send' as const, id: 's', to: 'alice@pay.example.com', amountMsat: 2_000_000, started: 0 };
    const renew = { kind: 'renew' as const, id: 'r', days: 7, started: 0 };
    expect(
      resumeNotice([
        { req: move, outcome: { at: 'answered', answer: { status: 'moved' } } },
        { req: move, outcome: { at: 'refused', error: new CarddError(409, 'insufficient', 'store: not enough money available') } },
        { req: move, outcome: { at: 'unknown' } },
        { req: send, outcome: { at: 'dropped' } },
        { req: renew, outcome: { at: 'dropped' } },
        { req: { ...renew, days: 1 }, outcome: { at: 'answered', answer: { status: 'sent', paymentHash: 'ab', amountMsat: 222_000, feeMsat: 0 } } },
      ]),
    ).toEqual([
      'A move of 1,000 sat from before is done.',
      'A move of 1,000 sat from before was refused: There isn’t enough money available.',
      "A move of 1,000 sat from before isn't confirmed yet: the history will show it.",
      "A send of 2,000 sat to alice@pay.example.com from before wasn't confirmed. Before sending it again, check pool: a “Sent out” line in its history means it went; nothing held and no line means it didn't.",
      "A renewal of 7 days from before wasn't confirmed. Before renewing again, check hosting: a “Renewed the VM” line in its history means it went; nothing held and no line means it didn't.",
      'A renewal of 1 day from before is done.',
    ]);
  });
});

// The dates in Settings and its pages.
describe('whenText', () => {
  const NOW = 1_790_000_000; // 2026-09-21 14:13:20 UTC
  const MIDNIGHT = 1_789_948_800; // 2026-09-21 00:00 UTC

  it('says today, yesterday, a date this year, and a date with its year', () => {
    expect(whenText(NOW - 3000, NOW, 0)).toBe('today at 13:23');
    expect(whenText(NOW - 86_400, NOW, 0)).toBe('yesterday at 14:13');
    expect(whenText(NOW - 10 * 86_400, NOW, 0)).toBe('11 Sep at 14:13');
    expect(whenText(NOW - 400 * 86_400, NOW, 0)).toBe('17 Aug 2025 at 14:13');
  });

  it('turns the day at midnight', () => {
    const halfPast = MIDNIGHT + 1800; // 00:30
    expect(whenText(halfPast - 60, halfPast, 0)).toBe('today at 00:29');
    expect(whenText(halfPast - 3600, halfPast, 0)).toBe('yesterday at 23:30');
  });

  it("reads the day in the phone's time zone, east and west of UTC", () => {
    const lateEvening = MIDNIGHT - 1800; // 2026-09-20 23:30 UTC
    expect(whenText(lateEvening, NOW, 0)).toBe('yesterday at 23:30');
    expect(whenText(lateEvening, NOW, 120)).toBe('today at 01:30'); // UTC+2
    const small = MIDNIGHT + 3 * 3600; // 2026-09-21 03:00 UTC
    expect(whenText(small, NOW, 0)).toBe('today at 03:00');
    expect(whenText(small, NOW, -300)).toBe('yesterday at 22:00'); // UTC-5
  });
});

describe('dayText and shortDate', () => {
  const NOW = 1_790_000_000; // 2026-09-21 14:13:20 UTC
  const MIDNIGHT = 1_789_948_800; // 2026-09-21 00:00 UTC

  it("names today and yesterday, then the date, with the year when it isn't this one's", () => {
    expect(dayText(NOW - 3000, NOW, 0)).toBe('Today');
    expect(dayText(NOW - 86_400, NOW, 0)).toBe('Yesterday');
    expect(dayText(NOW - 10 * 86_400, NOW, 0)).toBe('11 Sep');
    expect(dayText(NOW - 400 * 86_400, NOW, 0)).toBe('17 Aug 2025');
  });

  it("turns the day at the phone's midnight, east and west of UTC", () => {
    const lateEvening = MIDNIGHT - 1800; // 2026-09-20 23:30 UTC
    expect(dayText(lateEvening, NOW, 0)).toBe('Yesterday');
    expect(dayText(lateEvening, NOW, 120)).toBe('Today'); // UTC+2
    expect(dayText(MIDNIGHT + 3 * 3600, NOW, -300)).toBe('Yesterday'); // UTC-5
  });

  it("calls a time ahead of the phone's clock today: the server's clock may run a little fast across midnight", () => {
    expect(dayText(MIDNIGHT + 86_400 + 5, MIDNIGHT + 86_400 - 5, 0)).toBe('Today');
    expect(historyRows([{ id: 1, kind: 'topup', note: '', amountMsat: 1000, feeMsat: 0, created: NOW + 90_000 }], NOW, 0)[0].day).toBe('Today');
  });

  it('gives a date alone for a day to come or gone, never today or yesterday', () => {
    expect(shortDate(NOW, NOW, 0)).toBe('21 Sep');
    expect(shortDate(NOW + 54 * 86_400, NOW, 0)).toBe('14 Nov');
    expect(shortDate(NOW + 420 * 86_400, NOW, 0)).toBe('15 Nov 2027');
  });
});

describe('dayStart', () => {
  // cardd's sales/days names a day as (paid_at + offset) / 86400 * 86400 - offset, in whole seconds.
  it("is the first second of the phone's day, east and west of UTC", () => {
    const t = Date.UTC(2026, 8, 21, 2, 0) / 1000; // 02:00 UTC
    expect(dayStart(t, 0)).toBe(Date.UTC(2026, 8, 21) / 1000);
    expect(dayStart(t, 120)).toBe(Date.UTC(2026, 8, 20, 22, 0) / 1000);
    // Five hours west it is still the evening before: that day began at 05:00 UTC the day before.
    expect(dayStart(t, -300)).toBe(Date.UTC(2026, 8, 20, 5, 0) / 1000);
    expect(dayStart(t, -210)).toBe(Date.UTC(2026, 8, 20, 3, 30) / 1000);
    expect(dayStart(Date.UTC(2026, 8, 21) / 1000, 0)).toBe(Date.UTC(2026, 8, 21) / 1000);
  });
});

describe('historyRows', () => {
  const NOW = 1_790_000_000; // 2026-09-21 14:13:20 UTC
  const at = (daysAgo: number, h: number, m: number) => Date.UTC(2026, 8, 21 - daysAgo, h, m) / 1000;
  const tx = (id: number, kind: string, amountMsat: number, feeMsat: number, created: number, note = 'paid 3f9a') => ({ id, kind, note, amountMsat, feeMsat, created });

  it('groups the entries by day, newest first, under Today, Yesterday and the date', () => {
    const days = historyRows(
      [tx(5, 'spend', -2_101_000, 1_000, at(0, 14, 7)), tx(4, 'spend', -850_000, 0, at(0, 9, 12)), tx(3, 'move', 10_000_000, 0, at(1, 18, 30)), tx(2, 'topup', 5_000_000, 0, at(14, 22, 52)), tx(1, 'topup', 1_000_000, 0, Date.UTC(2025, 7, 17, 8, 0) / 1000)],
      NOW,
      0,
    );
    expect(days.map((d) => [d.day, d.rows.map((r) => r.id)])).toEqual([
      ['Today', [5, 4]],
      ['Yesterday', [3]],
      ['7 Sep', [2]],
      ['17 Aug 2025', [1]],
    ]);
  });

  it("puts an entry in the phone's day, not UTC's", () => {
    const lateEvening = Date.UTC(2026, 8, 20, 23, 30) / 1000;
    expect(historyRows([tx(1, 'topup', 1000, 0, lateEvening)], NOW, 0)[0].day).toBe('Yesterday');
    const east = historyRows([tx(1, 'topup', 1000, 0, lateEvening)], NOW, 120)[0];
    expect([east.day, east.rows[0].line]).toEqual(['Today', '01:30']);
  });

  it('shows a spend, a send and a renewal as the charge without the fee, the fee on the line under', () => {
    const [day] = historyRows(
      [tx(1, 'spend', -19_081_204, 81_204, at(0, 14, 7)), tx(2, 'send', -5_012_000, 12_000, at(0, 13, 0)), tx(3, 'renew', -1_108_000, 3_000, at(0, 3, 0))],
      NOW,
      0,
    );
    expect(day.rows.map((r) => [r.icon, r.name, r.line, r.amount, r.incoming])).toEqual([
      ['spend', 'Spent at a terminal', '14:07 · fee under 82 sat', '−19,000', false],
      ['out', 'Sent out', '13:00 · fee 12 sat', '−5,000', false],
      ['renew', 'Renewed the VM', '03:00 · fee 3 sat', '−1,105', false],
    ]);
  });

  it("names a move by its leg's sign, and a wipe's two legs", () => {
    const [day] = historyRows(
      [tx(1, 'move', 10_000_000, 0, at(0, 18, 30)), tx(2, 'move', -10_000_000, 0, at(0, 18, 30)), tx(3, 'wipe', -13_291_000, 0, at(0, 12, 0)), tx(4, 'wipe', 13_291_000, 0, at(0, 12, 0))],
      NOW,
      0,
    );
    expect(day.rows.map((r) => [r.icon, r.name, r.amount, r.incoming])).toEqual([
      ['move', 'Moved in', '+10,000', true],
      ['move', 'Moved out', '−10,000', false],
      ['wipe', 'Wiped', '−13,291', false],
      ['in', 'From a wiped card', '+13,291', true],
    ]);
  });

  it('names the other kinds and an unknown one by its own name, in whole sats to the nearest whole sat', () => {
    const [day] = historyRows(
      [tx(1, 'topup', 32_623_000, 0, at(0, 9, 5)), tx(2, 'fee-adjust', -1_204, 0, at(0, 9, 4)), tx(3, 'adjust', -400, 0, at(0, 9, 3)), tx(4, 'adjust', 0, 0, at(0, 9, 2)), tx(5, 'gift', 2_100_000, 0, at(0, 9, 1))],
      NOW,
      0,
    );
    expect(day.rows.map((r) => [r.icon, r.name, r.amount, r.incoming])).toEqual([
      ['in', 'Top-up', '+32,623', true],
      ['fee', 'Routing fee over budget', '−1', false],
      ['books', 'Books set', '−0', false],
      ['books', 'Books set', '0', false],
      ['dot', 'gift', '+2,100', true],
    ]);
  });

  it('shows a move of a part of a sat to the nearest whole sat in sat view, and says it so', () => {
    const [day] = historyRows([tx(1, 'move', -74_916, 0, at(0, 10, 29)), tx(2, 'move', 932_496, 0, at(0, 10, 28))], NOW, 0);
    expect(day.rows.map((r) => [r.amount, r.label])).toEqual([
      ['−75', 'Moved out, 10:29, minus 75 sat'],
      ['+932', 'Moved in, 10:28, plus 932 sat'],
    ]);
  });

  it('shows a top-up that paid a fee as what arrived, the fee on the line under as paid to ACINQ for the channel', () => {
    const [day] = historyRows([tx(1, 'topup', 49_000_000, 1_000_000, at(0, 9, 5))], NOW, 0);
    expect([day.rows[0].amount, day.rows[0].line]).toEqual(['+49,000', '09:05 · 1,000 sat to ACINQ for the channel']);
  });

  it("says a top-up's channel fee as paid to ACINQ, and only a top-up with nothing and no fee as fee credit", () => {
    const [day] = historyRows(
      [tx(4, 'topup', 7_673_000, 22_327_000, at(0, 9, 35)), tx(3, 'topup', 1_000_000, 4_084, at(0, 9, 30)), tx(2, 'topup', 0, 2_500_000, at(0, 9, 20)), tx(1, 'topup', 0, 0, at(0, 9, 10))],
      NOW,
      0,
    );
    expect(day.rows.map((r) => [r.line, r.amount, r.incoming])).toEqual([
      ['09:35 · 22,327 sat to ACINQ for the channel', '+7,673', true],
      ['09:30 · under 5 sat to ACINQ for the channel', '+1,000', true],
      ['09:20 · 2,500 sat to ACINQ for the channel', '+0', true],
      ['09:10 · to fee credit', '+0', true],
    ]);
    expect(day.rows[0].label).toBe('Top-up, 09:35, 22,327 sat to ACINQ for the channel, plus 7,673 sat');
    expect(day.rows[2].label).toBe('Top-up, 09:20, 2,500 sat to ACINQ for the channel, plus 0 sat');
  });

  it("leaves the server's note off every line", () => {
    const notes = ['paid 3f9a…', 'moved by the phone', 'received 32,623 sat', 'card wiped: its balance moved to pool', 'routing fee 81204 msat was above the 80000 msat budget'];
    const kinds = ['spend', 'move', 'topup', 'wipe', 'fee-adjust'];
    const [day] = historyRows(kinds.map((k, i) => tx(i, k, -1000, 0, at(0, 12, i), notes[i])), NOW, 0);
    for (const r of day.rows) expect(r.line).toMatch(/^12:0\d$/);
  });

  it('says each row aloud: its name, time, fee and the amount with plus or minus', () => {
    const [day] = historyRows([tx(1, 'spend', -2_101_000, 1_000, at(0, 14, 7)), tx(2, 'topup', 5_000_000, 0, at(0, 9, 0)), tx(3, 'adjust', 0, 0, at(0, 8, 0))], NOW, 0);
    expect(day.rows.map((r) => r.label)).toEqual(['Spent at a terminal, 14:07, fee 1 sat, minus 2,100 sat', 'Top-up, 09:00, plus 5,000 sat', 'Books set, 08:00, 0 sat']);
  });

  it('gives nothing for no entries', () => {
    expect(historyRows([], NOW, 0)).toEqual([]);
  });

  // A sale's facts and a move's other account, where cardd gives them.
  const sale = (id: number, amountMsat: number, created: number, method: 'card' | 'qr', device: string, priceMsat = amountMsat) => ({
    ...tx(id, 'sale', amountMsat, 0, created, 'received 2500 sat'),
    sale: { id: `00000000-0000-4000-8000-00000000000${id}`, method, device, priceMsat },
  });

  it('names a sale, with how it was paid and the phone that took it', () => {
    const [day] = historyRows([sale(2, 2_500_000, at(0, 14, 2), 'card', 'Till 1'), sale(1, 1_000_000, at(0, 13, 0), 'qr', 'Front')], NOW, 0);
    expect(day.rows.map((r) => [r.icon, r.name, r.line, r.amount, r.incoming])).toEqual([
      ['sale', 'Sale', '14:02 · Card · Till 1', '+2,500', true],
      ['sale', 'Sale', '13:00 · QR · Front', '+1,000', true],
    ]);
    expect(day.rows[0].label).toBe('Sale, 14:02, Card, Till 1, plus 2,500 sat');
  });

  it("shows a top-up the books credited nothing of: it went to phoenixd's fee credit", () => {
    const [day] = historyRows([tx(2, 'topup', 0, 0, at(0, 14, 2)), tx(1, 'topup', 3_000_000, 0, at(0, 14, 0))], NOW, 0);
    expect(day.rows.map((r) => [r.icon, r.name, r.line, r.amount, r.incoming])).toEqual([
      ['in', 'Top-up', '14:02 · to fee credit', '+0', true],
      ['in', 'Top-up', '14:00', '+3,000', true],
    ]);
    expect(day.rows[0].label).toBe('Top-up, 14:02, to fee credit, plus 0 sat');
  });

  it('shows a sale cardd has no record of with the time alone', () => {
    const [day] = historyRows([tx(1, 'sale', 2_100_000, 0, at(0, 12, 0), 'received 2100 sat (no record of this sale)')], NOW, 0);
    expect(day.rows.map((r) => [r.icon, r.name, r.line, r.amount, r.incoming])).toEqual([['sale', 'Sale', '12:00', '+2,100', true]]);
  });

  it('says where the rest of a sale credited less than its price went, and nothing of one overpaid', () => {
    const [day] = historyRows(
      [sale(3, 2_000_000, at(0, 14, 2), 'card', 'Till 1', 2_500_000), sale(2, 0, at(0, 14, 1), 'qr', 'Till 1', 2_500_000), sale(1, 2_600_000, at(0, 14, 0), 'qr', 'Till 1', 2_500_000)],
      NOW,
      0,
    );
    expect(day.rows.map((r) => [r.line, r.amount, r.incoming])).toEqual([
      ['14:02 · Card · Till 1 · 500 sat to channel fees', '+2,000', true],
      ['14:01 · QR · Till 1 · 2,500 sat to channel fees', '+0', true],
      ['14:00 · QR · Till 1', '+2,600', true],
    ]);
    expect(day.rows[1].label).toBe('Sale, 14:01, QR, Till 1, 2,500 sat to channel fees, plus 0 sat');
  });

  it('names a move for its other account: Pool, Hosting, Shop, a card by its name', () => {
    const daily = '0123456789abcdef0123456789abcdef';
    const blank = 'fedcba9876543210fedcba9876543210';
    const gone = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const cards = [{ id: daily, name: 'Daily card' }, { id: blank, name: '' }];
    const move = (id: number, amountMsat: number, other?: string) => ({ ...tx(id, 'move', amountMsat, 0, at(0, 18, 30), 'moved by the phone'), ...(other ? { other } : {}) });
    const [day] = historyRows(
      [move(9, -1000, 'pool'), move(8, 1000, 'hosting'), move(7, 1000, 'shop'), move(6, -1000, daily), move(5, 1000, daily), move(4, -1000, blank), move(3, 1000, gone), move(2, 1000), move(1, -1000)],
      NOW,
      0,
      { cards },
    );
    expect(day.rows.map((r) => r.name)).toEqual([
      'Moved to Pool', 'Moved from Hosting', 'Moved from Shop', 'Moved to Daily card', 'Moved from Daily card', 'Moved to a card', 'Moved from a card', 'Moved in', 'Moved out',
    ]);
    expect(day.rows.every((r) => r.icon === 'move' && r.line === '18:30')).toBe(true);
    // Without the wallet's cards a card is a card.
    expect(historyRows([move(6, -1000, daily)], NOW, 0)[0].rows[0].name).toBe('Moved to a card');
  });

  it("heads Shop's days with their sales, where the server counted the day", () => {
    const txs = [sale(5, 2_500_000, at(0, 14, 2), 'card', 'Till 1'), sale(4, 0, at(0, 9, 0), 'qr', 'Till 1', 9_900_000), tx(3, 'move', -1_000_000, 0, at(1, 18, 0)), sale(2, 1_000_000, at(2, 12, 0), 'qr', 'Till 1'), sale(1, 500_000, at(3, 12, 0), 'qr', 'Till 1')];
    // The phone is two hours east: its days start at 22:00 UTC.
    const start = (daysAgo: number) => Date.UTC(2026, 8, 20 - daysAgo, 22, 0) / 1000;
    const days = [{ day: start(0), count: 2, totalMsat: 12_400_000 }, { day: start(2), count: 1, totalMsat: 1_000_000 }];
    expect(historyRows(txs, NOW, 120, { days }).map((d) => d.day)).toEqual(['Today · 2 sales · 12,400 sat', 'Yesterday', '19 Sep · 1 sale · 1,000 sat', '18 Sep']);
    // A day counted in another offset's days isn't this one's.
    expect(historyRows(txs, NOW, 0, { days }).map((d) => d.day)).toEqual(['Today', 'Yesterday', '19 Sep', '18 Sep']);
    expect(historyRows(txs, NOW, 120).map((d) => d.day)).toEqual(['Today', 'Yesterday', '19 Sep', '18 Sep']);
  });

  it("keeps a sale dated a moment ahead of the phone's clock, across midnight, under today's own heading", () => {
    // The server's clock runs a little fast: at 23:59:50 here it dates a sale 00:00:20, which it counts in tomorrow's day.
    const now = Date.UTC(2026, 8, 21, 23, 59, 50) / 1000;
    const days = [{ day: Date.UTC(2026, 8, 22) / 1000, count: 1, totalMsat: 1_000_000 }, { day: Date.UTC(2026, 8, 21) / 1000, count: 2, totalMsat: 3_000_000 }];
    const out = historyRows([sale(3, 1_000_000, now + 30, 'qr', 'Till 1'), sale(2, 2_000_000, now - 60, 'card', 'Till 1'), sale(1, 1_000_000, now - 3600, 'qr', 'Till 1')], now, 0, { days });
    // One Today, never a day of its own above it; its heading is today's count until the phone's own midnight.
    expect(out.map((d) => [d.day, d.rows.map((r) => r.id)])).toEqual([['Today · 2 sales · 3,000 sat', [3, 2, 1]]]);
  });

  // Every row keeps its sats; in £ view its figure is today's value marked "now"; a sale rung up in £ says
  // "priced £2.50" in its line, never converted; fees follow the view; *** hides all of it.
  describe("in the app's view", () => {
    const GBP: Rated = { currency: 'GBP', price: 61_352, time: NOW };
    const pricedSale = (id: number, amountMsat: number, created: number, minor: number) => {
      const s = sale(id, amountMsat, created, 'card', 'Till 1');
      return { ...s, sale: { ...s.sale, price: { currency: 'GBP' as const, minor } } };
    };
    const rows = (view: 'fiat' | 'sat' | 'msat' | 'hidden', rated: Rated | null = GBP) =>
      historyRows([pricedSale(2, 4_386_000, at(0, 14, 2), 250), tx(1, 'spend', -2_101_000 - 4_412, 4_412, at(0, 13, 0))], NOW, 0, { view, rated })[0].rows;

    it('in sat view: the sats, "priced" in the line, and the label in the order a screen reader wants', () => {
      const [s, spend] = rows('sat');
      expect([s.amount, s.msat, s.sign, s.now, s.line]).toEqual(['+4,386', 4_386_000, '+', false, '14:02 · Card · Till 1 · priced £2.50']);
      expect(s.label).toBe(`Sale, 14:02, Card, Till 1, priced ${minorSpoken(250, 'GBP')}, plus 4,386 sat`);
      expect([spend.amount, spend.line]).toEqual(['−2,101', '13:00 · fee under 5 sat']);
    });

    it('in £ view: today\'s value marked now, the price as it was set, and the fee in pounds', () => {
      const [s, spend] = rows('fiat');
      expect([s.amount, s.now, s.line]).toEqual(['+2.69', true, '14:02 · Card · Till 1 · priced £2.50']);
      expect(s.label).toBe(`Sale, 14:02, Card, Till 1, priced ${minorSpoken(250, 'GBP')}, worth ${fiatSpoken(4_386_000, GBP)} at today's rate`);
      expect([spend.amount, spend.now, spend.line]).toEqual(['−1.29', true, '13:00 · fee under £0.01']);
    });

    it('in msat view: exact, the fee too', () => {
      const [s, spend] = rows('msat');
      expect([s.amount, s.label.endsWith('plus 4,386,000 msat')]).toEqual(['+4,386,000', true]);
      expect([spend.amount, spend.line]).toEqual(['−2,101,000', '13:00 · fee 4,412 msat']);
    });

    it('in ***: the figure, the fee and the price hidden, the sign too', () => {
      const [s, spend] = rows('hidden');
      expect([s.amount, s.sign, s.now, s.line]).toEqual(['***', '', false, '14:02 · Card · Till 1 · priced ***']);
      expect(s.label).toBe('Sale, 14:02, Card, Till 1, price hidden, amount hidden');
      expect([spend.amount, spend.line]).toEqual(['***', '13:00 · fee ***']);
      const short = historyRows([sale(3, 2_000_000, at(0, 14, 2), 'card', 'Till 1', 2_500_000)], NOW, 0, { view: 'hidden', rated: GBP })[0].rows[0];
      expect(short.line).toBe('14:02 · Card · Till 1 · *** to channel fees');
    });

    it('says what a priced sale lost to channel fees as today\'s value "now" in £ view, beside its price as set', () => {
      const s = pricedSale(3, 4_000_000, at(0, 14, 2), 250);
      const short = { ...s, sale: { ...s.sale, priceMsat: 4_500_000 } };
      const line = (view: 'fiat' | 'sat' | 'msat' | 'hidden') => historyRows([short], NOW, 0, { view, rated: GBP })[0].rows[0];
      expect(line('fiat').line).toBe('14:02 · Card · Till 1 · priced £2.50 · £0.31 now to channel fees');
      expect(line('fiat').label).toBe(
        `Sale, 14:02, Card, Till 1, priced ${minorSpoken(250, 'GBP')}, ${fiatSpoken(500_000, GBP)} now to channel fees, worth ${fiatSpoken(4_000_000, GBP)} at today's rate`,
      );
      expect(line('sat').line).toBe('14:02 · Card · Till 1 · priced £2.50 · 500 sat to channel fees');
      expect(line('msat').line).toBe('14:02 · Card · Till 1 · priced £2.50 · 500,000 msat to channel fees');
    });

    it('says no "priced" for a sale in a currency this app does not know, as Karto PoS shows it', () => {
      const s = sale(4, 4_386_000, at(0, 14, 2), 'card', 'Till 1');
      const unknown = { ...s, sale: { ...s.sale, price: { currency: 'XAU', minor: 250 } } } as unknown as Tx;
      const [row] = historyRows([unknown], NOW, 0, { view: 'sat', rated: GBP })[0].rows;
      expect([row.line, row.amount]).toEqual(['14:02 · Card · Till 1', '+4,386']);
    });

    it('says a figure under a penny with its sign as "−under 0.01", never "−< 0.01"', () => {
      const [t] = historyRows([tx(1, 'move', -5_000, 0, at(0, 9, 0)), tx(2, 'move', 5_000, 0, at(0, 8, 0))], NOW, 0, { view: 'fiat', rated: GBP })[0].rows;
      expect([t.amount, t.label]).toEqual(['−under 0.01', "Moved out, 09:00, worth under 1 penny at today's rate"]);
    });

    it('shows sats in a £ view that has no rate, so no row is ever empty', () => {
      const [s] = rows('fiat', null);
      expect([s.amount, s.now]).toEqual(['+4,386', false]);
    });

    it("heads Shop's days with the day's value now, from the total the heading shows, not the rows loaded", () => {
      // Two sales that day, one loaded so far (Load more brings the other): the heading's figure is sales/days' total.
      const txs = [pricedSale(2, 4_386_000, at(0, 14, 2), 250)];
      const days = [{ day: Date.UTC(2026, 8, 21) / 1000, count: 2, totalMsat: 13_250_000 }];
      const heading = (view: 'fiat' | 'sat' | 'msat' | 'hidden', rated: Rated | null = GBP) => historyRows(txs, NOW, 0, { days, view, rated })[0].day;
      expect(heading('sat')).toBe('Today · 2 sales · 13,250 sat · £8.13 now');
      expect(heading('fiat')).toBe('Today · 2 sales · £8.13 now');
      expect(heading('msat')).toBe('Today · 2 sales · 13,250,000 msat · £8.13 now');
      expect(heading('hidden')).toBe('Today · 2 sales · ***');
      expect(heading('sat', null)).toBe('Today · 2 sales · 13,250 sat');
    });
  });
});

// An amount typed in the currency, and a card's limits in their own unit.
describe('typing an amount in the currency', () => {
  const GBP = { currency: 'GBP' as const, price: 61_352, time: 1_792_037_404 };

  it('turns what is typed into msat: whole sats, or a price in the currency as the whole sats it is at the rate', () => {
    expect(typedMsat('8,150', 'sat', GBP)).toBe(8_150_000);
    expect(typedMsat('5.00', 'fiat', GBP)).toBe(8_150_000);
    expect(typedMsat('5,5', 'fiat', GBP)).toBe(8_965_000);
    expect(typedMsat('5.005', 'fiat', GBP)).toBeNull();
    expect(typedMsat('', 'fiat', GBP)).toBeNull();
    // With no rate a field types sat, whatever the phone last typed in.
    expect(typedMsat('500', 'fiat', null)).toBe(500_000);
    expect(typedMsat('5.00', 'fiat', null)).toBeNull();
  });

  it('turns what is typed into the other unit when the chip is tapped; nothing when it is no amount', () => {
    expect(convertTyped('5.00', 'sat', GBP)).toBe('8150');
    expect(convertTyped('8150', 'fiat', GBP)).toBe('5.00');
    expect(convertTyped('20,000', 'fiat', GBP)).toBe('12.27');
    expect(convertTyped('', 'sat', GBP)).toBe('');
    expect(convertTyped('abc', 'fiat', GBP)).toBe('');
  });

  it('moves a price typed in the currency as its whole sats, and All as every msat available', () => {
    expect(moveAmountMsat(false, '5', 13_438_796, 'fiat', GBP)).toBe(8_150_000);
    expect(moveAmountMsat(true, '5', 13_438_796, 'fiat', GBP)).toBe(13_438_796);
    expect(moveAmountMsat(false, '5', 13_438_796)).toBe(5_000);
  });

  it("says a card's limits in their own unit, and when their currency is no longer the server's", () => {
    expect(limitsNow({ perTapSat: 20_000, dailySat: 50_000 }, 'GBP')).toEqual({ line: 'Now 50,000 sat a day · 20,000 sat a tap', note: null });
    const eur = { currency: 'EUR' as const, perTapMinor: 500, dailyMinor: 2_050 };
    expect(limitsNow({ perTapSat: 8_149, dailySat: 33_413, limits: eur }, 'EUR')).toEqual({ line: 'Now €20.50 a day · €5 a tap', note: null });
    expect(limitsNow({ perTapSat: 8_149, dailySat: 33_413, limits: eur }, 'GBP').note).toBe("Set in euros, which is no longer your server's currency: change them in sat or GBP.");
    expect(limitsNow({ perTapSat: 8_149, dailySat: 33_413, limits: eur }, null).note).toBe("Set in euros, which is no longer your server's currency: change them in sat.");
  });

  it("knows limits in the server's currency while it has no rate for a moment, offering only what has one", () => {
    const gbp = { currency: 'GBP' as const, perTapMinor: 500, dailyMinor: 2_000 };
    expect(limitsNow({ perTapSat: 8_149, dailySat: 32_598, limits: gbp }, 'GBP', null).note).toBeNull();
    const eur = { currency: 'EUR' as const, perTapMinor: 500, dailyMinor: 2_000 };
    expect(limitsNow({ perTapSat: 8_149, dailySat: 32_598, limits: eur }, 'GBP', null).note).toBe("Set in euros, which is no longer your server's currency: change them in sat.");
  });
});

describe('a line\'s note and figure', () => {
  const NOW = 1_790_000_000;
  it("shows a line's note and reads it last", () => {
    const tx: Tx = { id: 7, kind: 'send', note: 'paid aa', comment: 'Coffee with Sam', amountMsat: -21_000, feeMsat: 0, created: NOW };
    const [day] = historyRows([tx], NOW, 0);
    expect(day.rows[0].comment).toBe('Coffee with Sam');
    expect(day.rows[0].label.endsWith(', Coffee with Sam')).toBe(true);
    const [plain] = historyRows([{ ...tx, comment: undefined }], NOW, 0);
    expect(plain.rows[0].comment).toBe('');
  });

  // A top-up's payer's note, in quotes, before the person's own; read after the worth.
  it("shows a payer's note in quotes and reads it after the worth, before the person's own note", () => {
    const top: Tx = { id: 8, kind: 'topup', note: 'received 5000 sat', payerNote: 'refund, order 1043', amountMsat: 5_000_000, feeMsat: 0, created: NOW };
    const [day] = historyRows([top], NOW, 0);
    expect(day.rows[0]).toMatchObject({ payerNote: '“refund, order 1043”', comment: '' });
    expect(day.rows[0].label.endsWith(', plus 5,000 sat, note from the payer, refund, order 1043')).toBe(true);
    const [both] = historyRows([{ ...top, comment: 'from the meetup' }], NOW, 0);
    expect(both.rows[0].label.endsWith(', note from the payer, refund, order 1043, from the meetup')).toBe(true);
    const [hidden] = historyRows([top], NOW, 0, { view: 'hidden' });
    expect(hidden.rows[0].payerNote).toBe('“refund, order 1043”');
    const [none] = historyRows([{ ...top, payerNote: undefined }], NOW, 0);
    expect(none.rows[0].payerNote).toBe('');
    expect(none.rows[0].label).not.toContain('payer');
  });

  it('lineAmount: a charge without its fee, money in with its plus', () => {
    expect(lineAmount({ id: 1, kind: 'send', note: '', amountMsat: -21_400, feeMsat: 400, created: 0 })).toEqual({ msat: -21_000, plus: false });
    expect(lineAmount({ id: 2, kind: 'topup', note: '', amountMsat: 0, feeMsat: 0, created: 0 })).toEqual({ msat: 0, plus: true });
  });

  it('lineAmount agrees with the row for spend, renew, sale, a move out and a fee-adjust', () => {
    const t = (kind: string, amountMsat: number, feeMsat: number): Tx => ({ id: 1, kind, note: '', amountMsat, feeMsat, created: NOW });
    const cases: [Tx, { msat: number; plus: boolean }, string][] = [
      [t('spend', -2_101_000, 1_000), { msat: -2_100_000, plus: false }, '−2,100'],
      [t('renew', -5_004_000, 4_000), { msat: -5_000_000, plus: false }, '−5,000'],
      [t('sale', 2_100_000, 0), { msat: 2_100_000, plus: true }, '+2,100'],
      // The row rounds to the nearest whole sat, not down.
      [t('move', -74_916, 0), { msat: -74_916, plus: false }, '−75'],
      [t('adjust', -3_000, 1_000), { msat: -3_000, plus: false }, '−3'],
    ];
    for (const [tx, want, shown] of cases) {
      expect(lineAmount(tx)).toEqual(want);
      expect(historyRows([tx], NOW, 0)[0].rows[0].amount).toBe(shown);
    }
  });
});

// A refund of a till sale, and the sale it gave back, in Shop's history.
describe('historyRows with refunds', () => {
  const NOW_R = Date.UTC(2026, 9, 19, 15, 0, 0) / 1000;
  const soldAt = Date.UTC(2026, 9, 19, 13, 2, 0) / 1000;
  const refundedAt = Date.UTC(2026, 9, 19, 14, 10, 0) / 1000;
  const sale: Tx = { id: 3, kind: 'sale', note: 'received', amountMsat: 8_000_000, feeMsat: 0, created: soldAt,
    sale: { id: 's', method: 'card', device: 'Front', priceMsat: 8_000_000, paidAt: soldAt, refund: { state: 'paid', txId: 9, at: refundedAt, amountMsat: 7_650_000, from: 'shop' } } };
  const refund: Tx = { id: 9, kind: 'refund', note: 'refund of sale s, paid ab', amountMsat: -7_653_000, feeMsat: 3_000, created: refundedAt,
    sale: { id: 's', method: 'card', device: 'Front', priceMsat: 8_000_000, paidAt: soldAt, refund: { state: 'paid', txId: 9, at: refundedAt, amountMsat: 7_650_000, from: 'shop' } } };

  it('names a refund line by the sale it gave back, its amount without the fee', () => {
    const [row] = historyRows([refund], NOW_R, 0)[0].rows;
    expect(row).toMatchObject({ name: 'Refund', icon: 'out', amount: '−7,650', line: '14:10 · for the sale of 13:02 · fee 3 sat' });
    expect(lineAmount(refund)).toEqual({ msat: -7_650_000, plus: false });
  });

  // The receiving card's line, its leg positive.
  it("draws the receiving card's refund line as money in", () => {
    const received: Tx = { ...refund, id: 10, amountMsat: 7_650_000, feeMsat: 0, other: 'shop' };
    const [row] = historyRows([received], NOW_R, 0)[0].rows;
    expect(row).toMatchObject({ name: 'Refund', icon: 'in', amount: '+7,650', line: '14:10 · for the sale of 13:02', incoming: true });
  });

  // A top-up that came through one of this server's refund links.
  it('names a top-up that came through a refund link Refund', () => {
    const back: Tx = { id: 11, kind: 'topup', via: 'refund', note: 'received 50 sat', amountMsat: 50_000, feeMsat: 0, created: refundedAt };
    const [row] = historyRows([back], NOW_R, 0)[0].rows;
    expect(row).toMatchObject({ name: 'Refund', icon: 'in', amount: '+50', incoming: true });
    expect(row.label).toMatch(/^Refund, /);
    const plain = { ...back, via: undefined };
    expect(historyRows([plain], NOW_R, 0)[0].rows[0].name).toBe('Top-up');
  });

  it('marks the refunded sale, and only once its refund is paid', () => {
    const [row] = historyRows([sale], NOW_R, 0)[0].rows;
    expect(row.refunded).toBe(true);
    expect(row.label).toMatch(/, refunded$/);
    const pending = { ...sale, sale: { ...sale.sale!, refund: { state: 'pending' as const } } };
    expect(historyRows([pending], NOW_R, 0)[0].rows[0].refunded).toBeUndefined();
  });
});
