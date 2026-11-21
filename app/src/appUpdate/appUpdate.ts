// A GitHub build's notice of a newer release: Karto Wallet and Karto PoS installed from the repository's APKs update
// only when the person installs the next APK, so each asks GitHub which release is the latest and says so when it is
// newer than itself: Home and the till at most once an hour, Settings and This PoS each time they open (at most once
// a minute), all sharing one answer. Only those builds ask: a Play build is updated by Play (and Play's rules
// allow no other way), an iPhone's by the App Store, a .dev build by its developer. The answer is read for its
// version alone; the notice opens the repository's own releases page, never an address from the answer.
// GitHub's API: https://docs.github.com/en/rest/releases/releases#get-the-latest-release (the latest full release:
// drafts and pre-releases are never it, and with none it answers 404).
import type { FetchFn } from '../lightning/lightning';
import { whenText } from '../money/words';

export const RELEASES_PAGE = 'https://github.com/boltcard/karto/releases/latest';
export const LATEST_RELEASE_API = 'https://api.github.com/repos/boltcard/karto/releases/latest';
/** How long an answer stands before Home or the till asks GitHub again. */
export const CHECK_EVERY_MS = 60 * 60 * 1000;
/** How long after a fetch that got no answer before Home or the till asks again; a refusal's own wait when it names none. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;

/** How old an answer may be before a caller asks again, and how long it waits after a fetch that got no answer. */
export type Rhythm = { everyMs: number; retryMs: number };
/** Home's and the till's. */
export const BACKGROUND: Rhythm = { everyMs: CHECK_EVERY_MS, retryMs: RETRY_AFTER_MS };
/**
 * Settings' and This PoS's: each time the page opens, no more than once a minute. GitHub answers /releases/latest
 * with `cache-control: public, max-age=60`, and React Native's OkHttp keeps a disk cache, so a publish can take about
 * a minute to show and an ask inside the minute could be answered from the phone anyway. (No ETag: GitHub spares a
 * 304 from the hour's allowance only for a request with an Authorization header, and these carry none.)
 */
export const ON_OPEN: Rhythm = { everyMs: 60_000, retryMs: 60_000 };
/** A refusal's wait, as its headers name it, kept within these. */
const REFUSED_MIN_MS = 60_000;
const REFUSED_MAX_MS = 60 * 60 * 1000;
/** expo-secure-store's key: letters, digits, '.', '-' and '_' only. */
export const SAVED_KEY = 'karto.appUpdate';

/** Where the app came from, as the bundle says: the platform, KARTO_RELEASE and KARTO_STORE. */
export type Build = { os: string; release: string | undefined; store: string | undefined };
/** A release APK from GitHub: Android, the store identifiers, and not built for Play. */
export const asksGithub = (b: Build): boolean => b.os === 'android' && b.release === '1' && b.store !== 'play';

