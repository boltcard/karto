import { describe, expect, it } from 'vitest';
import { CarddError, isNoRate, isRevoked, isWrongCurrency } from '../cardd/error';
import { FakeCardd, vectorDeviceKey } from '../testing/fakeCardd';
import { vectors } from '../testing/vectors';
import { pairPhone, PosClient } from './client';

const HOST = 'vm-1001.lnvps.cloud';
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A shop with this phone paired as Till 1 (the vectors' key), unless told not to pair. */
async function setup(o: { phoneClockOffsetMs?: number; pair?: boolean } = {}) {
  let nowMs = 1_790_000_000_000;
  const cardd = new FakeCardd(() => nowMs);
  const client = new PosClient({ fetch: cardd.http.fetch, host: HOST, key: vectorDeviceKey(), now: () => nowMs + (o.phoneClockOffsetMs ?? 0) });
  if (o.pair !== false) await pairPhone(cardd.http.fetch, HOST, cardd.newCode('Till 1'), vectors.deviceAuth.publicKey);
  return { cardd, client, tick: (ms: number) => (nowMs += ms) };
}

// Karto PoS has its own client, which knows only the /api/v1/pos/ routes and /pos/pair.
describe('pairPhone', () => {
  it('pairs with a code and the phone\'s public key, unsigned, and says the name the shop gave it', async () => {
    const { cardd } = await setup({ pair: false });
    const code = cardd.newCode('Till 1');
    expect(await pairPhone(cardd.http.fetch, HOST, code, vectors.deviceAuth.publicKey)).toEqual({ keyId: vectors.deviceAuth.keyId, name: 'Till 1', wallet: '' });
    const sent = cardd.http.requests.at(-1)!;
    expect([sent.method, sent.url, sent.headers.authorization]).toEqual(['POST', `https://${HOST}/pos/pair`, undefined]);
    expect(JSON.parse(sent.body!)).toEqual({ code, publicKey: vectors.deviceAuth.publicKey });
    expect(cardd.posCode).toBeNull();
  });

  it("is refused a code that is unknown, used or run out, and a key the shop already has", async () => {
    const { cardd, tick } = await setup({ pair: false });
    const pair = (code: string) => pairPhone(cardd.http.fetch, HOST, code, vectors.deviceAuth.publicKey);
    await expect(pair('0'.repeat(32))).rejects.toMatchObject({ status: 403, code: 'bad_code' });
    const old = cardd.newCode('Till 1');
    tick(601_000);
    await expect(pair(old)).rejects.toMatchObject({ status: 403, code: 'bad_code' });
    await pair(cardd.newCode('Till 1'));
    await expect(pair(cardd.newCode('Till 2'))).rejects.toMatchObject({ status: 409, code: 'key_known' });
  });
});

// The answer is whatever server the link named: it is a shop's only if it names this phone's own key and gives a
// name a shop could have given (1 to 24 characters, none of them a control or one that reorders the line).
describe("pairPhone and an answer that isn't a shop's", () => {
  const answering = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 201 });
  const pair = (body: unknown) => pairPhone(answering(body), HOST, 'a'.repeat(32), vectors.deviceAuth.publicKey);
  const mine = vectors.deviceAuth.keyId;

  it('takes the name of a shop that names this key', async () => {
    expect(await pair({ keyId: mine, name: 'Till 1' })).toEqual({ keyId: mine, name: 'Till 1', wallet: '' });
    expect(await pair({ keyId: mine, name: 'é'.repeat(24), more: 1 })).toEqual({ keyId: mine, name: 'é'.repeat(24), wallet: '' });
  });

  // The wallet's name is shown, never trusted: one a till wouldn't show is dropped, and the pairing stands.
  it("takes the wallet's name, and drops one that isn't a name", async () => {
    expect(await pair({ keyId: mine, name: 'Till 1', wallet: 'Café' })).toEqual({ keyId: mine, name: 'Till 1', wallet: 'Café' });
    for (const wallet of ['a\u200bb', ' Café', 'x'.repeat(25), 7, null]) {
      expect(await pair({ keyId: mine, name: 'Till 1', wallet }), JSON.stringify(wallet)).toEqual({ keyId: mine, name: 'Till 1', wallet: '' });
    }
  });

  it("refuses another key's answer, a name that is none, and what isn't an answer at all", async () => {
    for (const body of [
      { keyId: 'ffffffffffffffff', name: 'Till 1' },
      { name: 'Till 1' },
      { keyId: mine, name: '' },
      { keyId: mine, name: ' Till 1' },
      { keyId: mine, name: 'x'.repeat(25) },
      { keyId: mine, name: 7 },
      { keyId: mine },
      { keyId: mine, name: 'Till\u202e 1' },
      { keyId: mine, name: 'Till\n1' },
      { keyId: mine, name: 'Till\u200b1' },
      'hello',
      null,
      [],
    ]) {
      await expect(pair(body), JSON.stringify(body)).rejects.toMatchObject({ code: 'not_a_shop' });
    }
  });
});

