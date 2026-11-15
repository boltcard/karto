// The rules of a refund in Karto Wallet: which amount, from which
// account, and what the sale's page offers.
import { describe, expect, it } from 'vitest';
import type { Tx } from '../cardd/client';
import type { Rated } from './fiat';
import { refundButton, refundChoices, refundFrom, returnAddressText } from './refund';

type TxSale = NonNullable<Tx['sale']>;
// £5.00 at 65,359 a bitcoin is 7,650 sat; the sale took 8,000.
const GBP: Rated = { currency: 'GBP', price: 65_359, time: 1_790_000_000 };
const priced: TxSale = { id: 's', method: 'card', device: 'Front', priceMsat: 8_000_000, price: { currency: 'GBP', minor: 500 }, refund: null };
const plain: TxSale = { id: 's', method: 'qr', device: 'Front', priceMsat: 8_000_000, refund: null };

describe('refundChoices', () => {
  it('offers the price first, then what the sale took', () => {
    expect(refundChoices(priced, GBP)).toEqual([
      { msat: 7_650_000, title: '£5.00', line: "7,650 sat at today's rate. The price as it was rung up." },
      { msat: 8_000_000, title: '8,000 sat', line: "What the sale took. £5.23 at today's rate." },
    ]);
  });

  it('has one choice for a sale in sat, and for a priced one with no rate or another currency', () => {
    expect(refundChoices(plain, GBP)).toEqual([{ msat: 8_000_000, title: '8,000 sat', line: '' }]);
    const noRate = [{ msat: 8_000_000, title: '8,000 sat', line: 'No rate today: the refund is the 8,000 sat the sale took.' }];
    expect(refundChoices(priced, null)).toEqual(noRate);
    expect(refundChoices(priced, { ...GBP, currency: 'EUR' })).toEqual(noRate);
  });
});

describe('refundFrom', () => {
  it('pays from Shop when it covers the amount and the fee budget', () => {
    expect(refundFrom(10_000_000, 50_000_000, 7_650_000, true)).toEqual({ from: 'shop', warning: null });
  });

  it('pays all of it from Pool, with the warning, when Shop is short', () => {
    expect(refundFrom(849_000, 50_000_000, 7_650_000, true)).toEqual({ from: 'pool', warning: 'From Pool: Shop has only 849 sat.' });
    // Exactly the amount isn't enough with a fee to budget, and is for a card of this wallet.
    expect(refundFrom(7_650_000, 50_000_000, 7_650_000, true)).toMatchObject({ from: 'pool' });
    expect(refundFrom(7_650_000, 50_000_000, 7_650_000, false)).toEqual({ from: 'shop', warning: null });
  });

  it('says not enough when neither can', () => {
    expect(refundFrom(849_000, 1_000_000, 7_650_000, true)).toEqual({ short: 'Not enough in Shop or Pool for this refund.' });
  });
});

describe('refundButton', () => {
  it('offers the button with the line for where the money goes', () => {
    expect(refundButton({ ...priced, returnAddress: { host: 'boltcards.example' } })).toEqual({ kind: 'button', line: 'Gives the customer the whole sale back, to the card they paid with.' });
    expect(refundButton(plain)).toEqual({ kind: 'button', line: 'Gives the customer the whole sale back, to an invoice or Lightning address they show you.' });
  });

  it('shows Refunding…, Refunded, and the old-server line', () => {
    expect(refundButton({ ...plain, refund: { state: 'pending' } })).toEqual({ kind: 'pending' });
    expect(refundButton({ ...plain, refund: { state: 'paid', txId: 9, at: 1_790_000_100, amountMsat: 7_650_000, from: 'shop' } })).toEqual({ kind: 'refunded', at: 1_790_000_100 });
    const { refund: _gone, ...old } = plain;
    expect(refundButton(old)).toEqual({ kind: 'old-server' });
  });
});

describe('returnAddressText', () => {
  it("names another server's host, or this wallet's card", () => {
    expect(returnAddressText({ host: 'boltcards.example' })).toBe("The card's, from boltcards.example");
    expect(returnAddressText({ card: { id: 'c', name: 'A' } })).toBe('A, on this wallet');
  });
});
