// The Move screen rendered, over the card tests' fake cardd (testing/cardWorld.ts) and the money code as it is:
// To, Amount and Check, the screen lock for money moved onto a card, and the result. Only what needs a phone is
// replaced: the screen lock and the app's services.
// It lives here, not beside move.tsx: every file in src/app/ is a route to Expo Router.
import { fireEvent, render, screen } from '@testing-library/react';
import { useLocalSearchParams } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Move from '../../app/move';
import type { CardDeps } from '../../cards/deps';
import { screenLock } from '../../ui/lock';
import { cardWorld } from '../cardWorld';

const deps: { now: CardDeps | null } = { now: null };
/** The phone as a card, as the watch has it: which cards are phones', and which is this phone's own. */
const phoneCard: { own: string | null; ids: string[] } = { own: null, ids: [] };

vi.mock('../../services/server', () => ({
  useCardDeps: () => deps.now,
  useServer: () => ({ snap: { cards: [], photos: {}, phoneCard } }),
}));
vi.mock('../../services/services', () => ({ useRouteGuard: () => true }));
vi.mock('../../ui/lock', () => ({ screenLock: vi.fn(async () => null) }));
vi.mock('../../ui/amountView', async (original) => ({
  ...(await original<typeof import('../../ui/amountView')>()),
  useAmountView: () => ({
    view: 'sat', rated: null, fiat: null, unit: 'sat', hidden: false, setUnit: () => {}, setHidden: () => {},
    typingUnit: 'sat', setTypingUnit: () => {}, chooseCurrency: async () => {},
  }),
}));

const DAILY = 'ab12cd34ef' + '0'.repeat(22);
const PHONE = 'cc' + '2'.repeat(30);
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

/** Opens Move with its link's parameters, Pool holding 100,000 sat and Daily 20,000. */
async function open(params: { from?: string; to?: string } = {}) {
  const world = await cardWorld();
  world.cardd.cards.set(DAILY, { id: DAILY, version: 1, state: 'active', counter: 0, name: 'Daily', created: 0, updated: 0 });
  world.cardd.balances.set('pool', 100_000_000);
  world.cardd.balances.set(DAILY, 20_000_000);
  world.cardd.cards.set(PHONE, { id: PHONE, version: 1, state: 'active', counter: 0, name: 'My phone', created: 0, updated: 0 });
  deps.now = world.deps;
  vi.mocked(useLocalSearchParams).mockReturnValue(params);
  render(<Move />);
  // The wallet's answer: what the account moved from holds.
  await screen.findByText(/sat available$/);
  return world;
}

/** Picks the target, types the amount in sat and goes on to Check. */
function toCheck(to: RegExp, sat: number) {
  press(to);
  fireEvent.change(screen.getByPlaceholderText('Amount in sat'), { target: { value: String(sat) } });
  press('Next');
}

describe('Move', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    phoneCard.own = null;
    phoneCard.ids = [];
  });

  it('asks for the screen lock before money moves onto a card, then moves it', async () => {
    const world = await open();
    toCheck(/^Daily/, 5_000);
    press('Move 5,000 sat');
    expect(await screen.findByText('Moved 5,000 sat')).toBeTruthy();
    expect(screenLock).toHaveBeenCalledWith('Move 5,000 sat', 'moving money onto a card');
    expect(world.cardd.balances.get('pool')).toBe(95_000_000);
    expect(world.cardd.balances.get(DAILY)).toBe(25_000_000);
  });

  it('stays on Check, with the reason, when the screen lock is refused, and moves nothing', async () => {
    const world = await open();
    vi.mocked(screenLock).mockResolvedValueOnce('The screen lock was not confirmed.');
    toCheck(/^Daily/, 5_000);
    press('Move 5,000 sat');
    expect(await screen.findByText('The screen lock was not confirmed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move 5,000 sat' })).toBeTruthy();
    expect(screen.queryByText('Moving… keep this screen open.')).toBeNull();
    expect(world.cardd.balances.get('pool')).toBe(100_000_000);
    expect(world.cardd.balances.get(DAILY)).toBe(20_000_000);
  });

  it('asks for no lock to move money off a card, back to Pool', async () => {
    const world = await open({ from: DAILY });
    toCheck(/^Pool/, 5_000);
    press('Move 5,000 sat');
    expect(await screen.findByText('Moved 5,000 sat')).toBeTruthy();
    expect(screenLock).not.toHaveBeenCalled();
    expect(world.cardd.balances.get(DAILY)).toBe(15_000_000);
    expect(world.cardd.balances.get('pool')).toBe(105_000_000);
  });

  it('asks for no lock to move money from Pool to Hosting', async () => {
    const world = await open();
    toCheck(/^Hosting/, 5_000);
    press('Move 5,000 sat');
    expect(await screen.findByText('Moved 5,000 sat')).toBeTruthy();
    expect(screenLock).not.toHaveBeenCalled();
    expect(world.cardd.balances.get('hosting')).toBe(5_000_000);
  });
  it("asks for no lock to move money onto this phone's own card, which pays only behind the lock", async () => {
    phoneCard.own = PHONE;
    phoneCard.ids = [PHONE];
    const world = await open();
    toCheck(/^My phone/, 5_000);
    press('Move 5,000 sat');
    expect(await screen.findByText('Moved 5,000 sat')).toBeTruthy();
    expect(screenLock).not.toHaveBeenCalled();
    expect(world.cardd.balances.get(PHONE)).toBe(5_000_000);
  });

  it("asks for the lock to move money onto another phone's card, as onto a plastic one", async () => {
    phoneCard.ids = [PHONE];
    await open();
    toCheck(/^My phone/, 5_000);
    press('Move 5,000 sat');
    expect(await screen.findByText('Moved 5,000 sat')).toBeTruthy();
    expect(screenLock).toHaveBeenCalledWith('Move 5,000 sat', 'moving money onto a card');
  });

  it("asks for the lock to move money onto a plastic card while this phone is a card too", async () => {
    phoneCard.own = PHONE;
    phoneCard.ids = [PHONE];
    await open();
    toCheck(/^Daily/, 5_000);
    press('Move 5,000 sat');
    expect(await screen.findByText('Moved 5,000 sat')).toBeTruthy();
    expect(screenLock).toHaveBeenCalledWith('Move 5,000 sat', 'moving money onto a card');
  });
});
