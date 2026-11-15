// Karto PoS's sale screen rendered: on an iPhone the code
// shows first and Pay by card opens Apple's sheet, which a card's read ends with the tick, a payment by the code
// ends with Paid and Cancel sale ends with a red cross; on Android the hold row stays and no session is touched.
// The shop is a queue of answers for pos.ask; the sheet is a stand-in session whose state the test moves; a card is
// handed to the claim the screen made; readTap and chargeCard stand in for the card and its server.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NfcSession, SessionEnd, Tag } from '../../native/nfc';
import type { PosSale } from '../../pos/client';
import Sale from '../../pos-app/sale';

const NOW_S = Math.floor(Date.now() / 1000);
const ID = '00000000-0000-4000-8000-000000000001';
const SALE = { id: ID, amountMsat: 2_500_000, state: 'open', method: '', device: { keyId: 'k', name: 'Till 1' }, created: NOW_S, expires: NOW_S + 600, invoice: 'lnbc25u1xyz' } as unknown as PosSale;
const PAID = { ...SALE, state: 'paid', method: 'qr', paidAt: NOW_S + 5, txId: 7, invoice: undefined } as unknown as PosSale;
const OPEN_LINE = 'Hold the card against the top of the back of the phone. 2,500 sat';

/** Apple's sheet, as the screen sees it through nfc.session: its calls are recorded, its state is the test's. */
function fakeSession() {
  let st: 'none' | 'open' | 'ending' = 'none';
  const ends = new Set<(e: SessionEnd) => void>();
  // done, fail and close are told apart by their lines; each takes an open sheet to 'ending', as nativeSession does.
  const ending = () => vi.fn(() => void (st === 'open' && (st = 'ending')));
  return {
    open: vi.fn(async () => {
      if (st !== 'none') throw new Error('A card is already being read.');
      st = 'open';
    }),
    say: vi.fn(),
    again: vi.fn(),
    done: ending(),
    fail: ending(),
    close: ending(),
    onEnd: (fn: (e: SessionEnd) => void) => {
      ends.add(fn);
      return () => void ends.delete(fn);
    },
    state: () => st,
    /** iOS reports the end: the sheet has gone. */
    end: (e: SessionEnd) => {
      st = 'none';
      for (const fn of [...ends]) fn(e);
    },
  };
}

const env: {
  session: ReturnType<typeof fakeSession> | null;
  onTag: ((tag: Tag) => void) | null;
  reads: PosSale[];
  pos: Record<string, unknown>;
} = { session: null, onTag: null, reads: [], pos: {} };

const mocks = vi.hoisted(() => ({ readTap: vi.fn(), chargeCard: vi.fn() }));

vi.mock('expo-keep-awake', () => ({ useKeepAwake: () => undefined }));
vi.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000002' }));
vi.mock('../../pos/app', () => ({ usePos: () => env.pos }));
vi.mock('../../pos/nfc', async (original) => ({ ...(await original<typeof import('../../pos/nfc')>()), readTap: mocks.readTap }));
vi.mock('../../pos/charge', async (original) => ({ ...(await original<typeof import('../../pos/charge')>()), chargeCard: mocks.chargeCard }));

function setUp(mode: 'session' | 'always') {
  env.session = mode === 'session' ? fakeSession() : null;
  env.onTag = null;
  env.reads = [];
  const client = {
    sale: vi.fn(async () => env.reads.shift() ?? SALE),
    cancel: vi.fn(async () => undefined),
    cardRead: vi.fn(async () => undefined),
  };
  env.pos = {
    sale: SALE,
    paired: { host: 'karto.example', name: 'Till 1' },
    paid: null,
    removed: false,
    ask: (call: (c: typeof client) => Promise<unknown>) => call(client),
    slot: {
      claim: (fn: (tag: Tag) => void) => {
        env.onTag = fn;
        return () => void (env.onTag === fn && (env.onTag = null));
      },
    },
    nfc: { mode, session: env.session as unknown as NfcSession | null },
    cardFetch: vi.fn(),
    watch: vi.fn(),
    setSale: vi.fn(),
    celebrate: vi.fn(),
    buzzRefused: vi.fn(),
  };
}

