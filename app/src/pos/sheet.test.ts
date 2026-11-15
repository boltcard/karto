import { describe, expect, it } from 'vitest';
import type { PosSale } from './client';
import { saleStart, saleStep, type SaleEvent, type SaleState } from './sale';
import { cardButton, saleSheet, saleSheetEnd } from './sheet';

const NOW = 1_790_000_000;
const ID = '00000000-0000-4000-8000-000000000001';
const sale = (o: Partial<PosSale> = {}): PosSale => ({
  id: ID, amountMsat: 2_500_000, state: 'open', method: '', device: { keyId: 'b18b86ce1389e46d', name: 'Till 1' },
  created: NOW, expires: NOW + 600, invoice: 'lnbc25u1xyz', ...o,
});
const start = saleStart(sale());
const step = (s: SaleState, e: SaleEvent) => saleStep(s, e).state;
const cardRead = step(start, { kind: 'card', saleId: ID, outcome: { kind: 'accepted' }, nowMs: 5_000 });
const refused = step(start, { kind: 'card', saleId: ID, outcome: { kind: 'refused', said: true, reason: 'no' }, nowMs: 5_000 });
const ranOut = step(start, { kind: 'read', sale: sale({ state: 'expired' }) });
/** saleSheetEnd for an event from a state, as the screen asks it: with the state saleStep moved to. */
const endOf = (s: SaleState, e: SaleEvent) => saleSheetEnd(s, saleStep(s, e).state, e);

// What Apple's sheet is told at the till.
describe('saleSheet', () => {
  it('opens with where to hold the card and the amount', () => {
    expect(saleSheet({ on: 'press', amount: '2,500 sat' })).toEqual({ call: 'open', line: 'Hold the card against the top of the back of the phone. 2,500 sat' });
  });

  it('says it is reading a card, and ends with the tick once its link is read', () => {
    expect(saleSheet({ on: 'card' })).toEqual({ call: 'say', line: 'Reading the card…' });
    expect(saleSheet({ on: 'read', tap: 'link' })).toEqual({ call: 'done', line: 'Card read. You can take it away.' });
  });

  it('asks again for a card that is not a Bolt Card, or one lifted too soon', () => {
    expect(saleSheet({ on: 'read', tap: 'not-a-card' })).toEqual({ call: 'again', line: "That isn't a Bolt Card. Hold a Bolt Card against the top of the back of the phone." });
    expect(saleSheet({ on: 'read', tap: 'moved-away' })).toEqual({ call: 'again', line: 'The card moved away. Hold it against the top of the back of the phone again.' });
  });

  it('ends with the tick for Paid, a red cross for a sale that did not happen, and closes when the screen is left', () => {
    expect(saleSheet({ on: 'ended', to: 'paid' })).toEqual({ call: 'done', line: 'Paid' });
    expect(saleSheet({ on: 'ended', to: 'ran-out' })).toEqual({ call: 'fail', line: 'The sale ran out.' });
    expect(saleSheet({ on: 'ended', to: 'cancelled-on-shop' })).toEqual({ call: 'fail', line: 'The sale was cancelled.' });
    expect(saleSheet({ on: 'ended', to: 'cancel' })).toEqual({ call: 'fail', line: 'Sale cancelled.' });
    expect(saleSheet({ on: 'ended', to: 'leave' })).toEqual({ call: 'close' });
  });
});

describe('cardButton', () => {
  it('is never there where cards are read all the time', () => {
    for (const s of [start, cardRead, refused, ranOut]) expect(cardButton(s, null)).toBeNull();
  });

  it('is there only while the sale waits, and off while a sheet is up or still going', () => {
    expect(cardButton(start, 'none')).toEqual({ on: true });
    expect(cardButton(start, 'open')).toEqual({ on: false });
    expect(cardButton(start, 'ending')).toEqual({ on: false });
    for (const s of [cardRead, refused, ranOut]) expect(cardButton(s, 'none')).toBeNull();
  });
});

describe('saleSheetEnd', () => {
  it('ends the sheet with Paid when the sale is paid while it waits', () => {
    expect(endOf(start, { kind: 'read', sale: sale({ state: 'paid', method: 'qr', paidAt: NOW + 30, txId: 7 }) })).toEqual({ on: 'ended', to: 'paid' });
  });

  it('ends it with why when the sale runs out or the shop cancels it', () => {
    expect(endOf(start, { kind: 'read', sale: sale({ state: 'expired' }) })).toEqual({ on: 'ended', to: 'ran-out' });
    expect(endOf(start, { kind: 'read', sale: sale({ state: 'cancelled' }) })).toEqual({ on: 'ended', to: 'cancelled-on-shop' });
  });

  it('ends it for Cancel sale, from the sale or from a refusal, and closes it for Back', () => {
    expect(endOf(start, { kind: 'cancel' })).toEqual({ on: 'ended', to: 'cancel' });
    expect(endOf(refused, { kind: 'cancel' })).toEqual({ on: 'ended', to: 'cancel' });
    expect(endOf(start, { kind: 'back' })).toEqual({ on: 'ended', to: 'leave' });
  });

  it('tells it nothing for a card accepted (the screen ended it with the read) or a tick', () => {
    expect(endOf(start, { kind: 'card', saleId: ID, outcome: { kind: 'accepted' }, nowMs: 5_000 })).toBeNull();
    expect(endOf(start, { kind: 'tick', nowMs: 1 })).toBeNull();
    expect(endOf(start, { kind: 'read', sale: sale() })).toBeNull();
  });
});