/** X.Y.Z, or vX.Y.Z as a tag: each part a plain number below 1000 (app/variant.js's versionCode allows no more). */
export function parseVersion(s: unknown): [number, number, number] | null {
  if (typeof s !== 'string') return null;
  const m = /^v?(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether version a is later than b; false when either isn't X.Y.Z. */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let n = 0; n < 3; n++) if (x[n] !== y[n]) return x[n] > y[n];
  return false;
}

/**
 * GitHub refused (403, 429): the addresses behind one carrier's or shop's network have used up the hour's 60 asks.
 * Its docs say not to ask again before `retry-after` (seconds) or `x-ratelimit-reset` (epoch seconds, by GitHub's
 * clock: read against the answer's `date`, so a phone's clock that is out doesn't shorten or stretch it), and that
 * asking while refused may get the client banned. notBefore is that time on this phone's clock.
 */
export class Refused extends Error {
  constructor(
    readonly status: number,
    readonly notBefore: number,
  ) {
    super(`GitHub answered ${status}`);
    this.name = 'Refused';
  }
}

function refusedUntil(r: Response, nowMs: number): number {
  const header = (name: string) => {
    const v = r.headers?.get?.(name)?.trim();
    return v ? Number(v) : NaN;
  };
  const wait = (ms: number) => nowMs + Math.min(REFUSED_MAX_MS, Math.max(REFUSED_MIN_MS, ms));
  const after = header('retry-after');
  if (Number.isFinite(after)) return wait(after * 1000);
  const reset = header('x-ratelimit-reset');
  if (Number.isFinite(reset)) {
    const theirs = Date.parse(r.headers?.get?.('date') ?? '');
    return wait(reset * 1000 - (Number.isFinite(theirs) ? theirs : nowMs));
  }
  return nowMs + RETRY_AFTER_MS;
}

/**
 * The latest full release's version (X.Y.Z), or null when there is none (404) or the answer names none. Throws when
 * GitHub can't be reached, Refused when it refuses, so a refusal is never taken for "no newer release".
 */
export async function latestRelease(fetch: FetchFn, nowMs = Date.now()): Promise<string | null> {
  const r = await fetch(LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
  if (r.status === 404) return null;
  if (r.status === 403 || r.status === 429) throw new Refused(r.status, refusedUntil(r, nowMs));
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const body: unknown = await r.json();
  if (typeof body !== 'object' || body === null) return null;
  const { tag_name: tag, draft, prerelease } = body as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  const v = parseVersion(tag);
  return v && draft !== true && prerelease !== true ? v.join('.') : null;
}

/** expo-secure-store, as far as this uses it. */
export type KeyValue = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
};
export type Saved = { checkedAt: number; latest: string | null };

async function readSaved(kv: KeyValue): Promise<Saved | null> {
  try {
    const s = JSON.parse((await kv.getItemAsync(SAVED_KEY)) ?? 'null') as Partial<Saved> | null;
    if (!s || typeof s.checkedAt !== 'number') return null;
    if (s.latest === null) return { checkedAt: s.checkedAt, latest: null };
    return parseVersion(s.latest) ? { checkedAt: s.checkedAt, latest: s.latest as string } : null;
  } catch {
    return null;
  }
}

/**
 * What one app knows, shared by every caller. The secure store is read once, at the first check (`loading`); after
 * that this is the truth and the store is only written, so a stale stored answer never beats a fresh one.
 */
export type Memory = {
  saved: Saved | null;
  /** When the last fetch got no answer or a refusal; null once GitHub answers. */
  failedAt: number | null;
  /** A refusal's: no caller asks before it. */
  notBefore: number | null;
  loading: Promise<void> | null;
  fetching: Promise<void> | null;
  /** Told on every change. */
  onChange?: () => void;
};

const due = (at: number, every: number, nowMs: number) => nowMs - at >= every || nowMs < at;
/** A refusal's wait still running (not one left in the future by a clock gone back further than any wait). */
const held = (notBefore: number | null, nowMs: number) => notBefore !== null && nowMs < notBefore && notBefore - nowMs <= REFUSED_MAX_MS;

async function fetchLatest(kv: KeyValue, fetch: FetchFn, nowMs: number, memory: Memory): Promise<void> {
  try {
    const latest = await latestRelease(fetch, nowMs);
    memory.saved = { checkedAt: nowMs, latest };
    memory.failedAt = null;
    memory.notBefore = null;
    // A store that can't keep it is no failed ask: the answer stands in memory.
    await kv.setItemAsync(SAVED_KEY, JSON.stringify(memory.saved)).catch(() => {});
  } catch (e) {
    // No answer or a refusal: the last answer stands, and the caller's rhythm (or the refusal) says when to ask again.
    memory.failedAt = nowMs;
    if (e instanceof Refused) memory.notBefore = e.notBefore;
  } finally {
    memory.fetching = null;
    memory.onChange?.();
  }
}

/**
 * The newer version to tell the person about, or null. What is shared is the fetch, not the decision: a caller that
 * comes while one runs waits for it, then asks if its own rhythm still finds the answer old (Home's hour must not
 * stand for Settings' minute). GitHub is asked when the last answer is older than the rhythm's (or from a clock that
 * has since gone back), not within the rhythm's retry of a fetch that got no answer, and not before a refusal's time.
 */
export async function newerRelease(kv: KeyValue, fetch: FetchFn, current: string, nowMs: number, memory: Memory, rhythm: Rhythm = BACKGROUND): Promise<string | null> {
  memory.loading ??= readSaved(kv).then((kept) => {
    if (kept && !memory.saved) {
      memory.saved = kept;
      memory.onChange?.();
    }
  });
  await memory.loading;
  while (memory.fetching) await memory.fetching;
  const { saved, failedAt, notBefore } = memory;
  if ((!saved || due(saved.checkedAt, rhythm.everyMs, nowMs)) && (failedAt === null || due(failedAt, rhythm.retryMs, nowMs)) && !held(notBefore, nowMs)) {
    memory.fetching = fetchLatest(kv, fetch, nowMs, memory);
    memory.onChange?.();
    await memory.fetching;
  }
  return newerOf(memory, current);
}

/** The newer version an answer names, or null. */
export const newerOf = (s: { saved: Saved | null }, current: string): string | null =>
  s.saved?.latest && isNewer(s.saved.latest, current) ? s.saved.latest : null;

/** What a page draws from: a new object on every change, the same one between (useSyncExternalStore). */
export type UpdateStatus = { saved: Saved | null; asking: boolean; failedAt: number | null; notBefore: number | null };

export type UpdateChecker = {
  check(current: string, nowMs: number, rhythm?: Rhythm): Promise<string | null>;
  status(): UpdateStatus;
  subscribe(listener: () => void): () => void;
};

/** One app's checker: every caller's answer, fetch and failure are shared, and each change is told to its listeners. */
export function updateChecker(kv: KeyValue, fetch: FetchFn): UpdateChecker {
  const memory: Memory = { saved: null, failedAt: null, notBefore: null, loading: null, fetching: null };
  let status: UpdateStatus = { saved: null, asking: false, failedAt: null, notBefore: null };
  const listeners = new Set<() => void>();
  memory.onChange = () => {
    status = { saved: memory.saved, asking: memory.fetching !== null, failedAt: memory.failedAt, notBefore: memory.notBefore };
    for (const l of [...listeners]) l();
  };
  return {
    check: (current, nowMs, rhythm = BACKGROUND) => newerRelease(kv, fetch, current, nowMs, memory, rhythm),
    status: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * Settings' and This PoS's line, or null for none. A failure is silent (the person's call): the last answer stands,
 * with its own time, and with none there is no line. A newer release is a link to the releases page.
 */
export function updateLine(
  s: UpdateStatus,
  current: string,
  app: 'Karto Wallet' | 'Karto PoS',
  nowMs: number,
  offsetMin = -new Date(nowMs).getTimezoneOffset(),
): { text: string; link: boolean } | null {
  const newer = newerOf(s, current);
  if (newer) return { text: `${app} ${newer} is out on GitHub ›`, link: true };
  const { saved } = s;
  // An answer from a clock since gone back has no time to give; after a failure it can't say "up to date" bare.
  if (saved && saved.checkedAt <= nowMs) return { text: `Up to date · checked ${whenText(saved.checkedAt / 1000, nowMs / 1000, offsetMin)}`, link: false };
  if (saved && s.failedAt === null) return { text: 'Up to date', link: false };
  return s.asking ? { text: 'Asking GitHub for a newer version…', link: false } : null;
}
