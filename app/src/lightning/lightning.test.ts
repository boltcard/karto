import { describe, expect, it, vi } from 'vitest';
import { bolt11AmountMsat, bolt11Description, bolt11ExpiresAtMs, bolt11PaymentHash, lnurlDecode, lightningUri, lnurlPayInvoice, withDownloadTimeout, withTimeout, type FetchFn } from './lightning';
import { fakeInvoice } from '../testing/fakeLnvps';
import { FakeHttp } from '../testing/http';

// Human-readable parts from the BOLT 11 examples, with a dummy data part:
// only the part before the last "1" carries the amount.
const inv = (hrp: string) => `${hrp}1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq`;

describe('bolt11AmountMsat', () => {
  it('reads the BOLT 11 example amounts', () => {
    expect(bolt11AmountMsat(inv('lnbc2500u'))).toBe(250_000_000n);
    expect(bolt11AmountMsat(inv('lnbc20m'))).toBe(2_000_000_000n);
    expect(bolt11AmountMsat(inv('lnbc9678785340p'))).toBe(967_878_534n);
    expect(bolt11AmountMsat(inv('lnbc1000n'))).toBe(100_000n);
    expect(bolt11AmountMsat(inv('lnbc1'))).toBe(100_000_000_000n);
  });
  it('returns null for an any-amount invoice', () => {
    expect(bolt11AmountMsat(inv('lnbc'))).toBeNull();
  });
  it('accepts upper case and a lightning: prefix', () => {
    expect(bolt11AmountMsat('lightning:' + inv('lnbc2500u').toUpperCase())).toBe(250_000_000n);
  });
  it('rejects testnet, garbage and sub-millisat amounts', () => {
    expect(() => bolt11AmountMsat(inv('lntb2500u'))).toThrow('mainnet');
    expect(() => bolt11AmountMsat('hello')).toThrow('mainnet');
    expect(() => bolt11AmountMsat(inv('lnbc25p'))).toThrow('fraction');
  });
  it('builds the wallet deeplink', () => {
    expect(lightningUri('lnbc1x')).toBe('lightning:lnbc1x');
  });
});

describe('lnurlPayInvoice', () => {
  const server = (pr: string, metadata = '[["text/plain","Extend VM 1001"]]') =>
    new FakeHttp()
      .on('GET', 'https://api.lnvps.net/.well-known/lnurlp/1001', () => ({
        callback: 'https://api.lnvps.net/api/v1/vm/1001/renew-lnurlp',
        maxSendable: 1_000_000_000,
        minSendable: 100_000,
        tag: 'payRequest',
        metadata,
      }))
      .on('GET', 'https://api.lnvps.net/api/v1/vm/1001/renew-lnurlp', ({ url }) =>
        url.searchParams.get('amount') === '250000000' ? { pr, routes: [] } : { status: 'ERROR', reason: 'bad amount' });

  it('returns the invoice for the amount asked', async () => {
    const http = server(inv('lnbc2500u'));
    const pr = await lnurlPayInvoice(http.fetch, 'https://api.lnvps.net/.well-known/lnurlp/1001', 250_000_000n, 'Extend VM 1001');
    expect(pr).toBe(inv('lnbc2500u'));
    expect(http.requests[1].url).toBe('https://api.lnvps.net/api/v1/vm/1001/renew-lnurlp?amount=250000000');
  });
  it('refuses an endpoint that is not for this VM', async () => {
    const http = server(inv('lnbc2500u'), '[["text/plain","Extend VM 9999"]]');
    await expect(lnurlPayInvoice(http.fetch, 'https://api.lnvps.net/.well-known/lnurlp/1001', 250_000_000n, 'Extend VM 1001')).rejects.toThrow('does not describe itself');
  });
  it('refuses an endpoint whose text only contains this VM\'s', async () => {
    for (const metadata of ['[["text/plain","Extend VM 10010"]]', '[["text/plain","Extend VM 1001, and more"]]', 'not json']) {
      const http = server(inv('lnbc2500u'), metadata);
      await expect(lnurlPayInvoice(http.fetch, 'https://api.lnvps.net/.well-known/lnurlp/1001', 250_000_000n, 'Extend VM 1001')).rejects.toThrow('does not describe itself');
    }
  });
  it('refuses an invoice for a different amount', async () => {
    const http = server(inv('lnbc2600u'));
    await expect(lnurlPayInvoice(http.fetch, 'https://api.lnvps.net/.well-known/lnurlp/1001', 250_000_000n, 'Extend VM 1001')).rejects.toThrow('does not match');
  });
  it('enforces the endpoint limits and passes on LNURL errors', async () => {
    const http = server(inv('lnbc2500u'));
    await expect(lnurlPayInvoice(http.fetch, 'https://api.lnvps.net/.well-known/lnurlp/1001', 99_000n, 'Extend VM 1001')).rejects.toThrow('between 100 and 1000000 sat');
    await expect(lnurlPayInvoice(http.fetch, 'https://api.lnvps.net/.well-known/lnurlp/1001', 300_000n, 'Extend VM 1001')).rejects.toThrow('bad amount');
  });
});

