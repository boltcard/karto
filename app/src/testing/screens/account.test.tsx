// A card's account page rendered, over the card tests' fake cardd: Unfreeze behind the screen lock, which lets the
// card spend again; Freeze asks for none. Only what needs a phone is replaced: the screen lock and the app's services.
// It lives here, not beside account.tsx: every file in src/app/ is a route to Expo Router.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { router, useLocalSearchParams } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Account from '../../app/account';
import type { CardDeps } from '../../cards/deps';
import { GIVE_UP_UNREACHABLE } from '../../cards/giveUp';
import { screenLock } from '../../ui/lock';
import { cardWorld } from '../cardWorld';
import { blur } from './focus';

const deps: { now: CardDeps | null } = { now: null };
// The same objects every render, as the app's are.
const server = {
  snap: { cards: [], phoneCard: { own: null, ids: [] as string[] }, photos: {}, unreachable: false },
  watch: { reportRefresh: () => {}, reloadCards: async () => {}, seenWallet: () => {}, noteGaveUp: vi.fn() },
};
vi.mock('../../services/server', () => ({ useCardDeps: () => deps.now, useServer: () => server, useTapCheck: () => null }));
vi.mock('../../services/services', () => ({ useRouteGuard: () => true, useServices: () => ({}), phoneCardDeps: () => ({}) }));
vi.mock('../../ui/lock', () => ({ screenLock: vi.fn(async () => null) }));

const DAILY = 'ab12cd34ef' + '0'.repeat(22);

async function open(state: 'active' | 'frozen', o: { sat?: number; phoneCard?: boolean; unreachable?: boolean } = {}) {
  const world = await cardWorld();
  world.cardd.cards.set(DAILY, { id: DAILY, version: 1, state, counter: 0, name: 'Daily', created: 0, updated: 0 });
  if (o.sat) world.cardd.balances.set(DAILY, o.sat * 1000);
  server.snap.phoneCard.ids = o.phoneCard ? [DAILY] : [];
  server.snap.unreachable = !!o.unreachable;
  deps.now = world.deps;
  vi.mocked(useLocalSearchParams).mockReturnValue({ id: DAILY });
  render(<Account />);
  return world;
}

describe("A card's Unfreeze", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks for the screen lock, naming the card, then unfreezes it', async () => {
    const world = await open('frozen');
    fireEvent.click(await screen.findByRole('button', { name: 'Unfreeze' }));
    await vi.waitFor(() => expect(world.cardd.cards.get(DAILY)?.state).toBe('active'));
    expect(screenLock).toHaveBeenCalledWith('Unfreeze Daily', 'unfreezing a card');
  });

  it('leaves the card frozen, and says why, when the screen lock is refused', async () => {
    vi.mocked(screenLock).mockResolvedValueOnce('The screen lock was not confirmed.');
    const world = await open('frozen');
    fireEvent.click(await screen.findByRole('button', { name: 'Unfreeze' }));
    expect(await screen.findByText('The screen lock was not confirmed.')).toBeTruthy();
    await act(async () => {});
    expect(world.cardd.cards.get(DAILY)?.state).toBe('frozen');
  });

  it('asks for the lock once for a double tap', async () => {
    let confirm: (why: string | null) => void = () => {};
    vi.mocked(screenLock).mockImplementationOnce(() => new Promise((go) => (confirm = go)));
    const world = await open('frozen');
    const button = await screen.findByRole('button', { name: 'Unfreeze' });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => confirm(null));
    await vi.waitFor(() => expect(world.cardd.cards.get(DAILY)?.state).toBe('active'));
    expect(screenLock).toHaveBeenCalledTimes(1);
  });

  it('asks for no lock to freeze a card', async () => {
    const world = await open('active');
    fireEvent.click(await screen.findByRole('button', { name: 'Freeze' }));
    await vi.waitFor(() => expect(world.cardd.cards.get(DAILY)?.state).toBe('frozen'));
    expect(screenLock).not.toHaveBeenCalled();
  });
});

