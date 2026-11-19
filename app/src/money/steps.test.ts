import { describe, expect, it } from 'vitest';
import { CarddError, type Wallet, type WalletCard } from '../cardd/client';
import { bolt11ExpiresAtMs } from '../lightning/lightning';
import type { Destination } from './destination';
import type { Rated } from './fiat';
import {
  afterMove, afterSend, afterWatch, destinationPanel, moveAvailable, moveBack, moveLock, moveReadBack, moveStart, moveTargets, noteWho, ownTarget, resultView, sendAt, sendBack, sendNext,
  sendReadBack, sendToProblem, barLabel, STEP_NAMES, stepAt, stepLabel, fixedAmount, linkAmountProblem, lookupText, needsLookup, oldServerProblem, payableFrom,
  type LinkPayable, type OfferPayable, type Ran,
} from './steps';

// BOLT 11's donation example: no amount, made in 2017 (so long expired today), "Please consider supporting this project".
const DONATION =
  'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';
const EXPIRES = bolt11ExpiresAtMs(DONATION)!;
const FRESH = EXPIRES - 60_000;
const invoice = (amountMsat: number | null, description = 'Coffee beans, 250 g'): Extract<Destination, { kind: 'invoice' }> => ({ kind: 'invoice', to: DONATION, amountMsat, description });
const ADDRESS: Destination = { kind: 'address', to: 'alex@pay.example.com' };
const GBP: Rated = { currency: 'GBP', price: 61_352, time: 1_792_037_404 };
const PAYURL: Destination = { kind: 'payurl', to: 'https://shop.example.com/lnurlp/abc' };
const UNSUPPORTED: Destination = { kind: 'unsupported', what: 'a Bitcoin address' };
const OWN: Destination = { kind: 'own', account: 'cab12cd34ef', address: 'cab12cd34ef@vm.example.net' };

const card = (id: string, name: string, state: WalletCard['state'], balanceMsat: number, heldMsat = 0): WalletCard => ({
  id, name, state, version: 1, balanceMsat, heldMsat, spent24hMsat: 0, perTapSat: 20_000, dailySat: 50_000, address: `c${id.slice(0, 10)}@vm.example.net`,
});
const DAILY = 'ab12cd34ef' + '0'.repeat(22);
const SPARE = 'bb' + '1'.repeat(30);
const KIDS = 'cc' + '2'.repeat(30);
const NEW = 'dd' + '3'.repeat(30);
const WALLET: Wallet = {
  cards: [card(DAILY, 'Daily card', 'active', 13_291_796, 0), card(SPARE, '', 'active', 0), card(KIDS, "Kids' card", 'frozen', 2_000_000), card(NEW, 'New', 'programming', 0)],
  pool: { balanceMsat: 48_500_000, heldMsat: 0, address: 'pool@vm.example.net' },
  hosting: { balanceMsat: 18_789_000, heldMsat: 1_000_000, address: 'hosting@vm.example.net' },
  paused: false, pausedReason: '', liquidity: null, restore: null,
};

// Send out and Move in three steps.
describe('sendNext', () => {
  it('goes from To to Amount for an address, a pay link and an invoice with no amount', () => {
    expect(sendNext(ADDRESS, FRESH)).toBe('amount');
    expect(sendNext(PAYURL, FRESH)).toBe('amount');
    expect(sendNext(invoice(null), FRESH)).toBe('amount');
  });

  it('skips Amount for an invoice that carries one', () => {
    expect(sendNext(invoice(1_234_000), FRESH)).toBe('check');
  });

  it('goes nowhere with nothing typed, something unpayable, an own address or an expired invoice', () => {
    expect(sendNext(null, FRESH)).toBeNull();
    expect(sendNext(UNSUPPORTED, FRESH)).toBeNull();
    expect(sendNext(OWN, FRESH)).toBeNull();
    expect(sendNext(invoice(1_234_000), EXPIRES)).toBeNull();
    expect(sendNext(invoice(null), EXPIRES + 1)).toBeNull();
  });
});

describe('sendToProblem', () => {
  it('says what something unpayable is, and that an invoice has expired', () => {
    expect(sendToProblem(UNSUPPORTED, FRESH)).toBe("That is a Bitcoin address: Send out can't pay it.");
    expect(sendToProblem(invoice(1_234_000), EXPIRES)).toBe('This invoice has expired.');
  });

  it('says nothing of what can be paid, of an own address (its panel does), or of nothing', () => {
    for (const d of [ADDRESS, PAYURL, invoice(null), OWN, null]) expect(sendToProblem(d, FRESH)).toBeNull();
  });
});

