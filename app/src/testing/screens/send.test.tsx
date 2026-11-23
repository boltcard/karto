// The Send out screen rendered, over the card tests' fake cardd (testing/cardWorld.ts) and the
// money code as it is: To from a paste, a typed text and the scanner's hand-off, Amount, Check, the screen lock,
// and the result. Only what needs a phone is replaced: the clipboard, the screen lock and the app's services.
// It lives here, not beside send.tsx: every file in src/app/ is a route to Expo Router.
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Send from '../../app/send';
import type { CardDeps } from '../../cards/deps';
import type { Rated } from '../../money/fiat';
import { scanSlot } from '../../money/scanSlot';
import type { Unit, View } from '../../money/view';
import { screenLock } from '../../ui/lock';
import { cardWorld } from '../cardWorld';
import { refocus } from './focus';

const deps: { now: CardDeps | null } = { now: null };

vi.mock('expo-clipboard', () => ({ getStringAsync: vi.fn(async () => '') }));
// down: the status before cardd answered (null) or when it can't be reached; else ok, with schema.
const server: { schema: number | undefined; down: 'checking' | 'unreachable' | null } = { schema: 8, down: null };
vi.mock('../../services/server', () => ({
  useCardDeps: () => deps.now,
  useServer: () => ({
    snap: {
      status: server.down === 'checking' ? null
      : server.down === 'unreachable' ? { kind: 'unreachable', message: 'Network request failed' }
      : { kind: 'ok', version: 't', updateAvailable: false, schema: server.schema },
    },
  }),
}));
vi.mock('../../services/services', () => ({ useRouteGuard: () => true }));
vi.mock('../../ui/lock', () => ({ screenLock: vi.fn(async () => null) }));

/** The app's view, as the screen's hook gives it (ui/amountView.tsx): sat, no rate, unless a test sets them. unit: the one kept under ***. */
const look: { view: View; unit: Unit; rated: Rated | null; typingUnit: 'fiat' | 'sat' } = { view: 'sat', unit: 'sat', rated: null, typingUnit: 'sat' };
vi.mock('../../ui/amountView', async (original) => ({
  ...(await original<typeof import('../../ui/amountView')>()),
  useAmountView: () => ({
    view: look.view, rated: look.rated, fiat: look.rated, unit: look.view === 'hidden' ? look.unit : look.view, hidden: look.view === 'hidden', setUnit: () => {}, setHidden: () => {},
    typingUnit: look.typingUnit, setTypingUnit: () => {}, chooseCurrency: async () => {},
  }),
}));

const field = () => screen.getByPlaceholderText('Invoice, address, offer or link');
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
// BOLT 11's donation example: no amount, made in 2017, so long expired.
const DONATION =
  'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';

/** Types to, then the amount in sat, and goes on to Check. */
function toCheck(to: string, sat: number) {
  fireEvent.change(field(), { target: { value: to } });
  press('Next');
  fireEvent.change(screen.getByPlaceholderText('Amount in sat'), { target: { value: String(sat) } });
  press('Next');
}

/** Draws the screen again, as a change in the app's view (look) does. */
let rerender: (ui: ReactNode) => void = () => {};

async function open(before?: (world: Awaited<ReturnType<typeof cardWorld>>) => void) {
  const world = await cardWorld();
  world.cardd.balances.set('pool', 100_000_000);
  before?.(world);
  deps.now = world.deps;
  ({ rerender } = render(<Send />));
  // The wallet's answer: what Pool holds, beside From.
  await screen.findByText('100,000 sat available');
  return world;
}

