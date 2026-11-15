// Charging a card held to the till: LNURL-withdraw with the card's
// tap, exactly as a Bolt Card shop terminal does it. The link comes from a card anyone may hold to the till, so
// its server is untrusted: it is asked over https only, each request under a time limit, and an answer that came
// from somewhere else or is too big is a refusal. Nothing secret goes to it: the invoice is public, the k1 its own.
import type { FetchFn } from '../lightning/lightning';
import { thousands } from '../money/words';

/** How long the card's server has for each of the two requests. */
export const CARD_TIMEOUT_MS = 10_000;
/** The most a card's server may answer: its answers are a few hundred bytes. */
const MAX_ANSWER = 64 * 1024;

/**
 * How a charge ended. accepted: the card's server took the invoice ({"status":"OK"}), which means it is paying
 * it, not that it has been paid: the sale's own state says when. refused: said is true when reason is the card's
 * server's own words ("It says: …"), false when it is the till's sentence. unreachable: no answer before the
 * invoice was sent, so nothing happened and the sale goes on.
 */
export type ChargeOutcome = { kind: 'accepted'; returnLink?: string } | { kind: 'refused'; said: boolean; reason: string } | { kind: 'unreachable' };

/** The longest return link the till keeps. */
const MAX_RETURN_LINK = 2000;

/**
 * The card's return link: LUD-19's payLink from its withdrawRequest, an LNURL-pay link that pays the same card
 * back, as https (LUD-17's lnurlp:// becomes https://). Anything else, or one over 2,000 characters, is none: the sale
 * goes on without it. The till never calls it; it goes to the shop's server with the card step.
 */
export function returnLinkOf(wr: Record<string, unknown>): string | undefined {
  const link = wr.payLink;
  if (typeof link !== 'string' || link.length > MAX_RETURN_LINK) return undefined;
  const https = link.replace(/^lnurlp:\/\//i, 'https://');
  return originOf(https) ? https : undefined;
}

/** A refusal to show: the card's server's reason (said), or a check the till makes. */
export class PosRefusal extends Error {
  constructor(message: string, readonly said = false) {
    super(message);
    this.name = 'PosRefusal';
  }
}

/** No answer in time, or none at all. */
class NoAnswer extends Error {}

/** A card's lnurlw:// URL as the https:// one a terminal fetches (LUD-17). */
export const httpsFor = (cardUrl: string) => cardUrl.replace(/^lnurlw:\/\//i, 'https://');

/** "https://host" of an https address, lower case; null for anything else. */
const originOf = (url: string): string | null => /^https:\/\/[^/?#\s@\\]+/i.exec(url)?.[0].toLowerCase() ?? null;

/**
 * The address to ask for a card's link, or null when it isn't a Bolt Card's that can pay: lnurlw://, or https://,
 * with this tap's p and c in it.
 */
export function cardLink(url: string | null): string | null {
  if (!url) return null;
  const https = httpsFor(url);
  if (!originOf(https)) return null;
  const query = https.split('#')[0].split('?')[1] ?? '';
  const has = (key: string) => query.split('&').some((part) => part.startsWith(`${key}=`) && part.length > key.length + 1);
  return has('p') && has('c') ? https : null;
}

/**
 * A reason as it is shown, since it comes from a server anyone's card may name. Control characters and line
 * separators become a space. What could reorder, hide or redraw the words around it is dropped: direction marks
 * and overrides, zero-width and invisible characters, the soft hyphen, variation selectors, tag characters. Its
 * double quotation marks become single ones, so it can't close the till's own around it. Spaces are run together,
 * and it is cut to 200 characters.
 */
export function cleanReason(text: string): string {
  const plain = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u00ad\u034f\u061c\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e0fff}]/gu, '')
    .replace(/["\u00ab\u00bb\u201c-\u201f\u2033\u2036\u301d-\u301f\uff02]/g, "'")
    .replace(/ {2,}/g, ' ')
    .trim();
  return [...plain].slice(0, 200).join('');
}

/**
 * The refused page's sentence: the card's server's words inside the till's quotation marks, with a full stop
 * after them unless they end a sentence themselves; the till's own sentence as it is.
 */
export function refusalText(r: { said: boolean; reason: string }): string {
  if (!r.said) return r.reason;
  return /[.!?…]$/.test(r.reason) ? `It says: “${r.reason}”` : `It says: “${r.reason}”.`;
}

/**
 * An answer's text, read no further than MAX_ANSWER: where the platform hands the body over in pieces, reading
 * stops at the piece that passes the limit (an answer that never ends would otherwise fill the till's memory
 * until the time limit); where it doesn't (React Native), the whole body is read under the time limit.
 */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ANSWER) {
      await reader.cancel().catch(() => undefined);
      throw new PosRefusal("That card's server sent too much.");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(all);
}

/** One GET to a card's server: its JSON answer, or a PosRefusal; NoAnswer when none came within ms. */
async function ask(fetchFn: FetchFn, url: string, ms: number): Promise<Record<string, unknown>> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new NoAnswer());
      abort.abort();
    }, ms);
  });
  const answer = (async () => {
    // redirect: 'error' where the platform honours it; where it doesn't, the response's own address is checked below.
    const res = await fetchFn(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: abort.signal });
    // The till asked this host, over https, and takes no other's answer: a redirect shows in the response's own
    // address, and an answer with no address can't be told from one.
    if (originOf(res.url ?? '') !== originOf(url)) throw new PosRefusal("That card's server sent the till somewhere else.");
    // An answer that says it is too big isn't read at all; one that doesn't say is read under the time limit.
    if (Number(res.headers.get('content-length') ?? 0) > MAX_ANSWER) throw new PosRefusal("That card's server sent too much.");
    return { res, text: await readCapped(res) };
  })().catch((e) => {
    throw e instanceof PosRefusal ? e : new NoAnswer();
  });
  const { res, text } = await Promise.race([answer, late]).finally(() => clearTimeout(timer));
  if (text.length > MAX_ANSWER) throw new PosRefusal("That card's server sent too much.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new PosRefusal(`That card's server answered HTTP ${res.status}.`);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new PosRefusal(`That card's server answered HTTP ${res.status}.`);
  const b = body as Record<string, unknown>;
  if (b.status === 'ERROR') {
    const reason = cleanReason(typeof b.reason === 'string' ? b.reason : '');
    throw reason ? new PosRefusal(reason, true) : new PosRefusal("The card's server gave no reason.");
  }
  if (!res.ok) throw new PosRefusal(`That card's server answered HTTP ${res.status}.`);
  return b;
}

