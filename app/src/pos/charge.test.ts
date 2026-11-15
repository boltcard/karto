import { describe, expect, it } from 'vitest';
import type { FetchFn } from '../lightning/lightning';
import { FakeHttp } from '../testing/http';
import { cardLink, chargeCard, cleanReason, httpsFor, refusalText, returnLinkOf } from './charge';

const TAP = 'lnurlw://vm-1.lnvps.cloud/ln?p=AA&c=BB';
const INVOICE = 'lnbc10u1x';
const WR = { tag: 'withdrawRequest', callback: 'https://vm-1.lnvps.cloud/ln/cb', k1: 'k', minWithdrawable: 1000, maxWithdrawable: 20_000_000, defaultDescription: 'Bolt Card' };
/** A card's server: its withdrawRequest for the tap AA, and what its callback answers. */
const server = (wr: unknown = WR, cb: (q: URLSearchParams) => unknown = () => ({ status: 'OK' })) =>
  new FakeHttp()
    .on('GET', 'https://vm-1.lnvps.cloud/ln', ({ url }) => (url.searchParams.get('p') === 'AA' ? wr : { status: 'ERROR', reason: 'This tap was already used. Tap the card again.' }))
    .on('GET', 'https://vm-1.lnvps.cloud/ln/cb', ({ url }) => cb(url.searchParams));
const charge = (http: FakeHttp, link = TAP, msat = 1_000_000) => chargeCard(http.fetch, link, INVOICE, msat);

// The card's own server is asked, as a Bolt Card terminal asks it.
describe('cardLink', () => {
  it("takes a Bolt Card's link: lnurlw://, or https:// with p and c", () => {
    expect(cardLink(TAP)).toBe('https://vm-1.lnvps.cloud/ln?p=AA&c=BB');
    expect(cardLink('LNURLW://vm-1.lnvps.cloud/ln?p=AA&c=BB')).toBe('https://vm-1.lnvps.cloud/ln?p=AA&c=BB');
    expect(cardLink('https://card.example.com/w?x=1&p=AA&c=BB')).toBe('https://card.example.com/w?x=1&p=AA&c=BB');
    expect(httpsFor(TAP)).toBe('https://vm-1.lnvps.cloud/ln?p=AA&c=BB');
  });

  it("takes nothing else: a web page, a card with no tap in its link, a link that isn't https, or none", () => {
    for (const url of [null, '', 'https://example.com/', 'https://card.example.com/w?p=AA', 'lnurlw://vm-1.lnvps.cloud/ln', 'http://card.example.com/w?p=AA&c=BB', 'lnurlp://x.example/ln?p=A&c=B', 'lightning:lnbc1', 'lnurlw://?p=A&c=B']) {
      expect(cardLink(url), String(url)).toBeNull();
    }
  });
});

// The card's return link, LUD-19's payLink, kept with the sale.
describe('returnLinkOf', () => {
  it("keeps the card's payLink as https", async () => {
    expect(returnLinkOf({ payLink: 'lnurlp://cards.example/refund/ab' })).toBe('https://cards.example/refund/ab');
    expect(returnLinkOf({ payLink: 'LNURLP://cards.example/refund/ab' })).toBe('https://cards.example/refund/ab');
    expect(returnLinkOf({ payLink: 'https://cards.example/back?x=1' })).toBe('https://cards.example/back?x=1');
    const http = server({ ...WR, payLink: 'lnurlp://cards.example/refund/ab' });
    expect(await charge(http)).toEqual({ kind: 'accepted', returnLink: 'https://cards.example/refund/ab' });
  });

  it('drops a payLink that is not lnurlp or https, or too long, and the sale goes on', async () => {
    for (const payLink of ['http://x.example/p', 'javascript:alert(1)', 'lnurlp://', 'https://', `https://x.example/${'a'.repeat(2001)}`, 42, null]) {
      expect(returnLinkOf({ payLink }), String(payLink)).toBeUndefined();
    }
    expect(await charge(server({ ...WR, payLink: 'http://x.example/p' }))).toEqual({ kind: 'accepted' });
  });
});

