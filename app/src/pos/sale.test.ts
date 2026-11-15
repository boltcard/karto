import { describe, expect, it } from 'vitest';
import { minorSpoken } from '../money/fiat';
import type { PosSale } from './client';
import { afterOverlay, leftOpen, readsNow, takesCard, CARD_WAIT_MS, paidView, ranOutView, readsAgainAtOnce, SALE_WAIT_S, saleFigure, saleQr, saleStart, saleStep, waitingLine, WATCH_PAST_S, watched, type SaleState, type Watched } from './sale';

const NOW = 1_790_000_000; // 2026-09-21 14:13:20 UTC
const ID = '00000000-0000-4000-8000-000000000001';
const sale = (o: Partial<PosSale> = {}): PosSale => ({
  id: '00000000-0000-4000-8000-000000000001', amountMsat: 2_500_000, state: 'open', method: '', device: { keyId: 'b18b86ce1389e46d', name: 'Till 1' },
  created: NOW, expires: NOW + 600, invoice: 'lnbc25u1xyz', ...o,
});
const paid = (o: Partial<PosSale> = {}) => sale({ state: 'paid', method: 'qr', paidAt: NOW + 30, txId: 7, invoice: undefined, ...o });
const start = saleStart(sale());
const run = (s: SaleState, ...events: Parameters<typeof saleStep>[1][]) => events.reduce((acc, e) => saleStep(acc.state, e), { state: s, effects: [] as string[], leave: null as null | string });
const cardRead = run(start, { kind: 'card', saleId: ID, outcome: { kind: 'accepted' }, nowMs: 5_000 }).state;
const refused = run(start, { kind: 'card', saleId: ID, outcome: { kind: 'refused', said: true, reason: "over this card's limit for one payment" }, nowMs: 5_000 }).state;