const refused = (e: PosRefusal): ChargeOutcome => ({ kind: 'refused', said: e.said, reason: e.message });

/**
 * LNURL-withdraw with the card's tap: fetch its withdrawRequest, check the amount is within what the card may
 * pay, then send the invoice to its callback with the k1. Never throws: see ChargeOutcome. No answer after the
 * invoice was sent is taken as accepted, because it may have been.
 */
export async function chargeCard(fetchFn: FetchFn, link: string | null, invoice: string, amountMsat: number, timeoutMs = CARD_TIMEOUT_MS): Promise<ChargeOutcome> {
  const first = cardLink(link);
  if (!first) return refused(new PosRefusal("That isn't a Bolt Card that can pay."));
  let callback: string;
  let returnLink: string | undefined;
  try {
    const wr = await ask(fetchFn, first, timeoutMs);
    if (wr.tag !== 'withdrawRequest' || typeof wr.callback !== 'string' || !originOf(wr.callback) || typeof wr.k1 !== 'string') {
      throw new PosRefusal("That card's server didn't answer as a Bolt Card does.");
    }
    const max = Number(wr.maxWithdrawable ?? 0);
    const min = Number(wr.minWithdrawable ?? 0);
    if (!(amountMsat <= max)) throw new PosRefusal(`This card can pay at most ${thousands(Math.floor((Number.isFinite(max) ? max : 0) / 1000))} sat now.`);
    if (amountMsat < min) throw new PosRefusal('That amount is below what this card can pay.');
    const sep = wr.callback.includes('?') ? '&' : '?';
    callback = `${wr.callback}${sep}k1=${encodeURIComponent(wr.k1)}&pr=${encodeURIComponent(invoice)}`;
    returnLink = returnLinkOf(wr);
  } catch (e) {
    return e instanceof PosRefusal ? refused(e) : { kind: 'unreachable' };
  }
  try {
    await ask(fetchFn, callback, timeoutMs);
  } catch (e) {
    if (e instanceof PosRefusal) return refused(e);
  }
  return returnLink ? { kind: 'accepted', returnLink } : { kind: 'accepted' };
}
