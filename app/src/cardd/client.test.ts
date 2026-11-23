import { describe, expect, it } from 'vitest';
import { CarddClient, CarddError, isRevoked, noPhotoRoutes, noShopRoutes, noTransactionRoutes, revBehind, type Wallet } from './client';
import { FakeCardd, vectorDeviceKey } from '../testing/fakeCardd';
import { vectors } from '../testing/vectors';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { cardId, deriveCardKeys } from '../boltcard/cardkeys';
import { Ntag424 } from '../ntag424/card';
import { cardUrl, lnurlwFor, readSun } from '../ntag424/ndef';
import { Ntag424Sim } from '../testing/ntag424Sim';
import { withDownloadTimeout, withTimeout } from '../lightning/lightning';
import { CARDD_SCHEMA_VERSION } from '../deploy/schema';
import { sha256 } from '@noble/hashes/sha2.js';

function setup(phoneClockOffsetMs = 0) {
  let nowMs = 1_790_000_000_000;
  const cardd = new FakeCardd(() => nowMs);
  cardd.devices.set(vectors.deviceAuth.keyId, vectors.deviceAuth.publicKey);
  cardd.meta.set('bundle.sha256', 'ab12');
  const client = new CarddClient({ fetch: cardd.http.fetch, host: 'vm-1001.lnvps.cloud', key: vectorDeviceKey(), now: () => nowMs + phoneClockOffsetMs });
  return { cardd, client, tick: (ms: number) => (nowMs += ms) };
}

describe('CarddClient', () => {
  it('reads the server info with a signed request', async () => {
    const { cardd, client } = setup();
    expect(await client.server()).toEqual({ version: 'test', bundle: 'ab12', schema: CARDD_SCHEMA_VERSION });
    expect(cardd.http.requests[0].url).toBe('https://vm-1001.lnvps.cloud/api/v1/server');
    expect(cardd.http.requests[0].headers.authorization).toMatch(/^Device b18b86ce1389e46d\.\d+\.[0-9a-f]+$/);
  });

  it('reports a key cardd does not know as a 401 CarddError', async () => {
    const { cardd, client } = setup();
    cardd.devices.clear();
    const e = await client.server().catch((x) => x);
    expect(e).toBeInstanceOf(CarddError);
    expect(e.status).toBe(401);
  });

  // cardd allows ±60 s; phone clocks drift. Like the LNVPS client, sign again on the server's clock once.
  it('signs again on the server clock when the phone clock is off', async () => {
    const { cardd, client } = setup(-5 * 60_000);
    expect(await client.server()).toMatchObject({ bundle: 'ab12' });
    expect(cardd.http.requests).toHaveLength(2);
    expect(await client.server()).toMatchObject({ bundle: 'ab12' });
    expect(cardd.http.requests).toHaveLength(3);
  });
});

const ISSUER = hexToBytes(vectors.phrase.issuerKey);
const UID = hexToBytes('04a39493cc8680');
const ID = bytesToHex(cardId(ISSUER, UID));

/** A card programmed with this issuer's keys at `version`: each call is a tap, giving that tap's p and c. */
function programmed(version: number) {
  const k = deriveCardKeys(ISSUER, UID, version);
  const sim = Ntag424Sim.programmed({ keys: [k.k0, k.k1, k.k2, k.k3, k.k4], versions: [1, 1, 1, 1, 1], url: cardUrl(lnurlwFor('vm-1.lnvps.cloud')), uid: UID });
  return async () => {
    const card = new Ntag424(sim.transceive);
    return readSun(await card.readNdefFile(), await card.getFileSettings())!;
  };
}

describe('CarddClient cards', () => {
  it('reserves with a name, confirms, lists, checks, renames, wipes and reserves again at version 1', async () => {
    const { cardd, client } = setup();
    cardd.issuer = ISSUER;
    const tap = programmed(0);
    const r = await client.reserveCard(ID, 'Daily');
    expect(r).toMatchObject({ id: ID, version: 0, state: 'programming', name: 'Daily', counter: -1, host: 'vm-1.lnvps.cloud', lnurlw: 'lnurlw://vm-1.lnvps.cloud/ln' });
    expect(JSON.parse(cardd.http.requests.at(-1)!.body!)).toEqual({ id: ID, name: 'Daily' });
    expect(await client.confirmCard(ID, await tap())).toMatchObject({ state: 'active' });
    expect((await client.cards()).map((c) => [c.id, c.state])).toEqual([[ID, 'active']]);
    expect(await client.checkCard(await tap())).toMatchObject({ id: ID, state: 'active' });
    expect(await client.renameCard(ID, 'Kids')).toMatchObject({ name: 'Kids' });
    expect(await client.wipeCard(ID)).toMatchObject({ state: 'wiping' });
    expect(cardd.http.requests.at(-1)!.body).toBeUndefined();
    expect(await client.wipedCard(ID)).toMatchObject({ state: 'reset', version: 0 });
    expect(await client.reserveCard(ID)).toMatchObject({ version: 1, name: 'Kids' });
    expect(JSON.parse(cardd.http.requests.at(-1)!.body!)).toEqual({ id: ID });
  });

  it('passes cardd\'s refusals on with their codes', async () => {
    const { cardd, client } = setup();
    cardd.issuer = ISSUER;
    await client.reserveCard(ID);
    const sun = await programmed(0)();
    await client.confirmCard(ID, sun);
    await expect(client.checkCard(sun)).rejects.toMatchObject({ status: 409, code: 'replayed' });
    await expect(client.checkCard(await programmed(1)())).rejects.toMatchObject({ status: 422, code: 'bad_mac' });
    await expect(client.checkCard({ p: 'EF963FF7828658A599F3041510671E88', c: '94EED9EE65337086' })).rejects.toMatchObject({ code: 'not_ours' });
    await expect(client.wipedCard(ID)).rejects.toMatchObject({ status: 409, code: 'conflict' });
    await expect(client.wipeCard('f'.repeat(32))).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(client.renameCard(ID, 'x'.repeat(41))).rejects.toMatchObject({ status: 400, code: 'bad_name' });
  });
});

