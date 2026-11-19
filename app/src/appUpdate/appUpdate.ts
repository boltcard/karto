// A GitHub build's notice of a newer release: Karto Wallet and Karto PoS installed from the repository's APKs update
// only when the person installs the next APK, so each asks GitHub, at most once a day, which release is the latest
// and says so when it is newer than itself. Only those builds ask: a Play build is updated by Play (and Play's rules
// allow no other way), an iPhone's by the App Store, a .dev build by its developer. The answer is read for its
// version alone; the notice opens the repository's own releases page, never an address from the answer.
// GitHub's API: https://docs.github.com/en/rest/releases/releases#get-the-latest-release (the latest full release:
// drafts and pre-releases are never it, and with none it answers 404).
import type { FetchFn } from '../lightning/lightning';

export const RELEASES_PAGE = 'https://github.com/boltcard/karto/releases/latest';
export const LATEST_RELEASE_API = 'https://api.github.com/repos/boltcard/karto/releases/latest';
/** How long an answer stands before GitHub is asked again. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** How long after an ask that failed (no answer, a refusal, an answer that couldn't be kept) before the next. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;
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
 * The latest full release's version (X.Y.Z), or null when there is none (404) or the answer names none. Throws when
 * GitHub can't be reached or refuses (a 403 or 429 when the addresses behind one carrier's or shop's network have
 * used up the hour's 60 asks), so a refusal is never taken for "no newer release".
 */
export async function latestRelease(fetch: FetchFn): Promise<string | null> {
  const r = await fetch(LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
  if (r.status === 404) return null;
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
type Saved = { checkedAt: number; latest: string | null };

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

/** What one app remembers between checks while it runs: the last answer had, and when an ask last failed. */
export type Memory = { saved: Saved | null; failedAt: number | null };

const due = (at: number, every: number, nowMs: number) => nowMs - at >= every || nowMs < at;

/**
 * The newer version to tell the person about, or null. GitHub is asked when the last answer is a day old (or from a
 * clock that has since gone back), and not within an hour of an ask that failed; a failed ask leaves the last answer
 * standing. The answer is kept in the secure store, and in memory too, in case the store can't keep it.
 */
export async function newerRelease(kv: KeyValue, fetch: FetchFn, current: string, nowMs: number, memory: Memory): Promise<string | null> {
  const kept = await readSaved(kv);
  let saved = kept && (!memory.saved || kept.checkedAt >= memory.saved.checkedAt) ? kept : memory.saved;
  if ((!saved || due(saved.checkedAt, CHECK_EVERY_MS, nowMs)) && (memory.failedAt === null || due(memory.failedAt, RETRY_AFTER_MS, nowMs))) {
    try {
      saved = { checkedAt: nowMs, latest: await latestRelease(fetch) };
      memory.saved = saved;
      memory.failedAt = null;
      await kv.setItemAsync(SAVED_KEY, JSON.stringify(saved));
    } catch {
      // No answer, a refusal, or one the store couldn't keep: the last answer stands, and GitHub waits an hour.
      memory.failedAt = nowMs;
    }
  }
  return saved?.latest && isNewer(saved.latest, current) ? saved.latest : null;
}

/** One app's checks: two that overlap (the screen opening as the app comes to the front) share one ask. */
export function updateChecker(kv: KeyValue, fetch: FetchFn): (current: string, nowMs: number) => Promise<string | null> {
  const memory: Memory = { saved: null, failedAt: null };
  let running: Promise<string | null> | null = null;
  return (current, nowMs) => {
    running ??= newerRelease(kv, fetch, current, nowMs, memory).finally(() => {
      running = null;
    });
    return running;
  };
}