// saleStep holds the screen; watched holds the ended sales still read.
describe('saleStep', () => {
  it('starts waiting, with the sale as cardd made it', () => {
    expect(start).toEqual({ at: 'waiting', sale: sale(), note: '', online: true });
  });

  describe('a read of the sale', () => {
    it('keeps waiting while it is open, and clears the lost connection', () => {
      const offline = saleStep(start, { kind: 'offline' }).state;
      expect(offline).toMatchObject({ at: 'waiting', online: false });
      expect(saleStep(offline, { kind: 'read', sale: sale() })).toEqual({ state: start, effects: [], leave: null });
    });

    it('is Paid from waiting, from card read and from the refused panel, with the buzz and the chime', () => {
      for (const s of [start, cardRead, refused]) {
        expect(saleStep(s, { kind: 'read', sale: paid() }), s.at).toEqual({ state: { at: 'paid', sale: paid(), how: '' }, effects: ['paid'], leave: null });
      }
    });

    it('is the ran-out page when the sale expired, and says nothing of ten minutes when it was cancelled', () => {
      expect(saleStep(start, { kind: 'read', sale: sale({ state: 'expired' }) }).state).toEqual({ at: 'ran-out', sale: sale({ state: 'expired' }), cancelled: false });
      expect(saleStep(start, { kind: 'read', sale: sale({ state: 'cancelled' }) }).state).toMatchObject({ at: 'ran-out', cancelled: true });
      expect(saleStep(cardRead, { kind: 'read', sale: sale({ state: 'expired' }) }).state).toMatchObject({ at: 'ran-out' });
    });

    it('changes nothing once the sale is paid or ran out: the page stays until the person leaves it', () => {
      const done = saleStep(start, { kind: 'read', sale: paid() }).state;
      expect(saleStep(done, { kind: 'read', sale: sale({ state: 'expired' }) }).state).toBe(done);
      const out = saleStep(start, { kind: 'read', sale: sale({ state: 'expired' }) }).state;
      expect(saleStep(out, { kind: 'read', sale: sale() }).state).toBe(out);
      // But a ran-out sale that is paid after all is Paid.
      expect(saleStep(out, { kind: 'read', sale: paid() }).state).toMatchObject({ at: 'paid', how: 'after-ran-out' });
    });

    it("is for this sale only: another sale's read is ignored", () => {
      expect(saleStep(start, { kind: 'read', sale: paid({ id: '00000000-0000-4000-8000-000000000002' }) }).state).toBe(start);
    });
  });

  describe('no answer from the shop', () => {
    it('says so in the waiting line and keeps asking; on any other page it shows nothing', () => {
      expect(saleStep(start, { kind: 'offline' }).state).toEqual({ ...start, online: false });
      expect(saleStep(cardRead, { kind: 'offline' }).state).toBe(cardRead);
      expect(saleStep(refused, { kind: 'offline' }).state).toBe(refused);
    });
  });

  describe('a card held', () => {
    it('accepted: Card read, and the shop is told a card was read', () => {
      expect(saleStep(start, { kind: 'card', saleId: ID, outcome: { kind: 'accepted' }, nowMs: 5_000 })).toEqual({
        state: { at: 'card-read', sale: sale(), since: 5_000, canLeave: false }, effects: ['tell-card'], leave: null,
      });
    });

    it('refused: two buzzes and the red panel, in the server\'s words or the till\'s', () => {
      expect(saleStep(start, { kind: 'card', saleId: ID, outcome: { kind: 'refused', said: true, reason: 'limit' }, nowMs: 1 })).toEqual({
        state: { at: 'refused', sale: sale(), said: true, reason: 'limit' }, effects: ['buzz-refused'], leave: null,
      });
    });

    it("an amber line, and the sale goes on, for a card that isn't one, one lifted too soon, or a server out of reach", () => {
      const note = (outcome: Parameters<typeof saleStep>[1] & { kind: 'card' }) => saleStep(start, outcome);
      expect(note({ kind: 'card', saleId: ID, outcome: { kind: 'not-a-card' }, nowMs: 1 })).toEqual({ state: { ...start, note: "That isn't a Bolt Card that can pay." }, effects: [], leave: null });
      expect(note({ kind: 'card', saleId: ID, outcome: { kind: 'moved-away' }, nowMs: 1 }).state).toMatchObject({ at: 'waiting', note: 'The card moved away. Hold it still.' });
      expect(note({ kind: 'card', saleId: ID, outcome: { kind: 'unreachable' }, nowMs: 1 }).state).toMatchObject({ at: 'waiting', note: "Can't reach that card's server." });
      // The till's own refusal of a link that isn't a Bolt Card's is that amber line too, not the red panel.
      expect(note({ kind: 'card', saleId: ID, outcome: { kind: 'refused', said: false, reason: "That isn't a Bolt Card that can pay." }, nowMs: 1 }).state).toMatchObject({ at: 'waiting', note: "That isn't a Bolt Card that can pay." });
    });

    it('is ignored while one is being paid, on the refused panel, and once the sale is over', () => {
      const again = { kind: 'card', saleId: ID, outcome: { kind: 'accepted' }, nowMs: 9_000 } as const;
      expect(saleStep(cardRead, again)).toEqual({ state: cardRead, effects: [], leave: null });
      expect(saleStep(refused, again).state).toBe(refused);
      const done = saleStep(start, { kind: 'read', sale: paid() }).state;
      expect(saleStep(done, again).state).toBe(done);
    });

    // A card's server may answer after the person has moved on: an outcome is for the sale its card was held to.
    it("is for the sale it was held to: another sale's outcome changes nothing", () => {
      const late = { kind: 'card', saleId: '00000000-0000-4000-8000-000000000009', outcome: { kind: 'accepted' }, nowMs: 9_000 } as const;
      expect(saleStep(start, late)).toEqual({ state: start, effects: [], leave: null });
      const refusedLate = { ...late, outcome: { kind: 'refused', said: true, reason: 'x' } } as const;
      expect(saleStep(start, refusedLate)).toEqual({ state: start, effects: [], leave: null });
    });

    it('is being read: the note is cleared for the next card', () => {
      const noted = saleStep(start, { kind: 'card', saleId: ID, outcome: { kind: 'moved-away' }, nowMs: 1 }).state;
      expect(saleStep(noted, { kind: 'card-held' }).state).toEqual(start);
      expect(saleStep(cardRead, { kind: 'card-held' }).state).toBe(cardRead);
    });
  });

  describe('Card read', () => {
    it('holds the person for 30 seconds: Back does nothing, and no button shows', () => {
      expect(CARD_WAIT_MS).toBe(30_000);
      expect(saleStep(cardRead, { kind: 'back' })).toEqual({ state: cardRead, effects: [], leave: null });
      expect(saleStep(cardRead, { kind: 'tick', nowMs: 34_999 }).state).toBe(cardRead);
      expect(saleStep(cardRead, { kind: 'stop-waiting' }).state).toBe(cardRead);
      expect(saleStep(cardRead, { kind: 'back-to-sale' }).state).toBe(cardRead);
    });

    it('then offers Stop waiting and Back to the sale', () => {
      const late = saleStep(cardRead, { kind: 'tick', nowMs: 35_000 }).state;
      expect(late).toEqual({ at: 'card-read', sale: sale(), since: 5_000, canLeave: true });
      // Stop waiting: back to the till, the sale left open and still watched.
      expect(saleStep(late, { kind: 'stop-waiting' })).toEqual({ state: late, effects: ['watch-stopped'], leave: 'till' });
      // Back to the sale: the code and the card row again, for the same invoice.
      expect(saleStep(late, { kind: 'back-to-sale' })).toEqual({ state: start, effects: [], leave: null });
      // Android's Back still does nothing: the two buttons are the ways out.
      expect(saleStep(late, { kind: 'back' })).toEqual({ state: late, effects: [], leave: null });
    });
  });

  describe('the refused panel', () => {
    it('goes back to the sale, the same invoice, or cancels it', () => {
      expect(saleStep(refused, { kind: 'back-to-sale' })).toEqual({ state: start, effects: [], leave: null });
      expect(saleStep(refused, { kind: 'cancel' })).toEqual({ state: refused, effects: ['cancel', 'watch-cancelled'], leave: 'till' });
      expect(saleStep(refused, { kind: 'back' })).toEqual({ state: start, effects: [], leave: null });
    });
  });

  describe('Cancel sale, ← and Android\'s Back', () => {
    it('ask the shop to cancel, keep the sale watched, and go back to the till with the amount cleared', () => {
      for (const kind of ['cancel', 'back'] as const) {
        expect(saleStep(start, { kind })).toEqual({ state: start, effects: ['cancel', 'watch-cancelled'], leave: 'till' });
      }
    });

    it('on Paid, Back is New sale; on the ran-out page it leaves too; neither cancels anything', () => {
      const done = saleStep(start, { kind: 'read', sale: paid() }).state;
      expect(saleStep(done, { kind: 'back' })).toEqual({ state: done, effects: [], leave: 'till' });
      const out = saleStep(start, { kind: 'read', sale: sale({ state: 'expired' }) }).state;
      expect(saleStep(out, { kind: 'back' })).toEqual({ state: out, effects: ['watch-ran-out'], leave: 'till' });
      expect(saleStep(done, { kind: 'cancel' }).effects).toEqual([]);
    });
  });
});