// A card the person no longer has: given up from its More sheet, after a confirm and the screen lock.
describe("A card's I no longer have this card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  const more = async () => fireEvent.click(await screen.findByRole('button', { name: 'More' }));
  const row = () => screen.findByRole('button', { name: /I no longer have this card/ });

  it("has its own icon, not Wipe's, so the two red rows don't look alike", async () => {
    await open('active', { sat: 5000 });
    await more();
    const svg = async (name: RegExp) => (await screen.findByRole('button', { name })).querySelector('svg')?.innerHTML;
    const giveUp = await svg(/I no longer have this card/);
    expect(giveUp).toBeTruthy();
    expect(giveUp).not.toBe(await svg(/Wipe the card/));
  });

  it('asks for the screen lock after the confirm, then removes the card and its money goes to Pool', async () => {
    const world = await open('active', { sat: 5000 });
    await more();
    fireEvent.click(await row());
    expect(await screen.findByText(/It can't be undone\. Its 5,000 sat move to Pool; taps of it are refused\./)).toBeTruthy();
    expect(screenLock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the card' }));
    await vi.waitFor(() => expect(world.cardd.cards.get(DAILY)?.state).toBe('reset'));
    expect(screenLock).toHaveBeenCalledWith('Remove Daily', 'removing a card');
    expect(world.cardd.balances.get('pool')).toBe(5_000_000);
    await vi.waitFor(() => expect(router.back).toHaveBeenCalled());
    // The Wallet page says what was removed.
    expect(server.watch.noteGaveUp).toHaveBeenCalledWith({ name: 'Daily', amountMsat: 5_000_000, pending: false });
  });

  // The start waits for its answer until the test lets it go.
  const held = (world: Awaited<ReturnType<typeof open>>) => {
    const go = { release: () => {} };
    const real = world.deps.cardd.wipeCard.bind(world.deps.cardd);
    vi.spyOn(world.deps.cardd, 'wipeCard').mockImplementationOnce(async (id: string) => {
      await new Promise<void>((r) => (go.release = r));
      return real(id);
    });
    return go;
  };
  const confirm = async () => {
    await more();
    fireEvent.click(await row());
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the card' }));
  };

  it("says it is removing the card while the server's answers are awaited, with the page's actions gone", async () => {
    const world = await open('active', { sat: 5000 });
    const go = held(world);
    await confirm();
    expect(await screen.findByText('Removing the card…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Freeze' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    await act(async () => go.release());
    await vi.waitFor(() => expect(router.back).toHaveBeenCalled());
  });

  it('goes back all the same when the finish gets no answer, the Wallet page saying the server will be told', async () => {
    const world = await open('active', { sat: 5000 });
    vi.spyOn(world.deps.cardd, 'wipedCard').mockRejectedValueOnce(new TypeError('fetch failed: no answer'));
    await confirm();
    await vi.waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(server.watch.noteGaveUp).toHaveBeenCalledWith({ name: 'Daily', amountMsat: 5_000_000, pending: true });
    expect(world.cardd.cards.get(DAILY)?.state).toBe('wiping');
  });

  it('does not go back from whatever page the person has gone on to', async () => {
    const world = await open('active', { sat: 5000 });
    const go = held(world);
    await confirm();
    await screen.findByText('Removing the card…');
    act(() => blur());
    await act(async () => go.release());
    await vi.waitFor(() => expect(server.watch.noteGaveUp).toHaveBeenCalled());
    expect(world.cardd.cards.get(DAILY)?.state).toBe('reset');
    expect(router.back).not.toHaveBeenCalled();
  });

  it('changes nothing when the screen lock is refused', async () => {
    vi.mocked(screenLock).mockResolvedValueOnce('The screen lock was not confirmed.');
    const world = await open('active', { sat: 5000 });
    await more();
    fireEvent.click(await row());
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the card' }));
    expect(await screen.findByText('The screen lock was not confirmed.')).toBeTruthy();
    expect(world.cardd.cards.get(DAILY)?.state).toBe('active');
    expect(world.cardd.balances.get(DAILY)).toBe(5_000_000);
  });

  it("says so and changes nothing when the server can't be reached at the start", async () => {
    const world = await open('active', { sat: 5000 });
    await more();
    fireEvent.click(await row());
    world.w.carddDown = true;
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the card' }));
    expect(await screen.findByText(GIVE_UP_UNREACHABLE)).toBeTruthy();
    world.w.carddDown = false;
    expect(world.cardd.cards.get(DAILY)?.state).toBe('active');
    expect(router.back).not.toHaveBeenCalled();
  });

  it("is off while the server can't be reached", async () => {
    await open('active', { unreachable: true });
    await more();
    expect((await row()).getAttribute('aria-disabled')).toBe('true');
  });

  it("shows no such row on a phone's card", async () => {
    await open('active', { phoneCard: true });
    await more();
    await screen.findByRole('button', { name: /Limits/ });
    expect(screen.queryByRole('button', { name: /I no longer have this card/ })).toBeNull();
  });
});

// A payment that started after the confirm opened: the confirm says so in a sentence, and can't be pressed.
describe("The confirm for I no longer have this card", () => {
  it('reads as a sentence and is off while a payment is in progress', async () => {
    const { GiveUpSheet } = await import('../../ui/GiveUpSheet');
    render(<GiveUpSheet name="Daily" line="Wait for the payment in progress" disabled onConfirm={() => {}} onClose={() => {}} />);
    expect(await screen.findByText(/It can't be undone\. Wait for the payment in progress\. If the card turns up/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove the card' }).getAttribute('aria-disabled')).toBe('true');
  });
});
