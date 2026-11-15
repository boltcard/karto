// Refunding a till sale from its page in Karto Wallet, over the card
// tests' fake cardd: to the card's return address in three presses; to a scanned invoice when the sale has none or the
// card's address can't take it; from Pool when Shop is short; Check again with cardd's figure; never a second refund.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { router, useLocalSearchParams } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Payment from '../../app/payment';
import Refund from '../../app/refund';
import type { CardDeps } from '../../cards/deps';
import type { Price } from '../../cardd/client';
import type { Rated } from '../../money/fiat';
import type { View } from '../../money/view';
import { screenLock } from '../../ui/lock';
import { cardWorld } from '../cardWorld';
import { fakeInvoice } from '../fakeLnvps';
import { refocus } from './focus';

const deps: { now: CardDeps | null } = { now: null };
const server: { schema: number } = { schema: 14 };

vi.mock('expo-clipboard', () => ({ getStringAsync: vi.fn(async () => ''), setStringAsync: vi.fn(async () => true) }));
vi.mock('../../services/server', () => ({
  useCardDeps: () => deps.now,
  useServer: () => ({ snap: { cards: [], status: { kind: 'ok', version: 't', updateAvailable: false, schema: server.schema } } }),
}));
vi.mock('../../services/services', () => ({ useRouteGuard: () => true }));
vi.mock('../../ui/lock', () => ({ screenLock: vi.fn(async () => null) }));
const look: { view: View; rated: Rated | null } = { view: 'sat', rated: null };
vi.mock('../../ui/amountView', async (original) => ({
  ...(await original<typeof import('../../ui/amountView')>()),
  useAmountView: () => ({
    view: look.view, rated: look.rated, fiat: look.rated, showMsat: false, next: () => {}, setShowMsat: () => {},
    typingUnit: 'sat', setTypingUnit: () => {}, chooseCurrency: async () => {},
  }),
}));

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
// £5.00 at 65,359 a bitcoin is 7,650 sat; the sale took 8,000.
const GBP: Rated = { currency: 'GBP', price: 65_359, time: Math.floor(Date.now() / 1000) };
const FIVE_POUNDS: Price = { currency: 'GBP', minor: 500 };

/** A sale of 8,000 sat by the till Front, paid now, its page's params set; shop and pool hold what they're given. */
async function sold(o: { method?: 'card' | 'qr'; price?: Price; link?: string; shop?: number; pool?: number } = {}) {
  const world = await cardWorld();
  world.cardd.pos.set('k1', { name: 'Front', created: 0, removed: false });
  const id = world.cardd.sell('k1', 8_000_000, o.method ?? 'card', 8_000_000, o.price, o.link);
  world.cardd.balances.set('shop', o.shop ?? 20_000_000);
  world.cardd.balances.set('pool', o.pool ?? 50_000_000);
  const [line] = await world.deps.cardd.history('shop', { limit: 1 });
  deps.now = world.deps;
  vi.mocked(useLocalSearchParams).mockReturnValue({ account: 'shop', tx: String(line.id) });
  return { world, id };
}