describe('waitingLine, saleQr and the pages\' words', () => {
  it('counts the sale down, and says when the shop can\'t be reached', () => {
    expect(waitingLine(sale(), NOW + 19, true)).toBe('Waiting for payment · 9:41 left');
    expect(waitingLine(sale(), NOW + 595, true)).toBe('Waiting for payment · 0:05 left');
    expect(waitingLine(sale(), NOW + 700, true)).toBe('Waiting for payment · 0:00 left');
    expect(waitingLine(sale(), NOW + 19, false)).toBe('No connection: still checking.');
  });

  it("makes the code a wallet scans: lightning: and the invoice, in capitals", () => {
    expect(saleQr('lnbc25u1xyz')).toBe('LIGHTNING:LNBC25U1XYZ');
  });

  it('says how a sale was paid, when, and by which phone', () => {
    const at = Date.UTC(2026, 8, 21, 14, 2) / 1000;
    expect(paidView(paid({ method: 'card', paidAt: at }), '', NOW, 0)).toEqual({ amount: '2,500 sat', line: 'By card · today at 14:02 · Till 1', how: '', label: 'Paid, 2,500 sat, By card · today at 14:02 · Till 1' });
    expect(paidView(paid({ paidAt: at }), 'after-cancel', NOW, 0)).toMatchObject({ line: 'By QR code · today at 14:02 · Till 1', how: 'after the sale was cancelled' });
    expect(paidView(paid({ paidAt: at }), 'after-ran-out', NOW, 0).how).toBe('after the sale ran out');
    expect(paidView(paid({ paidAt: at }), '', NOW, 120).line).toBe('By QR code · today at 16:02 · Till 1');
  });

  it('says a sale ran out, or only that nothing was paid after a cancel, and offers the same amount again', () => {
    expect(ranOutView(sale({ state: 'expired' }), false)).toEqual({ lines: ['This sale ran out after 10 minutes.', 'Nothing has been paid.'], again: 'Charge 2,500 sat again', charge: { sat: 2500 } });
    expect(ranOutView(sale({ state: 'cancelled' }), true).lines).toEqual(['Nothing has been paid.']);
  });

  // A sale rung up in a currency shows its price large, cardd's sats under
  // it, and is rung again at its price (its sats may differ from the first time).
  it('shows a priced sale by its price, with its sats, and rings it again at its price', () => {
    const priced = { price: { currency: 'GBP' as const, minor: 250 }, amountMsat: 4_075_000 };
    expect(saleFigure(sale())).toEqual({ figure: '2,500', unit: 'sat', under: null, label: '2,500 sat' });
    expect(saleFigure(sale(priced))).toEqual({ figure: '2.50', unit: 'GBP', under: '4,075 sat', label: `${minorSpoken(250, 'GBP')}, 4,075 sat` });
    expect(saleFigure(sale({ price: { currency: 'GBP', minor: 122_704 }, amountMsat: 2_000_000_000 }))).toMatchObject({ figure: '1,227.04' });
    expect(saleFigure(sale({ price: { currency: 'JPY', minor: 480 }, amountMsat: 3_756_000 }))).toMatchObject({ figure: '480', unit: 'JPY', under: '3,756 sat' });
    expect(ranOutView(sale({ ...priced, state: 'expired' }), false)).toMatchObject({ again: 'Charge £2.50 again', charge: { price: { currency: 'GBP', minor: 250 } } });
    const at = Date.UTC(2026, 8, 21, 14, 2) / 1000;
    expect(paidView(paid({ ...priced, method: 'card', paidAt: at }), '', NOW, 0)).toEqual({
      amount: '£2.50 · 4,075 sat', line: 'By card · today at 14:02 · Till 1', how: '', label: `Paid, ${minorSpoken(250, 'GBP')}, 4,075 sat, By card · today at 14:02 · Till 1`,
    });
  });
});