describe('PosClient', () => {
  it("signs as Karto Wallet's client does, and is what the shop paired", async () => {
    const { cardd, client } = await setup();
    expect(await client.me()).toEqual({ keyId: vectors.deviceAuth.keyId, name: 'Till 1', role: 'pos', wallet: '' });
    const sent = cardd.http.requests.at(-1)!;
    expect(sent.url).toBe(`https://${HOST}/api/v1/pos/me`);
    // The fake verifies the signature with the vectors' public key, as cardd's deviceauth does.
    expect(sent.headers.authorization).toMatch(/^Device b18b86ce1389e46d\.1790000000\.[0-9a-f]+$/);
  });

  // cardd allows ±60 s; a till's clock drifts. Signed once more on the server's clock, from its Date header.
  it('signs again on the server clock when the phone clock is off, once, and keeps the correction', async () => {
    const { cardd, client } = await setup({ phoneClockOffsetMs: -5 * 60_000 });
    const before = cardd.http.requests.length;
    expect(await client.me()).toMatchObject({ name: 'Till 1' });
    expect(cardd.http.requests.length - before).toBe(2);
    expect(await client.me()).toMatchObject({ name: 'Till 1' });
    expect(cardd.http.requests.length - before).toBe(3);
  });

  it('knows it was removed from its 401, and not from a clock that is off', async () => {
    const { cardd, client } = await setup();
    cardd.pos.get(vectors.deviceAuth.keyId)!.removed = true;
    const e = await client.me().catch((x) => x);
    expect(e).toBeInstanceOf(CarddError);
    expect(e).toMatchObject({ status: 401 });
    expect(isRevoked(e)).toBe(true);
    expect(isRevoked(new CarddError(401, 'unauthorized', 'deviceauth: timestamp out of range'))).toBe(false);
  });

  it('makes a sale: an invoice for the amount, open for ten minutes', async () => {
    const { client } = await setup();
    const sale = await client.newSale(ID(1), { sat: 2500 });
    expect(sale).toEqual({
      id: ID(1), amountMsat: 2_500_000, state: 'open', method: '', device: { keyId: vectors.deviceAuth.keyId, name: 'Till 1' },
      created: 1_790_000_000, expires: 1_790_000_600, invoice: expect.stringMatching(/^lnbc25u1/),
    });
    // The same request again is the same sale.
    expect(await client.newSale(ID(1), { sat: 2500 })).toEqual(sale);
    expect(await client.sale(ID(1))).toEqual(sale);
    await expect(client.newSale(ID(1), { sat: 3000 })).rejects.toMatchObject({ status: 409, code: 'sale_exists' });
  });

  it('reads a sale with a wait when given one: the shop may hold its answer until the sale is paid', async () => {
    const { cardd, client } = await setup();
    const sale = await client.newSale(ID(1), { sat: 2500 });
    expect(await client.sale(ID(1), 8)).toEqual(sale);
    expect(cardd.http.requests.at(-1)!.url).toBe(`https://${HOST}/api/v1/pos/sales/${ID(1)}?wait=8`);
    expect(await client.sale(ID(1))).toEqual(sale);
    expect(cardd.http.requests.at(-1)!.url).toBe(`https://${HOST}/api/v1/pos/sales/${ID(1)}`);
  });

  it("is refused an amount out of range, an id that isn't one, and a second new sale within the second", async () => {
    const { client, tick } = await setup();
    await expect(client.newSale(ID(1), { sat: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(client.newSale(ID(1), { sat: 2_000_001 })).rejects.toMatchObject({ status: 400 });
    await expect(client.newSale('days', { sat: 100 })).rejects.toMatchObject({ status: 400 });
    await client.newSale(ID(1), { sat: 100 });
    await expect(client.newSale(ID(2), { sat: 100 })).rejects.toMatchObject({ status: 429, code: 'slow_down' });
    tick(1000);
    expect(await client.newSale(ID(2), { sat: 100 })).toMatchObject({ state: 'open' });
    // A phone has one open sale: the new one cancelled the old.
    expect(await client.sale(ID(1))).toMatchObject({ state: 'cancelled' });
  });

  // The card's return link goes with the card step; an old till's step has no body.
  it("sends the card's return link with the card step", async () => {
    const { cardd, client, tick } = await setup();
    await client.newSale(ID(1), { sat: 2500 });
    await client.cardRead(ID(1), 'https://cards.example/refund/ab');
    expect(cardd.sales.get(ID(1))?.returnLink).toBe('https://cards.example/refund/ab');
    tick(1000);
    await client.newSale(ID(2), { sat: 2500 });
    await client.cardRead(ID(2));
    expect(cardd.sales.get(ID(2))?.returnLink).toBeUndefined();
  });

  it('watches a sale through to paid, and says a card was read', async () => {
    const { cardd, client } = await setup();
    await client.newSale(ID(1), { sat: 2500 });
    expect(await client.cardRead(ID(1))).toMatchObject({ state: 'open', method: '' });
    cardd.paySale(ID(1));
    const paid = await client.sale(ID(1));
    expect(paid).toEqual({
      id: ID(1), amountMsat: 2_500_000, state: 'paid', method: 'card', device: { keyId: vectors.deviceAuth.keyId, name: 'Till 1' },
      created: 1_790_000_000, expires: 1_790_000_600, paidAt: 1_790_000_000, txId: expect.any(Number),
    });
    // A PoS phone sees prices, never what the shop received.
    expect(paid).not.toHaveProperty('receivedMsat');
    expect(paid).not.toHaveProperty('invoice');
  });

  it('cancels a sale, sees one run out, and sees either paid all the same', async () => {
    const { cardd, client, tick } = await setup();
    await client.newSale(ID(1), { sat: 1000 });
    expect(await client.cancel(ID(1))).toMatchObject({ state: 'cancelled' });
    tick(1000);
    await client.newSale(ID(2), { sat: 1000 });
    tick(601_000);
    expect(await client.sale(ID(2))).toMatchObject({ state: 'expired' });
    cardd.paySale(ID(1));
    cardd.paySale(ID(2));
    expect(await client.sale(ID(1))).toMatchObject({ state: 'paid', method: 'qr' });
    expect(await client.sale(ID(2))).toMatchObject({ state: 'paid', method: 'qr' });
  });

  it("is refused another phone's sale, and a sale that isn't there", async () => {
    const { cardd, client } = await setup();
    cardd.pair(cardd.newCode('Till 2'), 'bbbbbbbbbbbbbbbb');
    const theirs = cardd.sell('bbbbbbbbbbbbbbbb', 1_000_000, 'qr');
    await expect(client.cancel(theirs)).rejects.toMatchObject({ status: 403, code: 'not_allowed' });
    await expect(client.cardRead(theirs)).rejects.toMatchObject({ status: 403, code: 'not_allowed' });
    // Reading one by its id is allowed, as cardd allows it; the list is the till's own (below).
    expect(await client.sale(theirs)).toMatchObject({ state: 'paid', device: { name: 'Till 2' } });
    await expect(client.sale(ID(9))).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('lists the paid sales it took a page at a time, with their days, and no other till\'s', async () => {
    const { cardd, client, tick } = await setup();
    cardd.pair(cardd.newCode('Till 2'), 'bbbbbbbbbbbbbbbb');
    const first = cardd.sell(vectors.deviceAuth.keyId, 1_000_000, 'qr');
    tick(86_400_000);
    cardd.sell('bbbbbbbbbbbbbbbb', 4_000_000, 'qr');
    const second = cardd.sell(vectors.deviceAuth.keyId, 2_500_000, 'card', 2_000_000);
    const all = await client.sales();
    expect(all.map((s) => s.id)).toEqual([second, first]);
    expect(all[0]).not.toHaveProperty('receivedMsat');
    const page = await client.sales({ limit: 1 });
    expect((await client.sales({ before: page[0].txId, limit: 1 })).map((s) => s.id)).toEqual([first]);
    expect(await client.days(60)).toEqual([
      { day: 1_790_031_600, count: 1, totalMsat: 2_500_000 },
      { day: 1_789_945_200, count: 1, totalMsat: 1_000_000 },
    ]);
    expect(await client.days(60, 1)).toHaveLength(1);
  });

  it("reads its name and the wallet's", async () => {
    const { cardd, client } = await setup();
    expect(await client.me()).toMatchObject({ name: 'Till 1', wallet: '' });
    cardd.walletName = 'Café';
    expect(await client.me()).toMatchObject({ name: 'Till 1', wallet: 'Café' });
    cardd.nameRoutes = false;
    expect(await client.me()).not.toHaveProperty('wallet');
  });

  it('unpairs itself', async () => {
    const { cardd, client } = await setup();
    await client.forget();
    expect(cardd.pos.get(vectors.deviceAuth.keyId)!.removed).toBe(true);
    expect(isRevoked(await client.me().catch((x) => x))).toBe(true);
  });

  it("is kept to its own routes by the shop: the wallet's are refused it", async () => {
    const { cardd } = await setup();
    // The same key, asking as Karto Wallet's client would.
    const { CarddClient } = await import('../cardd/client');
    const wallet = new CarddClient({ fetch: cardd.http.fetch, host: HOST, key: vectorDeviceKey(), now: () => 1_790_000_000_000 });
    await expect(wallet.wallet()).rejects.toMatchObject({ status: 403, code: 'not_allowed' });
    await expect(wallet.shopPhones()).rejects.toMatchObject({ status: 403, code: 'not_allowed' });
  });
});

// The till reads the shop's currency under
// /api/v1/pos/ and rings a sale up in it; cardd turns the price into sats, once.
describe('PosClient and the currency', () => {
  const T = 1_792_037_404;

  it("reads the shop's currency and its rate, under /api/v1/pos/", async () => {
    const { cardd, client } = await setup();
    expect(await client.fiat()).toEqual({ currency: null });
    expect(cardd.http.requests.at(-1)!.url).toBe(`https://${HOST}/api/v1/pos/fiat`);
    cardd.currency = 'GBP';
    cardd.prices = { time: T, per: { GBP: 61_352 } };
    expect(await client.fiat()).toEqual({ currency: 'GBP', price: 61_352, time: T });
  });

  it('sends a sale in sats as amountSat, and one in the currency as its price, which cardd turns into sats', async () => {
    const { cardd, client, tick } = await setup();
    cardd.currency = 'GBP';
    cardd.prices = { time: T, per: { GBP: 61_352 } };
    await client.newSale(ID(1), { sat: 2500 });
    expect(JSON.parse(cardd.http.requests.at(-1)!.body!)).toEqual({ id: ID(1), amountSat: 2500 });
    tick(1000);
    const sale = await client.newSale(ID(2), { price: { currency: 'GBP', minor: 250 } });
    expect(JSON.parse(cardd.http.requests.at(-1)!.body!)).toEqual({ id: ID(2), price: { currency: 'GBP', minor: 250 } });
    expect(sale).toMatchObject({ id: ID(2), amountMsat: 4_075_000, state: 'open', price: { currency: 'GBP', minor: 250 } });
  });

  it('finds a priced sale asked for again by its price, with its first sats, though the rate has moved', async () => {
    const { cardd, client } = await setup();
    cardd.currency = 'GBP';
    cardd.prices = { time: T, per: { GBP: 61_352 } };
    const sale = await client.newSale(ID(1), { price: { currency: 'GBP', minor: 250 } });
    cardd.prices = { time: T + 300, per: { GBP: 50_000 } };
    expect(await client.newSale(ID(1), { price: { currency: 'GBP', minor: 250 } })).toEqual(sale);
    await expect(client.newSale(ID(1), { price: { currency: 'GBP', minor: 300 } })).rejects.toMatchObject({ status: 409, code: 'sale_exists' });
  });

  it("is refused a price with no rate yet, and one in a currency that isn't the shop's", async () => {
    const { cardd, client } = await setup();
    cardd.currency = 'GBP';
    const none = await client.newSale(ID(1), { price: { currency: 'GBP', minor: 250 } }).catch((e: unknown) => e);
    expect(none).toMatchObject({ status: 409, code: 'no_rate' });
    expect(isNoRate(none)).toBe(true);
    cardd.prices = { time: T, per: { GBP: 61_352, EUR: 72_070 } };
    const wrong = await client.newSale(ID(2), { price: { currency: 'EUR', minor: 250 } }).catch((e: unknown) => e);
    expect(wrong).toMatchObject({ status: 409, code: 'wrong_currency' });
    expect(isWrongCurrency(wrong)).toBe(true);
    expect(isNoRate(wrong)).toBe(false);
  });
});