describe('chargeCard', () => {
  it('asks the card\'s server over https, then sends the invoice with the k1: accepted', async () => {
    let sent: URLSearchParams | undefined;
    const http = server(WR, (q) => ((sent = q), { status: 'OK' }));
    expect(await charge(http)).toEqual({ kind: 'accepted' });
    expect(http.requests.map((r) => r.url.split('?')[0])).toEqual(['https://vm-1.lnvps.cloud/ln', 'https://vm-1.lnvps.cloud/ln/cb']);
    expect([sent?.get('k1'), sent?.get('pr')]).toEqual(['k', INVOICE]);
  });

  it('refuses more than the card can pay, and less, before the invoice is sent', async () => {
    const low = server({ ...WR, maxWithdrawable: 500_000 });
    expect(await charge(low)).toEqual({ kind: 'refused', said: false, reason: 'This card can pay at most 500 sat now.' });
    expect(low.requests).toHaveLength(1);
    expect(await charge(server({ ...WR, minWithdrawable: 2_000_000 }))).toEqual({ kind: 'refused', said: false, reason: 'That amount is below what this card can pay.' });
  });

  it("gives the card's server's own reason, from its withdrawRequest or from its callback", async () => {
    expect(await charge(server(), 'lnurlw://vm-1.lnvps.cloud/ln?p=XX&c=BB')).toEqual({ kind: 'refused', said: true, reason: 'This tap was already used. Tap the card again.' });
    const http = server(WR, () => ({ status: 'ERROR', reason: "There isn't enough money on this card." }));
    expect(await charge(http)).toEqual({ kind: 'refused', said: true, reason: "There isn't enough money on this card." });
  });

  it("refuses an answer that isn't a Bolt Card's", async () => {
    const not = { kind: 'refused', said: false, reason: "That card's server didn't answer as a Bolt Card does." };
    expect(await charge(server({ tag: 'payRequest', callback: 'https://vm-1.lnvps.cloud/ln/cb', k1: 'k' }))).toEqual(not);
    expect(await charge(server({ ...WR, k1: 7 }))).toEqual(not);
    expect(await charge(new FakeHttp().on('GET', 'https://vm-1.lnvps.cloud/ln', () => new Response('<html>hello</html>')))).toEqual({ kind: 'refused', said: false, reason: "That card's server answered HTTP 200." });
    expect(await charge(server('just a string'))).toEqual({ kind: 'refused', said: false, reason: "That card's server answered HTTP 200." });
    expect(await charge(new FakeHttp().on('GET', 'https://vm-1.lnvps.cloud/ln', () => new Response('nope', { status: 502 })))).toEqual({
      kind: 'refused', said: false, reason: "That card's server answered HTTP 502.",
    });
  });

  it('asks only https: a callback over http, or one that is no address, is refused unasked', async () => {
    for (const callback of ['http://vm-1.lnvps.cloud/ln/cb', 'ftp://vm-1.lnvps.cloud/x', 'javascript:alert(1)', '/ln/cb', '']) {
      const http = server({ ...WR, callback });
      expect(await charge(http), callback).toEqual({ kind: 'refused', said: false, reason: "That card's server didn't answer as a Bolt Card does." });
      expect(http.requests).toHaveLength(1);
    }
  });

  it('takes an answer that came from somewhere else, by the response\'s own address, as a refusal', async () => {
    const moved = (to: string) => {
      const res = new Response(JSON.stringify(WR), { status: 200 });
      Object.defineProperty(res, 'url', { value: to });
      return res;
    };
    const elsewhere = { kind: 'refused', said: false, reason: "That card's server sent the till somewhere else." };
    expect(await charge(new FakeHttp().on('GET', 'https://vm-1.lnvps.cloud/ln', () => moved('https://evil.example.com/ln')))).toEqual(elsewhere);
    expect(await charge(new FakeHttp().on('GET', 'https://vm-1.lnvps.cloud/ln', () => moved('http://vm-1.lnvps.cloud/ln')))).toEqual(elsewhere);
    // The same host, another path: still the card's own server.
    const same = new FakeHttp().on('GET', 'https://vm-1.lnvps.cloud/ln', () => moved('https://vm-1.lnvps.cloud/v2/ln')).on('GET', 'https://vm-1.lnvps.cloud/ln/cb', () => ({ status: 'OK' }));
    expect(await charge(same)).toEqual({ kind: 'accepted' });
  });

  it("tells the platform not to follow a redirect, and takes an answer with no address of its own as from elsewhere", async () => {
    const seen: (string | undefined)[] = [];
    const http = server();
    const watching: FetchFn = (url, init) => {
      seen.push(init?.redirect);
      return http.fetch(url, init);
    };
    expect(await chargeCard(watching, TAP, INVOICE, 1_000_000)).toEqual({ kind: 'accepted' });
    expect(seen).toEqual(['error', 'error']);
    const nameless: FetchFn = async () => new Response(JSON.stringify(WR), { status: 200 });
    expect(await chargeCard(nameless, TAP, INVOICE, 1_000_000)).toEqual({ kind: 'refused', said: false, reason: "That card's server sent the till somewhere else." });
  });

  it('refuses an answer that says it is over 64 KB without reading it', async () => {
    let read = false;
    const huge: FetchFn = async (url) =>
      ({
        ok: true, status: 200, url, headers: new Headers({ 'content-length': String(50 * 1024 * 1024) }),
        text: async () => {
          read = true;
          return '';
        },
      }) as unknown as Response;
    expect(await chargeCard(huge, TAP, INVOICE, 1_000_000)).toEqual({ kind: 'refused', said: false, reason: "That card's server sent too much." });
    expect(read).toBe(false);
  });

  it('stops reading an answer that runs past 64 KB, without waiting for its end or the time limit', async () => {
    let pulls = 0;
    let cancelled = false;
    const endless: FetchFn = async (url) => {
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          pulls++;
          c.enqueue(new Uint8Array(16 * 1024).fill(0x20));
        },
        cancel() {
          cancelled = true;
        },
      });
      const res = new Response(body, { status: 200 });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    };
    const started = Date.now();
    expect(await chargeCard(endless, TAP, INVOICE, 1_000_000)).toEqual({ kind: 'refused', said: false, reason: "That card's server sent too much." });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(12);
  });

  it('takes an answer over 64 KB as a refusal', async () => {
    const big = { ...WR, defaultDescription: 'x'.repeat(65 * 1024) };
    expect(await charge(server(big))).toEqual({ kind: 'refused', said: false, reason: "That card's server sent too much." });
  });

  it("can't reach the card's server before the invoice is sent: nothing happened, and the sale goes on", async () => {
    const down: FetchFn = async () => {
      throw new Error('Network request failed');
    };
    expect(await chargeCard(down, TAP, INVOICE, 1_000_000)).toEqual({ kind: 'unreachable' });
  });

  it('gives a slow server 10 seconds for each request', async () => {
    const never = new FakeHttp().on('GET', 'https://vm-1.lnvps.cloud/ln', () => new Promise<Response>(() => {}));
    const started = Date.now();
    expect(await chargeCard(never.fetch, TAP, INVOICE, 1_000_000, 30)).toEqual({ kind: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('treats no answer after the invoice was sent as accepted: it may have been', async () => {
    const http = server();
    const lost: FetchFn = async (url, init) => {
      if (url.includes('/ln/cb')) throw new Error('Network request failed');
      return http.fetch(url, init);
    };
    expect(await chargeCard(lost, TAP, INVOICE, 1_000_000)).toEqual({ kind: 'accepted' });
    const slow = server(WR, () => new Promise<Response>(() => {}));
    expect(await chargeCard(slow.fetch, TAP, INVOICE, 1_000_000, 30)).toEqual({ kind: 'accepted' });
  });

  it("is refused by a link that isn't a Bolt Card's, unasked", async () => {
    const http = server();
    expect(await charge(http, 'https://example.com/')).toEqual({ kind: 'refused', said: false, reason: "That isn't a Bolt Card that can pay." });
    expect(http.requests).toHaveLength(0);
  });
});

// The refused page's sentence: the server's own words inside the till's quotation marks, ended once. Seen on the
// live run (2026-10-14): "It says: “That is over this card's limit per payment.”." had two full stops.
describe('refusalText', () => {
  it("quotes the card's server and ends the sentence with one full stop", () => {
    expect(refusalText({ said: true, reason: "That is over this card's limit per payment." })).toBe("It says: “That is over this card's limit per payment.”");
    expect(refusalText({ said: true, reason: 'Card frozen!' })).toBe('It says: “Card frozen!”');
    expect(refusalText({ said: true, reason: 'Is the card on?' })).toBe('It says: “Is the card on?”');
    expect(refusalText({ said: true, reason: 'Wait…' })).toBe('It says: “Wait…”');
    expect(refusalText({ said: true, reason: 'over the limit' })).toBe('It says: “over the limit”.');
  });

  it("gives the till's own sentence as it is", () => {
    expect(refusalText({ said: false, reason: "That isn't a Bolt Card that can pay." })).toBe("That isn't a Bolt Card that can pay.");
  });
});

describe('cleanReason', () => {
  it('drops control characters and cuts a long reason to 200 characters', () => {
    expect(cleanReason('over this\ncard\'s limit\u0007 for\tone payment')).toBe("over this card's limit for one payment");
    expect(cleanReason('x'.repeat(500))).toBe('x'.repeat(200));
    expect(cleanReason('  spaced   out  ')).toBe('spaced out');
    expect(cleanReason('')).toBe('');
  });

  // The words come from a server anyone's card may name, and are shown on the till: nothing in them may reorder
  // or hide the text around them.
  it('drops what could reorder or hide text: direction marks and overrides, zero-width characters, line separators', () => {
    expect(cleanReason('refused\u202e diaP\u202c')).toBe('refused diaP');
    expect(cleanReason('a\u200bb\u200fc\u2066d\u2069e\ufefff\u2028g\u2029h\u00adi\u061cj')).toBe('abcdef g hij');
    expect(cleanReason('\u202e\u202d')).toBe('');
  });

  // The till shows the reason inside its own quotation marks: the reason can't close them and add words of its own.
  it("turns a reason's own double quotation marks into single ones", () => {
    expect(cleanReason('no\u201d. Paid in full. \u201c')).toBe("no'. Paid in full. '");
    expect(cleanReason('say "x" \u00abx\u00bb \u201ex\u201f')).toBe("say 'x' 'x' 'x'");
  });

  it('drops marks that change how a character is drawn, and invisible tag characters', () => {
    expect(cleanReason('a\ufe0fb\u180ec\u034fd\u{e0041}e\ufff9f')).toBe('abcdef');
  });

  it("is applied to the card's server's reason, which anyone's card may bring", async () => {
    const http = server(WR, () => ({ status: 'ERROR', reason: `line one\r\nline two${'!'.repeat(300)}` }));
    const r = await charge(http);
    expect(r).toMatchObject({ kind: 'refused', said: true });
    expect((r as { reason: string }).reason).toBe(`line one line two${'!'.repeat(183)}`);
  });

  it('says so when the server refused with no reason', async () => {
    expect(await charge(server(WR, () => ({ status: 'ERROR' })))).toEqual({ kind: 'refused', said: false, reason: "The card's server gave no reason." });
  });
});
