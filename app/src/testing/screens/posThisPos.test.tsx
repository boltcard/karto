// Karto PoS's This PoS rendered: Unpair this phone asks first, and only Unpair acts: the shop is asked to forget the
// phone, the phone forgets the shop, and Pair opens. Keep this shop leaves everything as it was.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { router } from 'expo-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUpdateCheckerForTests } from '../../appUpdate/useAppUpdate';
import ThisPos from '../../pos-app/this-pos';

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.1' } } }));

const QUESTION = "Unpair this phone? It stops taking payments at once. The shop's sales stay. To take payments again it needs a new code from Karto Wallet.";
const phone = { forget: vi.fn(async () => undefined), storeForget: vi.fn(async () => undefined), setPaired: vi.fn() };

vi.mock('../../pos/app', () => ({
  usePos: () => ({
    paired: { host: 'karto.example', name: 'Till 1', wallet: 'Café' },
    sound: true,
    setSound: vi.fn(),
    store: { forget: phone.storeForget },
    ask: (call: (c: { forget: typeof phone.forget }) => Promise<unknown>) => call({ forget: phone.forget }),
    setPaired: phone.setPaired,
  }),
}));

const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
/** The row's name is read with its line. */
const ROW = /^Unpair this phone/;

describe('This PoS', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks before unpairing, and Keep this shop changes nothing', () => {
    render(<ThisPos />);
    press(ROW);
    expect(screen.getByText(QUESTION)).toBeTruthy();
    expect(phone.forget).not.toHaveBeenCalled();
    press('Keep this shop');
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(screen.getByRole('button', { name: ROW })).toBeTruthy();
    expect(phone.forget).not.toHaveBeenCalled();
    expect(phone.storeForget).not.toHaveBeenCalled();
    expect(phone.setPaired).not.toHaveBeenCalled();
  });

  it('unpairs once the person presses Unpair: the shop forgets the phone, the phone the shop, and Pair opens', async () => {
    render(<ThisPos />);
    press(ROW);
    press('Unpair');
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/pair'));
    expect(phone.forget).toHaveBeenCalledTimes(1);
    expect(phone.storeForget).toHaveBeenCalledTimes(1);
    expect(phone.setPaired).toHaveBeenCalledWith(null);
  });
});

// Settings / This PoS in a GitHub build: the update line is drawn under the build label.
describe('the update line', () => {
  afterEach(() => setUpdateCheckerForTests({ os: 'android', release: undefined, store: 'play' }, { getItemAsync: async () => null, setItemAsync: async () => {} }, vi.fn()));

  it('is drawn on the page, naming Karto PoS', async () => {
    const github = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ tag_name: 'v9.0.0' }) }) as Response);
    setUpdateCheckerForTests({ os: 'android', release: '1', store: '' }, { getItemAsync: async () => null, setItemAsync: async () => {} }, github);
    render(<ThisPos />);
    expect(await screen.findByRole('link', { name: 'Karto PoS 9.0.0 is out on GitHub' })).toBeTruthy();
    expect(github).toHaveBeenCalledTimes(1);
    // The test bundle carries no commit: the version and "build unknown".
    expect(screen.getByText('Karto PoS 1.0.1, build unknown')).toBeTruthy();
  });
});
