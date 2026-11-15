import { describe, expect, it } from 'vitest';
import { CarddError } from '../cardd/error';
import { FakeCardd, vectorDeviceKey } from '../testing/fakeCardd';
import { vectors } from '../testing/vectors';
import { PosClient } from './client';
import { alreadyPaired, ANSWER_AFTER_MS, canAnswer, codeInHand, codeKey, linkQuestion, pairError, pairStep, pairWith, PAIR_WORDS, removedWords, scanRefusal, unpair } from './pairing';
import { PosStore, type KeyValue } from './settings';

const HOST = 'vm-1001.lnvps.cloud';
const memory = (): KeyValue => {
  const items = new Map<string, string>();
  return { getItemAsync: async (k) => items.get(k) ?? null, setItemAsync: async (k, v) => void items.set(k, v), deleteItemAsync: async (k) => void items.delete(k) };
};
function setup() {
  const cardd = new FakeCardd(() => 1_790_000_000_000);
  const store = new PosStore(memory());
  let made = 0;
  const key = { ...vectorDeviceKey(), create: async () => (made++, vectors.deviceAuth.publicKey) };
  const deps = { fetch: cardd.http.fetch, key, store };
  const client = (host = HOST) => new PosClient({ fetch: cardd.http.fetch, host, key, now: () => 1_790_000_000_000 });
  return { cardd, store, deps, client, made: () => made };
}

