// The hold-the-card screen rendered for Add card, over the simulated card and the fake cardd
// (testing/cardWorld.ts): the screen lock before a card is added, asked as the screen opens when a press in the app
// led there, and only at its button when a karto:// link opened it; a card held before the lock has passed is
// closed unwritten. Only what needs a phone is replaced: the screen lock, NFC's slot and the app's services.
// It lives here, not beside card.tsx: every file in src/app/ is a route to Expo Router.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLocalSearchParams } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CardScreen from '../../app/card';
import type { CardDeps } from '../../cards/deps';
import { holdPress } from '../../cards/holdPress';
import type { Tag } from '../../native/nfc';
import { screenLock } from '../../ui/lock';
import { cardWorld } from '../cardWorld';

const deps: { now: CardDeps | null } = { now: null };
/** The screen's claim on NFC's taps: a card held to the phone. */
const slot: { onTag: ((tag: Tag) => void) | null } = { onTag: null };
const services = {
  nfc: { session: null },
  nfcSlot: {
    claim: (onTag: (tag: Tag) => void) => {
      slot.onTag = onTag;
      return () => {
        slot.onTag = null;
      };
    },
  },
};

vi.mock('expo-keep-awake', () => ({ useKeepAwake: () => undefined }));
vi.mock('../../services/server', () => ({
  useCardDeps: () => deps.now,
  useServer: () => ({ snap: { cards: [], photos: {}, wallet: null, unreachable: false } }),
}));
vi.mock('../../services/services', () => ({ useRouteGuard: () => true, useServices: () => services }));
vi.mock('../../ui/lock', () => ({ screenLock: vi.fn(async () => null), useLockKind: () => 'screen-lock' }));

const REFUSED = 'The screen lock was not confirmed.';
const WAITING = 'Hold Daily flat against the back of the phone';

/** Opens the screen with its link's parameters over a world with a blank card in the field. */
async function open(params: Record<string, string>) {
  const world = await cardWorld();
  deps.now = world.deps;
  vi.mocked(useLocalSearchParams).mockReturnValue(params);
  render(<CardScreen />);
  return world;
}

/** Holds the world's card to the phone, as Android hands it over, and waits for the screen to be done with it. */
async function hold(world: Awaited<ReturnType<typeof cardWorld>>) {
  const transceive = vi.fn(world.sim.transceive);
  const close = vi.fn(async () => {});
  await act(async () => {
    slot.onTag!({ uid: world.sim.tagId(), transceive, close });
  });
  await waitFor(() => expect(close).toHaveBeenCalled());
  return { transceive, close };
}

describe('Add card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    slot.onTag = null;
  });

  it('asks for the screen lock as it opens from the name screen, then adds the card held', async () => {
    const world = await open({ op: 'add', name: 'Daily', randomUid: '1', press: holdPress() });
    expect(await screen.findByText(WAITING)).toBeTruthy();
    expect(screenLock).toHaveBeenCalledTimes(1);
    expect(screenLock).toHaveBeenCalledWith('Add Daily', 'adding a card');
    await hold(world);
    expect(await screen.findByText('Card added')).toBeTruthy();
    expect([...world.cardd.cards.values()]).toMatchObject([{ name: 'Daily', state: 'active' }]);
  });

  it('stays on its page, with the reason, when the screen lock is refused, and leaves a card held unwritten', async () => {
    vi.mocked(screenLock).mockResolvedValueOnce(REFUSED);
    const world = await open({ op: 'add', name: 'Daily', randomUid: '1', press: holdPress() });
    expect(await screen.findByText(REFUSED)).toBeTruthy();
    expect(screen.getByText('Add Daily')).toBeTruthy();
    expect(screen.getByText('Adding a card needs your screen lock, then Daily held to the phone.')).toBeTruthy();
    expect(screen.queryByText(WAITING)).toBeNull();
    const { transceive } = await hold(world);
    expect(transceive).not.toHaveBeenCalled();
    expect(world.cardd.cards.size).toBe(0);
    // Its button asks again.
    fireEvent.click(screen.getByRole('button', { name: 'Unlock to add' }));
    expect(await screen.findByText(WAITING)).toBeTruthy();
    expect(screenLock).toHaveBeenCalledTimes(2);
  });

  it('opened by a link, asks for nothing until its button is pressed, and leaves a card held meanwhile unwritten', async () => {
    const world = await open({ op: 'add', name: 'Daily', randomUid: '0' });
    expect(await screen.findByRole('button', { name: 'Unlock to add' })).toBeTruthy();
    expect(screenLock).not.toHaveBeenCalled();
    const { transceive } = await hold(world);
    expect(transceive).not.toHaveBeenCalled();
    expect(world.cardd.cards.size).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock to add' }));
    expect(await screen.findByText(WAITING)).toBeTruthy();
    expect(screenLock).toHaveBeenCalledWith('Add Daily', 'adding a card');
    await hold(world);
    expect(await screen.findByText('Card added')).toBeTruthy();
  });

  it('opened by a link to a press that was not its own, asks for nothing until its button is pressed', async () => {
    holdPress();
    await open({ op: 'add', name: 'Daily', press: 'not the token' });
    expect(await screen.findByRole('button', { name: 'Unlock to add' })).toBeTruthy();
    expect(screenLock).not.toHaveBeenCalled();
  });

  it('asks for the lock before finishing an add, which a blank card held would add too', async () => {
    vi.mocked(screenLock).mockResolvedValueOnce(REFUSED);
    const world = await open({ op: 'finish-add', press: holdPress() });
    expect(await screen.findByText(REFUSED)).toBeTruthy();
    expect(screenLock).toHaveBeenCalledWith('Finish adding the card', 'adding a card');
    const { transceive } = await hold(world);
    expect(transceive).not.toHaveBeenCalled();
    expect(world.cardd.cards.size).toBe(0);
  });
});
