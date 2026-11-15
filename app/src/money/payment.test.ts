import { describe, expect, it } from 'vitest';
import type { Tx, TxDetail } from '../cardd/client';
import type { Rated } from './fiat';
import { paymentView, shortValue, spokenValue, type PaymentAt } from './payment';
import type { View } from './view';

const NOW = Date.UTC(2026, 9, 15, 9, 0, 0) / 1000;
const AT: PaymentAt = { nowS: NOW, offsetMin: 60, account: 'pool', cards: [{ id: 'c1', name: 'Daily' }] };
const at8 = Date.UTC(2026, 9, 15, 7, 1, 12) / 1000;
const SEND: Tx = { id: 7, kind: 'send', note: 'paid 3f9a', comment: 'Coffee with Sam', amountMsat: -21_400, feeMsat: 400, created: at8 };
const PRE = 'a07c41e2'.padEnd(58, '0') + 'd19b4d';

describe('paymentView', () => {
  it("a send, before its details: the line's facts at once, the note greyed", () => {
    const v = paymentView(SEND, { at: 'loading' }, AT);
    expect(v).toMatchObject({ title: 'Sent out', amount: '21 sat', incoming: false, status: 'Paid · today at 08:01 · from Pool', paid: true, proof: [], record: "Server's record: paid 3f9a", notice: null });
    expect(v.facts).toEqual([['Fee', 'under 1 sat'], ['When', '15 Oct 2026, 08:01:12']]);
    expect(v.note).toEqual({ shown: true, editable: false, value: 'Coffee with Sam' });
  });

  it('a send with its details: For, To, Fee, When, and its proof', () => {
    const detail: TxDetail = { ...SEND, payment: { hash: '3f9a0b77'.padEnd(58, '1') + '52c21e', preimage: PRE, invoice: 'lnbc210n1p5'.padEnd(80, 'x') + 'q8wz3s', description: '2 flat whites', destination: 'sam@example.com' } };
    const v = paymentView(SEND, { at: 'loaded', detail }, AT);
    expect(v.facts).toEqual([['For', '2 flat whites'], ['To', 'sam@example.com'], ['Fee', 'under 1 sat'], ['When', '15 Oct 2026, 08:01:12']]);
    expect(v.proof.map((p) => [p.label, p.short, p.full !== null])).toEqual([
      ['Proof of payment (preimage)', 'a07c41e2…d19b4d', true],
      ['Payment hash', '3f9a0b77…52c21e', true],
      ['Invoice', 'lnbc210n…q8wz3s', true],
    ]);
    // What TalkBack reads: the shown characters, never the whole value.
    expect(v.proof.map((p) => p.spoken)).toEqual(['starts a07c41e2, ends d19b4d', 'starts 3f9a0b77, ends 52c21e', 'starts lnbc210n, ends q8wz3s']);
    expect(v.record).toBe("Server's record: paid 3f9a");
    expect(v.note).toEqual({ shown: true, editable: true, value: 'Coffee with Sam' });
  });

  it('a send to an offer: its Offer row as proof, no Invoice row', () => {
    const offer = 'lno1qgsqvgnwgcg35z6ee2h3yczraddm72xrfua9uve2rlrm9deu7xyfzr';
    const detail: TxDetail = { ...SEND, payment: { hash: 'aa', preimage: 'bb'.repeat(32), offer, destination: '₿alice@phoenixwallet.me' } };
    const v = paymentView(SEND, { at: 'loaded', detail }, AT);
    // Spoken by its ends, as every proof row is.
    expect(v.proof).toContainEqual({ label: 'Offer', short: shortValue(offer), spoken: spokenValue(offer), full: offer, copyName: 'the offer' });
    expect(v.proof.map((p) => p.label)).not.toContain('Invoice');
    // An offer with no description has no For row, as Send's Check has none.
    expect(v.facts.map(([k]) => k)).toEqual(['To', 'Fee', 'When']);
  });

  it("an old send: no To row, For says No description, the preimage isn't recorded", () => {
    const detail: TxDetail = { ...SEND, comment: '', payment: { hash: 'h'.repeat(64), preimage: '', invoice: 'lnbc1' } };
    const v = paymentView(SEND, { at: 'loaded', detail }, AT);
    expect(v.facts.map(([k]) => k)).toEqual(['For', 'Fee', 'When']);
    expect(v.facts[0]).toEqual(['For', 'No description']);
    expect(v.proof[0]).toEqual({ label: 'Proof of payment (preimage)', short: 'Not recorded: paid before your server kept it', spoken: 'Not recorded: paid before your server kept it', full: null, copyName: 'the proof of payment' });
  });

  it('a top-up with a channel fee: added and to ACINQ, no total, its sentence; the hash as proof', () => {
    const topup: Tx = { id: 3, kind: 'topup', note: 'received 40411 sat after 21411000 msat of channel fees', amountMsat: 19_000_000, feeMsat: 21_411_000, created: at8 };
    const v = paymentView(topup, { at: 'loaded', detail: { ...topup, comment: '', payment: { hash: 'e'.repeat(64) } } }, AT);
    expect(v).toMatchObject({ title: 'Top-up', amount: '+19,000 sat', incoming: true, status: 'Received · today at 08:01 · into Pool', paid: false });
    expect(v.facts).toEqual([['Added to Pool', '19,000 sat'], ['To ACINQ for the channel', '21,411 sat'], ['When', '15 Oct 2026, 08:01:12']]);
    expect(v.proof.map((p) => p.label)).toEqual(['Payment hash']);
    expect(v.factsNote).toBe("21,411 sat went to ACINQ for more room in your server's Lightning channel.");
  });

  // The payer's note is the first fact, in quotes; the person's own note stays as it is.
  it("a top-up with a payer's note: Payer's note first, then the facts as before", () => {
    const top: Tx = { id: 4, kind: 'topup', note: 'received 2000 sat', payerNote: 'thanks for the talk', comment: 'from the meetup', amountMsat: 2_000_000, feeMsat: 0, created: at8 };
    const v = paymentView(top, { at: 'loaded', detail: { ...top, payment: { hash: 'e'.repeat(64) } } }, AT);
    expect(v.facts).toEqual([["Payer's note", '“thanks for the talk”'], ['When', '15 Oct 2026, 08:01:12']]);
    expect(v.note).toEqual({ shown: true, editable: true, value: 'from the meetup' });
    const fee: Tx = { ...top, amountMsat: 19_000_000, feeMsat: 21_411_000 };
    expect(paymentView(fee, { at: 'loaded', detail: { ...fee, payment: { hash: 'e'.repeat(64) } } }, AT).facts.map(([k]) => k)).toEqual(["Payer's note", 'Added to Pool', 'To ACINQ for the channel', 'When']);
    expect(paymentView({ ...top, payerNote: undefined }, { at: 'loading' }, AT).facts.map(([k]) => k)).toEqual(['When']);
  });

  it("a top-up that went to fee credit: the history's words", () => {
    const credit: Tx = { id: 9, kind: 'topup', note: 'received 100 sat: 100 sat went to phoenixd\'s fee credit', amountMsat: 0, feeMsat: 0, created: at8 };
    const v = paymentView(credit, { at: 'loaded', detail: { ...credit, comment: '', payment: { hash: 'e'.repeat(64) } } }, AT);
    expect(v.facts).toEqual([['Added to Pool', 'nothing: to fee credit'], ['When', '15 Oct 2026, 08:01:12']]);
    expect(v.proof.map((p) => p.label)).toEqual(['Payment hash']);
  });

  it('a move: from, to and when, and that it was no Lightning payment', () => {
    const move: Tx = { id: 4, kind: 'move', note: 'moved by the phone', amountMsat: 51_000, feeMsat: 0, created: at8, other: 'shop' };
    const v = paymentView(move, { at: 'loading' }, AT);
    expect(v.title).toBe('Moved from Shop');
    expect(v.status).toBe('Moved · today at 08:01');
    expect(v.facts).toEqual([['From', 'Shop'], ['To', 'Pool'], ['When', '15 Oct 2026, 08:01:12']]);
    expect(v.factsNote).toBe('A move between your own accounts: no Lightning payment, no fee.');
  });

  it("a sale: price, how it was paid and the till", () => {
    const sale: Tx = { id: 5, kind: 'sale', note: 'received 5 sat', amountMsat: 5_000, feeMsat: 0, created: at8, sale: { id: 's', method: 'card', device: 'Pixel 9a', priceMsat: 5_000 } };
    const v = paymentView(sale, { at: 'loading' }, { ...AT, account: 'shop' });
    expect(v.facts).toEqual([['Price', '5 sat'], ['Paid by', 'Card'], ['Till', 'Pixel 9a'], ['When', '15 Oct 2026, 08:01:12']]);
    expect(v.status).toBe('Received · today at 08:01 · into Shop');
  });

  it('an old server, an unreachable one and a line gone', () => {
    expect(paymentView(SEND, { at: 'old-server' }, AT)).toMatchObject({ notice: "Update server to see this payment's details.", retry: false, note: { shown: false } });
    expect(paymentView(SEND, { at: 'unreachable' }, AT)).toMatchObject({ notice: "Can't reach your server: the details show when it can.", retry: true, note: { shown: true, editable: false } });
    expect(paymentView(SEND, { at: 'gone' }, AT)).toMatchObject({ notice: "This payment isn't in your server's books any more.", retry: false, note: { shown: false } });
  });

  it("opened with no line kept (the app restarted on the page): a plain title until the details come", () => {
    expect(paymentView(null, { at: 'loading' }, AT)).toMatchObject({ title: 'Payment', amount: '', facts: [] });
  });

  it('a spend: the card it was spent from, between For and Fee', () => {
    const spend: Tx = { id: 8, kind: 'spend', note: 'spent', amountMsat: -5_000, feeMsat: 0, created: at8 };
    const v = paymentView(spend, { at: 'loaded', detail: { ...spend, comment: '', payment: { description: 'Tea' } } }, { ...AT, account: 'c1' });
    expect(v.facts).toEqual([['For', 'Tea'], ['Card', 'Daily'], ['Fee', 'none'], ['When', '15 Oct 2026, 08:01:12']]);
  });

  it("the server's record shows from the line on an old server", () => {
    expect(paymentView(SEND, { at: 'old-server' }, AT).record).toBe("Server's record: paid 3f9a");
  });

  it('a top-up with a fee and nothing credited: nothing, not 0 sat', () => {
    const t: Tx = { id: 11, kind: 'topup', note: 'x', amountMsat: 0, feeMsat: 5_000, created: at8 };
    expect(paymentView(t, { at: 'loading' }, AT).facts).toEqual([['Added to Pool', 'nothing'], ['To ACINQ for the channel', '5 sat'], ['When', '15 Oct 2026, 08:01:12']]);
  });

  it("a preimage not asked yet: not read yet, nothing to copy", () => {
    const detail: TxDetail = { ...SEND, payment: { hash: 'h'.repeat(64) } };
    const row = paymentView(SEND, { at: 'loaded', detail }, AT).proof[0];
    expect(row.short).toBe('Not read yet: open this page again in a minute');
    expect(row.full).toBeNull();
    expect(row.spoken).toBe(row.short);
  });

  it('a sale credited less than its price: To channel fees before When', () => {
    const sale: Tx = { id: 5, kind: 'sale', note: 'x', amountMsat: 4_000, feeMsat: 0, created: at8, sale: { id: 's', method: 'qr', device: 'Pixel 9a', priceMsat: 5_000 } };
    const f = paymentView(sale, { at: 'loading' }, { ...AT, account: 'shop' }).facts;
    expect(f.slice(-2)).toEqual([['To channel fees', '1 sat'], ['When', '15 Oct 2026, 08:01:12']]);
  });

  it('a renewal: paid from Hosting, For, Fee, and its proof', () => {
    const renew: Tx = { id: 12, kind: 'renew', note: 'paid 77aa', amountMsat: -2_000_000, feeMsat: 0, created: at8 };
    const detail: TxDetail = { ...renew, comment: '', payment: { hash: '77aa'.padEnd(64, '2'), preimage: PRE, invoice: 'lnbc20u1'.padEnd(70, 'y'), description: 'VM 1009, 30 days' } };
    const v = paymentView(renew, { at: 'loaded', detail }, { ...AT, account: 'hosting' });
    expect(v).toMatchObject({ title: 'Renewed the VM', amount: '2,000 sat', incoming: false, status: 'Paid · today at 08:01 · from Hosting', paid: true });
    expect(v.facts).toEqual([['For', 'VM 1009, 30 days'], ['Fee', 'none'], ['When', '15 Oct 2026, 08:01:12']]);
    expect(v.proof.map((p) => p.label)).toEqual(['Proof of payment (preimage)', 'Payment hash', 'Invoice']);
  });

  it("a card spend before its details: the card and the fee, no For yet", () => {
    const spend: Tx = { id: 8, kind: 'spend', note: 'spent', amountMsat: -12_000, feeMsat: 1_000, created: at8 };
    const v = paymentView(spend, { at: 'loading' }, { ...AT, account: 'c1' });
    expect(v).toMatchObject({ title: 'Spent at a terminal', amount: '11 sat', status: 'Paid · today at 08:01 · from Daily', paid: true, proof: [] });
    expect(v.facts).toEqual([['Card', 'Daily'], ['Fee', '1 sat'], ['When', '15 Oct 2026, 08:01:12']]);
  });

  it('a wipe, both legs: the card wiped and what pool got from it', () => {
    const out: Tx = { id: 13, kind: 'wipe', note: 'wiped', amountMsat: -5_000, feeMsat: 0, created: at8 };
    const v = paymentView(out, { at: 'loaded', detail: { ...out, comment: '' } }, { ...AT, account: 'c1' });
    expect(v).toMatchObject({ title: 'Wiped', amount: '5 sat', incoming: false, status: 'today at 08:01', paid: false, proof: [], factsNote: null });
    expect(v.facts).toEqual([['When', '15 Oct 2026, 08:01:12']]);
    const back: Tx = { ...out, amountMsat: 5_000 };
    expect(paymentView(back, { at: 'loading' }, AT)).toMatchObject({ title: 'From a wiped card', amount: '+5 sat', incoming: true });
  });

  it('a Books set and a fee over budget: what they were and when', () => {
    const books: Tx = { id: 14, kind: 'adjust', note: 'books set to phoenixd', amountMsat: 1_000, feeMsat: 0, created: at8 };
    const vb = paymentView(books, { at: 'loaded', detail: { ...books, comment: '' } }, AT);
    expect(vb).toMatchObject({ title: 'Books set', amount: '+1 sat', incoming: true, status: 'today at 08:01', paid: false, record: "Server's record: books set to phoenixd" });
    expect(vb.facts).toEqual([['When', '15 Oct 2026, 08:01:12']]);
    const fee: Tx = { id: 15, kind: 'fee-adjust', note: 'fee over budget', amountMsat: -1_000, feeMsat: 0, created: at8 };
    const vf = paymentView(fee, { at: 'loading' }, AT);
    expect(vf).toMatchObject({ title: 'Routing fee over budget', amount: '1 sat', incoming: false, status: 'today at 08:01', paid: false });
    expect(vf.facts).toEqual([['When', '15 Oct 2026, 08:01:12']]);
  });

  it('no line kept, in each state but loading: a plain title, the words, and Try again where it may help', () => {
    const plain = { title: 'Payment', amount: '', facts: [], proof: [], record: null };
    expect(paymentView(null, { at: 'unreachable' }, AT)).toMatchObject({ ...plain, notice: "Can't reach your server: the details show when it can.", retry: true, note: { shown: true, editable: false } });
    expect(paymentView(null, { at: 'failed', reason: 'The server refused: boom' }, AT)).toMatchObject({ ...plain, notice: "Your server couldn't give this payment's details. The server refused: boom", retry: true, note: { shown: true, editable: false } });
    expect(paymentView(null, { at: 'gone' }, AT)).toMatchObject({ ...plain, notice: "This payment isn't in your server's books any more.", retry: false, note: { shown: false } });
    expect(paymentView(null, { at: 'old-server' }, AT)).toMatchObject({ ...plain, notice: "Update server to see this payment's details.", retry: false, note: { shown: false } });
  });

  // The page's amounts in the app's view as the history row's: today's
  // value marked "now" in £ view, fees following the view, *** hiding them all, and a sale's price as it was rung up.
  describe("in the app's view", () => {
    const GBP: Rated = { currency: 'GBP', price: 61_352, time: NOW };
    const send: Tx = { id: 7, kind: 'send', note: 'paid 3f9a', amountMsat: -21_004_412, feeMsat: 4_412, created: at8 };
    const view = (t: Tx, v: View, account = 'pool') => paymentView(t, { at: 'loading' }, { ...AT, account, view: v, rated: GBP });

    it("a send in £ view: today's value marked now, the fee in pounds", () => {
      const v = view(send, 'fiat');
      expect([v.amount, v.msat, v.sign, v.now]).toEqual(['£12.88', 21_000_000, '', true]);
      expect(v.facts[0]).toEqual(['Fee', 'under £0.01']);
    });

    it('a send in msat view: exact, the fee too; in ***: all hidden', () => {
      expect(view(send, 'msat')).toMatchObject({ amount: '21,000,000 msat', now: false, facts: [['Fee', '4,412 msat'], expect.anything()] });
      expect(view(send, 'hidden')).toMatchObject({ amount: '***', now: false, facts: [['Fee', '***'], expect.anything()] });
    });

    it("a top-up in £ view: what was added as today's value, now; in *** hidden", () => {
      const topup: Tx = { id: 3, kind: 'topup', note: 'x', amountMsat: 19_000_000, feeMsat: 21_411_000, created: at8 };
      const v = view(topup, 'fiat');
      expect([v.amount, v.sign, v.now]).toEqual(['+£11.66', '+', true]);
      expect(v.facts.slice(0, 2)).toEqual([['Added to Pool', '£11.66 now'], ['To ACINQ for the channel', '£13.14']]);
      expect(view(topup, 'hidden')).toMatchObject({ amount: '***', sign: '', facts: [['Added to Pool', '***'], ['To ACINQ for the channel', '***'], expect.anything()] });
    });

    it("a sale rung up in £: priced as it was set, never converted, beside today's value now; hidden in ***", () => {
      const sale: Tx = {
        id: 5, kind: 'sale', note: 'x', amountMsat: 4_000_000, feeMsat: 0, created: at8,
        sale: { id: 's', method: 'card', device: 'Till 1', priceMsat: 4_500_000, price: { currency: 'GBP', minor: 250 } },
      };
      const v = view(sale, 'fiat', 'shop');
      expect([v.amount, v.sign, v.now]).toEqual(['+£2.45', '+', true]);
      expect(v.facts).toEqual([['Priced', '£2.50'], ['Paid by', 'Card'], ['Till', 'Till 1'], ['To channel fees', '£0.31 now'], ['When', '15 Oct 2026, 08:01:12']]);
      expect(view(sale, 'sat', 'shop').facts[0]).toEqual(['Priced', '£2.50']);
      expect(view(sale, 'hidden', 'shop').facts[0]).toEqual(['Priced', '***']);
    });

    it("a sale typed in sat: its price in the view, today's value marked now in £ view", () => {
      const sale: Tx = { id: 5, kind: 'sale', note: 'x', amountMsat: 4_386_000, feeMsat: 0, created: at8, sale: { id: 's', method: 'qr', device: 'Till 1', priceMsat: 4_386_000 } };
      expect(view(sale, 'fiat', 'shop').facts[0]).toEqual(['Price', '£2.69 now']);
      expect(view(sale, 'sat', 'shop').facts[0]).toEqual(['Price', '4,386 sat']);
    });

    it('shows sats in a £ view with no rate', () => {
      const v = paymentView(send, { at: 'loading' }, { ...AT, view: 'fiat', rated: null });
      expect([v.amount, v.now]).toEqual(['21,000 sat', false]);
    });
  });

  it('shortValue and spokenValue', () => {
    expect(shortValue('short')).toBe('short');
    expect(shortValue('0123456789abcdefXYZ')).toBe('01234567…defXYZ');
    expect(spokenValue('short')).toBe('short');
    expect(spokenValue('0123456789abcdefXYZ')).toBe('starts 01234567, ends defXYZ');
  });
});