// After a rebuild: each card's host, and a card found again by its tap (phrase only).
describe('CarddClient adopt and host', () => {
  it('adopts a card it does not know from a tap at its version, once', async () => {
    const { cardd, client } = setup();
    cardd.issuer = ISSUER;
    cardd.host = 'vm-1004.lnvps.cloud';
    const tap = programmed(2);
    const sun = await tap();
    await expect(client.adoptCard({ version: 1, name: 'Daily', ...sun })).rejects.toMatchObject({ status: 422, code: 'bad_mac' });
    await expect(client.adoptCard({ version: 2, name: 'x'.repeat(41), ...sun })).rejects.toMatchObject({ status: 400, code: 'bad_name' });
    await expect(client.adoptCard({ version: 2, name: '', p: 'EF963FF7828658A599F3041510671E88', c: '94EED9EE65337086' }))
      .rejects.toMatchObject({ status: 422, code: 'not_ours' });
    const card = await client.adoptCard({ version: 2, name: ' Daily ', ...sun });
    // No host yet: its URL isn't rewritten, so it is listed for re-pointing until the re-point sets it.
    expect(card).toMatchObject({ id: ID, version: 2, state: 'active', name: 'Daily', host: '' });
    expect(card.counter).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(cardd.http.requests.at(-1)!.body!)).toEqual({ version: 2, name: ' Daily ', p: sun.p, c: sun.c });
    expect(cardd.http.requests.at(-1)!.url).toBe('https://vm-1001.lnvps.cloud/api/v1/cards/adopt');
    await expect(client.adoptCard({ version: 2, name: '', ...(await tap()) })).rejects.toMatchObject({ status: 409, code: 'conflict' });
    // Adopted at the tap's counter: that tap can't be replayed.
    await expect(client.checkCard(sun)).rejects.toMatchObject({ code: 'replayed' });
  });

  it("sets a card's host in any state but reset", async () => {
    const { cardd, client } = setup();
    cardd.issuer = ISSUER;
    await client.reserveCard(ID);
    expect(await client.setCardHost(ID, 'vm-1004.lnvps.cloud')).toMatchObject({ id: ID, state: 'programming', host: 'vm-1004.lnvps.cloud' });
    expect(cardd.http.requests.at(-1)).toMatchObject({ method: 'PUT', url: `https://vm-1001.lnvps.cloud/api/v1/cards/${ID}/host` });
    expect(JSON.parse(cardd.http.requests.at(-1)!.body!)).toEqual({ host: 'vm-1004.lnvps.cloud' });
    expect((await client.cards())[0].host).toBe('vm-1004.lnvps.cloud');
    await expect(client.setCardHost(ID, 'VM-1.lnvps.cloud')).rejects.toMatchObject({ status: 400, code: 'bad_host' });
    await expect(client.setCardHost(ID, '')).rejects.toMatchObject({ status: 400, code: 'bad_host' });
    await expect(client.setCardHost('f'.repeat(32), 'vm-1.lnvps.cloud')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await client.wipeCard(ID);
    await client.wipedCard(ID);
    await expect(client.setCardHost(ID, 'vm-1.lnvps.cloud')).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });
});

describe('CarddClient wallet', () => {
  it('reads balances, top-up addresses and the first channel\'s fee', async () => {
    const { cardd, client } = setup();
    cardd.issuer = ISSUER;
    await client.reserveCard(ID, 'Daily');
    await client.confirmCard(ID, await programmed(0)());
    cardd.balances.set(ID, 5_012_345);
    cardd.balances.set('pool', 1_000);
    const w = await client.wallet();
    expect(w.cards).toEqual([expect.objectContaining({ id: ID, name: 'Daily', state: 'active', balanceMsat: 5_012_345, address: `c${ID.slice(0, 10)}@vm-1.lnvps.cloud` })]);
    // sendableMsat: the most a Send out can take (cardd's); 1 sat in Pool can't pay a fee.
    expect(w.pool).toEqual({ balanceMsat: 1_000, heldMsat: 0, address: 'pool@vm-1.lnvps.cloud', sendableMsat: 0 });
    expect(w.liquidity).toEqual({ channel: false, usable: false, inboundSat: 0, feeCreditSat: 0, firstChannelFeeSat: 21_411 });
    expect(w.paused).toBe(false);
  });

  it('sets the books to the server\'s balance when spending is paused', async () => {
    const { cardd, client } = setup();
    cardd.pausedReason = 'the books say 1000 msat, phoenixd holds 0 sat';
    expect(await client.wallet()).toMatchObject({ paused: true, pausedReason: cardd.pausedReason });
    expect(await client.reconcileBooks()).toEqual({ bookedMsat: 0 });
    expect((await client.wallet()).paused).toBe(false);
  });

  // After a restore, cardd sets the books itself once the channel is back;
  // only when none came back does the person set them, and the usual Set the books waits meanwhile.
  it("carries a restore's state, and sets the books by hand only when no channel came back", async () => {
    const { cardd, client, tick } = setup();
    expect((await client.wallet()).restore).toBeNull();
    cardd.restore = { state: 'pending', from: '00112233445566778899aabbccddeeff-7-1790000000' };
    expect(await client.wallet()).toMatchObject({ paused: true, restore: { state: 'pending', from: '00112233445566778899aabbccddeeff-7-1790000000' } });
    await expect(client.reconcileBooks()).rejects.toMatchObject({ status: 409, code: 'restore_pending' });
    await expect(client.restoreBooks()).rejects.toMatchObject({ status: 409, code: 'not_no_channel' });
    cardd.restore = { state: 'no_channel', from: 'phrase' };
    cardd.restoreDiffMsat = -5_000_000;
    await expect(client.reconcileBooks()).rejects.toMatchObject({ code: 'restore_pending' });
    // A channel that isn't up yet: cardd sets the books itself once it is.
    cardd.channel = true;
    cardd.channelUp = false;
    expect((await client.wallet()).liquidity).toMatchObject({ channel: true, usable: false });
    await expect(client.restoreBooks()).rejects.toMatchObject({ status: 409, code: 'channel_not_up' });
    cardd.channel = false;
    tick(60_000);
    expect(await client.restoreBooks()).toEqual({ bookedMsat: -5_000_000 });
    expect(cardd.http.requests.at(-1)).toMatchObject({ method: 'POST', url: 'https://vm-1001.lnvps.cloud/api/v1/ledger/restore-books' });
    const w = await client.wallet();
    expect(w.restore).toEqual({ state: 'done', from: 'phrase', reconciledMsat: -5_000_000, reconciledAt: 1_790_000_060 });
    expect(w).toMatchObject({ paused: false, pool: { balanceMsat: -5_000_000 } });
    await expect(client.restoreBooks()).rejects.toMatchObject({ code: 'not_no_channel' });
    expect(await client.reconcileBooks()).toEqual({ bookedMsat: 0 });
  });

  it("reads an account's history, newest first", async () => {
    const { cardd, client } = setup();
    cardd.history.set(ID, [{ id: 2, kind: 'spend', note: 'paid ab', amountMsat: -1_010_000, feeMsat: 10_000, created: 1_790_000_100 }]);
    expect(await client.history(ID)).toEqual([{ id: 2, kind: 'spend', note: 'paid ab', amountMsat: -1_010_000, feeMsat: 10_000, created: 1_790_000_100 }]);
    expect(await client.history('pool')).toEqual([]);
  });
});

