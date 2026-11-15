// The little Lightning the app needs itself: reading an invoice's amount and
// fetching an invoice from an LNURL-pay endpoint (LUD-06). Paying is always
// done by the user's own wallet.

import { bech32 } from '@scure/base';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The request never got an answer (DNS, connection, TLS). WHATWG fetch rejects
 * with a TypeError; expo/fetch on the phone with a FetchError ("fetch failed: …").
 */
export function isNetworkFailure(e: unknown): boolean {
  return e instanceof Error && /^fetch failed\b|^network request failed\b/i.test(e.message);
}

/** A network failure that is a call given up for want of an answer (withTimeout's own error), not a server out of reach. */
export function isTimeout(e: unknown): boolean {
  return e instanceof Error && /^fetch failed: no answer from \S+ in [\d.]+ s$/.test(e.message);
}

const MULTIPLIER_MSAT: Record<string, bigint> = { m: 100_000_000n, u: 100_000n, n: 100n };

/**
 * Amount of a BOLT11 invoice in millisats, from its human-readable part,
 * or null for an "any amount" invoice. Throws if it is not a mainnet invoice.
 * Does not check the signature or checksum: the paying wallet does that.
 */
export function bolt11AmountMsat(invoice: string): bigint | null {
  const s = invoice.trim().toLowerCase().replace(/^lightning:/, '');
  const hrp = s.slice(0, s.lastIndexOf('1'));
  const m = /^lnbc(\d+)?([munp])?$/.exec(hrp);
  if (!m) throw new Error('not a mainnet Lightning invoice');
  if (m[1] === undefined) {
    if (m[2] !== undefined) throw new Error('invoice multiplier without an amount');
    return null;
  }
  const n = BigInt(m[1]);
  if (m[2] === undefined) return n * 100_000_000_000n; // whole bitcoin
  if (m[2] === 'p') {
    if (n % 10n !== 0n) throw new Error('invoice amount is a fraction of a millisat');
    return n / 10n;
  }
  return n * MULTIPLIER_MSAT[m[2]];
}

const SIGNATURE_WORDS = 104; // 65 bytes of signature + recovery id, in 5-bit words
const TAG_EXPIRY = 6; // 'x'
const DEFAULT_EXPIRY_S = 3600;

/** A big-endian number from 5-bit words. */
const wordsToInt = (words: number[]) => words.reduce((n, w) => n * 32 + w, 0);

/**
 * When a BOLT11 invoice expires, in ms since the epoch: its timestamp plus its
 * expiry (an hour if it sets none). Null if it does not decode. Like
 * bolt11AmountMsat, it does not check the signature.
 */
export function bolt11ExpiresAtMs(invoice: string): number | null {
  let words: number[];
  try {
    words = bech32.decode(invoice.trim().toLowerCase().replace(/^lightning:/, '') as `${string}1${string}`, false).words;
  } catch {
    return null;
  }
  if (words.length < 7 + SIGNATURE_WORDS) return null;
  const timestamp = wordsToInt(words.slice(0, 7));
  let expiry = DEFAULT_EXPIRY_S;
  for (let i = 7; i + 3 <= words.length - SIGNATURE_WORDS; ) {
    const tag = words[i];
    const len = words[i + 1] * 32 + words[i + 2];
    if (tag === TAG_EXPIRY) expiry = wordsToInt(words.slice(i + 3, i + 3 + len));
    i += 3 + len;
  }
  return (timestamp + expiry) * 1000;
}

const TAG_PAYMENT_HASH = 1; // 'p'

/** A BOLT11 invoice's payment hash, as hex; null if it does not decode. No signature check. */
export function bolt11PaymentHash(invoice: string): string | null {
  let words: number[];
  try {
    words = bech32.decode(invoice.trim().toLowerCase().replace(/^lightning:/, '') as `${string}1${string}`, false).words;
  } catch {
    return null;
  }
  for (let i = 7; i + 3 <= words.length - SIGNATURE_WORDS; ) {
    const len = words[i + 1] * 32 + words[i + 2];
    if (words[i] === TAG_PAYMENT_HASH && len === 52) {
      const bytes = bech32.fromWordsUnsafe(words.slice(i + 3, i + 3 + len));
      return bytes ? Array.from(bytes.subarray(0, 32), (b) => b.toString(16).padStart(2, '0')).join('') : null;
    }
    i += 3 + len;
  }
  return null;
}

const TAG_DESCRIPTION = 13; // 'd'

/** UTF-8 bytes as text, without TextDecoder (Hermes may not have it). */
const utf8 = (bytes: Uint8Array) => {
  try {
    return decodeURIComponent(Array.from(bytes, (b) => `%${b.toString(16).padStart(2, '0')}`).join(''));
  } catch {
    return String.fromCharCode(...bytes);
  }
};

/** A BOLT11 invoice's description (empty when it has none, or only a hash of one). No signature check. */
export function bolt11Description(invoice: string): string {
  let words: number[];
  try {
    words = bech32.decode(invoice.trim().toLowerCase().replace(/^lightning:/, '') as `${string}1${string}`, false).words;
  } catch {
    return '';
  }
  for (let i = 7; i + 3 <= words.length - SIGNATURE_WORDS; ) {
    const len = words[i + 1] * 32 + words[i + 2];
    if (words[i] === TAG_DESCRIPTION) return utf8(bech32.fromWordsUnsafe(words.slice(i + 3, i + 3 + len)) ?? new Uint8Array());
    i += 3 + len;
  }
  return '';
}