describe('ownTarget', () => {
  it("finds the account an own address names: hosting, or the card whose id it starts", () => {
    expect(ownTarget({ kind: 'own', account: 'hosting', address: 'hosting@vm.example.net' }, WALLET)).toBe('hosting');
    expect(ownTarget(OWN, WALLET)).toBe(DAILY);
  });

  it('finds none for pool itself, a card the wallet does not list, or before the wallet answers', () => {
    expect(ownTarget({ kind: 'own', account: 'pool', address: 'pool@vm.example.net' }, WALLET)).toBeNull();
    expect(ownTarget({ kind: 'own', account: 'c0000000000', address: 'c0000000000@vm.example.net' }, WALLET)).toBeNull();
    expect(ownTarget(OWN, null)).toBeNull();
    // A card being added can't receive: Move doesn't list it.
    expect(ownTarget({ kind: 'own', account: `c${NEW.slice(0, 10)}`, address: 'x' }, WALLET)).toBeNull();
  });
});

describe('sendBack and moveBack', () => {
  it('go back one step, and leave the screen from To', () => {
    expect(sendBack('check', false)).toBe('amount');
    expect(sendBack('amount', false)).toBe('to');
    expect(sendBack('to', false)).toBeNull();
    expect(moveBack('check')).toBe('amount');
    expect(moveBack('amount')).toBe('to');
    expect(moveBack('to')).toBeNull();
  });

  it("skip Amount on the way back too, for an invoice that carries its amount", () => {
    expect(sendBack('check', fixedAmount(invoice(1_234_000)) !== null)).toBe('to');
    expect(sendBack('check', fixedAmount(invoice(null)) !== null)).toBe('amount');
  });
});

// An invoice that expired at Check left the step at Check, so the next destination pasted landed
// there at once, past Amount, with the old amount and the old refusal.
describe('sendAt', () => {
  const atCheck = { step: 'check' as const, raw: 'alex@pay.example.com' };

  it('shows the step last reached while its destination stands and can be paid', () => {
    expect(sendAt(atCheck, 'alex@pay.example.com', ADDRESS as never)).toBe('check');
    expect(sendAt({ step: 'amount', raw: 'alex@pay.example.com' }, 'alex@pay.example.com', ADDRESS as never)).toBe('amount');
  });

  it('is at To once there is nothing to pay: an invoice that expired while Check showed', () => {
    expect(sendAt({ step: 'check', raw: DONATION }, DONATION, null)).toBe('to');
  });

  it('starts at To again for another destination, never at the step the last one had reached', () => {
    expect(sendAt(atCheck, 'https://shop.example.com/lnurlp/abc', PAYURL as never)).toBe('to');
    expect(sendAt({ step: 'check', raw: DONATION }, 'alex@pay.example.com', ADDRESS as never)).toBe('to');
  });
});

// The bar takes any names (Add card's Name, Hold, Photo).
describe('barLabel', () => {
  it('says any bar\'s step aloud', () => {
    expect(barLabel(['Name', 'Hold', 'Photo'], 0)).toBe('Step 1 of 3, Name');
    expect(barLabel(['Name', 'Hold', 'Photo'], 2)).toBe('Step 3 of 3, Photo');
    expect(barLabel(['One', 'Two'], 1)).toBe('Step 2 of 2, Two');
  });
  it("gives Send's and Move's bar its names and where a step stands in it", () => {
    expect(STEP_NAMES).toEqual(['To', 'Amount', 'Check']);
    expect([stepAt('to'), stepAt('amount'), stepAt('check')]).toEqual([0, 1, 2]);
  });
});

describe('stepLabel', () => {
  it('says the step aloud', () => {
    expect(stepLabel('to')).toBe('Step 1 of 3, To');
    expect(stepLabel('amount')).toBe('Step 2 of 3, Amount');
    expect(stepLabel('check')).toBe('Step 3 of 3, Check');
  });
});

