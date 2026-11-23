import { describe, expect, it, vi } from 'vitest';
import { asksGithub, BACKGROUND, showsLatest, CHECK_EVERY_MS, isNewer, LATEST_RELEASE_API, latestRelease, newerRelease, ON_OPEN, parseVersion, Refused, RETRY_AFTER_MS, SAVED_KEY, updateChecker, updateLine, type KeyValue, type Memory, type UpdateStatus } from './appUpdate';
import { whenText } from '../money/words';

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body }) as Response;
const github = (body: unknown, status = 200, headers?: Record<string, string>) => vi.fn(async (_url: string, _init?: RequestInit) => answer(status, body, headers));
const unreachable = () =>
  vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
    throw new Error('fetch failed: no answer from api.github.com in 15 s');
  });
function memory(start?: unknown): KeyValue & { saved: Map<string, string> } {
  const saved = new Map<string, string>();
  if (start !== undefined) saved.set(SAVED_KEY, JSON.stringify(start));
  return { saved, getItemAsync: async (k) => saved.get(k) ?? null, setItemAsync: async (k, v) => void saved.set(k, v) };
}
const NOW = 1_790_000_000_000;

describe('asksGithub', () => {
  it('asks only for a release APK built for GitHub, not Play', () => {
    expect(asksGithub({ os: 'android', release: '1', store: '' })).toBe(true);
    expect(asksGithub({ os: 'android', release: '1', store: undefined })).toBe(true);
    expect(asksGithub({ os: 'android', release: '1', store: 'play' })).toBe(false);
    expect(asksGithub({ os: 'android', release: '', store: '' })).toBe(false);
    expect(asksGithub({ os: 'android', release: undefined, store: undefined })).toBe(false);
    expect(asksGithub({ os: 'ios', release: '1', store: '' })).toBe(false);
  });
});

// Settings' and This PoS's line: GitHub APKs and .dev builds (the person, 2026-11-23); Play and the App Store update
// their own builds, and a Play build must never point at GitHub.
describe('showsLatest', () => {
  it('shows the latest release in a GitHub APK and a .dev build, never in a Play or App Store build', () => {
    expect(showsLatest({ os: 'android', release: '1', store: '' })).toBe(true);
    expect(showsLatest({ os: 'android', release: undefined, store: undefined })).toBe(true);
    expect(showsLatest({ os: 'android', release: '', store: '' })).toBe(true);
    expect(showsLatest({ os: 'ios', release: undefined, store: undefined })).toBe(true);
    expect(showsLatest({ os: 'android', release: undefined, store: 'play' })).toBe(false);
    expect(showsLatest({ os: 'android', release: '1', store: 'play' })).toBe(false);
    expect(showsLatest({ os: 'ios', release: '1', store: '' })).toBe(false);
    // A screen test's page is no phone: it never asks unless the test sets a phone's build.
    expect(showsLatest({ os: 'web', release: undefined, store: undefined })).toBe(false);
  });
});