/** The URL inside a LUD-01 LNURL ("LNURL1…"), or null. */
export function lnurlDecode(lnurl: string): string | null {
  try {
    const { prefix, words } = bech32.decode(lnurl.trim().toLowerCase() as `${string}1${string}`, false);
    return prefix === 'lnurl' ? utf8(bech32.fromWords(words)) : null;
  } catch {
    return null;
  }
}

/**
 * A fetch that gives up after `ms`: the request is aborted and the promise
 * rejects with "fetch failed: …", which onboarding treats as a network failure
 * (wait and ask again) rather than hanging on a request that never answers.
 * The time covers the body too: it is read here (every answer the app gets is
 * small) and handed back in a new Response, so its text() can't stall.
 */
export function withTimeout(fetch: FetchFn, ms: number): FetchFn {
  return (url, init) => {
    const abort = new AbortController();
    init?.signal?.addEventListener('abort', () => abort.abort());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Settle with our reason first: aborting makes the request reject too.
        reject(new Error(`fetch failed: no answer from ${new URL(url).host} in ${ms / 1000} s`));
        abort.abort();
      }, ms);
    });
    const answer = fetch(url, { ...init, signal: abort.signal }).then(async (res) => {
      const body = await res.text();
      // A 204, 205 or 304 may not carry a body, not even an empty one.
      return new Response([204, 205, 304].includes(res.status) ? null : body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    });
    return Promise.race([answer, timeout]).finally(() => clearTimeout(timer));
  };
}

/**
 * A fetch for big, binary answers (snapshot downloads): like withTimeout it
 * aborts the request and rejects with "fetch failed: no answer from <host> in
 * <s> s" if the headers don't come within `ms`, but it hands back the
 * Response untouched, so its body is not buffered or decoded and the caller
 * can stream it and stop at its own cap. The same timer keeps running after
 * the headers: a body still arriving `ms` after the request began is aborted
 * (reading it then fails). The timer is not cleared once the body is read; it
 * fires later and aborts a request that has already finished, which does nothing.
 */
export function withDownloadTimeout(fetch: FetchFn, ms: number): FetchFn {
  return async (url, init) => {
    const abort = new AbortController();
    init?.signal?.addEventListener('abort', () => abort.abort());
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, ms);
    try {
      return await fetch(url, { ...init, signal: abort.signal });
    } catch (e) {
      clearTimeout(timer);
      if (timedOut) throw new Error(`fetch failed: no answer from ${new URL(url).host} in ${ms / 1000} s`);
      throw e;
    }
  };
}

/** The deeplink that opens the user's wallet on this invoice. */
export const lightningUri = (bolt11: string) => `lightning:${bolt11}`;

type PayRequest = { tag: string; callback: string; minSendable: number; maxSendable: number; metadata: string };

/**
 * Fetches an invoice for amountMsat from an LNURL-pay endpoint, after checking
 * that the endpoint describes itself with expectText (e.g. "Extend VM 1001")
 * and that the invoice is for exactly the amount asked for.
 */
export async function lnurlPayInvoice(
  fetchFn: FetchFn,
  payUrl: string,
  amountMsat: bigint,
  expectText: string,
): Promise<string> {
  const req = (await getJson(fetchFn, payUrl)) as PayRequest;
  if (req.tag !== 'payRequest') throw new Error(`${payUrl} is not an LNURL-pay endpoint`);
  if (metadataText(req.metadata) !== expectText) throw new Error(`${payUrl} does not describe itself as "${expectText}"`);
  if (amountMsat < BigInt(req.minSendable) || amountMsat > BigInt(req.maxSendable)) {
    throw new Error(`amount must be between ${req.minSendable / 1000} and ${req.maxSendable / 1000} sat`);
  }
  const sep = req.callback.includes('?') ? '&' : '?';
  const res = (await getJson(fetchFn, `${req.callback}${sep}amount=${amountMsat}`)) as { pr?: string };
  if (!res.pr) throw new Error('LNURL callback returned no invoice');
  if (bolt11AmountMsat(res.pr) !== amountMsat) throw new Error('invoice amount does not match the amount asked for');
  return res.pr;
}

/** LNURL-pay metadata's text/plain entry (LUD-06), or null. */
function metadataText(metadata: string | undefined): string | null {
  try {
    const entries = JSON.parse(metadata ?? '') as unknown[][];
    const text = entries.find((e) => Array.isArray(e) && e[0] === 'text/plain')?.[1];
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** An LNURL request that HTTP refused, with its status: a 429 is a wait, not a fault. */
export class LnurlHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function getJson(fetchFn: FetchFn, url: string): Promise<unknown> {
  const res = await fetchFn(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let body: { status?: string; reason?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new LnurlHttpError(res.status, `${url} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || body.status === 'ERROR') throw new LnurlHttpError(res.status, `${url} → ${body.reason ?? `HTTP ${res.status}`}`);
  return body;
}