describe('CarddClient money', () => {
  const card = (cardd: FakeCardd) =>
    cardd.cards.set(ID, { id: ID, version: 1, state: 'active', counter: 0, name: 'Daily', created: 0, updated: 0 });

  it('moves money once per request id, and refuses the id with another body', async () => {
    const { cardd, client } = setup();
    card(cardd);
    cardd.balances.set('pool', 5_000_000);
    const req = { id: 'm1', from: 'pool', to: ID, amountMsat: 2_000_000 };
    expect(await client.move(req)).toEqual({ status: 'moved' });
    expect(await client.move(req)).toEqual({ status: 'moved' });
    expect([cardd.balances.get('pool'), cardd.balances.get(ID)]).toEqual([3_000_000, 2_000_000]);
    await expect(client.move({ ...req, amountMsat: 1 })).rejects.toMatchObject({ status: 409, code: 'request_mismatch' });
    await expect(client.move({ id: 'm2', from: 'pool', to: 'pool', amountMsat: 1000 })).rejects.toMatchObject({ status: 400 });
  });

  it('sends, answering with the payment hash and the fee, on its slower fetch', async () => {
    const { cardd } = setup();
    let slow = 0;
    const client = new CarddClient({
      fetch: cardd.http.fetch, slowFetch: (u, i) => (slow++, cardd.http.fetch(u, i)),
      host: 'vm-1001.lnvps.cloud', key: vectorDeviceKey(), now: () => 1_790_000_000_000,
    });
    cardd.balances.set('pool', 5_000_000);
    cardd.sendOutcome = { status: 'sent', feeMsat: 4_000 };
    const a = await client.send({ id: 's1', to: 'lnbc10u1fake', amountMsat: 1_000_000 });
    expect(a).toEqual({ status: 'sent', paymentHash: expect.stringMatching(/^[0-9a-f]{64}$/), amountMsat: 1_000_000, feeMsat: 4_000 });
    expect(slow).toBe(1);
    expect(cardd.balances.get('pool')).toBe(3_996_000);
    expect(await client.history('pool')).toEqual([
      { id: expect.any(Number), kind: 'send', note: `paid ${a.paymentHash}`, amountMsat: -1_004_000, feeMsat: 4_000, created: expect.any(Number) },
    ]);
  });

  it('freezes, unfreezes and sets limits', async () => {
    const { cardd, client } = setup();
    card(cardd);
    expect((await client.freezeCard(ID)).state).toBe('frozen');
    expect((await client.unfreezeCard(ID)).state).toBe('active');
    expect(await client.setLimits(ID, { perTapSat: 5_000, dailySat: 40_000 })).toMatchObject({ perTapSat: 5_000, dailySat: 40_000 });
    expect((await client.wallet()).cards[0]).toMatchObject({ perTapSat: 5_000, dailySat: 40_000 });
    await expect(client.setLimits(ID, { perTapSat: 50_000, dailySat: 40_000 })).rejects.toMatchObject({ status: 400, code: 'bad_limits' });
  });

  it('reads history a page at a time, signing the query too', async () => {
    const { cardd, client } = setup();
    const tx = (id: number) => ({ id, kind: 'topup', note: '', amountMsat: 1000, feeMsat: 0, created: id });
    cardd.history.set('pool', [tx(3), tx(2), tx(1)]);
    expect(await client.history('pool', { before: 3, limit: 1 })).toEqual([tx(2)]);
    expect(cardd.http.requests.at(-1)!.url).toBe('https://vm-1001.lnvps.cloud/api/v1/accounts/pool/history?before=3&limit=1');
  });

  it('asks for history with a wait and the transaction it waits past: the server may hold its answer until there is a newer one', async () => {
    const { cardd, client } = setup();
    const tx = (id: number) => ({ id, kind: 'topup', note: '', amountMsat: 1000, feeMsat: 0, created: id });
    cardd.history.set('pool', [tx(3), tx(2), tx(1)]);
    expect(await client.history('pool', { limit: 5, after: 2, wait: 8 })).toEqual([tx(3), tx(2), tx(1)]);
    expect(cardd.http.requests.at(-1)!.url).toBe('https://vm-1001.lnvps.cloud/api/v1/accounts/pool/history?limit=5&after=2&wait=8');
    // With no transaction yet the wait is past none; without a wait, after is not sent.
    await client.history('pool', { wait: 8 });
    expect(cardd.http.requests.at(-1)!.url).toBe('https://vm-1001.lnvps.cloud/api/v1/accounts/pool/history?after=0&wait=8');
    await client.history('pool', { after: 2 });
    expect(cardd.http.requests.at(-1)!.url).toBe('https://vm-1001.lnvps.cloud/api/v1/accounts/pool/history');
  });
});

describe('CarddClient hosting', () => {
  // setup's clock is 1_790_000_000 s: ten days on is 1_790_864_000.
  it('syncs the estimate from LNVPS and reads it back', async () => {
    const { cardd, client } = setup();
    cardd.balances.set('hosting', 13_000_000);
    expect(await client.hosting()).toMatchObject({ synced: false, willRenew: false });
    const s = await client.syncHosting({ expires: 1_790_864_000, satPerDay: 221.395, vatOk: true });
    expect(s).toMatchObject({ synced: true, expires: 1_790_864_000, msatPerDay: 221_395, vatOk: true, daysLeft: 10, willRenew: true, problem: '' });
    expect(s.fundingDays).toBeCloseTo(13_000_000 / 221_395, 9);
    expect(cardd.http.requests.at(-1)).toMatchObject({ method: 'PUT', url: 'https://vm-1001.lnvps.cloud/api/v1/hosting' });
    expect(await client.hosting()).toEqual(s);
    await expect(client.syncHosting({ expires: 1_790_864_000, satPerDay: 5, vatOk: true })).rejects.toMatchObject({ status: 400, code: 'bad_sync' });
  });

  it('renews now once per request id, on its slower fetch', async () => {
    const { cardd } = setup();
    let slow = 0;
    const client = new CarddClient({
      fetch: cardd.http.fetch, slowFetch: (u, i) => (slow++, cardd.http.fetch(u, i)),
      host: 'vm-1001.lnvps.cloud', key: vectorDeviceKey(), now: () => 1_790_000_000_000,
    });
    cardd.balances.set('hosting', 13_000_000);
    await expect(client.renewNow({ id: 'r0', days: 1 })).rejects.toMatchObject({ status: 409, code: 'not_synced' });
    await client.syncHosting({ expires: 1_790_864_000, satPerDay: 221.395, vatOk: true });
    await expect(client.renewNow({ id: 'r1', days: 366 })).rejects.toMatchObject({ status: 400, code: 'bad_days' });
    const a = await client.renewNow({ id: 'r2', days: 1 });
    expect(a).toEqual({ status: 'sent', paymentHash: expect.stringMatching(/^[0-9a-f]{64}$/), amountMsat: 222_000, feeMsat: 0 });
    expect(await client.renewNow({ id: 'r2', days: 1 })).toEqual(a);
    expect(slow).toBe(4);
    expect(cardd.balances.get('hosting')).toBe(12_778_000);
    expect((await client.hosting()).expires).toBe(1_790_864_000 + 86_400);
    expect((await client.history('hosting'))[0]).toMatchObject({ kind: 'renew', note: `paid ${a.paymentHash}`, amountMsat: -222_000 });
  });
});