const tag = (): Tag => ({ uid: new Uint8Array([1, 2, 3, 4]), transceive: null, close: vi.fn(async () => undefined) });
/** Lets the promises a step started settle. */
const settle = () => act(async () => {});
/** One second of the screen's clock, and the read of the sale it starts. */
const second = async () => {
  await act(async () => void vi.advanceTimersByTime(1000));
  await settle();
};
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('the sale screen on an iPhone', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.clearAllMocks();
    setUp('session');
  });
  afterEach(() => vi.useRealTimers());

  it('shows Pay by card on an iPhone and opens the sheet with the amount', async () => {
    render(<Sale />);
    expect(screen.queryByText('Hold a Bolt Card to the back of this phone')).toBeNull();
    press('Pay by card');
    await settle();
    expect(env.session!.open).toHaveBeenCalledWith(OPEN_LINE);
  });

  it("ends the sheet with Card read and charges once a card's link is read", async () => {
    mocks.readTap.mockResolvedValue({ kind: 'link', link: 'lnurlw://card.example/ln?p=AA&c=BB' });
    mocks.chargeCard.mockResolvedValue({ kind: 'accepted' });
    render(<Sale />);
    press('Pay by card');
    await settle();
    await act(async () => env.onTag!(tag()));
    await settle();
    expect(env.session!.say).toHaveBeenCalledWith('Reading the card…');
    expect(env.session!.done).toHaveBeenCalledWith('Card read. You can take it away.');
    expect(mocks.chargeCard).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Card read')).toBeTruthy();
  });

  it('asks again for a card that is not a Bolt Card, leaving the sale waiting', async () => {
    mocks.readTap.mockResolvedValue({ kind: 'not-a-card' });
    render(<Sale />);
    press('Pay by card');
    await settle();
    await act(async () => env.onTag!(tag()));
    await settle();
    expect(env.session!.again).toHaveBeenCalledWith("That isn't a Bolt Card. Hold a Bolt Card against the top of the back of the phone.");
    expect(env.session!.done).not.toHaveBeenCalled();
    expect(mocks.chargeCard).not.toHaveBeenCalled();
    // The sheet says it: no note under it, which would show stale once it ends.
    expect(screen.queryByText("That isn't a Bolt Card that can pay.")).toBeNull();
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeTruthy();
    // A second card is read: the first freed the screen.
    mocks.readTap.mockResolvedValue({ kind: 'link', link: 'lnurlw://card.example/ln?p=AA&c=BB' });
    mocks.chargeCard.mockResolvedValue({ kind: 'accepted' });
    await act(async () => env.onTag!(tag()));
    await settle();
    expect(mocks.chargeCard).toHaveBeenCalledTimes(1);
  });

  it('ends the sheet with Paid when the QR payment arrives while it is up', async () => {
    render(<Sale />);
    press('Pay by card');
    await settle();
    env.reads.push(PAID);
    await second();
    expect(env.session!.done).toHaveBeenCalledWith('Paid');
    expect(env.pos.celebrate).toHaveBeenCalledTimes(1);
  });

  it('ends the sheet with Sale cancelled on Cancel sale', async () => {
    render(<Sale />);
    press('Pay by card');
    await settle();
    press('Cancel sale');
    await settle();
    expect(env.session!.fail).toHaveBeenCalledWith('Sale cancelled.');
  });

  it('turns the button off while the sheet is up or ending, and on again once iOS reports its end', async () => {
    render(<Sale />);
    press('Pay by card');
    await settle();
    press('Pay by card');
    await settle();
    expect(env.session!.open).toHaveBeenCalledTimes(1);
    await act(async () => env.session!.end({ why: 'timeout' }));
    press('Pay by card');
    await settle();
    expect(env.session!.open).toHaveBeenCalledTimes(2);
  });

  it("shows iOS's words when the sheet ends with an error of its own", async () => {
    render(<Sale />);
    press('Pay by card');
    await settle();
    await act(async () => env.session!.end({ why: 'error', error: 'NFC is busy.' }));
    expect(screen.getByText('NFC is busy.')).toBeTruthy();
  });

  it('a card after Paid is not charged', async () => {
    render(<Sale />);
    env.reads.push(PAID);
    await second();
    const t = tag();
    await act(async () => env.onTag?.(t));
    await settle();
    expect(mocks.readTap).not.toHaveBeenCalled();
    expect(mocks.chargeCard).not.toHaveBeenCalled();
    expect(t.close).toHaveBeenCalled();
  });
});

describe('the sale screen on Android', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.clearAllMocks();
    setUp('always');
  });
  afterEach(() => vi.useRealTimers());

  it('on Android draws the hold row and never touches a session', async () => {
    mocks.readTap.mockResolvedValue({ kind: 'link', link: 'lnurlw://card.example/ln?p=AA&c=BB' });
    mocks.chargeCard.mockResolvedValue({ kind: 'accepted' });
    render(<Sale />);
    expect(screen.getByText('Hold a Bolt Card to the back of this phone')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pay by card' })).toBeNull();
    await act(async () => env.onTag!(tag()));
    await settle();
    expect(mocks.chargeCard).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Card read')).toBeTruthy();
  });
});