describe('moveTargets and moveStart', () => {
  it('lists Pool, Hosting and the active and frozen cards, but the account it moves from', () => {
    expect(moveTargets(WALLET, DAILY).map((a) => [a.id, a.name, a.availableMsat, a.card, a.frozen])).toEqual([
      ['pool', 'Pool', 48_500_000, false, false],
      ['hosting', 'Hosting', 17_789_000, false, false],
      [SPARE, 'Unnamed card', 0, true, false],
      [KIDS, "Kids' card", 2_000_000, true, true],
    ]);
    expect(moveTargets(WALLET, 'pool').map((a) => a.id)).toEqual(['hosting', DAILY, SPARE, KIDS]);
  });

  it('starts at To, from pool when the link names no account', () => {
    expect(moveStart({ from: DAILY }, WALLET)).toMatchObject({ from: { id: DAILY, name: 'Daily card', availableMsat: 13_291_796, card: true }, to: null, step: 'to' });
    expect(moveStart({}, WALLET)).toMatchObject({ from: { id: 'pool' }, to: null, step: 'to' });
  });

  it("starts at Amount when the link's to is one of the targets, and drops any other", () => {
    expect(moveStart({ from: 'pool', to: 'hosting' }, WALLET)).toMatchObject({ from: { id: 'pool' }, to: { id: 'hosting' }, step: 'amount' });
    expect(moveStart({ from: 'pool', to: DAILY }, WALLET)).toMatchObject({ to: { id: DAILY }, step: 'amount' });
    for (const to of ['pool', NEW, 'nonsense', '']) expect(moveStart({ from: 'pool', to }, WALLET)).toMatchObject({ to: null, step: 'to' });
  });

  it('knows no such account for a from that is not pool, hosting or a card the wallet lists', () => {
    expect(moveStart({ from: 'ee' + '4'.repeat(30) }, WALLET)).toBeNull();
    expect(moveStart({ from: 'nonsense' }, WALLET)).toBeNull();
  });

  // Money leaves Shop by a move, and nothing moves into it.
  it('moves from Shop, in the words of an account, and never lists Shop to move to', () => {
    const withShop: Wallet = { ...WALLET, shop: { balanceMsat: 12_400_000, heldMsat: 0, address: '', phones: 1, sales: 5 } };
    const start = moveStart({ from: 'shop' }, withShop)!;
    expect(start).toMatchObject({ from: { id: 'shop', name: 'Shop', availableMsat: 12_400_000, card: false, frozen: false }, to: null, step: 'to' });
    expect(moveAvailable(start.from)).toBe('12,400 sat available in Shop.');
    const [pool] = moveTargets(withShop, 'shop');
    expect(moveReadBack(start.from, pool, 2_400_000)[4]).toEqual(['Left in Shop', '10,000 sat']);
    expect(moveTargets(withShop, 'shop').map((a) => a.id)).toEqual(['pool', 'hosting', DAILY, SPARE, KIDS]);
    for (const from of ['pool', 'hosting', DAILY]) expect(moveTargets(withShop, from).map((a) => a.id)).not.toContain('shop');
    expect(moveStart({ from: 'pool', to: 'shop' }, withShop)).toMatchObject({ to: null, step: 'to' });
    // An older server has no Shop.
    expect(moveStart({ from: 'shop' }, WALLET)).toBeNull();
  });

  it('says what is available in an account, on a card', () => {
    expect(moveAvailable(moveStart({ from: DAILY }, WALLET)!.from)).toBe('13,292 sat available on Daily card.');
    expect(moveAvailable(moveStart({}, WALLET)!.from)).toBe('48,500 sat available in Pool.');
  });
});