// BOLT11's own examples: created 1496314658; one says "within one minute" (x = 60), one sets no expiry (3600 s).
describe('bolt11ExpiresAtMs', () => {
  it('reads the creation time and expiry the invoice carries', () => {
    const coffee =
      'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
    expect(bolt11ExpiresAtMs(coffee)).toBe((1496314658 + 60) * 1000);
    expect(bolt11ExpiresAtMs(`lightning:${coffee.toUpperCase()}`)).toBe((1496314658 + 60) * 1000);
  });

  it('uses the default hour when the invoice sets no expiry', () => {
    const donation =
      'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w';
    expect(bolt11ExpiresAtMs(donation)).toBe((1496314658 + 3600) * 1000);
  });

  it('returns null for something that is not an invoice', () => {
    expect(bolt11ExpiresAtMs('lnbc1notaninvoice')).toBeNull();
  });

  it('decodes the fakes the tests use', () => {
    expect(bolt11ExpiresAtMs(fakeInvoice(1_550_000n, 1_790_000_000, 600))).toBe((1_790_000_000 + 600) * 1000);
    expect(bolt11AmountMsat(fakeInvoice(1_550_000n))).toBe(1_550_000n);
  });
});

// A request that never answers (seen on the phone: the pay poll stopped for minutes) must
// fail like a network failure, so onboarding waits and asks again instead of hanging.
describe('withTimeout', () => {
  it('gives up on a request that never answers, as a network failure', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const never: FetchFn = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        });
      const p = withTimeout(never, 30_000)('https://api.lnvps.net/api/v1/vm/1011');
      const check = expect(p).rejects.toThrow(/^fetch failed: no answer from api\.lnvps\.net in 30 s$/);
      await vi.advanceTimersByTimeAsync(30_000);
      await check;
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // The headers can arrive and the body then stall, which hung the caller's res.text().
  it('gives up on an answer whose body never finishes', async () => {
    vi.useFakeTimers();
    try {
      const stalls: FetchFn = async () =>
        new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"da')) }), { status: 200 });
      const p = withTimeout(stalls, 30_000)('https://api.lnvps.net/api/v1/account').then((r) => r.text());
      const check = expect(p).rejects.toThrow(/^fetch failed: no answer from api\.lnvps\.net in 30 s$/);
      await vi.advanceTimersByTimeAsync(30_000);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the status, headers and an empty body', async () => {
    const empty: FetchFn = async () => new Response(null, { status: 204, headers: { date: 'Sat, 03 Oct 2026 12:00:00 GMT' } });
    const res = await withTimeout(empty, 30_000)('https://api.lnvps.net/api/v1/vm/1');
    expect([res.status, res.ok, res.headers.get('date'), await res.text()]).toEqual([204, true, 'Sat, 03 Oct 2026 12:00:00 GMT', '']);
  });

  it('passes an answer through, and keeps the caller\'s own options', async () => {
    let seen: RequestInit | undefined;
    const ok: FetchFn = async (_url, init) => ((seen = init), new Response('{}', { status: 200 }));
    const res = await withTimeout(ok, 30_000)('https://api.mail.tm/domains', { method: 'POST', body: 'x' });
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({ method: 'POST', body: 'x' });
  });
});

// BOLT 11's example "Please make a donation of any amount using payment_hash 0001020304050607080900010203040506070809000102030405060708090102".
describe('bolt11PaymentHash', () => {
  it("reads the example's payment hash", () => {
    const example =
      'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';
    expect(bolt11PaymentHash(example)).toBe('0001020304050607080900010203040506070809000102030405060708090102');
    expect(bolt11PaymentHash('lnbcgarbage')).toBeNull();
  });
});

describe('bolt11Description and lnurlDecode', () => {
  it("read BOLT 11's donation example and LUD-01's LNURL", () => {
    const donation =
      'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';
    expect(bolt11Description(donation)).toBe('Please consider supporting this project');
    expect(lnurlDecode('LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS')).toBe(
      'https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df',
    );
    expect(lnurlDecode('lnbc1nope')).toBeNull();
  });
});

describe('withDownloadTimeout', () => {
  it('gives up when the headers never come, as a network failure', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const never: FetchFn = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        });
      const p = withDownloadTimeout(never, 300_000)('https://vm-1001.lnvps.cloud/api/v1/backups/1');
      const check = expect(p).rejects.toThrow(/^fetch failed: no answer from vm-1001\.lnvps\.cloud in 300 s$/);
      await vi.advanceTimersByTimeAsync(300_000);
      await check;
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the very Response it was given, and aborts a body that trickles at ms', async () => {
    vi.useFakeTimers();
    try {
      let given!: Response;
      const trickle: FetchFn = async (_url, init) => {
        given = new Response(
          new ReadableStream({
            start: (c) => {
              c.enqueue(new Uint8Array([1]));
              init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
            },
          }),
          { status: 200 },
        );
        return given;
      };
      const res = await withDownloadTimeout(trickle, 1000)('https://h.example/x');
      expect(res).toBe(given);
      const reading = res.arrayBuffer().catch((e) => e);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await reading).toMatchObject({ message: 'aborted' });
    } finally {
      vi.useRealTimers();
    }
  });
});