describe('versions', () => {
  it('reads X.Y.Z and vX.Y.Z, nothing else', () => {
    expect(parseVersion('1.0.0')).toEqual([1, 0, 0]);
    expect(parseVersion('v1.2.30')).toEqual([1, 2, 30]);
    for (const bad of ['1.0', '1.0.0-rc.1', 'V1.0.0', '01.0.0', '1.1000.0', '', ' 1.0.0', null, 1]) expect(parseVersion(bad)).toBeNull();
  });
  it('compares part by part, as numbers', () => {
    expect(isNewer('1.0.1', '1.0.0')).toBe(true);
    expect(isNewer('1.10.0', '1.9.9')).toBe(true);
    expect(isNewer('2.0.0', '1.99.99')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.9.0', '1.0.0')).toBe(false);
    expect(isNewer('nonsense', '1.0.0')).toBe(false);
  });
});

describe('latestRelease', () => {
  it("asks GitHub's API for the latest release and takes its tag's version", async () => {
    const fetch = github({ tag_name: 'v1.0.1', draft: false, prerelease: false, html_url: 'https://evil.example/' });
    expect(await latestRelease(fetch)).toBe('1.0.1');
    expect(fetch).toHaveBeenCalledWith(LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
  });
  it('reads no version from no release (404), a draft, a pre-release, an odd tag or an odd answer', async () => {
    expect(await latestRelease(github({ message: 'Not Found' }, 404))).toBeNull();
    expect(await latestRelease(github({ tag_name: 'v1.0.1', draft: true }))).toBeNull();
    expect(await latestRelease(github({ tag_name: 'v1.0.1', prerelease: true }))).toBeNull();
    expect(await latestRelease(github({ tag_name: 'v1.0.1-rc.1' }))).toBeNull();
    expect(await latestRelease(github(['v1.0.1']))).toBeNull();
    expect(await latestRelease(github(null))).toBeNull();
  });
  it('throws on a refusal, so it is never taken for "no newer release"', async () => {
    await expect(latestRelease(github({ message: 'API rate limit exceeded' }, 403))).rejects.toThrow('GitHub answered 403');
    await expect(latestRelease(github({}, 429))).rejects.toThrow('GitHub answered 429');
    await expect(latestRelease(github({}, 500))).rejects.toThrow('GitHub answered 500');
  });
});

const fresh = (): Memory => ({ saved: null, failedAt: null, notBefore: null, loading: null, fetching: null });

describe('newerRelease', () => {
  it('names a newer release, and saves the answer', async () => {
    const kv = memory();
    expect(await newerRelease(kv, github({ tag_name: 'v1.0.1' }), '1.0.0', NOW, fresh())).toBe('1.0.1');
    expect(JSON.parse(kv.saved.get(SAVED_KEY)!)).toEqual({ checkedAt: NOW, latest: '1.0.1' });
  });
  it('names nothing when this app is as new or newer, or there is no release', async () => {
    expect(await newerRelease(memory(), github({ tag_name: 'v1.0.0' }), '1.0.0', NOW, fresh())).toBeNull();
    expect(await newerRelease(memory(), github({ tag_name: 'v0.9.0' }), '1.0.0', NOW, fresh())).toBeNull();
    expect(await newerRelease(memory(), github({ message: 'Not Found' }, 404), '1.0.0', NOW, fresh())).toBeNull();
  });
  it('asks at most once an hour', async () => {
    const kv = memory({ checkedAt: NOW - CHECK_EVERY_MS + 1, latest: '1.0.1' });
    const fetch = github({ tag_name: 'v1.0.2' });
    const m = fresh();
    expect(await newerRelease(kv, fetch, '1.0.0', NOW, m)).toBe('1.0.1');
    expect(fetch).not.toHaveBeenCalled();
    expect(await newerRelease(kv, fetch, '1.0.0', NOW + 1, m)).toBe('1.0.2');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('asks again when the clock has gone back past the last answer', async () => {
    const fetch = github({ tag_name: 'v1.0.2' });
    expect(await newerRelease(memory({ checkedAt: NOW + 1000, latest: '1.0.1' }), fetch, '1.0.0', NOW, fresh())).toBe('1.0.2');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps the last answer when GitHub refuses or cannot be reached, and waits an hour before asking again', async () => {
    const kv = memory({ checkedAt: NOW - CHECK_EVERY_MS, latest: '1.0.1' });
    const m = fresh();
    const refused = github({ message: 'API rate limit exceeded' }, 403);
    expect(await newerRelease(kv, refused, '1.0.0', NOW, m)).toBe('1.0.1');
    expect(JSON.parse(kv.saved.get(SAVED_KEY)!)).toEqual({ checkedAt: NOW - CHECK_EVERY_MS, latest: '1.0.1' });
    expect(m.failedAt).toBe(NOW);
    const down = unreachable();
    expect(await newerRelease(kv, down, '1.0.0', NOW + RETRY_AFTER_MS - 1, m)).toBe('1.0.1');
    expect(down).not.toHaveBeenCalled();
    const back = github({ tag_name: 'v1.0.2' });
    expect(await newerRelease(kv, back, '1.0.0', NOW + RETRY_AFTER_MS, m)).toBe('1.0.2');
    expect(m.failedAt).toBeNull();
    expect(await newerRelease(memory(), unreachable(), '1.0.0', NOW, fresh())).toBeNull();
  });
  it('drops a saved answer it cannot read, and asks', async () => {
    const kv = memory();
    kv.saved.set(SAVED_KEY, '{"checkedAt":"soon","latest":"1.0.1"}');
    const fetch = github({ tag_name: 'v1.0.3' });
    expect(await newerRelease(kv, fetch, '1.0.0', NOW, fresh())).toBe('1.0.3');
    kv.saved.set(SAVED_KEY, 'not json');
    expect(await newerRelease(kv, fetch, '1.0.0', NOW, fresh())).toBe('1.0.3');
  });
  it("answers from memory when the store can't keep the answer, and doesn't ask again within the hour", async () => {
    const kv: KeyValue = { getItemAsync: async () => null, setItemAsync: async () => Promise.reject(new Error('keystore busy')) };
    const m = fresh();
    const fetch = github({ tag_name: 'v1.0.1' });
    expect(await newerRelease(kv, fetch, '1.0.0', NOW, m)).toBe('1.0.1');
    expect(await newerRelease(kv, fetch, '1.0.0', NOW + 60_000, m)).toBe('1.0.1');
    expect(fetch).toHaveBeenCalledTimes(1);
    // GitHub answered: a store that couldn't keep it is no failed ask.
    expect(m.failedAt).toBeNull();
  });
});

describe('updateChecker', () => {
  const v = (tag: string) => answer(200, { tag_name: tag });
  function held() {
    const answers: ((r: Response) => void)[] = [];
    const fetch = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((r) => answers.push(r)));
    return { fetch, answer: (r: Response) => answers.shift()!(r) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('shares one fetch between checks that overlap', async () => {
    const g = held();
    const c = updateChecker(memory(), g.fetch);
    const a = c.check('1.0.0', NOW, ON_OPEN);
    const b = c.check('1.0.0', NOW, ON_OPEN);
    await vi.waitFor(() => expect(g.fetch).toHaveBeenCalledTimes(1));
    g.answer(v('v1.0.1'));
    expect(await a).toBe('1.0.1');
    expect(await b).toBe('1.0.1');
    expect(g.fetch).toHaveBeenCalledTimes(1);
  });

  // The app comes to the front with Settings open: Home's listener (the hour's rhythm) runs first. Its "not due" must
  // not stand for Settings, whose minute has passed.
  it("an hourly caller doesn't shut out a minute caller", async () => {
    const fetch = github({ tag_name: 'v1.0.1' });
    const c = updateChecker(memory({ checkedAt: NOW - 120_000, latest: '1.0.0' }), fetch);
    const [home, settings] = await Promise.all([c.check('1.0.0', NOW), c.check('1.0.0', NOW, ON_OPEN)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(settings).toBe('1.0.1');
    expect(home).toBeNull();
    expect(newerOfStatus(c)).toBe('1.0.1');
  });

  it('a caller that comes while a fetch runs judges by its own rhythm after it', async () => {
    const g = held();
    const c = updateChecker(memory(), g.fetch);
    const first = c.check('1.0.0', NOW);
    await vi.waitFor(() => expect(g.fetch).toHaveBeenCalledTimes(1));
    const second = c.check('1.0.0', NOW, ON_OPEN);
    g.answer(v('v1.0.1'));
    expect(await first).toBe('1.0.1');
    expect(await second).toBe('1.0.1');
    expect(g.fetch).toHaveBeenCalledTimes(1);
  });

  it('the minute rhythm asks at most once a minute', async () => {
    const fetch = github({ tag_name: 'v1.0.1' });
    const c = updateChecker(memory(), fetch);
    await c.check('1.0.0', NOW, ON_OPEN);
    await c.check('1.0.0', NOW + 59_999, ON_OPEN);
    expect(fetch).toHaveBeenCalledTimes(1);
    await c.check('1.0.0', NOW + 60_000, ON_OPEN);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a refusal holds every rhythm until GitHub's retry-after", async () => {
    const refused = github({ message: 'API rate limit exceeded' }, 429, { 'retry-after': '120' });
    const c = updateChecker(memory({ checkedAt: NOW - 2 * CHECK_EVERY_MS, latest: '1.0.0' }), refused);
    await c.check('1.0.0', NOW, ON_OPEN);
    expect(c.status().notBefore).toBe(NOW + 120_000);
    expect(c.status().failedAt).toBe(NOW);
    await c.check('1.0.0', NOW + 119_999, ON_OPEN);
    await c.check('1.0.0', NOW + 119_999, BACKGROUND);
    expect(refused).toHaveBeenCalledTimes(1);
    await c.check('1.0.0', NOW + 120_000, ON_OPEN);
    expect(refused).toHaveBeenCalledTimes(2);
  });

  it('a refusal without retry-after waits for x-ratelimit-reset by GitHub\'s clock, else an hour', async () => {
    const githubNow = NOW + 10 * 60_000; // this phone is 10 minutes slow
    const reset = github({}, 403, { 'x-ratelimit-reset': String((githubNow + 300_000) / 1000), date: new Date(githubNow).toUTCString() });
    const a = updateChecker(memory(), reset);
    await a.check('1.0.0', NOW, ON_OPEN);
    expect(a.status().notBefore).toBe(NOW + 300_000);
    const noDate = updateChecker(memory(), github({}, 403, { 'x-ratelimit-reset': String((NOW + 300_000) / 1000) }));
    await noDate.check('1.0.0', NOW, ON_OPEN);
    expect(noDate.status().notBefore).toBe(NOW + 300_000);
    const bare = updateChecker(memory(), github({}, 403));
    await bare.check('1.0.0', NOW, ON_OPEN);
    expect(bare.status().notBefore).toBe(NOW + RETRY_AFTER_MS);
    const odd = updateChecker(memory(), github({}, 429, { 'retry-after': 'soon', 'x-ratelimit-reset': '' }));
    await odd.check('1.0.0', NOW, ON_OPEN);
    expect(odd.status().notBefore).toBe(NOW + RETRY_AFTER_MS);
  });

  it('keeps a refusal\'s wait between a minute and an hour', async () => {
    const short = updateChecker(memory(), github({}, 429, { 'retry-after': '1' }));
    await short.check('1.0.0', NOW, ON_OPEN);
    expect(short.status().notBefore).toBe(NOW + 60_000);
    const long = updateChecker(memory(), github({}, 429, { 'retry-after': '86400' }));
    await long.check('1.0.0', NOW, ON_OPEN);
    expect(long.status().notBefore).toBe(NOW + 60 * 60_000);
  });

  it('a fetch with no answer is asked again after a minute on the minute rhythm, an hour on the hour\'s', async () => {
    const down = unreachable();
    const c = updateChecker(memory(), down);
    await c.check('1.0.0', NOW, ON_OPEN);
    expect(c.status().notBefore).toBeNull();
    await c.check('1.0.0', NOW + 60_000, BACKGROUND);
    expect(down).toHaveBeenCalledTimes(1);
    await c.check('1.0.0', NOW + 60_000, ON_OPEN);
    expect(down).toHaveBeenCalledTimes(2);
  });

  it('reads the store once, even for two first checks at the same time', async () => {
    const kv = memory({ checkedAt: NOW - 1000, latest: '1.0.1' });
    const read = vi.spyOn(kv, 'getItemAsync');
    const c = updateChecker(kv, github({ tag_name: 'v1.0.2' }));
    await Promise.all([c.check('1.0.0', NOW), c.check('1.0.0', NOW)]);
    kv.saved.set(SAVED_KEY, JSON.stringify({ checkedAt: NOW, latest: '9.0.0' }));
    expect(await c.check('1.0.0', NOW + 1000)).toBe('1.0.1');
    expect(read).toHaveBeenCalledTimes(1);
  });

  // After a restart: the banner shows the stored answer at once, without waiting for the next fetch.
  it('tells its listeners what the store held, with no fetch', async () => {
    const fetch = github({ tag_name: 'v1.0.3' });
    const c = updateChecker(memory({ checkedAt: NOW - 1000, latest: '1.0.2' }), fetch);
    const heard = vi.fn();
    c.subscribe(heard);
    await c.check('1.0.0', NOW);
    expect(fetch).not.toHaveBeenCalled();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(c.status().saved).toEqual({ checkedAt: NOW - 1000, latest: '1.0.2' });
  });

  it('tells its listeners when a fetch starts and ends, and keeps one status between changes', async () => {
    const g = held();
    const c = updateChecker(memory(), g.fetch);
    expect(c.status()).toBe(c.status());
    const heard = vi.fn();
    const stop = c.subscribe(heard);
    const run = c.check('1.0.0', NOW, ON_OPEN);
    await vi.waitFor(() => expect(c.status().asking).toBe(true));
    expect(c.status()).toBe(c.status());
    g.answer(v('v1.0.1'));
    await run;
    expect(c.status()).toMatchObject({ asking: false, saved: { checkedAt: NOW, latest: '1.0.1' }, failedAt: null });
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    const again = c.check('1.0.0', NOW + 60_000, ON_OPEN);
    await vi.waitFor(() => expect(g.fetch).toHaveBeenCalledTimes(2));
    g.answer(v('v1.0.2'));
    await again;
    await settle();
    expect(heard).toHaveBeenCalledTimes(2);
  });

  // A Keystore write that never returns must not hold the line, the banner, or any later check.
  it("tells its listeners GitHub's answer without waiting for the store to keep it", async () => {
    const kv: KeyValue = { getItemAsync: async () => null, setItemAsync: () => new Promise<void>(() => {}) };
    const fetch = github({ tag_name: 'v1.0.1' });
    const c = updateChecker(kv, fetch);
    expect(await c.check('1.0.0', NOW, ON_OPEN)).toBe('1.0.1');
    expect(c.status()).toMatchObject({ asking: false, saved: { checkedAt: NOW, latest: '1.0.1' } });
    expect(await c.check('1.0.0', NOW + 60_000, ON_OPEN)).toBe('1.0.1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('remembers a failure between checks', async () => {
    const fetch = unreachable();
    const c = updateChecker(memory(), fetch);
    expect(await c.check('1.0.0', NOW)).toBeNull();
    expect(await c.check('1.0.0', NOW + 1000)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws a Refused carrying its status on 403 and 429', async () => {
    const e = await latestRelease(github({}, 429, { 'retry-after': '120' }), NOW).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Refused);
    expect((e as Refused).notBefore).toBe(NOW + 120_000);
  });
});

const newerOfStatus = (c: ReturnType<typeof updateChecker>) => c.status().saved?.latest ?? null;

describe('updateLine', () => {
  const st = (o: Partial<UpdateStatus>): UpdateStatus => ({ saved: null, asking: false, failedAt: null, notBefore: null, ...o });
  const line = (o: Partial<UpdateStatus>, current = '1.0.1', app: 'Karto Wallet' | 'Karto PoS' = 'Karto Wallet') => updateLine(st(o), current, app, NOW, 0);
  const at = NOW - 60_000;
  const when = whenText(at / 1000, NOW / 1000, 0);

  it('draws nothing before anything is known, and says it is asking while the first fetch runs', () => {
    expect(line({})).toBeNull();
    expect(line({ asking: true })).toEqual({ text: 'Asking GitHub for a newer version…', link: false });
  });
  it('names a newer release as a link, after a failure too, in the app\'s own name', () => {
    const newer = { saved: { checkedAt: at, latest: '1.0.2' } };
    expect(line(newer)).toEqual({ text: 'Karto Wallet 1.0.2 is out on GitHub ›', link: true });
    expect(line({ ...newer, failedAt: NOW })).toEqual({ text: 'Karto Wallet 1.0.2 is out on GitHub ›', link: true });
    expect(line(newer, '1.0.1', 'Karto PoS')).toEqual({ text: 'Karto PoS 1.0.2 is out on GitHub ›', link: true });
  });
  it('names the latest release with the time of the answer, while a new fetch runs too', () => {
    expect(when).toMatch(/^today at /);
    expect(line({ saved: { checkedAt: at, latest: '1.0.1' } })).toEqual({ text: `Up to date with release 1.0.1 · checked ${when}`, link: false });
    expect(line({ saved: { checkedAt: at, latest: '1.0.1' }, asking: true })).toEqual({ text: `Up to date with release 1.0.1 · checked ${when}`, link: false });
    // A .dev build of main made after the release carries a later number, or the same one.
    expect(line({ saved: { checkedAt: at, latest: '1.0.0' } })).toEqual({ text: `Latest release 1.0.0 · checked ${when}`, link: false });
    expect(line({ saved: { checkedAt: at, latest: null } })).toEqual({ text: `No release on GitHub yet · checked ${when}`, link: false });
  });
  // The person: "a fail should be silent". The last answer stands, with its own time.
  it('keeps the last answer\'s line after a failure, and draws nothing after one with no answer', () => {
    expect(line({ saved: { checkedAt: at, latest: '1.0.1' }, failedAt: NOW })).toEqual({ text: `Up to date with release 1.0.1 · checked ${when}`, link: false });
    expect(line({ failedAt: NOW })).toBeNull();
    expect(line({ failedAt: NOW, notBefore: NOW + 60_000 })).toBeNull();
  });
  it('leaves the time off an answer from a clock since gone back, and draws nothing for one after a failure', () => {
    const future = { saved: { checkedAt: NOW + 3_600_000, latest: '1.0.1' } };
    expect(line(future)).toEqual({ text: 'Up to date with release 1.0.1', link: false });
    expect(line({ saved: { checkedAt: NOW + 3_600_000, latest: '1.0.0' } })).toEqual({ text: 'Latest release 1.0.0', link: false });
    expect(line({ saved: { checkedAt: NOW + 3_600_000, latest: null } })).toEqual({ text: 'No release on GitHub yet', link: false });
    expect(line({ ...future, failedAt: NOW })).toBeNull();
  });
});