describe('Send out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    server.schema = 8;
    server.down = null;
  });

  it('pays a pasted Lightning address: To, Amount, Check, the screen lock, then Sent', async () => {
    const world = await open();
    vi.mocked(Clipboard.getStringAsync).mockResolvedValueOnce('alice@example.com');
    press('Paste');
    expect(await screen.findByDisplayValue('alice@example.com')).toBeTruthy();
    press('Next');
    fireEvent.change(screen.getByPlaceholderText('Amount in sat'), { target: { value: '5000' } });
    press('Next');
    expect(screen.getByText('alice@example.com')).toBeTruthy();
    press('Send 5,000 sat');
    expect(await screen.findByText('Sent 5,000 sat')).toBeTruthy();
    expect(screenLock).toHaveBeenCalledWith('Send 5,000 sat', 'sending out');
    expect(world.cardd.balances.get('pool')).toBe(95_000_000);
  });

  it('stays on Check, with the reason, when the screen lock is refused, and sends nothing', async () => {
    const world = await open();
    vi.mocked(screenLock).mockResolvedValueOnce('The screen lock was not confirmed.');
    fireEvent.change(field(), { target: { value: 'alice@example.com' } });
    press('Next');
    fireEvent.change(screen.getByPlaceholderText('Amount in sat'), { target: { value: '5000' } });
    press('Next');
    press('Send 5,000 sat');
    expect(await screen.findByText('The screen lock was not confirmed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send 5,000 sat' })).toBeTruthy();
    expect(world.cardd.balances.get('pool')).toBe(100_000_000);
  });

  it("comes back to Check with cardd's refusal in its words, and nothing leaves Pool", async () => {
    const world = await open();
    // cardd refuses the hold (another payment took what Pool had since the screen read it): the screen says so in its words.
    world.cardd.sendRefusal = { status: 409, code: 'insufficient', message: 'store: not enough money available' };
    toCheck('alice@example.com', 5000);
    press('Send 5,000 sat');
    expect(await screen.findByText('There isn’t enough money available.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send 5,000 sat' })).toBeTruthy();
    expect(world.cardd.balances.get('pool')).toBe(100_000_000);
  });

  it('keeps Next off for more than Pool can pay with its routing fees', async () => {
    await open();
    fireEvent.change(field(), { target: { value: 'alice@example.com' } });
    press('Next');
    fireEvent.change(screen.getByPlaceholderText('Amount in sat'), { target: { value: '100000' } });
    expect(screen.getByText('Pool has 100,000 sat; this needs up to 100,405 sat with routing fees.')).toBeTruthy();
    // On Amount, Next is there but off while there is a problem.
    expect(screen.getByRole('button', { name: 'Next' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('says an invoice has expired, and offers no Next', async () => {
    await open();
    fireEvent.change(field(), { target: { value: DONATION } });
    expect(screen.getByText('This invoice has expired.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it("offers a Move for this server's own address, which costs no routing fee", async () => {
    const world = await open();
    fireEvent.change(field(), { target: { value: `hosting@${world.cardd.host}` } });
    expect(screen.getByText(`That is hosting@${world.cardd.host}, an account on this server: moving to it is free.`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    press('Move to it instead');
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/move', params: { from: 'pool', to: 'hosting' } });
  });

  it('watches a send cardd answered pending, and says Sent once it settles', async () => {
    const world = await open();
    world.cardd.sendOutcome = { status: 'pending' };
    toCheck('alice@example.com', 5000);
    press('Send 5,000 sat');
    expect(await screen.findByText('Still on its way…')).toBeTruthy();
    act(() => world.cardd.endPendingSend(4_000));
    expect(await screen.findByText('Sent 5,000 sat', undefined, { timeout: 5000 })).toBeTruthy();
    expect(world.cardd.balances.get('pool')).toBe(94_996_000);
  });

  it('says Not sent when a pending send is given back', async () => {
    const world = await open();
    world.cardd.sendOutcome = { status: 'pending' };
    toCheck('alice@example.com', 5000);
    press('Send 5,000 sat');
    expect(await screen.findByText('Still on its way…')).toBeTruthy();
    act(() => world.cardd.endPendingSend(null));
    expect(await screen.findByText('Not sent', undefined, { timeout: 5000 })).toBeTruthy();
    expect(world.cardd.balances.get('pool')).toBe(100_000_000);
  });

  it('says what it cannot pay, and offers no Next', async () => {
    await open();
    fireEvent.change(field(), { target: { value: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' } });
    expect(screen.getByText("That is a Bitcoin address: Send out can't pay it.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('Scan QR opens the scanner, and the code it read fills To when Send is back in front', async () => {
    await open();
    press('Scan QR');
    expect(router.push).toHaveBeenCalledWith('/scan');
    // What scan.tsx does with the first code read; then Send comes back into focus.
    scanSlot.put('lightning:bob@example.com');
    act(refocus);
    expect(await screen.findByDisplayValue('lightning:bob@example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy();
  });

  it('keeps a note given at Check with the payment', async () => {
    const world = await open();
    toCheck('alice@example.com', 5000);
    const note = screen.getByLabelText('Note (optional)');
    expect(screen.getByText('Note (optional)')).toBeTruthy();
    expect(screen.getByText("For you only: alice doesn't see it.")).toBeTruthy();
    fireEvent.change(note, { target: { value: 'Coffee with Sam' } });
    press('Send 5,000 sat');
    await screen.findByText('Sent 5,000 sat');
    const [line] = await world.deps.cardd.history('pool', { limit: 1 });
    expect(line.comment).toBe('Coffee with Sam');
  });

  it('sends a note of 201 code points as 200', async () => {
    const world = await open();
    toCheck('alice@example.com', 5000);
    fireEvent.change(screen.getByPlaceholderText('Add a note'), { target: { value: '\u{1F600}'.repeat(201) } });
    press('Send 5,000 sat');
    await screen.findByText('Sent 5,000 sat');
    const [line] = await world.deps.cardd.history('pool', { limit: 1 });
    expect([...(line.comment ?? '')]).toHaveLength(200);
  });

  it('offers no note to a server before schema 8', async () => {
    server.schema = 7;
    await open();
    toCheck('alice@example.com', 5000);
    expect(screen.queryByPlaceholderText('Add a note')).toBeNull();
  });

  it('clears the note when a scanned code gives a new destination', async () => {
    await open();
    toCheck('alice@example.com', 5000);
    fireEvent.change(screen.getByPlaceholderText('Add a note'), { target: { value: 'for Alice' } });
    scanSlot.put('lightning:bob@example.com');
    act(refocus);
    await screen.findByDisplayValue('lightning:bob@example.com');
    press('Next');
    press('Next');
    expect((screen.getByPlaceholderText('Add a note') as HTMLInputElement).value).toBe('');
  });

  it('keeps the note when the same code is scanned again', async () => {
    await open();
    toCheck('lightning:bob@example.com', 5000);
    fireEvent.change(screen.getByPlaceholderText('Add a note'), { target: { value: 'for Bob' } });
    scanSlot.put(' lightning:bob@example.com ');
    act(refocus);
    expect((screen.getByPlaceholderText('Add a note') as HTMLInputElement).value).toBe('for Bob');
  });

  it('takes 200 emoji in the note field, not 100, and no more', async () => {
    await open();
    toCheck('alice@example.com', 5000);
    const note = screen.getByPlaceholderText('Add a note') as HTMLInputElement;
    expect(note.maxLength).toBe(-1); // no UTF-16 cap: the field cuts by code points
    fireEvent.change(note, { target: { value: '\u{1F600}'.repeat(201) } });
    expect(note.value).toBe('\u{1F600}'.repeat(200));
  });

  it('sends no comment for a note of only spaces', async () => {
    const world = await open();
    toCheck('alice@example.com', 5000);
    fireEvent.change(screen.getByPlaceholderText('Add a note'), { target: { value: '   ' } });
    press('Send 5,000 sat');
    await screen.findByText('Sent 5,000 sat');
    const [line] = await world.deps.cardd.history('pool', { limit: 1 });
    expect(line.comment ?? '').toBe('');
  });

  it('offers no note when the server does not report its schema', async () => {
    server.schema = undefined;
    await open();
    toCheck('alice@example.com', 5000);
    expect(screen.queryByPlaceholderText('Add a note')).toBeNull();
  });

  // To → lookup → Amount → Check → Send.
  describe('offers and ₿ names, on a server that looks them up (schema 10)', () => {
    beforeEach(() => {
      server.schema = 10;
    });

    it('pays a ₿ name: Looking up, Amount, Check with the name, then Sent to it', async () => {
      const world = await open();
      world.cardd.lookups.set('₿alice@phoenixwallet.me', { kind: 'offer', offer: 'lno1phoenix', name: '₿alice@phoenixwallet.me', amountMsat: null, description: '', issuer: '' });
      fireEvent.change(field(), { target: { value: '₿alice@phoenixwallet.me' } });
      press('Next');
      expect(screen.getByText('Looking up…')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Next' }).getAttribute('aria-disabled')).toBe('true');
      fireEvent.change(await screen.findByPlaceholderText('Amount in sat'), { target: { value: '2100' } });
      press('Next');
      expect(screen.getByText('₿alice@phoenixwallet.me')).toBeTruthy();
      press('Send 2,100 sat');
      expect(await screen.findByText('Sent 2,100 sat')).toBeTruthy();
      expect(screen.getByText(/to ₿alice@phoenixwallet\.me/)).toBeTruthy();
      // The send carried the offer and the name it was looked up by: the history names the payment so.
      expect([...world.cardd.payments.values()]).toEqual([expect.objectContaining({ offer: 'lno1phoenix', destination: '₿alice@phoenixwallet.me' })]);
    });

    it("stays on To with cardd's sentence when the lookup refuses", async () => {
      const world = await open();
      world.cardd.lookups.set('₿bob@example.com', { refusal: "₿bob@example.com doesn't exist: example.com has no BIP353 record for bob." });
      fireEvent.change(field(), { target: { value: '₿bob@example.com' } });
      press('Next');
      expect(await screen.findByText("₿bob@example.com doesn't exist: example.com has no BIP353 record for bob.")).toBeTruthy();
      expect(screen.queryByPlaceholderText('Amount in sat')).toBeNull();
    });

    it('goes straight to Check for an offer that fixes its amount', async () => {
      const world = await open();
      world.cardd.lookups.set('lno1cafe', { kind: 'offer', offer: 'lno1cafe', amountMsat: 4_500_000, description: 'Flat white, large', issuer: "Ana's Café" });
      fireEvent.change(field(), { target: { value: 'lno1cafe' } });
      press('Next');
      expect(await screen.findByText("An offer from Ana's Café")).toBeTruthy();
      expect(screen.getByText('Flat white, large')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Send 4,500 sat' })).toBeTruthy();
    });

    it("keeps an LNURL amount within the address's limits", async () => {
      const world = await open();
      world.cardd.lookups.set('sam@getalby.com', { kind: 'payurl', to: 'sam@getalby.com', minMsat: 1_000, maxMsat: 2_000_000_000, description: "Sam's tips" });
      fireEvent.change(field(), { target: { value: 'sam@getalby.com' } });
      press('Next');
      fireEvent.change(await screen.findByPlaceholderText('Amount in sat'), { target: { value: '3000000' } });
      expect(screen.getByText('Between 1 and 2,000,000 sat for this address.')).toBeTruthy();
    });

    it('says Not sent with the reason phoenixd gave', async () => {
      const world = await open();
      world.cardd.sendOutcome = { status: 'failed', reason: 'The receiving wallet refused the payment.' };
      fireEvent.change(field(), { target: { value: 'lno1free' } });
      press('Next');
      fireEvent.change(await screen.findByPlaceholderText('Amount in sat'), { target: { value: '1000' } });
      press('Next');
      press('Send 1,000 sat');
      expect(await screen.findByText('Not sent')).toBeTruthy();
      expect(screen.getByText('The receiving wallet refused the payment.')).toBeTruthy();
    });

    it('follows a pending offer send by its id until it is Sent', async () => {
      const world = await open();
      world.cardd.sendOutcome = { status: 'pending' };
      fireEvent.change(field(), { target: { value: 'lno1free' } });
      press('Next');
      fireEvent.change(await screen.findByPlaceholderText('Amount in sat'), { target: { value: '5000' } });
      press('Next');
      press('Send 5,000 sat');
      expect(await screen.findByText('Still on its way…')).toBeTruthy();
      act(() => world.cardd.endPendingSend(4_000));
      expect(await screen.findByText('Sent 5,000 sat', undefined, { timeout: 5000 })).toBeTruthy();
    });

    it('follows a pending offer send by its id until it is Not sent, and Pool is whole', async () => {
      const world = await open();
      world.cardd.sendOutcome = { status: 'pending' };
      fireEvent.change(field(), { target: { value: 'lno1free' } });
      press('Next');
      fireEvent.change(await screen.findByPlaceholderText('Amount in sat'), { target: { value: '5000' } });
      press('Next');
      press('Send 5,000 sat');
      expect(await screen.findByText('Still on its way…')).toBeTruthy();
      act(() => world.cardd.endPendingSend(null));
      expect(await screen.findByText('Not sent', undefined, { timeout: 5000 })).toBeTruthy();
      expect(world.cardd.balances.get('pool')).toBe(100_000_000);
    });

    it('shows the record-changed refusal at Check, sends nothing, and Back then Next looks it up again', async () => {
      const world = await open();
      world.cardd.lookups.set('₿alice@phoenixwallet.me', { kind: 'offer', offer: 'lno1phoenix', name: '₿alice@phoenixwallet.me', amountMsat: 1_000_000, description: '', issuer: '' });
      world.cardd.sendRefusal = { status: 400, code: 'bad_destination', message: "₿alice@phoenixwallet.me's record changed since it was looked up: look it up again." };
      fireEvent.change(field(), { target: { value: '₿alice@phoenixwallet.me' } });
      press('Next');
      await screen.findByRole('button', { name: 'Send 1,000 sat' });
      press('Send 1,000 sat');
      expect(await screen.findByText("₿alice@phoenixwallet.me's record changed since it was looked up: look it up again.")).toBeTruthy();
      expect(world.cardd.balances.get('pool')).toBe(100_000_000);
      // Back at To, the answer the send was refused with isn't shown as where the money goes.
      fireEvent.click(screen.getAllByRole('button', { name: 'Back' })[0]);
      expect(screen.queryByText('₿alice@phoenixwallet.me')).toBeNull();
      expect(screen.queryByText('1,000 sat')).toBeNull();
      // The record is gone now: Next looks it up again, and the refusal stands alone, with no old offer above it.
      world.cardd.lookups.set('₿alice@phoenixwallet.me', { refusal: "₿alice@phoenixwallet.me doesn't exist: phoenixwallet.me has no BIP353 record for alice." });
      press('Next');
      expect(await screen.findByText("₿alice@phoenixwallet.me doesn't exist: phoenixwallet.me has no BIP353 record for alice.")).toBeTruthy();
      expect(screen.queryByText('₿alice@phoenixwallet.me')).toBeNull();
      expect(screen.queryByText('1,000 sat')).toBeNull();
      // The record names another amount: the answer from before is not used again.
      world.cardd.lookups.set('₿alice@phoenixwallet.me', { kind: 'offer', offer: 'lno1phoenix2', name: '₿alice@phoenixwallet.me', amountMsat: 2_000_000, description: '', issuer: '' });
      press('Next');
      expect(await screen.findByRole('button', { name: 'Send 2,000 sat' })).toBeTruthy();
    });

    it('looks up once for two quick presses of Next', async () => {
      const world = await open();
      const asked = vi.spyOn(world.cardd.lookups, 'get');
      fireEvent.change(field(), { target: { value: 'lno1free' } });
      // Both presses land before the screen draws again.
      act(() => {
        press('Next');
        press('Next');
      });
      await screen.findByPlaceholderText('Amount in sat');
      expect(asked).toHaveBeenCalledTimes(1);
    });

    it('keeps the answer for the same text: Back from Amount, then Next, asks cardd nothing', async () => {
      const world = await open();
      fireEvent.change(field(), { target: { value: 'sam@getalby.com' } });
      press('Next');
      await screen.findByPlaceholderText('Amount in sat');
      // What cardd would answer now: Next back on To must not ask.
      world.cardd.lookups.set('sam@getalby.com', { refusal: 'asked twice' });
      fireEvent.click(screen.getAllByRole('button', { name: 'Back' })[0]);
      press('Next');
      expect(await screen.findByPlaceholderText('Amount in sat')).toBeTruthy();
      expect(screen.queryByText('asked twice')).toBeNull();
    });
  });

  it("waits for the server's status before Next for an offer, and never asks to update it meanwhile", async () => {
    server.down = 'checking';
    server.schema = 10;
    await open();
    fireEvent.change(field(), { target: { value: 'lno1free' } });
    expect(screen.queryByText('Update your server to pay offers and ₿ addresses.')).toBeNull();
    expect(screen.getByText('Checking your server…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' }).getAttribute('aria-disabled')).toBe('true');
    // cardd answers: schema 10 looks offers up.
    server.down = null;
    rerender(<Send />);
    expect(screen.queryByText('Checking your server…')).toBeNull();
    press('Next');
    expect(await screen.findByPlaceholderText('Amount in sat')).toBeTruthy();
  });

  it("says it can't reach the server, and waits, for a ₿ name while the server is down", async () => {
    server.down = 'unreachable';
    server.schema = 10;
    const world = await open();
    world.cardd.lookups.set('₿alice@phoenixwallet.me', { kind: 'offer', offer: 'lno1phoenix', name: '₿alice@phoenixwallet.me', amountMsat: 1_000_000, description: '', issuer: '' });
    fireEvent.change(field(), { target: { value: '₿alice@phoenixwallet.me' } });
    expect(screen.queryByText('Update your server to pay offers and ₿ addresses.')).toBeNull();
    expect(screen.getByText("Can't reach your server.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' }).getAttribute('aria-disabled')).toBe('true');
    server.down = null;
    rerender(<Send />);
    press('Next');
    expect(await screen.findByRole('button', { name: 'Send 1,000 sat' })).toBeTruthy();
  });

  it("asks an older server's person to update it for an offer or a ₿ name", async () => {
    server.schema = 9;
    await open();
    fireEvent.change(field(), { target: { value: 'lno1free' } });
    expect(screen.getByText('Update your server to pay offers and ₿ addresses.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    fireEvent.change(field(), { target: { value: '₿alice@phoenixwallet.me' } });
    expect(screen.getByText('Update your server to pay offers and ₿ addresses.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });
});

// Typed in pounds, Next turns the pounds into whole sats on the
// phone (minorToMsat, cardd's own rounding), and Check and the request carry those sats.
describe('Send out: All', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    server.schema = 8;
    server.down = null;
  });
  afterEach(() => {
    deps.now = null;
  });

  /** To alice@example.com, then Amount. */
  function toAmount(to = 'alice@example.com') {
    fireEvent.change(field(), { target: { value: to } });
    press('Next');
  }

  it('All fills the most Pool can send, and Check and the send carry it', async () => {
    const world = await open();
    toAmount();
    press('All');
    // cardd's figure: all but phoenixd's fee and 1 sat.
    expect(await screen.findByText('All: 99,596 sat')).toBeTruthy();
    expect(screen.getByText("Up to 404 sat kept for routing fees; what isn't used stays in Pool.")).toBeTruthy();
    press('Next');
    press('Send 99,596 sat');
    expect(await screen.findByText('Sent 99,596 sat')).toBeTruthy();
    // The fake routes for nothing: the allowance stays in Pool.
    expect(world.cardd.balances.get('pool')).toBe(404_000);
  });

  it('All on an older server keeps the full routing budget', async () => {
    const world = await open();
    world.cardd.oldFees = true;
    act(refocus);
    toAmount();
    press('All');
    expect(await screen.findByText('All: 99,497 sat')).toBeTruthy();
    expect(screen.getByText("Up to 503 sat kept for routing fees; what isn't used stays in Pool.")).toBeTruthy();
    press('Next');
    expect(screen.getByRole('button', { name: 'Send 99,497 sat' })).toBeTruthy();
  });

  it('takes a typed amount as large as All', async () => {
    await open();
    toAmount();
    fireEvent.change(screen.getByPlaceholderText('Amount in sat'), { target: { value: '99596' } });
    expect(screen.getByRole('button', { name: 'Next' }).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('typing after All clears it', async () => {
    await open();
    toAmount();
    press('All');
    expect(await screen.findByText('All: 99,596 sat')).toBeTruthy();
    fireEvent.change(await screen.findByPlaceholderText('All'), { target: { value: '5000' } });
    expect(screen.getByPlaceholderText('Amount in sat')).toBeTruthy();
    expect(screen.queryByText(/kept for routing fees/)).toBeNull();
    press('Next');
    expect(screen.getByRole('button', { name: 'Send 5,000 sat' })).toBeTruthy();
  });

  it("All stops at the most an address takes", async () => {
    server.schema = 10;
    const world = await open();
    world.cardd.lookups.set('sam@getalby.com', { kind: 'payurl', to: 'sam@getalby.com', minMsat: 1_000, maxMsat: 50_000_000, description: "Sam's tips" });
    toAmount('sam@getalby.com');
    await screen.findByPlaceholderText('Amount in sat');
    press('All');
    expect(await screen.findByText('Most this address takes: 50,000 sat')).toBeTruthy();
    // What cardd sets aside beside 50,000 sat: the full budget, which fits.
    expect(screen.getByText("Up to 255 sat kept for routing fees; what isn't used stays in Pool.")).toBeTruthy();
  });

  it("All stops at the most a link takes", async () => {
    server.schema = 10;
    const world = await open();
    const link = 'https://shop.example.com/lnurlp/abc';
    world.cardd.lookups.set(link, { kind: 'payurl', to: link, minMsat: 1_000, maxMsat: 20_000_000, description: 'Shop' });
    toAmount(link);
    await screen.findByPlaceholderText('Amount in sat');
    press('All');
    expect(await screen.findByText('Most this link takes: 20,000 sat')).toBeTruthy();
  });

  it('All reads Pool afresh', async () => {
    const world = await open();
    toAmount();
    world.cardd.balances.set('pool', 50_000_000);
    press('All');
    expect(await screen.findByText('All: 49,795 sat')).toBeTruthy();
  });

  it('after cardd refuses, Back finds All following Pool', async () => {
    const world = await open();
    toAmount();
    press('All');
    press('Next');
    world.cardd.sendRefusal = { status: 409, code: 'insufficient', message: 'store: not enough money available' };
    world.cardd.balances.set('pool', 50_000_000);
    press('Send 99,596 sat');
    expect(await screen.findByText('There isn’t enough money available.')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Back' })[0]);
    expect(await screen.findByText('All: 49,795 sat')).toBeTruthy();
  });

  it('no All to press for a Pool too small to send from', async () => {
    const world = await open();
    world.cardd.balances.set('pool', 6_003);
    act(refocus);
    await screen.findByText('6 sat available');
    toAmount();
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('Send out typed in pounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    look.rated = { currency: 'GBP', price: 61_352, time: Math.floor(Date.now() / 1000) };
    look.typingUnit = 'fiat';
  });
  afterEach(() => {
    look.rated = null;
    look.typingUnit = 'sat';
  });

  it('sends £5.00 as the 8,150 sat it comes to at 1 BTC = £61,352', async () => {
    const world = await open();
    fireEvent.change(field(), { target: { value: 'alice@example.com' } });
    press('Next');
    // The chip names the unit the field types in.
    expect(await screen.findByText('£ GBP')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Amount in £'), { target: { value: '5' } });
    expect(screen.getByText('≈ 8,150 sat at 1 BTC = £61,352')).toBeTruthy();
    press('Next');
    // Check reads the sats back, and the other figure under them.
    expect(await screen.findByRole('button', { name: 'Send 8,150 sat' })).toBeTruthy();
    expect(screen.getByText('≈ £5.00')).toBeTruthy();
    press('Send 8,150 sat');
    expect(await screen.findByText('Sent 8,150 sat')).toBeTruthy();
    expect(screenLock).toHaveBeenCalledWith('Send 8,150 sat', 'sending out');
    expect(world.cardd.balances.get('pool')).toBe(91_850_000);
  });

  it('asks the screen lock for the figure its button shows, "Send £5.00" in £ view', async () => {
    const world = await open();
    look.view = 'fiat';
    try {
      rerender(<Send />);
      fireEvent.change(field(), { target: { value: 'alice@example.com' } });
      press('Next');
      fireEvent.change(await screen.findByPlaceholderText('Amount in £'), { target: { value: '5' } });
      press('Next');
      press('Send £5.00');
      expect(await screen.findByText('Sent £5.00')).toBeTruthy();
      expect(screenLock).toHaveBeenCalledWith('Send £5.00', 'sending out');
      expect(world.cardd.balances.get('pool')).toBe(91_850_000);
    } finally {
      look.view = 'sat';
    }
  });

  it('confirms in £ while amounts are hidden with £ chosen: "Send £5.00"', async () => {
    await open();
    look.view = 'hidden';
    look.unit = 'fiat';
    try {
      rerender(<Send />);
      fireEvent.change(field(), { target: { value: 'alice@example.com' } });
      press('Next');
      fireEvent.change(await screen.findByPlaceholderText('Amount in £'), { target: { value: '5' } });
      press('Next');
      expect(await screen.findByRole('button', { name: 'Send £5.00' })).toBeTruthy();
    } finally {
      look.view = 'sat';
      look.unit = 'sat';
    }
  });

  // Check confirms in £ while amounts are hidden with £ chosen: a £ figure is on the page, so the rate's age is said.
  it('says the rate is old on Check while amounts are hidden with £ chosen', async () => {
    await open();
    const fresh = look.rated;
    look.rated = { currency: 'GBP', price: 61_352, time: Math.floor(Date.now() / 1000) - 5 * 3600 };
    look.view = 'hidden';
    look.unit = 'fiat';
    try {
      rerender(<Send />);
      fireEvent.change(field(), { target: { value: 'alice@example.com' } });
      press('Next');
      fireEvent.change(await screen.findByPlaceholderText('Amount in £'), { target: { value: '5' } });
      press('Next');
      expect(await screen.findByRole('button', { name: 'Send £5.00' })).toBeTruthy();
      expect(screen.getByText(/^£ at a rate .* old$/)).toBeTruthy();
    } finally {
      look.rated = fresh;
      look.view = 'sat';
      look.unit = 'sat';
    }
  });

  it('empties the pounds typed when the rate goes while Check shows, so Back finds no "5" to read as 5 sat', async () => {
    await open();
    fireEvent.change(field(), { target: { value: 'alice@example.com' } });
    press('Next');
    fireEvent.change(await screen.findByPlaceholderText('Amount in £'), { target: { value: '5' } });
    press('Next');
    expect(await screen.findByRole('button', { name: 'Send 8,150 sat' })).toBeTruthy();
    // The rate goes: the app types sat now. Check keeps the sats Next took.
    look.rated = null;
    look.typingUnit = 'sat';
    rerender(<Send />);
    expect(screen.getByRole('button', { name: 'Send 8,150 sat' })).toBeTruthy();
    // Check's Back (the header's does the same).
    fireEvent.click(screen.getAllByRole('button', { name: 'Back' })[0]);
    const amount = (await screen.findByPlaceholderText('Amount in sat')) as HTMLInputElement;
    expect(amount.value).toBe('');
    expect(screen.getByRole('button', { name: 'Next' }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('Send out: the Recent list', () => {
  const nowS = () => Math.floor(Date.now() / 1000);
  const two = () => [
    { to: 'alice@a.com', shown: 'alice@a.com', paidAt: nowS() - 1 },
    { to: 'bob@b.com', shown: '₿bob@b.com', paidAt: nowS() - 2 },
  ];
  const openWithTwo = () => open((w) => (w.cardd.recent = two()));
  const row = (shown: string) => screen.getByRole('button', { name: new RegExp(`^${shown}, Paid today at`) });

  beforeEach(() => {
    vi.clearAllMocks();
    server.schema = 13;
    server.down = null;
  });

  it('shows Recent with an empty field', async () => {
    await openWithTwo();
    expect(await screen.findByText('Recent')).toBeTruthy();
    expect(screen.getByText('alice@a.com')).toBeTruthy();
    expect(screen.getByText('₿bob@b.com')).toBeTruthy();
    expect(screen.getAllByText(/^Paid today at \d/)).toHaveLength(2);
  });

  it('hides Recent once the field has text, and shows it again when cleared', async () => {
    await openWithTwo();
    await screen.findByText('Recent');
    fireEvent.change(field(), { target: { value: 'c' } });
    expect(screen.queryByText('Recent')).toBeNull();
    fireEvent.change(field(), { target: { value: '' } });
    expect(screen.getByText('Recent')).toBeTruthy();
  });

  it('a tap fills the field as Paste does, and Next looks it up', async () => {
    const world = await openWithTwo();
    await screen.findByText('Recent');
    fireEvent.click(row('alice@a.com'));
    expect((field() as HTMLInputElement).value).toBe('alice@a.com');
    expect(screen.queryByText('Recent')).toBeNull();
    press('Next');
    await screen.findByPlaceholderText('Amount in sat');
    const asked = world.cardd.http.requests.find((r) => r.url.endsWith('/api/v1/send/lookup'))!;
    expect(asked.body).toBe(JSON.stringify({ to: 'alice@a.com' }));
  });

  it('Edit puts a remove button on each row, and Done takes them off', async () => {
    await openWithTwo();
    await screen.findByText('Recent');
    press('Edit');
    expect(screen.getByRole('button', { name: 'Remove alice@a.com from Recent' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove ₿bob@b.com from Recent' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^alice@a.com, Paid/ })).toBeNull();
    press('Done');
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(row('alice@a.com')).toBeTruthy();
  });

  it('removing calls the server and drops the row', async () => {
    const world = await openWithTwo();
    await screen.findByText('Recent');
    press('Edit');
    press('Remove alice@a.com from Recent');
    expect(screen.queryByText('alice@a.com')).toBeNull();
    await vi.waitFor(() => expect(world.cardd.recent.map((r) => r.to)).toEqual(['bob@b.com']));
    expect(screen.getByText('₿bob@b.com')).toBeTruthy();
  });

  it('a removed row stays gone after the field is typed in and cleared', async () => {
    const world = await openWithTwo();
    await screen.findByText('Recent');
    press('Edit');
    press('Remove alice@a.com from Recent');
    await vi.waitFor(() => expect(world.cardd.recent.map((r) => r.to)).toEqual(['bob@b.com']));
    fireEvent.change(field(), { target: { value: 'c' } });
    fireEvent.change(field(), { target: { value: '' } });
    await screen.findByText('Recent');
    expect(screen.queryByText('alice@a.com')).toBeNull();
    expect(screen.getByText('₿bob@b.com')).toBeTruthy();
  });

  it('a failed removal brings the row back with the reason', async () => {
    await open((w) => {
      w.cardd.recent = two();
      w.cardd.removeRecentFails = 'disk full';
    });
    await screen.findByText('Recent');
    press('Edit');
    press('Remove alice@a.com from Recent');
    expect(await screen.findByText("Couldn't remove it: disk full")).toBeTruthy();
    expect(screen.getByText('alice@a.com')).toBeTruthy();
  });

  it('removing the last row ends Edit and the heading goes', async () => {
    await open((w) => (w.cardd.recent = [two()[0]]));
    await screen.findByText('Recent');
    press('Edit');
    press('Remove alice@a.com from Recent');
    await vi.waitFor(() => expect(screen.queryByText('Recent')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
  });

  it('shows no Recent on a schema-12 server', async () => {
    server.schema = 12;
    await openWithTwo();
    await act(async () => {});
    expect(screen.queryByText('Recent')).toBeNull();
  });

  it('shows no Recent when the list is empty', async () => {
    await open();
    await act(async () => {});
    expect(screen.queryByText('Recent')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it("leaves out this server's own addresses", async () => {
    await open((w) => (w.cardd.recent = [{ to: `pool@${w.cardd.host}`, shown: `pool@${w.cardd.host}`, paidAt: nowS() - 1 }, two()[0]]));
    await screen.findByText('Recent');
    expect(screen.queryByText(/^pool@/)).toBeNull();
    expect(screen.getByText('alice@a.com')).toBeTruthy();
  });
});