// A sale's page with where its refund would go, and once it was refunded; a refund's own page.
describe('paymentView with refunds', () => {
  const soldAt = Date.UTC(2026, 9, 15, 7, 2, 0) / 1000;
  const SALE: Tx = { id: 3, kind: 'sale', note: 'received', amountMsat: 8_000_000, feeMsat: 0, created: soldAt,
    sale: { id: 's', method: 'card', device: 'Front', priceMsat: 8_000_000, paidAt: soldAt, refund: null, returnAddress: { host: 'boltcards.example' } } };
  const SHOP: PaymentAt = { ...AT, account: 'shop' };

  it('names the return address and offers the refund', () => {
    const v = paymentView(SALE, { at: 'loaded', detail: SALE }, SHOP);
    expect(v.facts).toContainEqual(['Return address', "The card's, from boltcards.example"]);
    expect(v.refund).toEqual({ kind: 'button', line: 'Gives the customer the whole sale back, to the card they paid with.' });
  });

  it('says Refunded with when, and links the refund', () => {
    const done = { ...SALE, sale: { ...SALE.sale!, refund: { state: 'paid' as const, txId: 9, at: soldAt + 3600, amountMsat: 7_650_000, from: 'pool' as const } } };
    const v = paymentView(done, { at: 'loaded', detail: done }, SHOP);
    expect(v.status).toMatch(/ · Refunded · /);
    expect(v.facts).toContainEqual(['Refund', '7,650 sat']);
    expect(v.refundLink).toEqual({ account: 'pool', txId: 9 });
    expect(v.refund).toMatchObject({ kind: 'refunded' });
  });

  it("shows a refund's own page as a payment out", () => {
    const refund: TxDetail = { id: 9, kind: 'refund', note: 'refund of sale s, paid ab', amountMsat: -7_653_000, feeMsat: 3_000, created: soldAt + 3600,
      sale: SALE.sale, payment: { hash: 'ab'.repeat(32), destination: 'https://boltcards.example/refund/x', preimage: '' } };
    const v = paymentView(refund, { at: 'loaded', detail: refund }, SHOP);
    expect(v.title).toBe('Refund');
    expect(v.paid).toBe(true);
    expect(v.facts).toContainEqual(['Fee', '3 sat']);
    // It names its sale first.
    expect(v.facts[0]).toEqual(['Sale', 'today at 08:02 · Front']);
    expect(v.facts).toContainEqual(['For', 'No description']);
  });

  // An own-card refund, booked inside the server, has no payment.
  const ownSale = { ...SALE.sale!, returnAddress: { card: { id: 'c1', name: 'Daily' } } };
  it("shows the receiving card's page of an own-card refund as money received", () => {
    const back: TxDetail = { id: 10, kind: 'refund', note: 'refund of sale s', amountMsat: 8_000_000, feeMsat: 0, created: soldAt + 3600, other: 'shop', sale: ownSale };
    const v = paymentView(back, { at: 'loaded', detail: back }, { ...AT, account: 'c1' });
    expect(v).toMatchObject({ title: 'Refund', status: 'Received · today at 09:02 · into Daily', paid: false, incoming: true, proof: [] });
    expect(v.facts).toEqual([['Sale', 'today at 08:02 · Front'], ['From', 'Shop'], ['When', '15 Oct 2026, 09:02:00']]);
  });

  it("shows the shop's page of an own-card refund with the card it went to and no For row", () => {
    const out: TxDetail = { id: 10, kind: 'refund', note: 'refund of sale s', amountMsat: -8_000_000, feeMsat: 0, created: soldAt + 3600, other: 'c1', sale: ownSale };
    const v = paymentView(out, { at: 'loaded', detail: out }, SHOP);
    expect(v.status).toBe('Paid · today at 09:02 · from Shop');
    expect(v.facts[0]).toEqual(['Sale', 'today at 08:02 · Front']);
    expect(v.facts).toContainEqual(['To', 'Daily']);
    expect(v.facts.map(([k]) => k)).not.toContain('For');
  });

  // A top-up that came through one of this server's refund links.
  it("names a refund link's top-up Refund and says where it came from", () => {
    const back: TxDetail = { id: 11, kind: 'topup', via: 'refund', note: 'received 50 sat', amountMsat: 50_000, feeMsat: 0, created: soldAt + 3600, payment: { hash: 'cd'.repeat(32) } };
    const v = paymentView(back, { at: 'loaded', detail: back }, { ...AT, account: 'c1' });
    expect(v).toMatchObject({ title: 'Refund', status: 'Received · today at 09:02 · into Daily', incoming: true });
    expect(v.factsNote).toBe("A refund from a shop, paid to this card's return address.");
    const pooled = paymentView(back, { at: 'loaded', detail: back }, AT);
    expect(pooled.factsNote).toBe("A refund from a shop, paid to a card's return address.");
  });

  it("keeps the channel's note after a refund's", () => {
    const back: TxDetail = { id: 12, kind: 'topup', via: 'refund', note: 'received', amountMsat: 40_000, feeMsat: 2_000_000, created: soldAt + 3600 };
    const v = paymentView(back, { at: 'loaded', detail: back }, { ...AT, account: 'c1' });
    expect(v.factsNote).toMatch(/^A refund from a shop, paid to this card's return address\. .+ACINQ/);
  });
});
