// A card's account page rendered, over the card tests' fake cardd: Unfreeze behind the screen lock, which lets the
// card spend again; Freeze asks for none. Only what needs a phone is replaced: the screen lock and the app's services.
// It lives here, not beside account.tsx: every file in src/app/ is a route to Expo Router.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useLocalSearchParams } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Account from '../../app/account';
import type { CardDeps } from '../../cards/deps';
import { screenLock } from '../../ui/lock';
import { cardWorld } from '../cardWorld';

const deps: { now: CardDeps | null } = { now: null };
// The same objects every render, as the app's are.
const server = {
  snap: { cards: [], phoneCard: { own: null, ids: [] }, photos: {} },
  watch: { reportRefresh: () => {}, reloadCards: async () => {}, seenWallet: () => {} },
};
vi.mock('../../services/server', () => ({ useCardDeps: () => deps.now, useServer: () => server, useTapCheck: () => null }));
vi.mock('../../services/services', () => ({ useRouteGuard: () => true, useServices: () => ({}), phoneCardDeps: () => ({}) }));
vi.mock('../../ui/lock', () => ({ screenLock: vi.fn(async () => null) }));

const DAILY = 'ab12cd34ef' + '0'.repeat(22);

async function open(state: 'active' | 'frozen') {
  const world = await cardWorld();
  world.cardd.cards.set(DAILY, { id: DAILY, version: 1, state, counter: 0, name: 'Daily', created: 0, updated: 0 });
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