describe('CarddClient backups', () => {
  it('reads the backup status, checking in, and downloads a snapshot as bytes', async () => {
    const { cardd, client } = setup();
    expect(await client.backups()).toMatchObject({ latest: null, lastCheckIn: 0, problem: '' }); // the check-in before: none
    const file = new Uint8Array([1, 2, 3, 250]);
    cardd.addSnapshot(file);
    const s = await client.backups();
    expect(s).toMatchObject({ installId: cardd.backupInstallId, recipient: cardd.backupRecipient, lastCheckIn: 1_790_000_000, latest: { version: 1, size: 4, created: 1_790_000_000 } });
    expect(s.latest!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await client.backupFile(1)).toEqual(file);
    expect((await client.backups()).lastDownload).toBe(1_790_000_000);
    await expect(client.backupFile(2)).rejects.toMatchObject({ status: 404, code: 'no_snapshot' });
  });

  // A server that lies about the size can't make the phone read gigabytes:
  // the length is checked before the body is read.
  it('refuses a snapshot over the limit, or of no stated length, before reading it', async () => {
    const { cardd, client } = setup();
    cardd.addSnapshot(new Uint8Array(100));
    await expect(client.backupFile(1, 99)).rejects.toMatchObject({ code: 'too_big' });
    expect((await client.backupFile(1, 100)).length).toBe(100);
    cardd.backupNoLength = true;
    await expect(client.backupFile(1, 100)).rejects.toMatchObject({ code: 'too_big' });
  });

  // The stated length is only a claim: reading stops once the body passes the limit.
  it('stops reading a body that runs past the limit, whatever length was stated', async () => {
    const { cardd } = setup();
    let pulled = 0;
    const endless = (u: string, i?: RequestInit) =>
      cardd.http.fetch(u, i).then((r) =>
        r.status !== 200
          ? r
          : new Response(new ReadableStream({ pull: (c) => (pulled++, c.enqueue(new Uint8Array(1000))) }), { status: 200, headers: { 'content-length': '50' } }),
      );
    const client = new CarddClient({ fetch: endless, host: 'vm-1001.lnvps.cloud', key: vectorDeviceKey(), now: () => 1_790_000_000_000 });
    cardd.addSnapshot(new Uint8Array(50));
    await expect(client.backupFile(1, 5000)).rejects.toMatchObject({ code: 'too_big' });
    expect(pulled).toBeLessThan(10);
  });

  // A fetch without streams reads the whole body first, so the cap can only bound what is kept.
  it('keeps nothing over the limit from a fetch without a body stream', async () => {
    const { cardd } = setup();
    cardd.addSnapshot(new Uint8Array(50));
    const noStream = (size: number) => (u: string, i?: RequestInit) =>
      cardd.http.fetch(u, i).then((r) =>
        r.status !== 200
          ? r
          : ({ ok: true, status: 200, headers: new Headers({ 'content-length': '50' }), body: null, arrayBuffer: async () => new Uint8Array(size).buffer } as unknown as Response),
      );
    const clientOf = (size: number) => new CarddClient({ fetch: noStream(size), host: 'vm-1001.lnvps.cloud', key: vectorDeviceKey(), now: () => 1_790_000_000_000 });
    await expect(clientOf(6000).backupFile(1, 5000)).rejects.toMatchObject({ code: 'too_big' });
    expect((await clientOf(50).backupFile(1, 5000)).length).toBe(50);
  });

  // withTimeout reads res.text(), which UTF-8-decodes a binary body: 4096 random bytes came back as ~7500.
  describe('snapshot downloads through the app\'s timeouts', () => {
    const random = () => crypto.getRandomValues(new Uint8Array(4096));
    const fetchOf = (cardd: FakeCardd, wrap: typeof withTimeout) => wrap((u, i) => cardd.http.fetch(u, i), 300_000);
    const clientWith = (cardd: FakeCardd, o: { fetch?: any; download?: any }) =>
      new CarddClient({ fetch: cardd.http.fetch, host: 'vm-1001.lnvps.cloud', key: vectorDeviceKey(), now: () => 1_790_000_000_000, ...o });

    it('returns the bytes untouched through withDownloadTimeout', async () => {
      const { cardd } = setup();
      const file = random();
      cardd.addSnapshot(file);
      const got = await clientWith(cardd, { download: fetchOf(cardd, withDownloadTimeout) }).backupFile(1, 10_000);
      expect(bytesToHex(sha256(got))).toBe(bytesToHex(sha256(file)));
    });

    it('is the text-buffering withTimeout that mangles them (pins the bug)', async () => {
      const { cardd } = setup();
      const file = random();
      cardd.addSnapshot(file);
      const got = await clientWith(cardd, { download: fetchOf(cardd, withTimeout) }).backupFile(1, 10_000);
      expect(got.length).not.toBe(file.length);
    });

    it('still stops an endless streamed body at the cap', async () => {
      const { cardd } = setup();
      cardd.addSnapshot(new Uint8Array(50));
      let pulled = 0;
      const endless = (u: string, i?: RequestInit) =>
        cardd.http.fetch(u, i).then((r) =>
          r.status !== 200
            ? r
            : new Response(new ReadableStream({ pull: (c) => (pulled++, c.enqueue(new Uint8Array(1000))) }), { status: 200, headers: { 'content-length': '50' } }),
        );
      const client = clientWith(cardd, { download: withDownloadTimeout(endless, 300_000) });
      await expect(client.backupFile(1, 5000)).rejects.toMatchObject({ code: 'too_big' });
      expect(pulled).toBeLessThan(10);
    });
  });

  // cardd answers 401 "deviceauth: unknown or revoked device" once another phone restored the server.
  it('knows a revoked phone from its 401, and not a clock that is off', async () => {
    const { cardd, client } = setup();
    cardd.revoked.add(vectors.deviceAuth.keyId);
    const e = await client.backups().catch((x) => x);
    expect(e).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(isRevoked(e)).toBe(true);
    expect(isRevoked(new CarddError(401, 'unauthorized', 'deviceauth: timestamp out of range'))).toBe(false);
    expect(isRevoked(new Error('fetch failed'))).toBe(false);
  });
});