describe('destinationPanel and sendReadBack', () => {
  it('reads the destination back: To an address, or Invoice and its description', () => {
    expect(destinationPanel(ADDRESS)).toEqual({ label: 'To', value: 'alex@pay.example.com' });
    expect(destinationPanel(PAYURL)).toEqual({ label: 'To', value: 'https://shop.example.com/lnurlp/abc' });
    expect(destinationPanel(invoice(null))).toEqual({ label: 'Invoice', value: 'Coffee beans, 250 g' });
    expect(destinationPanel(invoice(null, ''))).toEqual({ label: 'Invoice', value: '' });
  });

  it('lists what Check shows: where, the amount, the fee to expect and what is left in Pool', () => {
    expect(sendReadBack(invoice(1_234_000), 1_234_000, 48_500_000)).toEqual([
      ['Invoice', 'Coffee beans, 250 g'],
      ['Amount', { msat: 1_234_000 }],
      ['Fee', 'about 9 sat'],
      ['Left in Pool', 'about 47,257 sat'],
    ]);
    expect(sendReadBack(ADDRESS, 5_000_000, 48_500_000)[0]).toEqual(['To', 'alex@pay.example.com']);
  });

  it("leaves out what is left when Pool can't pay it: the problem line says so", () => {
    expect(sendReadBack(ADDRESS, 5_000_000, 3_000_000).map(([label]) => label)).toEqual(['To', 'Amount', 'Fee']);
    expect(sendReadBack(ADDRESS, 1_000, 6_000)[3]).toEqual(['Left in Pool', 'about 0 sat']);
  });

  it('says an invoice has no description, and leaves out what is left before the wallet answered', () => {
    expect(sendReadBack(invoice(1_234_000, ''), 1_234_000, null)).toEqual([
      ['Invoice', 'No description'],
      ['Amount', { msat: 1_234_000 }],
      ['Fee', 'about 9 sat'],
    ]);
  });
});

describe('moveLock', () => {
  it("asks for the screen lock for money moved onto a card, from Pool or another card, with Check's button as its prompt", () => {
    const [, , spare, kids] = moveTargets(WALLET, 'pool');
    const lock = { prompt: 'Move 5,000 sat', needs: 'moving money onto a card' };
    expect(moveLock(spare, 'Move 5,000 sat')).toEqual(lock);
    expect(moveLock(kids, 'Move 5,000 sat')).toEqual(lock);
    expect(moveLock(moveTargets(WALLET, DAILY).find((a) => a.id === KIDS)!, 'Move 5,000 sat')).toEqual(lock);
  });

  it('asks for none for money moved off a card, to Pool or Hosting', () => {
    const [pool, hosting] = moveTargets(WALLET, DAILY);
    expect(moveLock(pool, 'Move 5,000 sat')).toBeNull();
    expect(moveLock(hosting, 'Move 5,000 sat')).toBeNull();
    expect(moveLock(moveTargets(WALLET, 'pool')[0], 'Move 5,000 sat')).toBeNull();
  });

  it("asks for none for money moved onto this phone's own card, by its id; another card still asks", () => {
    const [, , spare, kids] = moveTargets(WALLET, 'pool');
    expect(moveLock(spare, 'Move 5,000 sat', SPARE)).toBeNull();
    expect(moveLock(kids, 'Move 5,000 sat', SPARE)).toEqual({ prompt: 'Move 5,000 sat', needs: 'moving money onto a card' });
    // By id, not by name: a card named as the phone's is still asked for.
    expect(moveLock({ ...kids, name: spare.name }, 'Move 5,000 sat', SPARE)).not.toBeNull();
  });
});

describe('moveReadBack', () => {
  const { from } = moveStart({ from: DAILY }, WALLET)!;
  const [pool, , , kids] = moveTargets(WALLET, DAILY);

  it('lists what Check shows: from, to, the amount, no fee and what is left', () => {
    expect(moveReadBack(from, pool, 5_000_000)).toEqual([
      ['From', 'Daily card'],
      ['To', 'Pool'],
      ['Amount', { msat: 5_000_000 }],
      ['Fee', 'none'],
      ['Left on Daily card', '8,292 sat'],
    ]);
  });

  it('moves All as the exact msat and leaves nothing, and says in for Pool and Hosting', () => {
    expect(moveReadBack(from, kids, 13_291_796).slice(2)).toEqual([
      ['Amount', { msat: 13_291_796 }],
      ['Fee', 'none'],
      ['Left on Daily card', '0 sat'],
    ]);
    expect(moveReadBack(pool, from, 500_000)[4]).toEqual(['Left in Pool', '48,000 sat']);
  });
});

