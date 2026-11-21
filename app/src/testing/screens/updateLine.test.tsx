// The update line on Settings and This PoS, and the shared answer behind it and Home's banner / the till's link: a
// GitHub build asks each time the page comes into view (no more than once a minute), a failure is silent, and what
// the page finds is what Home shows. GitHub is a fake fetch; the build is set through useAppUpdate's test seam.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppState, Linking, Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_EVERY_MS, RELEASES_PAGE, SAVED_KEY, type KeyValue } from '../../appUpdate/appUpdate';
import { UpdateLine } from '../../appUpdate/UpdateLine';
import { setUpdateCheckerForTests, TICK_MS, useAppUpdate } from '../../appUpdate/useAppUpdate';
import { refocus } from './focus';

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.1' } } }));

const GITHUB_BUILD = { os: 'android', release: '1', store: '' };
const T0 = 1_790_000_000_000;

let tag = 'v1.0.1';
let down = false;
const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
  if (down) throw new Error('fetch failed: no answer from api.github.com in 15 s');
  return { ok: true, status: 200, headers: new Headers(), json: async () => ({ tag_name: tag }) } as Response;
});
function store(start?: unknown): KeyValue & { getItemAsync: ReturnType<typeof vi.fn> } {
  const saved = new Map<string, string>();
  if (start !== undefined) saved.set(SAVED_KEY, JSON.stringify(start));
  return { getItemAsync: vi.fn(async (k: string) => saved.get(k) ?? null), setItemAsync: async (k, v) => void saved.set(k, v) };
}
let now = T0;
/** Lets the store read, the fetch and the redraws that follow run. */
const settle = () => act(async () => {});
/** Home's banner, as far as these tests need it: the version useAppUpdate names. */
function Home() {
  return <Text>{`banner: ${useAppUpdate() ?? 'none'}`}</Text>;
}
const banner = () => screen.getByText(/^banner: /).textContent;

describe('the update line', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tag = 'v1.0.1';
    down = false;
    now = T0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(Linking, 'openURL').mockResolvedValue(true);
    setUpdateCheckerForTests(GITHUB_BUILD, store(), fetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it('asks GitHub on opening and says it is up to date', async () => {
    render(<UpdateLine app="Karto Wallet" />);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^Up to date · checked today at \d\d:\d\d$/)).toBeTruthy();
  });

  it('names a newer release as a link to the releases page', async () => {
    tag = 'v1.0.2';
    render(<UpdateLine app="Karto PoS" />);
    await settle();
    fireEvent.click(screen.getByRole('link', { name: 'Karto PoS 1.0.2 is out on GitHub' }));
    expect(Linking.openURL).toHaveBeenCalledWith(RELEASES_PAGE);
  });

  it('asks again on coming back into view after a minute, not before', async () => {
    render(<UpdateLine app="Karto Wallet" />);
    await settle();
    now = T0 + 30_000;
    await act(async () => refocus());
    expect(fetch).toHaveBeenCalledTimes(1);
    now = T0 + 61_000;
    await act(async () => refocus());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('asks again when the app comes back to the front with the page open', async () => {
    render(<UpdateLine app="Karto Wallet" />);
    await settle();
    now = T0 + 61_000;
    // react-native-web's AppState follows the page's visibility: hidden then visible again is the app coming back.
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // The person: "a fail should be silent".
  it('says nothing when GitHub has never answered, and keeps the last answer when it fails', async () => {
    down = true;
    const { container } = render(<UpdateLine app="Karto Wallet" />);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('');
    setUpdateCheckerForTests(GITHUB_BUILD, store({ checkedAt: T0 - 120_000, latest: '1.0.1' }), fetch);
    render(<UpdateLine app="Karto Wallet" />);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/^Up to date · checked today at /)).toBeTruthy();
  });

  it("what the page finds shows on Home's banner, from one fetch", async () => {
    setUpdateCheckerForTests(GITHUB_BUILD, store({ checkedAt: T0 - 120_000, latest: '1.0.1' }), fetch);
    tag = 'v1.0.2';
    render(<Home />);
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(banner()).toBe('banner: none');
    render(<UpdateLine app="Karto Wallet" />);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(banner()).toBe('banner: 1.0.2');
  });

  it('shows a stored newer release on Home at once after a restart, with no fetch', async () => {
    setUpdateCheckerForTests(GITHUB_BUILD, store({ checkedAt: T0 - 1000, latest: '1.0.2' }), fetch);
    render(<Home />);
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(banner()).toBe('banner: 1.0.2');
  });

  it('draws nothing and asks nothing in a build that does not ask GitHub', async () => {
    const kv = store();
    setUpdateCheckerForTests({ os: 'android', release: undefined, store: undefined }, kv, fetch);
    const { container } = render(
      <>
        <Home />
        <UpdateLine app="Karto Wallet" />
      </>,
    );
    await settle();
    expect(kv.getItemAsync).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(container.textContent).toBe('banner: none');
  });
});

describe("Home and the till left in front", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(T0);
    vi.clearAllMocks();
    tag = 'v1.0.1';
    down = false;
    setUpdateCheckerForTests(GITHUB_BUILD, store(), fetch);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  it('asks again once its answer is an hour old, never backgrounded', async () => {
    render(<Home />);
    await pass(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await pass(CHECK_EVERY_MS - TICK_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    tag = 'v1.0.2';
    await pass(TICK_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(banner()).toBe('banner: 1.0.2');
  });

  it('does not ask on the tick while the app is in the background', async () => {
    render(<Home />);
    await pass(0);
    vi.spyOn(AppState, 'currentState', 'get').mockReturnValue('background');
    await pass(2 * CHECK_EVERY_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