// The JPEG travels as base64 in the signed JSON.
describe('CarddClient card photos', () => {
  const JPEG = '/9j/4AAQSkZJRgABAQ=='; // base64 of a JPEG's first bytes: the fake cardd doesn't decode

  it('sets, lists, reads and removes a card\'s photo', async () => {
    const { cardd, client } = setup();
    await client.reserveCard(ID, 'Daily');
    expect((await client.cards())[0].photo).toBe('');
    const { photo } = await client.setCardPhoto(ID, JPEG);
    expect(photo).toMatch(/^[0-9a-f]{16}$/);
    expect(cardd.http.requests.at(-1)).toMatchObject({ method: 'PUT', url: `https://vm-1001.lnvps.cloud/api/v1/cards/${ID}/photo` });
    expect(JSON.parse(cardd.http.requests.at(-1)!.body!)).toEqual({ jpeg: JPEG });
    expect((await client.cards())[0].photo).toBe(photo);
    expect(await client.cardPhoto(ID)).toEqual({ jpeg: JPEG, photo });
    await client.removeCardPhoto(ID);
    expect(cardd.http.requests.at(-1)).toMatchObject({ method: 'DELETE' });
    await expect(client.cardPhoto(ID)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect((await client.cards())[0].photo).toBe('');
  });

  // An older cardd has no photo routes: Go's router answers a plain-text 404,
  // which the client reads as a bad_response; cardd's own 404 is JSON.
  it('tells an older server from a card cardd doesn\'t know', async () => {
    const { cardd, client } = setup();
    const unknown = await client.setCardPhoto('f'.repeat(32), JPEG).catch((x) => x);
    expect(unknown).toMatchObject({ status: 404, code: 'not_found' });
    expect(noPhotoRoutes(unknown)).toBe(false);
    cardd.photoRoutes = false;
    await client.reserveCard(ID);
    const older = await client.setCardPhoto(ID, JPEG).catch((x) => x);
    expect(older).toMatchObject({ status: 404, code: 'bad_response' });
    expect(noPhotoRoutes(older)).toBe(true);
    expect(noPhotoRoutes(new CarddError(502, 'bad_response', 'Caddy'))).toBe(false);
    expect(noPhotoRoutes(new Error('fetch failed'))).toBe(false);
  });

  it('refuses a new photo on a wiped card, as a rename', async () => {
    const { client } = setup();
    await client.reserveCard(ID);
    await client.wipeCard(ID);
    await client.wipedCard(ID);
    await expect(client.setCardPhoto(ID, JPEG)).rejects.toMatchObject({ status: 409, code: 'conflict' });
    await expect(client.removeCardPhoto(ID)).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });
});

// The shop: what cardd answers, as the fake has it.
describe('CarddClient shop', () => {
  it('reads Shop in the wallet, and nothing of it from a server not yet updated', async () => {
    const { cardd, client } = setup();
    cardd.balances.set('shop', 12_400_000);
    cardd.pair(cardd.newCode('Till 1'), 'aaaaaaaaaaaaaaaa');
    expect((await client.wallet()).shop).toEqual({ balanceMsat: 12_400_000, heldMsat: 0, address: '', phones: 1, sales: 0 });
    cardd.shopRoutes = false;
    expect((await client.wallet()).shop).toBeUndefined();
    await expect(client.shopPhones()).rejects.toSatisfy(noShopRoutes);
  });

  it('asks for a pairing code by name, and drops it', async () => {
    const { cardd, client } = setup();
    const a = await client.shopCode(' Till 1 ');
    expect(a.code).toMatch(/^[0-9a-f]{32}$/);
    expect(a.expires).toBe(1_790_000_000 + 600);
    expect(cardd.posCode).toMatchObject({ code: a.code, name: 'Till 1' });
    // A second code replaces the first.
    const b = await client.shopCode('Till 1');
    expect(cardd.posCode?.code).toBe(b.code);
    expect(b.code).not.toBe(a.code);
    await client.dropShopCode();
    expect(cardd.posCode).toBeNull();
    await client.dropShopCode(); // none open is fine
    await expect(client.shopCode('')).rejects.toMatchObject({ status: 400, code: 'bad_name' });
    await expect(client.shopCode('x'.repeat(25))).rejects.toMatchObject({ status: 400, code: 'bad_name' });
    cardd.pair(cardd.newCode('Till 1'), 'aaaaaaaaaaaaaaaa');
    await expect(client.shopCode('Till 1')).rejects.toMatchObject({ status: 409, code: 'name_taken' });
  });

  it('lists the PoS phones, renames and removes one', async () => {
    const { cardd, client, tick } = setup();
    expect(await client.shopPhones()).toEqual({ phones: [] });
    cardd.pair(cardd.newCode('Till 1'), 'aaaaaaaaaaaaaaaa');
    tick(60_000);
    cardd.pair(cardd.newCode('Till 2'), 'bbbbbbbbbbbbbbbb');
    cardd.sell('bbbbbbbbbbbbbbbb', 2_500_000, 'card');
    cardd.restoredAt = 1_790_000_030;
    expect(await client.shopPhones()).toEqual({
      phones: [
        { keyId: 'aaaaaaaaaaaaaaaa', name: 'Till 1', created: 1_790_000_000, sales: 0 },
        { keyId: 'bbbbbbbbbbbbbbbb', name: 'Till 2', created: 1_790_000_060, sales: 1, lastSale: 1_790_000_060 },
      ],
      restored: 1_790_000_030,
    });
    expect(await client.renameShopPhone('aaaaaaaaaaaaaaaa', ' Front ')).toEqual({ keyId: 'aaaaaaaaaaaaaaaa', name: 'Front' });
    await expect(client.renameShopPhone('aaaaaaaaaaaaaaaa', 'Till 2')).rejects.toMatchObject({ status: 409, code: 'name_taken' });
    await expect(client.renameShopPhone('ffffffffffffffff', 'X')).rejects.toMatchObject({ status: 404 });
    await client.removeShopPhone('bbbbbbbbbbbbbbbb');
    await expect(client.removeShopPhone('bbbbbbbbbbbbbbbb')).rejects.toMatchObject({ status: 404 });
    expect((await client.shopPhones()).phones.map((p) => p.name)).toEqual(['Front']);
    expect((await client.wallet()).shop).toMatchObject({ phones: 1, sales: 1 });
  });

  it('answers of a phone as cardd does: its name as it is now on its sales, its first pairing kept, its key once', async () => {
    const { cardd, client, tick } = setup();
    cardd.pair(cardd.newCode('Till 1'), 'aaaaaaaaaaaaaaaa');
    const sold = cardd.sell('aaaaaaaaaaaaaaaa', 1_000_000, 'qr');
    await client.renameShopPhone('aaaaaaaaaaaaaaaa', 'Front');
    // A sale carries no name of its own: the list and the history read the phone's.
    expect((await client.sales())[0].device).toEqual({ keyId: 'aaaaaaaaaaaaaaaa', name: 'Front' });
    expect((await client.history('shop'))[0].sale).toEqual({ id: sold, method: 'qr', device: 'Front', priceMsat: 1_000_000, paidAt: expect.any(Number), refund: null });
    // An active phone's key pairs no second time, and the code stays open.
    const code = cardd.newCode('Till 2');
    expect(() => cardd.pair(code, 'aaaaaaaaaaaaaaaa')).toThrow(expect.objectContaining({ status: 409, code: 'key_known' }));
    expect(cardd.posCode?.code).toBe(code);
    // A removed phone paired again is the same phone under the new name, added when it first was.
    await client.removeShopPhone('aaaaaaaaaaaaaaaa');
    tick(60_000);
    cardd.pair(code, 'aaaaaaaaaaaaaaaa');
    expect((await client.shopPhones()).phones).toEqual([{ keyId: 'aaaaaaaaaaaaaaaa', name: 'Till 2', created: 1_790_000_000, sales: 1, lastSale: 1_790_000_000 }]);
    // The name is judged before the phone is looked for.
    await expect(client.renameShopPhone('ffffffffffffffff', 'Till 2')).rejects.toMatchObject({ status: 409, code: 'name_taken' });
    await expect(client.renameShopPhone('ffffffffffffffff', '')).rejects.toMatchObject({ status: 400, code: 'bad_name' });
  });

  it("reads the shop's paid sales a page at a time, and its days", async () => {
    const { cardd, client, tick } = setup();
    cardd.pair(cardd.newCode('Till 1'), 'aaaaaaaaaaaaaaaa');
    const first = cardd.sell('aaaaaaaaaaaaaaaa', 1_000_000, 'qr');
    tick(86_400_000);
    const second = cardd.sell('aaaaaaaaaaaaaaaa', 2_500_000, 'card', 2_000_000); // 500 sat went toward more room
    const third = cardd.sell('aaaaaaaaaaaaaaaa', 4_000_000, 'card');
    const all = await client.sales();
    expect(all.map((s) => s.id)).toEqual([third, second, first]);
    expect(all[1]).toEqual({
      id: second, amountMsat: 2_500_000, state: 'paid', method: 'card', device: { keyId: 'aaaaaaaaaaaaaaaa', name: 'Till 1' },
      created: 1_790_086_400, expires: 1_790_087_000, paidAt: 1_790_086_400, txId: expect.any(Number), receivedMsat: 2_000_000,
    });
    const page = await client.sales({ limit: 2 });
    expect(page.map((s) => s.id)).toEqual([third, second]);
    // The next page is asked before the last one's place in the ledger.
    expect(page[1].txId).toBe(cardd.history.get('shop')!.find((t) => t.sale?.id === second)!.id);
    expect((await client.sales({ before: page[1].txId, limit: 2 })).map((s) => s.id)).toEqual([first]);
    // 1,790,000,000 is 14:13:20 UTC on its day; an hour east the days start at 23:00 UTC.
    expect(await client.salesDays(60)).toEqual([
      { day: 1_790_031_600, count: 2, totalMsat: 6_500_000 },
      { day: 1_789_945_200, count: 1, totalMsat: 1_000_000 },
    ]);
    expect(await client.salesDays(60, 1)).toEqual([{ day: 1_790_031_600, count: 2, totalMsat: 6_500_000 }]);
    await expect(client.salesDays(900)).rejects.toMatchObject({ status: 400 });
  });

  it("names a move's other account, and a sale's facts, in the history", async () => {
    const { cardd, client } = setup();
    cardd.pair(cardd.newCode('Till 1'), 'aaaaaaaaaaaaaaaa');
    const sold = cardd.sell('aaaaaaaaaaaaaaaa', 2_500_000, 'card', 2_000_000);
    await client.move({ id: 'm1', from: 'shop', to: 'pool', amountMsat: 1_000_000 });
    expect(await client.history('shop')).toEqual([
      { id: expect.any(Number), kind: 'move', note: 'moved by the phone', amountMsat: -1_000_000, feeMsat: 0, created: 1_790_000_000, other: 'pool' },
      { id: expect.any(Number), kind: 'sale', note: 'received 2500 sat', amountMsat: 2_000_000, feeMsat: 0, created: 1_790_000_000,
        sale: { id: sold, method: 'card', device: 'Till 1', priceMsat: 2_500_000, paidAt: expect.any(Number), refund: null } },
    ]);
    expect((await client.history('pool'))[0]).toMatchObject({ kind: 'move', amountMsat: 1_000_000, other: 'shop' });
    // Nothing moves into Shop.
    await expect(client.move({ id: 'm2', from: 'pool', to: 'shop', amountMsat: 1_000 })).rejects.toMatchObject({ status: 409, code: 'cannot_receive' });
  });
});

describe('CarddClient held reads of the wallet', () => {
  it('asks for the wallet with the rev it was given and a wait: the server holds its answer until the books change', async () => {
    const { cardd, client } = setup();
    const first = await client.wallet();
    expect(first.rev).toMatch(/^[0-9a-f]{8}-[0-9]+$/);
    expect(cardd.http.requests.at(-1)!.url).toBe('https://vm-1001.lnvps.cloud/api/v1/wallet');
    let answer: Wallet | null = null;
    const asked = client.wallet({ since: first.rev!, wait: 5 }).then((w) => void (answer = w));
    await new Promise((done) => setTimeout(done, 5));
    expect(cardd.http.requests.at(-1)!.url).toBe(`https://vm-1001.lnvps.cloud/api/v1/wallet?since=${first.rev}&wait=5`);
    expect(answer).toBeNull();
    cardd.topUp('pool', 3_000_000);
    await asked;
    expect(answer!.pool.balanceMsat).toBe(3_000_000);
    expect(answer!.rev).not.toBe(first.rev);
    // A rev from before the last change is answered at once.
    expect((await client.wallet({ since: first.rev!, wait: 5 })).rev).toBe(answer!.rev);
  });

  it('is answered as it then reads when the wait is over with nothing new', async () => {
    const { cardd, client } = setup();
    const first = await client.wallet();
    const asked = client.wallet({ since: first.rev!, wait: 5 });
    await new Promise((done) => setTimeout(done, 5));
    cardd.waitOver();
    expect((await asked).rev).toBe(first.rev);
  });

  it('has no rev from a server from before held reads, which answers at once whatever is asked', async () => {
    const { cardd, client } = setup();
    cardd.holds = false;
    const first = await client.wallet();
    expect(first.rev).toBeUndefined();
    expect((await client.wallet({ since: '0123abcd-4', wait: 5 })).rev).toBeUndefined();
  });
});

describe('revBehind', () => {
  it("is whether a wallet's rev counts fewer changes than the one shown, for the same start of the server", () => {
    expect(revBehind('fa4eca4d-2', 'fa4eca4d-3')).toBe(true);
    expect(revBehind('fa4eca4d-9', 'fa4eca4d-10')).toBe(true);
    expect(revBehind('fa4eca4d-3', 'fa4eca4d-3')).toBe(false);
    expect(revBehind('fa4eca4d-4', 'fa4eca4d-3')).toBe(false);
    // Another start of the server, a server with no rev, or no wallet shown yet: not behind.
    expect(revBehind('0123abcd-1', 'fa4eca4d-3')).toBe(false);
    expect(revBehind(undefined, 'fa4eca4d-3')).toBe(false);
    expect(revBehind('fa4eca4d-1', undefined)).toBe(false);
  });
});

// One currency per server, set from the wallet, read
// with the wallet with its rate; a card's limits kept in a currency and said in sat at the last rate; a sale's price.
describe('CarddClient and the currency', () => {
  const T = 1_792_037_404;
  const card = (cardd: FakeCardd) =>
    cardd.cards.set(ID, { id: ID, version: 1, state: 'active', counter: 0, name: 'Daily', created: 0, updated: 0 });

  it('reads the currency with the wallet: never set, then set, with its rate once cardd has one', async () => {
    const { cardd, client } = setup();
    expect((await client.wallet()).fiat).toEqual({ currency: null });
    expect(await client.setCurrency('GBP')).toEqual({ currency: 'GBP' });
    const sent = cardd.http.requests.at(-1)!;
    expect([sent.method, sent.url, JSON.parse(sent.body!)]).toEqual(['PUT', 'https://vm-1001.lnvps.cloud/api/v1/currency', { currency: 'GBP' }]);
    cardd.prices = { time: T, per: { GBP: 61_352, EUR: 72_070 } };
    expect((await client.wallet()).fiat).toEqual({ currency: 'GBP', price: 61_352, time: T });
    expect(await client.setCurrency('none')).toEqual({ currency: 'none' });
    expect((await client.wallet()).fiat).toEqual({ currency: 'none' });
  });

  it("answers a held read of the wallet at once when the currency changes: the bell's rev moves", async () => {
    const { client } = setup();
    const first = await client.wallet();
    let answer: Wallet | null = null;
    const asked = client.wallet({ since: first.rev!, wait: 5 }).then((w) => void (answer = w));
    await new Promise((done) => setTimeout(done, 5));
    expect(answer).toBeNull();
    await client.setCurrency('EUR');
    await asked;
    expect(answer!.fiat).toEqual({ currency: 'EUR' });
    expect(answer!.rev).not.toBe(first.rev);
  });

  it('has no currency from a server not yet updated, whose router answers /currency with a plain 404', async () => {
    const { cardd, client } = setup();
    cardd.fiatRoutes = false;
    expect((await client.wallet()).fiat).toBeUndefined();
    await expect(client.setCurrency('GBP')).rejects.toMatchObject({ status: 404, code: 'bad_response' });
  });

  it("names the wallet: the name comes back trimmed, and the wallet's answer carries it", async () => {
    const { client } = setup();
    expect((await client.wallet()).name).toBe('');
    expect(await client.setWalletName(' Café ')).toBe('Café');
    expect((await client.wallet()).name).toBe('Café');
  });

  it('has no name from a server not yet updated, whose router answers the PUT with a plain 404', async () => {
    const { cardd, client } = setup();
    cardd.nameRoutes = false;
    expect(await client.wallet()).not.toHaveProperty('name');
    await expect(client.setWalletName('Café')).rejects.toMatchObject({ status: 404 });
  });

  it("sets a card's limits in a currency, read back with their conversion at the last rate; sat limits clear it", async () => {
    const { cardd, client } = setup();
    card(cardd);
    cardd.currency = 'GBP';
    cardd.prices = { time: T, per: { GBP: 61_352 } };
    const set = await client.setLimits(ID, { currency: 'GBP', perTapMinor: 500, dailyMinor: 2_000 });
    expect(JSON.parse(cardd.http.requests.at(-1)!.body!)).toEqual({ currency: 'GBP', perTapMinor: 500, dailyMinor: 2_000 });
    expect(set).toMatchObject({ limits: { currency: 'GBP', perTapMinor: 500, dailyMinor: 2_000 }, perTapSat: 8_150, dailySat: 32_599 });
    expect((await client.wallet()).cards[0]).toMatchObject({ limits: { currency: 'GBP', perTapMinor: 500, dailyMinor: 2_000 }, perTapSat: 8_150, dailySat: 32_599 });
    const sat = await client.setLimits(ID, { perTapSat: 5_000, dailySat: 40_000 });
    expect(JSON.parse(cardd.http.requests.at(-1)!.body!)).toEqual({ perTapSat: 5_000, dailySat: 40_000 });
    expect(sat).toMatchObject({ perTapSat: 5_000, dailySat: 40_000 });
    expect(sat).not.toHaveProperty('limits');
    expect((await client.wallet()).cards[0]).not.toHaveProperty('limits');
  });

  it('is refused limits in a currency with no rate, and over the 2,000,000 sat a card may spend once converted', async () => {
    const { cardd, client } = setup();
    card(cardd);
    cardd.currency = 'GBP';
    await expect(client.setLimits(ID, { currency: 'GBP', perTapMinor: 500, dailyMinor: 2_000 })).rejects.toMatchObject({ status: 409, code: 'no_rate' });
    cardd.prices = { time: T, per: { GBP: 61_352 } };
    expect(await client.setLimits(ID, { currency: 'GBP', perTapMinor: 500, dailyMinor: 122_704 })).toMatchObject({ dailySat: 2_000_000 });
    await expect(client.setLimits(ID, { currency: 'GBP', perTapMinor: 500, dailyMinor: 122_705 })).rejects.toMatchObject({ status: 400, code: 'bad_limits' });
  });

  it("names a sale's price in the history and the sales list when it was rung up in a currency", async () => {
    const { cardd, client } = setup();
    cardd.pair(cardd.newCode('Till 1'), 'aaaaaaaaaaaaaaaa');
    const sold = cardd.sell('aaaaaaaaaaaaaaaa', 4_075_000, 'card', 4_075_000, { currency: 'GBP', minor: 250 });
    expect((await client.history('shop'))[0].sale).toEqual({ id: sold, method: 'card', device: 'Till 1', priceMsat: 4_075_000, price: { currency: 'GBP', minor: 250 }, paidAt: expect.any(Number), refund: null });
    expect((await client.sales())[0]).toMatchObject({ id: sold, amountMsat: 4_075_000, price: { currency: 'GBP', minor: 250 } });
  });
});

describe('CarddClient lines', () => {
  it('sends the note only when there is one, after the amount, and reads and sets a line', async () => {
    const { cardd, client } = setup();
    cardd.balances.set('pool', 10_000_000);
    await client.send({ id: 's1', to: 'alice@example.com', amountMsat: 1_000_000, comment: 'with Sam' });
    await client.send({ id: 's2', to: 'alice@example.com', amountMsat: 1_000_000 });
    const bodies = cardd.http.requests.filter((r) => r.url.endsWith('/api/v1/send')).map((r) => r.body);
    expect(bodies).toEqual([
      JSON.stringify({ id: 's1', to: 'alice@example.com', amountMsat: 1_000_000, comment: 'with Sam' }),
      JSON.stringify({ id: 's2', to: 'alice@example.com', amountMsat: 1_000_000 }),
    ]);
    const [line] = await client.history('pool', { limit: 1 });
    const detail = await client.transaction('pool', line.id);
    expect(detail.payment?.destination).toBe('alice@example.com');
    expect((await client.setComment('pool', line.id, 'rent')).comment).toBe('rent');
    cardd.transactionRoutes = false;
    await expect(client.transaction('pool', line.id)).rejects.toSatisfy(noTransactionRoutes);
  });

  it('leaves an empty note out of the send body', async () => {
    const { cardd, client } = setup();
    cardd.balances.set('pool', 10_000_000);
    await client.send({ id: 's3', to: 'alice@example.com', amountMsat: 1_000_000, comment: '' });
    const body = cardd.http.requests.filter((r) => r.url.endsWith('/api/v1/send')).map((r) => r.body)[0]!;
    expect(JSON.parse(body)).not.toHaveProperty('comment');
  });

  it('tells a missing line from a cardd without the routes, and keeps a note to 200 characters', async () => {
    const { cardd, client } = setup();
    cardd.balances.set('pool', 10_000_000);
    await client.send({ id: 's4', to: 'alice@example.com', amountMsat: 1_000_000 });
    const [line] = await client.history('pool', { limit: 1 });
    const e = await client.transaction('pool', 99999).catch((x) => x);
    expect(e).toBeInstanceOf(CarddError);
    expect(e.code).toBe('not_found');
    expect(noTransactionRoutes(e)).toBe(false);
    const bad = await client.setComment('pool', line.id, '😀'.repeat(201)).catch((x) => x);
    expect(bad.code).toBe('bad_note');
    expect((await client.setComment('pool', line.id, '😀'.repeat(200))).comment).toBe('😀'.repeat(200));
  });
});

describe('CarddClient Recent list', () => {
  it('reads the Recent list and removes an address from it', async () => {
    const { cardd, client } = setup();
    cardd.recent = [{ to: 'alice@a.com', shown: 'alice@a.com', paidAt: 1_790_000_000 }, { to: 'bob@b.com', shown: '₿bob@b.com', paidAt: 1_789_000_000 }];
    expect(await client.recentSends()).toEqual(cardd.recent);
    await client.removeRecent('alice@a.com');
    const asked = cardd.http.requests.at(-1)!;
    expect(asked.method).toBe('DELETE');
    expect(asked.url).toBe('https://vm-1001.lnvps.cloud/api/v1/send/recent');
    expect(asked.body).toBe(JSON.stringify({ to: 'alice@a.com' }));
    expect(await client.recentSends()).toEqual([{ to: 'bob@b.com', shown: '₿bob@b.com', paidAt: 1_789_000_000 }]);
  });

  it('passes a failed removal on as a CarddError', async () => {
    const { cardd, client } = setup();
    cardd.removeRecentFails = 'disk full';
    const e = await client.removeRecent('alice@a.com').catch((x) => x);
    expect(e).toBeInstanceOf(CarddError);
    expect(e.message).toBe('disk full');
  });
});

describe('CarddClient sends to offers and names', () => {
  it('looks a destination up, and reads a send state, held', async () => {
    const { cardd, client } = setup();
    cardd.lookups.set('₿alice@example.com', { kind: 'offer', offer: 'lno1x', name: '₿alice@example.com', amountMsat: null, description: '', issuer: '' });
    expect(await client.lookup('₿alice@example.com')).toEqual({ kind: 'offer', offer: 'lno1x', name: '₿alice@example.com', amountMsat: null, description: '', issuer: '' });
    const asked = cardd.http.requests.find((r) => r.url.endsWith('/api/v1/send/lookup'))!;
    expect(asked.body).toBe(JSON.stringify({ to: '₿alice@example.com' }));
    cardd.sends.set('req-1', { status: 'sent', paymentHash: 'aa', amountMsat: 1000, feeMsat: 4 });
    expect(await client.sendState('req-1', 20)).toEqual({ status: 'sent', paymentHash: 'aa', amountMsat: 1000, feeMsat: 4 });
    expect(cardd.http.requests.at(-1)!.url).toBe('https://vm-1001.lnvps.cloud/api/v1/send/req-1?wait=20');
    await expect(client.sendState('nobody')).rejects.toBeInstanceOf(CarddError);
  });

  it("refuses a ₿ name it wasn't given, as the server does; a plain name it wasn't given reads as LNURL", async () => {
    const { client } = setup();
    const e = await client.lookup('₿bob@example.com').catch((x) => x);
    expect(e).toBeInstanceOf(CarddError);
    expect(e.code).toBe('bad_destination');
    expect(e.message).toBe("₿bob@example.com doesn't exist: example.com has no BIP353 record for bob.");
    expect(await client.lookup('bob@example.com')).toEqual({ kind: 'payurl', to: 'bob@example.com', minMsat: 1_000, maxMsat: 1_000_000_000, description: '' });
  });

  it('sends a name with its offer, in one key order', async () => {
    const { cardd, client } = setup();
    cardd.balances.set('pool', 10_000_000);
    await client.send({ id: 'r', to: 'lno1x', name: '₿alice@example.com', amountMsat: 1_000_000 });
    const body = cardd.http.requests.filter((r) => r.url.endsWith('/api/v1/send')).map((r) => r.body)[0];
    expect(body).toBe(JSON.stringify({ id: 'r', to: 'lno1x', name: '₿alice@example.com', amountMsat: 1_000_000 }));
  });
});

// Alerts with the app closed: the push API's four calls.
describe('CarddClient push', () => {
  const REQ = { endpoint: 'https://vm-1.lnvps.cloud:8443/upAbC123?up=1', p256dh: 'BPk', auth: 'aGk', transport: 'unifiedpush' } as const;

  it('reads how alerts stand, registers an endpoint, tests it and turns it off, on the push paths', async () => {
    const { cardd, client } = setup();
    expect(await client.push()).toEqual({ vapidPublicKey: cardd.pushVapid, ntfy: 'https://vm-1.lnvps.cloud:8443', endpoint: null });
    const on = await client.setPush(REQ);
    expect(on.endpoint).toEqual({ transport: 'unifiedpush', origin: 'https://vm-1.lnvps.cloud:8443', createdAt: 1_790_000_000, deliveredAt: null, failedAt: null, failure: '', failures: 0 });
    await client.testPush();
    expect((await client.push()).endpoint?.deliveredAt).toBe(1_790_000_000);
    await client.dropPush();
    expect((await client.push()).endpoint).toBeNull();
    const asked = cardd.http.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(asked).toEqual(['GET /api/v1/push', 'PUT /api/v1/push', 'POST /api/v1/push/test', 'GET /api/v1/push', 'DELETE /api/v1/push', 'GET /api/v1/push']);
    expect(JSON.parse(cardd.http.requests[1].body!)).toEqual(REQ);
  });

  it("refuses an ntfy.sh endpoint with ntfy_sh, and says what the endpoint said to a test alert it didn't take", async () => {
    const { cardd, client } = setup();
    await expect(client.setPush({ ...REQ, endpoint: 'https://ntfy.sh/upXyz?up=1' })).rejects.toMatchObject({ status: 400, code: 'ntfy_sh' });
    await expect(client.testPush()).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await client.setPush(REQ);
    cardd.pushTestFailure = 'HTTP 410 Gone';
    const e = await client.testPush().catch((x) => x);
    expect(e).toBeInstanceOf(CarddError);
    expect(e).toMatchObject({ status: 502, code: 'push_failed', message: 'HTTP 410 Gone' });
  });
});