describe('watched', () => {
  const SHOP = 'vm-1001.lnvps.cloud';
  const w = (why: Watched['why'], o: Partial<Watched> = {}): Watched => ({ id: sale().id, expires: NOW + 600, why, host: SHOP, ...o });
  const other = '00000000-0000-4000-8000-000000000002';

  it('takes a sale that ended unpaid, once', () => {
    const one = watched([], { kind: 'add', sale: w('cancelled') });
    expect(one).toEqual({ list: [w('cancelled')], paid: null });
    expect(watched(one.list, { kind: 'add', sale: w('ran-out') }).list).toEqual([w('ran-out')]);
    expect(watched(one.list, { kind: 'add', sale: w('stopped', { id: other }) }).list).toHaveLength(2);
  });

  it('opens Paid when one is paid after all, says how, and stops watching it', () => {
    expect(watched([w('cancelled')], { kind: 'read', sale: paid() })).toEqual({ list: [], paid: { sale: paid(), how: 'after-cancel' } });
    expect(watched([w('ran-out')], { kind: 'read', sale: paid() }).paid).toEqual({ sale: paid(), how: 'after-ran-out' });
    // After Stop waiting the sale was still open: nothing more is said.
    expect(watched([w('stopped')], { kind: 'read', sale: paid() }).paid).toEqual({ sale: paid(), how: '' });
  });

  it('keeps one that is still unpaid, and ignores a read of a sale it isn\'t watching', () => {
    const list = [w('cancelled')];
    expect(watched(list, { kind: 'read', sale: sale({ state: 'cancelled' }) })).toEqual({ list, paid: null });
    expect(watched(list, { kind: 'read', sale: paid({ id: other }) })).toEqual({ list, paid: null });
  });

  it('drops a sale 15 seconds past its end, and one the shop no longer has', () => {
    expect(WATCH_PAST_S).toBe(15);
    const list = [w('cancelled'), w('stopped', { id: other, expires: NOW + 900 })];
    expect(watched(list, { kind: 'tick', nowS: NOW + 615, host: SHOP }).list).toEqual(list);
    expect(watched(list, { kind: 'tick', nowS: NOW + 616, host: SHOP }).list).toEqual([list[1]]);
    expect(watched(list, { kind: 'tick', nowS: NOW + 916, host: SHOP }).list).toEqual([]);
    expect(watched(list, { kind: 'gone', id: other }).list).toEqual([list[0]]);
  });

  // A sale is one shop's: its id is never asked of another server. A screen torn down after the phone was unpaired
  // can still hand a sale over to be watched, so each one carries its shop and the tick drops any that isn't this one's.
  it("drops a sale of another shop before it is ever read, and keeps this shop's", () => {
    const list = [w('cancelled'), w('stopped', { id: other, host: 'vm-1003.lnvps.cloud' })];
    expect(watched(list, { kind: 'tick', nowS: NOW, host: SHOP }).list).toEqual([list[0]]);
    expect(watched(list, { kind: 'tick', nowS: NOW, host: 'vm-1003.lnvps.cloud' }).list).toEqual([list[1]]);
    expect(watched(list, { kind: 'tick', nowS: NOW, host: 'vm-1010.lnvps.cloud' }).list).toEqual([]);
  });

  // The sale screen can be taken away by something other than its own ways out (the Paid page of an earlier sale
  // and its New sale, say): a sale left open then must still be read, or its payment would go unseen.
  it('says which sale a screen that was taken away leaves to be watched: one still open, and no other', () => {
    const open = sale();
    const stopped = { id: open.id, expires: open.expires, why: 'stopped', host: SHOP };
    expect(leftOpen({ at: 'waiting', sale: open, note: '', online: true }, SHOP)).toEqual(stopped);
    expect(leftOpen({ at: 'card-read', sale: open, since: 0, canLeave: false }, SHOP)).toEqual(stopped);
    expect(leftOpen({ at: 'refused', sale: open, said: true, reason: 'over the limit' }, SHOP)).toEqual(stopped);
    // Paid needs no watch; ran out or cancelled is watched already, with its own reason.
    expect(leftOpen({ at: 'paid', sale: sale({ state: 'paid' }), how: '' }, SHOP)).toBeNull();
    expect(leftOpen({ at: 'ran-out', sale: sale({ state: 'expired' }), cancelled: false }, SHOP)).toBeNull();
  });

  // The Paid page of an earlier sale can open over a second sale that is still waiting for its own customer.
  // Leaving that page (its button, or Android's Back) must not end the second sale: it is shown again.
  it('goes back to a sale that is open underneath when the Paid page over it is left, else to the till', () => {
    expect(afterOverlay(sale())).toBe('sale');
    expect(afterOverlay(null)).toBe('till');
  });

  // Which claim on the NFC slot is the newest can change while a page is over the sale screen (the sale screen
  // claims again whenever what the screens share changes), so the sale screen itself refuses a card then.
  it('reads a card only for a sale that waits, with nothing over its screen and no card already being read', () => {
    const waiting = { at: 'waiting', sale: sale(), note: '', online: true } as const;
    expect(takesCard(waiting, false, false)).toBe(true);
    expect(takesCard(waiting, false, true)).toBe(false);
    expect(takesCard(waiting, true, false)).toBe(false);
    expect(takesCard({ ...waiting, sale: sale({ invoice: undefined }) }, false, false)).toBe(false);
    expect(takesCard({ at: 'card-read', sale: sale(), since: 0, canLeave: false }, false, false)).toBe(false);
    expect(takesCard({ at: 'refused', sale: sale(), said: false, reason: '' }, false, false)).toBe(false);
    expect(takesCard({ at: 'paid', sale: sale({ state: 'paid' }), how: '' }, false, false)).toBe(false);
    expect(takesCard({ at: 'ran-out', sale: sale({ state: 'expired' }), cancelled: false }, false, false)).toBe(false);
  });

  it('is emptied when the phone is unpaired or removed', () => {
    expect(watched([w('cancelled'), w('stopped', { id: other })], { kind: 'clear' })).toEqual({ list: [], paid: null });
  });
});