describe('afterSend and afterWatch', () => {
  const answer = (status: 'sent' | 'failed' | 'pending') => ({ status, paymentHash: 'ab'.repeat(32), amountMsat: 1_234_000, feeMsat: status === 'sent' ? 3_000 : undefined });

  it('ends on the result for an answer: sent, or failed with nothing gone', () => {
    expect(afterSend({ at: 'answered', answer: answer('sent') }, ADDRESS)).toEqual({ at: 'result', result: { kind: 'sent', amountMsat: 1_234_000, feeMsat: 3_000, dest: ADDRESS } });
    expect(afterSend({ at: 'answered', answer: answer('failed') }, ADDRESS)).toEqual({ at: 'result', result: { kind: 'failed', what: 'send', text: 'The payment failed: nothing left Pool.' } });
  });

  it('watches a payment still on its way, then says how it ended', () => {
    const pending = answer('pending');
    expect(afterSend({ at: 'answered', answer: pending }, ADDRESS)).toEqual({ at: 'watch', answer: pending });
    expect(afterWatch({ kind: 'sent', feeMsat: 4_000 }, pending, ADDRESS)).toEqual({ kind: 'sent', amountMsat: 1_234_000, feeMsat: 4_000, dest: ADDRESS });
    expect(afterWatch({ kind: 'failed' }, pending, ADDRESS)).toMatchObject({ kind: 'failed', what: 'send' });
    expect(afterWatch({ kind: 'unconfirmed' }, pending, ADDRESS)).toMatchObject({ kind: 'unknown' });
  });

  it("comes back to Check with cardd's reason for a refusal: the amount or the destination can be changed", () => {
    expect(afterSend({ at: 'refused', error: new CarddError(409, 'insufficient', 'ledger: insufficient') }, ADDRESS)).toEqual({ at: 'check', error: 'There isn’t enough money available.' });
    const limits = new CarddError(400, 'bad_address', "lnaddr: can't get an invoice from this address: it takes 100 to 50,000 sat");
    expect(afterSend({ at: 'refused', error: limits }, ADDRESS)).toEqual({ at: 'check', error: "Couldn't get an invoice: it takes 100 to 50,000 sat." });
  });

  it('is not known without an answer in time, and failed when the request itself broke', () => {
    expect(afterSend({ at: 'unknown' }, ADDRESS)).toMatchObject({ at: 'result', result: { kind: 'unknown' } });
    expect(afterSend({ at: 'failed', e: new Error('boom') }, ADDRESS)).toEqual({ at: 'result', result: { kind: 'failed', what: 'send', text: 'Something went wrong: boom' } });
  });
});

describe('afterMove', () => {
  const { from } = moveStart({ from: DAILY }, WALLET)!;
  const [pool] = moveTargets(WALLET, DAILY);

  it('ends on the result once moved, and when not known', () => {
    expect(afterMove({ at: 'answered', answer: { status: 'moved' } }, from, pool, 5_000_000)).toEqual({ at: 'result', result: { kind: 'moved', amountMsat: 5_000_000, from: 'Daily card', to: 'Pool' } });
    expect(afterMove({ at: 'unknown' }, from, pool, 5_000_000)).toEqual({ at: 'result', result: { kind: 'unknown', text: "The accounts' history will show whether it moved." } });
  });

  it('comes back to Check for a refusal', () => {
    expect(afterMove({ at: 'refused', error: new CarddError(409, 'cannot_receive', 'x') }, from, pool, 5_000_000)).toEqual({ at: 'check', error: "That account can't receive money now." });
  });

  it('has failed when the request itself broke', () => {
    expect(afterMove({ at: 'failed', e: new Error('boom') }, from, pool, 5_000_000)).toEqual({ at: 'result', result: { kind: 'failed', what: 'move', text: 'Something went wrong: boom' } });
  });
});

