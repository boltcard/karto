import { describe, expect, it, vi } from 'vitest';
import { asksGithub, CHECK_EVERY_MS, isNewer, LATEST_RELEASE_API, latestRelease, newerRelease, parseVersion, RETRY_AFTER_MS, SAVED_KEY, updateChecker, type KeyValue, type Memory } from './appUpdate';

const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const github = (body: unknown, status = 200) => vi.fn(async (_url: string, _init?: RequestInit) => answer(status, body));
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

const fresh = (): Memory => ({ saved: null, failedAt: null });

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
  it('asks at most once a day', async () => {
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
  });
});

describe('updateChecker', () => {
  it('shares one ask between checks that overlap', async () => {
    let answer!: (r: Response) => void;
    const fetch = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((r) => (answer = r)));
    const check = updateChecker(memory(), fetch);
    const a = check('1.0.0', NOW);
    const b = check('1.0.0', NOW);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    answer({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.0.1' }) } as Response);
    expect(await a).toBe('1.0.1');
    expect(await b).toBe('1.0.1');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('remembers a failure between checks', async () => {
    const fetch = unreachable();
    const check = updateChecker(memory(), fetch);
    expect(await check('1.0.0', NOW)).toBeNull();
    expect(await check('1.0.0', NOW + 1000)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