// The sale screen's reads of its sale: the shop holds each answer until the sale is paid (cardd's ?wait), so Paid
// shows the moment the payment arrives; a shop that doesn't hold answers at once, and is asked once a second.
describe('the reads of a sale', () => {
  it('asks the shop to hold its answer for 8 seconds: under the 10 a request may take', () => {
    expect(SALE_WAIT_S).toBe(8);
  });

  it('reads again at once after an answer that took a second or more, and waits for the next second after a quick one', () => {
    expect(readsAgainAtOnce(1_000, 9_050)).toBe(true);
    expect(readsAgainAtOnce(1_000, 2_000)).toBe(true);
    expect(readsAgainAtOnce(1_000, 1_999)).toBe(false);
    expect(readsAgainAtOnce(1_000, 1_080)).toBe(false);
  });
});

// On an iPhone Apple's sheet may put the app in 'inactive'
// while it is up, and a QR payment must still be seen; only 'background' stops the reads then.
describe('readsNow', () => {
  it('reads while active, and while inactive only under a sheet', () => {
    expect(readsNow('active', false)).toBe(true);
    expect(readsNow('inactive', false)).toBe(false);
    expect(readsNow('inactive', true)).toBe(true);
    expect(readsNow('background', true)).toBe(false);
    expect(readsNow(null, true)).toBe(false);
  });
});

describe('a sheet that ended with an error of its own', () => {
  it("puts iOS's words in the waiting screen's note, and is ignored elsewhere", () => {
    expect(saleStep(start, { kind: 'sheet-error', text: 'Session invalidated unexpectedly' })).toEqual({ state: { ...start, note: 'Session invalidated unexpectedly' }, effects: [], leave: null });
    expect(saleStep(refused, { kind: 'sheet-error', text: 'x' }).state).toEqual(refused);
  });
});