describe('resultView', () => {
  it('shows a send with its fee, and what it paid: the description, or the address', () => {
    expect(resultView({ kind: 'sent', amountMsat: 1_234_000, feeMsat: 3_000, dest: invoice(1_234_000) })).toEqual({ tone: 'ok', mark: 'check', title: 'Sent 1,234 sat', line: 'Fee 3 sat · Coffee beans, 250 g' });
    expect(resultView({ kind: 'sent', amountMsat: 5_000_000, feeMsat: 24_500, dest: ADDRESS }).line).toBe('Fee under 25 sat · to alex@pay.example.com');
    expect(resultView({ kind: 'sent', amountMsat: 1_234_000, feeMsat: 0, dest: invoice(1_234_000, '') }).line).toBe('Fee 0 sat');
  });

  // The fee as the history says it: seen on the emulator, the Sent page said "Fee 4.4 sat" where the
  // same payment's row said "fee under 5 sat".
  it('says a fee with a part of a sat as under the next whole sat, as the history does', () => {
    expect(resultView({ kind: 'sent', amountMsat: 100_000, feeMsat: 4_400, dest: ADDRESS }).line).toBe('Fee under 5 sat · to alex@pay.example.com');
    expect(resultView({ kind: 'sent', amountMsat: 100_000, feeMsat: 4_000, dest: ADDRESS }).line).toBe('Fee 4 sat · to alex@pay.example.com');
  });

  it('shows a move with its accounts and no fee', () => {
    expect(resultView({ kind: 'moved', amountMsat: 5_000_000, from: 'Daily card', to: 'Pool' })).toEqual({ tone: 'ok', mark: 'check', title: 'Moved 5,000 sat', line: 'From Daily card to Pool · no fee' });
  });

  it('shows a failure in red with its reason, and not known in amber', () => {
    expect(resultView({ kind: 'failed', what: 'send', text: 'The payment failed: nothing left Pool.' })).toEqual({ tone: 'error', mark: 'cross', title: 'Not sent', line: 'The payment failed: nothing left Pool.' });
    expect(resultView({ kind: 'failed', what: 'move', text: "Can't reach your server." }).title).toBe('Not moved');
    expect(resultView({ kind: 'unknown', text: "The accounts' history will show whether it moved." })).toEqual({ tone: 'warn', mark: 'dots', title: 'Not known yet', line: "The accounts' history will show whether it moved." });
  });

  it("noteWho: the address's name, else the payee", () => {
    expect(noteWho({ kind: 'address', to: 'sam@example.com' })).toBe('sam');
    expect(noteWho(invoice(1000, ''))).toBe('the payee');
    expect(noteWho(invoice(1000, ''))).not.toContain(DONATION);
  });
});

// Check, the result and what is available, in the app's view.
describe("Send out and Move in the app's view", () => {
  it("reads Check back in pounds: the amount as an amount, the fee and what is left as words", () => {
    expect(sendReadBack(invoice(1_234_000), 1_234_000, 48_500_000, 'fiat', GBP)).toEqual([
      ['Invoice', 'Coffee beans, 250 g'],
      ['Amount', { msat: 1_234_000 }],
      ['Fee', 'under £0.01'],
      ['Left in Pool', 'about £28.99'],
    ]);
    expect(sendReadBack(ADDRESS, 5_000_000, 48_500_000, 'msat', null).slice(2)).toEqual([
      ['Fee', 'about 24,000 msat'],
      ['Left in Pool', 'about 43,476,000 msat'],
    ]);
    const { from } = moveStart({ from: DAILY }, WALLET)!;
    const [pool] = moveTargets(WALLET, DAILY);
    expect(moveReadBack(from, pool, 5_000_000, 'fiat', GBP)[4]).toEqual(['Left on Daily card', '£5.09']);
  });

  it('says what is available, and the result, in the view', () => {
    expect(moveAvailable(moveStart({}, WALLET)!.from, 'fiat', GBP)).toBe('£29.76 available in Pool.');
    expect(resultView({ kind: 'sent', amountMsat: 1_234_000, feeMsat: 3_000, dest: invoice(1_234_000) }, 'fiat', GBP)).toEqual({
      tone: 'ok', mark: 'check', title: 'Sent £0.76', line: 'Fee under £0.01 · Coffee beans, 250 g',
    });
    expect(resultView({ kind: 'sent', amountMsat: 5_000_000, feeMsat: 4_412, dest: ADDRESS }, 'msat', null)).toMatchObject({ title: 'Sent 5,000,000 msat', line: 'Fee 4,412 msat · to alex@pay.example.com' });
    expect(resultView({ kind: 'moved', amountMsat: 5_000_000, from: 'Daily card', to: 'Pool' }, 'fiat', GBP).title).toBe('Moved £3.07');
  });
});