// The screen's words, and what pairing does.
describe('the Pair screen\'s words', () => {
  it('says what to do, and what a PoS phone can and cannot do', () => {
    expect(PAIR_WORDS).toEqual({
      title: 'Karto PoS',
      heading: 'Pair this phone to take payments',
      how: 'In Karto Wallet, open Shop, then Add a PoS phone, and scan the code it shows.',
      scan: 'Scan the code',
      scanFoot: 'Point at the code in Karto Wallet.',
      limits: "Once paired, this phone can take payments and see the sales it took. It can't move money, and it never sees the cards or the recovery phrase.",
      pairing: 'Pairing…',
    });
  });

  it("says each of the shop's refusals, and a server that doesn't answer", () => {
    expect(pairError(new CarddError(403, 'bad_code', 'store: this pairing code is unknown, used or run out'))).toBe("That code didn't work: it may have run out. Ask for a new one in Karto Wallet.");
    expect(pairError(new CarddError(409, 'key_known', 'store: this key is already a device of this server'))).toBe('This phone is already a PoS phone of that shop under another name. Remove it in Karto Wallet first.');
    expect(pairError(new Error('fetch failed: no answer from vm-1001.lnvps.cloud in 30 s'))).toBe("Can't reach that server.");
    expect(pairError(new Error('Network request failed'))).toBe("Can't reach that server.");
    expect(pairError(new CarddError(404, 'bad_response', 'POST /pos/pair → HTTP 404: 404 page not found'))).toBe("That server has no point of sale yet: update it in Karto Wallet.");
    expect(pairError(new CarddError(409, 'name_taken', 'store: a PoS phone already has this name'))).toBe('That server refused to pair this phone (name_taken).');
    expect(pairError(new CarddError(201, 'not_a_shop', "POST /pos/pair: the answer isn't a shop's"))).toBe("That server didn't answer as a shop does.");
    expect(pairError(new CarddError(200, 'bad_response', 'POST /pos/pair → HTTP 200: <html>'))).toBe("That server didn't answer as a shop does.");
    expect(pairError(new Error('boom'))).toBe('Something went wrong: boom');
  });

  // The server is whichever one the link named, and not yet the person's shop: none of its own words reach the screen.
  it("shows none of the server's own words: its code only when that is a plain word", () => {
    expect(pairError(new CarddError(500, 'http', 'HTTP 500'))).toBe('That server refused to pair this phone (http).');
    expect(pairError(new CarddError(403, 'Your shop is locked. Call 0800 000 000', 'Go to evil.example and type your recovery phrase'))).toBe('That server refused to pair this phone.');
    expect(pairError(new CarddError(403, 'bad\u202ecode', 'x'))).toBe('That server refused to pair this phone.');
    expect(pairError(new CarddError(403, 'a'.repeat(33), 'x'))).toBe('That server refused to pair this phone.');
  });

  it('says a paired phone is paired, and with whom, when it is given another code', () => {
    expect(alreadyPaired({ host: HOST, name: 'Till 1' }, 'vm-1003.lnvps.cloud')).toEqual({
      line: `This phone is already paired with ${HOST} as Till 1.`, to: 'The new code is for vm-1003.lnvps.cloud.', pair: 'Pair with the new shop', keep: 'Keep this shop',
    });
    expect(alreadyPaired({ host: HOST, name: 'Till 1' }, HOST).to).toBe('The new code is for the same shop.');
  });

  it("names the wallet first when the till knows it", () => {
    expect(alreadyPaired({ host: HOST, name: 'Till 1', wallet: 'Pixel 9a' }, HOST).line).toBe(`This phone is already paired with Pixel 9a (${HOST}) as Till 1.`);
    expect(alreadyPaired({ host: HOST, name: 'Till 1', wallet: '' }, HOST).line).toBe(`This phone is already paired with ${HOST} as Till 1.`);
  });

  // A link can come from anywhere on the phone: a web page, another app. Only a code this app's own scanner read
  // is used without asking; any other is put to the person, with the server it names, before anything is paired.
  it('asks before pairing by a link from outside the app, naming the server', () => {
    expect(linkQuestion(HOST)).toEqual({
      line: `Pair this phone with ${HOST}?`,
      why: 'Only if you opened this from Karto Wallet, or scanned its code, just now. This phone will take payments for that server.',
      pair: 'Pair',
      no: 'Not now',
    });
  });

  it("pairs at once only by its own scanner's code, on a phone that isn't paired", () => {
    const link = { host: HOST, code: 'a'.repeat(32) };
    const paired = { host: HOST, name: 'Till 1' };
    expect(pairStep(null, { link, scanned: true }, false)).toBe('pair');
    expect(pairStep(null, { link, scanned: false }, false)).toBe('ask');
    expect(pairStep(paired, { link, scanned: true }, false)).toBe('choose');
    expect(pairStep(paired, { link, scanned: false }, false)).toBe('choose');
    // No link, or one already used or turned down: the plain page, with whatever went wrong.
    expect(pairStep(null, null, false)).toBe('plain');
    expect(pairStep(paired, null, false)).toBe('plain');
    expect(pairStep(null, { link, scanned: true }, true)).toBe('plain');
    expect(pairStep(paired, { link, scanned: false }, true)).toBe('plain');
  });

  // Found on the Pixel 8 Pro: a link that comes while Pair is already in front opens no new screen; the router
  // hands it to the one showing. So the code in hand follows the link, and isn't fixed when the screen opens.
  it('takes a link that arrives while the screen shows, over an older link or a scanned code; else the scanned code', () => {
    const a = { host: HOST, code: 'a'.repeat(32) };
    const b = { host: HOST, code: 'b'.repeat(32) };
    expect(codeInHand(null, null)).toBeNull();
    expect(codeInHand(null, a)).toEqual({ link: a, scanned: false });
    expect(codeInHand(a, null)).toEqual({ link: a, scanned: true });
    expect(codeInHand(a, b)).toEqual({ link: b, scanned: false });
  });

  // A link can arrive at any moment, from any app: a question that has just appeared, or just changed to another
  // server's, must not be answered by a tap that was on its way to whatever was there before.
  it('lets a question be answered only once it has been showing, unchanged, for a second', () => {
    expect(ANSWER_AFTER_MS).toBe(1000);
    expect(canAnswer({ key: 'l:aaa', sinceMs: 5_000 }, 'l:aaa', 5_999)).toBe(false);
    expect(canAnswer({ key: 'l:aaa', sinceMs: 5_000 }, 'l:aaa', 6_000)).toBe(true);
    // Another link took its place: the second starts again.
    expect(canAnswer({ key: 'l:aaa', sinceMs: 5_000 }, 'l:bbb', 9_000)).toBe(false);
    expect(canAnswer(null, 'l:aaa', 9_000)).toBe(false);
    // The phone's clock set back while it shows.
    expect(canAnswer({ key: 'l:aaa', sinceMs: 5_000 }, 'l:aaa', 4_000)).toBe(false);
  });

  // The wait is for the question as the person reads it: the same code under another server's name is another question.
  it('knows a code in hand by all the question shows: where it came from, its server, and the code', () => {
    const a = { host: HOST, code: 'a'.repeat(32) };
    expect(codeKey(null)).toBe('');
    expect(codeKey({ link: a, scanned: false })).toBe(`link ${HOST} ${a.code}`);
    expect(codeKey({ link: a, scanned: true })).toBe(`scan ${HOST} ${a.code}`);
    expect(codeKey({ link: { ...a, host: 'vm-1003.lnvps.cloud' }, scanned: false })).not.toBe(codeKey({ link: a, scanned: false }));
    expect(codeKey({ link: { ...a, code: 'b'.repeat(32) }, scanned: false })).not.toBe(codeKey({ link: a, scanned: false }));
    expect(codeKey({ link: a, scanned: false, answered: true })).toBe(codeKey({ link: a, scanned: false }));
  });

  // Nobody pairs a till in the middle of a sale: a link that comes then (from any app, at any moment) must not take
  // the sale's screen from under the customer. It is answered for good and the sale stays in front.
  it('turns away a link that comes while a sale is open', () => {
    const link = { host: HOST, code: 'a'.repeat(32) };
    const paired = { host: HOST, name: 'Till 1' };
    expect(pairStep(paired, { link, scanned: false }, false, true)).toBe('in-sale');
    expect(pairStep(paired, { link, scanned: false, answered: true }, false, true)).toBe('in-sale');
    expect(pairStep(paired, { link, scanned: false }, false, false)).toBe('choose');
    // With no link there is nothing to turn away.
    expect(pairStep(paired, null, false, true)).toBe('plain');
  });

  // Android hands a link over again when it remakes the app: one already answered opens the app as its icon does.
  it('leaves for the start screen on a link that was answered before, and never on a scanned code', () => {
    const link = { host: HOST, code: 'a'.repeat(32) };
    const paired = { host: HOST, name: 'Till 1' };
    expect(pairStep(null, { link, scanned: false, answered: true }, false)).toBe('stale');
    expect(pairStep(paired, { link, scanned: false, answered: true }, false)).toBe('stale');
    expect(pairStep(paired, { link, scanned: false, answered: false }, false)).toBe('choose');
    expect(pairStep(null, { link, scanned: true, answered: true }, false)).toBe('pair');
    // Once this screen has used it, the screen stays, with whatever went wrong.
    expect(pairStep(null, { link, scanned: false, answered: true }, true)).toBe('plain');
  });

  it('says a removed phone was removed', () => {
    expect(removedWords).toEqual({
      line: "This phone was removed from the shop. It can't take payments until it is paired again in Karto Wallet.", again: 'Pair again',
    });
  });
});

