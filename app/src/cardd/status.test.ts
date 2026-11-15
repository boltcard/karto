import { describe, expect, it } from 'vitest';
import { CarddClient } from './client';
import { serverStatus, updateOutcome } from './status';
import { FakeCardd, vectorDeviceKey } from '../testing/fakeCardd';
import { deviceKey } from '../native/deviceKey';
import { vectors } from '../testing/vectors';
import { CARDD_SCHEMA_VERSION } from '../deploy/schema';

const nowMs = 1_790_000_000_000;
function setup(key = vectorDeviceKey()) {
  const cardd = new FakeCardd(() => nowMs);
  cardd.devices.set(vectors.deviceAuth.keyId, vectors.deviceAuth.publicKey);
  cardd.meta.set('bundle.sha256', 'ab12');
  return { cardd, client: new CarddClient({ fetch: cardd.http.fetch, host: 'vm-1001.lnvps.cloud', key, now: () => nowMs }) };
}

describe('serverStatus', () => {
  it('offers an update when the server runs a different bundle', async () => {
    const { client } = setup();
    expect(await serverStatus(client, 'ab12')).toEqual({ kind: 'ok', version: 'test', updateAvailable: false, schema: CARDD_SCHEMA_VERSION });
    expect(await serverStatus(client, 'cd34')).toEqual({ kind: 'ok', version: 'test', updateAvailable: true, schema: CARDD_SCHEMA_VERSION });
  });

  // Whether the server's name has an IPv4 address, as cardd says; an older cardd says nothing.
  it("carries what the server says of its name's IPv4 address", async () => {
    const { cardd, client } = setup();
    expect(await serverStatus(client, 'ab12')).not.toHaveProperty('dns');
    cardd.dns = { ipv4: 'other', got: ['1.2.3.4'] };
    expect(await serverStatus(client, 'ab12')).toMatchObject({ kind: 'ok', dns: { ipv4: 'other', got: ['1.2.3.4'] } });
  });

  it('offers an update to a server installed before bundles were recorded', async () => {
    const { cardd, client } = setup();
    cardd.meta.delete('bundle.sha256');
    expect(await serverStatus(client, 'ab12')).toMatchObject({ kind: 'ok', updateAvailable: true });
  });

  it('says the phone is not paired when cardd refuses its key', async () => {
    const { cardd, client } = setup();
    cardd.revoked.add(vectors.deviceAuth.keyId);
    const refused = await serverStatus(client, 'ab12');
    expect(refused).toMatchObject({ kind: 'not_paired' });
    // Refused by the server, not a phone without a key (the iPhone's words differ).
    expect(refused).not.toHaveProperty('noKey');
  });

  it('says the phone is not paired when it has no device key', async () => {
    const noKey = Object.assign(new Error('no device key'), { code: 'ERR_NO_DEVICE_KEY' });
    const key = deviceKey({
      deviceKeyCreate: async () => '',
      devicePublicKey: async () => { throw noKey; },
      deviceSign: async () => { throw noKey; },
    });
    const { client } = setup(key);
    expect(await serverStatus(client, 'ab12')).toEqual({
      kind: 'not_paired', noKey: true,
      message: 'This phone has no device key (was the app restored from a backup?). Pairing again comes with restore.',
    });
  });

  it('says the server is unreachable when the request fails', async () => {
    const client = new CarddClient({ fetch: async () => { throw new TypeError('Network request failed'); }, host: 'vm-1001.lnvps.cloud', key: vectorDeviceKey() });
    expect(await serverStatus(client, 'ab12')).toEqual({ kind: 'unreachable', message: 'Network request failed' });
  });
});

describe('updateOutcome', () => {
  it('says what the server now runs once it reports the app\'s bundle', () => {
    expect(updateOutcome({ kind: 'ok', version: '0.2.0', updateAvailable: false })).toEqual({ ok: true, text: 'Updated to cardd 0.2.0.' });
  });

  it('does not claim success while the server still reports another bundle', () => {
    expect(updateOutcome({ kind: 'ok', version: '0.1.0', updateAvailable: true })).toEqual({
      ok: false,
      text: 'The server still runs the old version. Try Update server again.',
    });
  });

  it('does not claim success when the server cannot be checked afterwards', () => {
    expect(updateOutcome({ kind: 'unreachable', message: 'certificate not ready' })).toEqual({
      ok: false,
      text: "The update ran, but the server can't be checked: certificate not ready",
    });
  });
});