describe('offers and names', () => {
  const phoenix: OfferPayable = { kind: 'offer', to: 'lno1x', name: '₿alice@phoenixwallet.me', amountMsat: null, description: '', issuer: '' };
  const cafe: OfferPayable = { kind: 'offer', to: 'lno1y', name: null, amountMsat: 4_500_000, description: 'Flat white, large', issuer: "Ana's Café" };

  it("looks up names, links and offers, not invoices; the server gate is the screen's", () => {
    expect(needsLookup({ kind: 'address', to: 'a@b.com' })).toBe(true);
    expect(needsLookup({ kind: 'offer', to: 'lno1x' })).toBe(true);
    expect(needsLookup({ kind: 'invoice', to: 'lnbc1', amountMsat: 1000, description: '' })).toBe(false);
    expect(oldServerProblem({ kind: 'offer', to: 'lno1x' }, false)).toBe('Update your server to pay offers and ₿ addresses.');
    expect(oldServerProblem({ kind: 'address', to: 'a@b.com', bip353Only: true }, false)).toBe('Update your server to pay offers and ₿ addresses.');
    expect(oldServerProblem({ kind: 'address', to: 'a@b.com' }, false)).toBe(null);
    expect(lookupText({ kind: 'address', to: 'a@b.com', bip353Only: true })).toBe('₿a@b.com');
  });

  it("makes the lookup's answer something to pay", () => {
    expect(payableFrom({ kind: 'offer', offer: 'lno1x', name: '₿alice@phoenixwallet.me', amountMsat: null, description: '', issuer: '' })).toEqual(phoenix);
    expect(payableFrom({ kind: 'payurl', to: 'sam@getalby.com', minMsat: 1000, maxMsat: 2_000_000_000, description: "Sam's tips" })).toEqual({ kind: 'address', to: 'sam@getalby.com', minMsat: 1000, maxMsat: 2_000_000_000, description: "Sam's tips" });
    expect(payableFrom({ kind: 'payurl', to: 'https://x.example/lnurlp/s', minMsat: 1000, maxMsat: 5000, description: '' }).kind).toBe('payurl');
    expect(fixedAmount(cafe)).toBe(4_500_000);
    expect(fixedAmount(phoenix)).toBe(null);
    expect(sendBack('check', true)).toBe('to');
    expect(sendBack('check', false)).toBe('amount');
  });

  it('reads an offer back at Check, and says who the note is hidden from', () => {
    expect(sendReadBack(phoenix, 2_100_000, 48_500_000)[0]).toEqual(['To', '₿alice@phoenixwallet.me']);
    expect(sendReadBack(cafe, 4_500_000, 48_500_000).slice(0, 2)).toEqual([['To', "An offer from Ana's Café"], ['For', 'Flat white, large']]);
    expect(sendReadBack({ ...cafe, issuer: '', description: '' }, 4_500_000, null)[0]).toEqual(['To', 'An offer']);
    expect(noteWho(phoenix)).toBe('alice');
    expect(noteWho(cafe)).toBe('the payee');
  });

  it('keeps an LNURL amount within what the address takes', () => {
    const sam: LinkPayable = { kind: 'address', to: 'sam@getalby.com', minMsat: 1000, maxMsat: 2_000_000_000 };
    expect(linkAmountProblem(sam, 3_000_000_000)).toBe('Between 1 and 2,000,000 sat for this address.');
    expect(linkAmountProblem({ ...sam, kind: 'payurl', to: 'https://x' }, 500)).toBe('Between 1 and 2,000,000 sat for this link.');
    expect(linkAmountProblem(sam, 5_000_000)).toBe(null);
    expect(linkAmountProblem(phoenix, 5_000_000)).toBe(null);
  });

  it("says where an offer's money went, and why one was not sent", () => {
    expect(resultView({ kind: 'sent', amountMsat: 2_100_000, feeMsat: 12_400, dest: phoenix }).line).toContain('to ₿alice@phoenixwallet.me');
    expect(resultView({ kind: 'sent', amountMsat: 4_500_000, feeMsat: 22_000, dest: cafe }).line).toContain("to an offer from Ana's Café");
    const failed = afterSend({ at: 'answered', answer: { status: 'failed', paymentHash: '', amountMsat: 1000, reason: 'The receiving wallet refused the payment.' } } as Ran, phoenix);
    expect(failed).toEqual({ at: 'result', result: { kind: 'failed', what: 'send', text: 'The receiving wallet refused the payment.' } });
    expect(afterWatch({ kind: 'failed', reason: 'The receiving wallet refused the payment.' }, { status: 'pending', paymentHash: '', amountMsat: 1000 }, phoenix))
      .toEqual({ kind: 'failed', what: 'send', text: 'The receiving wallet refused the payment.' });
  });
});