describe('pairWith', () => {
  it("keeps the wallet's name the shop gave with the pairing", async () => {
    const { cardd, store, deps } = setup();
    cardd.walletName = 'Pixel 9a';
    // Given back too, so the till shows it from its first screen, not only after its first read of /pos/me.
    expect(await pairWith(deps, { host: HOST, code: cardd.newCode('Till 1') })).toEqual({ ok: true, name: 'Till 1', wallet: 'Pixel 9a' });
    expect(await store.paired()).toEqual({ host: HOST, name: 'Till 1', wallet: 'Pixel 9a' });
  });

  it('makes the key if the phone has none, pairs, and keeps the host and the name the shop gave', async () => {
    const { cardd, store, deps, made } = setup();
    const code = cardd.newCode('Till 1');
    expect(await pairWith(deps, { host: HOST, code })).toEqual({ ok: true, name: 'Till 1', wallet: '' });
    expect(made()).toBe(1);
    expect(await store.paired()).toEqual({ host: HOST, name: 'Till 1', wallet: '' });
    expect(cardd.pos.get(vectors.deviceAuth.keyId)).toMatchObject({ name: 'Till 1', removed: false });
  });

  it('keeps nothing when the shop refuses, and says why', async () => {
    const { store, deps } = setup();
    expect(await pairWith(deps, { host: HOST, code: '0'.repeat(32) })).toEqual({ ok: false, text: "That code didn't work: it may have run out. Ask for a new one in Karto Wallet." });
    expect(await store.paired()).toBeNull();
  });

  // The old shop is dropped only once the new one has taken the phone: a bad code must not cost the till its shop.
  it('on a paired phone, pairs with the new shop first, and only then asks the old one to forget it', async () => {
    const { cardd, store, deps } = setup();
    await pairWith(deps, { host: HOST, code: cardd.newCode('Till 1') });
    const order: string[] = [];
    // The new shop is another server; the fake stands for both, so the old one's forget is only noted.
    const forget = async () => void order.push(`forget, paired with ${(await store.paired())?.host}`);
    cardd.pos.get(vectors.deviceAuth.keyId)!.removed = true; // the other server doesn't know this key
    const out = await pairWith({ ...deps, old: { host: HOST, forget } }, { host: 'vm-1003.lnvps.cloud', code: cardd.newCode('Front') });
    expect(out).toEqual({ ok: true, name: 'Front', wallet: '' });
    expect(order).toEqual(['forget, paired with vm-1003.lnvps.cloud']);
    expect(await store.paired()).toEqual({ host: 'vm-1003.lnvps.cloud', name: 'Front', wallet: '' });
  });

  it('keeps the old shop, untold, when the new code is refused', async () => {
    const { cardd, store, deps } = setup();
    await pairWith(deps, { host: HOST, code: cardd.newCode('Till 1') });
    let told = 0;
    const old = { host: HOST, forget: async () => void told++ };
    const refused = { ok: false, text: "That code didn't work: it may have run out. Ask for a new one in Karto Wallet." };
    expect(await pairWith({ ...deps, old }, { host: 'vm-1003.lnvps.cloud', code: '0'.repeat(32) })).toEqual(refused);
    // A bad code for its own shop too: the shop judges the code before the key.
    expect(await pairWith({ ...deps, old }, { host: HOST, code: '0'.repeat(32) })).toEqual(refused);
    expect(told).toBe(0);
    expect(await store.paired()).toEqual({ host: HOST, name: 'Till 1', wallet: '' });
    expect(cardd.pos.get(vectors.deviceAuth.keyId)!.removed).toBe(false);
  });

  // key_known comes only after the code was found good, and leaves it open: so the shop is asked to forget, and the code is used again.
  it('with a new code of its own shop, which still knows the key, has the shop forget the phone and pairs again', async () => {
    const { cardd, store, deps, client } = setup();
    await pairWith(deps, { host: HOST, code: cardd.newCode('Till 1') });
    const order: string[] = [];
    const forget = async () => {
      order.push('forget');
      await client().forget();
    };
    const out = await pairWith({ ...deps, old: { host: HOST, forget } }, { host: HOST, code: cardd.newCode('Front') });
    expect(out).toEqual({ ok: true, name: 'Front', wallet: '' });
    expect(order).toEqual(['forget']);
    expect(await store.paired()).toEqual({ host: HOST, name: 'Front', wallet: '' });
    expect(cardd.pos.get(vectors.deviceAuth.keyId)).toMatchObject({ name: 'Front', removed: false });
  });

  it("doesn't ask its own shop to forget a phone that shop has just paired again", async () => {
    const { cardd, store, deps } = setup();
    await pairWith(deps, { host: HOST, code: cardd.newCode('Till 1') });
    cardd.pos.get(vectors.deviceAuth.keyId)!.removed = true; // removed in Karto Wallet; this phone hasn't heard
    let told = 0;
    const out = await pairWith({ ...deps, old: { host: HOST, forget: async () => void told++ } }, { host: HOST, code: cardd.newCode('Front') });
    expect(out).toEqual({ ok: true, name: 'Front', wallet: '' });
    expect(told).toBe(0);
    expect(await store.paired()).toEqual({ host: HOST, name: 'Front', wallet: '' });
  });

  it("stays as it was when its own shop knows the key and can't be told to forget it", async () => {
    const { cardd, store, deps } = setup();
    await pairWith(deps, { host: HOST, code: cardd.newCode('Till 1') });
    const old = { host: HOST, forget: () => new Promise<void>(() => {}) };
    const out = await pairWith({ ...deps, old, forgetWaitMs: 30 }, { host: HOST, code: cardd.newCode('Front') });
    expect(out).toEqual({ ok: false, text: 'This phone is already a PoS phone of that shop under another name. Remove it in Karto Wallet first.' });
    expect(await store.paired()).toEqual({ host: HOST, name: 'Till 1', wallet: '' });
  });

  it("is paired with the new shop even when the old one never answers, after 5 seconds at most", async () => {
    const { cardd, store, deps } = setup();
    await pairWith(deps, { host: HOST, code: cardd.newCode('Till 1') });
    cardd.pos.get(vectors.deviceAuth.keyId)!.removed = true;
    const started = Date.now();
    const old = { host: HOST, forget: () => new Promise<void>(() => {}) };
    const out = await pairWith({ ...deps, old, forgetWaitMs: 30 }, { host: 'vm-1003.lnvps.cloud', code: cardd.newCode('Front') });
    expect(out).toEqual({ ok: true, name: 'Front', wallet: '' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await store.paired()).toEqual({ host: 'vm-1003.lnvps.cloud', name: 'Front', wallet: '' });
    const failing = { host: 'vm-1003.lnvps.cloud', forget: async () => Promise.reject(new Error('Network request failed')) };
    cardd.pos.get(vectors.deviceAuth.keyId)!.removed = true;
    expect(await pairWith({ ...deps, old: failing }, { host: HOST, code: cardd.newCode('Till 3') })).toEqual({ ok: true, name: 'Till 3', wallet: '' });
  });

  // The answer comes from whatever server the link named: nothing of it is kept unchecked.
  it("keeps nothing of an answer that isn't a shop's", async () => {
    const { store, deps } = setup();
    const answering = (body: unknown) => ({ ...deps, fetch: async () => new Response(JSON.stringify(body), { status: 201 }) });
    const link = { host: HOST, code: 'a'.repeat(32) };
    expect(await pairWith(answering({ keyId: 'ffffffffffffffff', name: 'Till 1' }), link)).toEqual({ ok: false, text: "That server didn't answer as a shop does." });
    expect(await store.paired()).toBeNull();
  });
});

describe('unpair', () => {
  it('asks the shop to forget this phone, then forgets the shop; the key stays', async () => {
    const { cardd, store, deps, client } = setup();
    await pairWith(deps, { host: HOST, code: cardd.newCode('Till 1') });
    await unpair({ store, forget: () => client().forget() });
    expect(cardd.pos.get(vectors.deviceAuth.keyId)!.removed).toBe(true);
    expect(await store.paired()).toBeNull();
  });

  it('forgets the shop even when it can\'t be told, after 5 seconds at most', async () => {
    const { cardd, store, deps } = setup();
    await pairWith(deps, { host: HOST, code: cardd.newCode('Till 1') });
    await unpair({ store, forget: () => new Promise<void>(() => {}), waitMs: 30 });
    expect(await store.paired()).toBeNull();
  });
});

// The scanner's refusal names the phone's own settings.
describe('scanRefusal', () => {
  it("names Android's settings, and offers them once Android won't ask again", () => {
    expect(scanRefusal('refused', false)).toEqual({ text: "The camera isn't allowed for this app. Allow it in Android's settings to scan the code in Karto Wallet.", settings: false });
    expect(scanRefusal('refused_for_good', false)).toEqual({ text: "The camera isn't allowed for this app. Allow it in Android's settings to scan the code in Karto Wallet.", settings: true });
  });

  it("names an iPhone's Settings, and offers them", () => {
    expect(scanRefusal('refused_for_good', true)).toEqual({ text: "The camera isn't allowed for this app. Allow it in Settings to scan the code in Karto Wallet.", settings: true });
  });
});