describe('Refunding a sale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    look.view = 'sat';
    look.rated = GBP;
    server.schema = 14;
  });

  it('refunds a card sale to its return address in three presses', async () => {
    const { world } = await sold({ price: FIVE_POUNDS, link: 'https://boltcards.example/refund/x' });
    render(<Payment />);
    expect(await screen.findByText("The card's, from boltcards.example")).toBeTruthy();
    press('Refund this sale');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/refund', params: { account: 'shop', tx: expect.any(String) } });
    render(<Refund />);
    await screen.findByText("7,650 sat at today's rate. The price as it was rung up.");
    press('Next');
    expect(await screen.findByText('The card it was paid with, through boltcards.example')).toBeTruthy();
    await screen.findByText(/^(Shop|Pool)$/);
    await act(async () => press('Refund 7,650 sat'));
    expect(screenLock).toHaveBeenCalledWith('Refund 7,650 sat', 'sending out');
    // The phone's offset at the sale's time rides in the query, for the note's time: the sale's, not today's,
    // which differ when a summer time change falls between them.
    expect(world.cardd.refunds).toEqual([{ saleId: expect.any(String), id: expect.any(String), amountMsat: 7_650_000, from: 'shop', offset: String(-new Date(world.w.nowMs).getTimezoneOffset()) }]);
    expect(await screen.findByText(/^Refunded 7,650 sat \(£5\.00\) for the sale of \d\d:\d\d\. Fee 3 sat\.$/)).toBeTruthy();
  });

  it("goes to the scan when the card's return address can't take it", async () => {
    const { world } = await sold({ link: 'https://boltcards.example/refund/x' });
    world.cardd.nextRefund = { fail: 'no route' };
    render(<Refund />);
    await screen.findByRole('button', { name: 'Refund 8,000 sat' });
    await screen.findByText(/^(Shop|Pool)$/);
    await act(async () => press('Refund 8,000 sat'));
    expect(await screen.findByText("The card's return address couldn't take it: no route.")).toBeTruthy();
    expect(screen.getByPlaceholderText('Invoice or Lightning address')).toBeTruthy();
  });

  // A refusal (the card's server down, or refusing the amount) falls back to the scan too.
  it("goes to the scan when the card's return address refuses", async () => {
    const { world } = await sold({ link: 'https://boltcards.example/refund/x' });
    world.cardd.nextRefund = { refuse: 'bad_address' };
    render(<Refund />);
    await screen.findByText(/^(Shop|Pool)$/);
    await act(async () => press('Refund 8,000 sat'));
    expect(await screen.findByText(/^The card's return address couldn't take it: /)).toBeTruthy();
    expect(screen.getByPlaceholderText('Invoice or Lightning address')).toBeTruthy();
  });

  it('asks for an invoice when the sale was paid from the QR, and refuses one for another amount', async () => {
    const { world } = await sold({ method: 'qr' });
    render(<Refund />);
    expect(await screen.findByText("This sale was paid from the QR, so it has no return address. Scan the customer's invoice or Lightning address.")).toBeTruthy();
    const nowS = Math.floor(Date.now() / 1000);
    fireEvent.change(screen.getByPlaceholderText('Invoice or Lightning address'), { target: { value: fakeInvoice(5_000_000n, nowS, 3600) } });
    expect(await screen.findByText('This invoice is for 5,000 sat; the refund is 8,000 sat.')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Invoice or Lightning address'), { target: { value: fakeInvoice(8_000_000n, nowS, 3600) } });
    press('Next');
    await screen.findByText(/^(Shop|Pool)$/);
    await act(async () => press('Refund 8,000 sat'));
    expect(world.cardd.refunds[0]).toMatchObject({ amountMsat: 8_000_000, to: expect.stringMatching(/^lnbc/) });
  });

  it('pays from Pool with the warning when Shop is short', async () => {
    const { world } = await sold({ link: 'https://boltcards.example/refund/x', shop: 849_000 });
    render(<Refund />);
    expect(await screen.findByText('From Pool: Shop has only 849 sat.')).toBeTruthy();
    await screen.findByText(/^(Shop|Pool)$/);
    await act(async () => press('Refund 8,000 sat'));
    expect(world.cardd.refunds[0]).toMatchObject({ from: 'pool' });
  });

  it("shows Check again with the server's figure", async () => {
    const { world } = await sold({ price: FIVE_POUNDS, link: 'https://boltcards.example/refund/x' });
    world.cardd.nextRefund = { wrongAmount: 7_700_000 };
    render(<Refund />);
    await screen.findByText("7,650 sat at today's rate. The price as it was rung up.");
    press('Next');
    await screen.findByText(/^(Shop|Pool)$/);
    await act(async () => press('Refund 7,650 sat'));
    expect(await screen.findByRole('button', { name: 'Refund 7,700 sat' })).toBeTruthy();
  });

  // The server's figure holds until the amount changes.
  it("drops the server's figure when another amount is chosen", async () => {
    const { world } = await sold({ price: FIVE_POUNDS, link: 'https://boltcards.example/refund/x' });
    world.cardd.nextRefund = { wrongAmount: 7_700_000 };
    render(<Refund />);
    await screen.findByText("7,650 sat at today's rate. The price as it was rung up.");
    press('Next');
    await screen.findByText(/^(Shop|Pool)$/);
    await act(async () => press('Refund 7,650 sat'));
    await screen.findByRole('button', { name: 'Refund 7,700 sat' });
    press('Back');
    press('8,000 sat');
    press('Next');
    expect(await screen.findByRole('button', { name: 'Refund 8,000 sat' })).toBeTruthy();
    expect(screen.queryByText(/Your server's figure/)).toBeNull();
  });

  // 4.2: Check says it is reading the balances, and offers Try again when it can't.
  it('says Check is reading the balances, and offers Try again', async () => {
    const { world } = await sold({ link: 'https://boltcards.example/refund/x' });
    const wallet = world.deps.cardd.wallet.bind(world.deps.cardd);
    let fail = true;
    world.deps.cardd.wallet = async () => {
      if (fail) throw new Error("Can't reach your server");
      return wallet();
    };
    render(<Refund />);
    expect(await screen.findByText(/Can't reach your server/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refund 8,000 sat' }).getAttribute('aria-disabled')).toBe('true');
    fail = false;
    await act(async () => press('Try again'));
    expect(await screen.findByText(/^(Shop|Pool)$/)).toBeTruthy();
  });

  it('says Check is reading the balances while they load', async () => {
    const { world } = await sold({ link: 'https://boltcards.example/refund/x' });
    world.deps.cardd.wallet = () => new Promise(() => {});
    render(<Refund />);
    expect(await screen.findByText('Reading your balances…')).toBeTruthy();
  });

  // 4.5: the customer's offer for another amount than the refund's, said as a sentence, back at To.
  it("goes back to To when the customer's offer is for another amount", async () => {
    const { world } = await sold({ method: 'qr' });
    world.cardd.nextRefund = { otherAmount: 9_000_000, of: 'offer' };
    render(<Refund />);
    fireEvent.change(await screen.findByPlaceholderText('Invoice or Lightning address'), { target: { value: 'lno1qcp4256ypq' } });
    press('Next');
    await screen.findByText(/^(Shop|Pool)$/);
    await act(async () => press('Refund 8,000 sat'));
    expect(await screen.findByText("The customer's offer is for 9,000 sat; the refund is 8,000 sat. Ask for one for 8,000 sat, or for no amount.")).toBeTruthy();
    expect(screen.getByPlaceholderText('Invoice or Lightning address')).toBeTruthy();
  });

  it('never offers a second refund, and says when one is on its way', async () => {
    const { world } = await sold({ link: 'https://boltcards.example/refund/x' });
    world.cardd.nextRefund = { pending: true };
    await world.deps.cardd.refund((await world.deps.cardd.history('shop', { limit: 1 }))[0].sale!.id, { id: 'r1', amountMsat: 8_000_000, from: 'shop' });
    render(<Payment />);
    expect(await screen.findByText('Refunding…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refund this sale' })).toBeNull();
  });

  // Back on the sale's page after the refund, it must no longer offer the button.
  it("reads the sale again when its page comes back to the front", async () => {
    const { world } = await sold({ link: 'https://boltcards.example/refund/x' });
    render(<Payment />);
    await screen.findByRole('button', { name: 'Refund this sale' });
    const [line] = await world.deps.cardd.history('shop', { limit: 1 });
    await world.deps.cardd.refund(line.sale!.id, { id: 'r1', amountMsat: 8_000_000, from: 'shop' });
    await act(async () => refocus());
    expect(await screen.findByText(/ · Refunded · /)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refund this sale' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open the refund' })).toBeTruthy();
  });

  it('says to update the server on an older one', async () => {
    const { world } = await sold();
    const [line] = await world.deps.cardd.history('shop', { limit: 1 });
    delete line.sale!.refund;
    // The page's own read of the line: the older server's, with no refund key.
    world.deps.cardd.transaction = async () => ({ ...line });
    render(<Payment />);
    expect(await screen.findByText('Update server to refund sales.')).toBeTruthy();
  });
});
