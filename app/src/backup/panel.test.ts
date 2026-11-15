import { describe, expect, it } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { CarddClient } from '../cardd/client';
import type { OnboardingState } from '../onboarding/machine';
import { FakeCardd, vectorDeviceKey } from '../testing/fakeCardd';
import { memoryFiles } from '../testing/memoryFiles';
import { vectors } from '../testing/vectors';
import { ageEncrypt } from './age';
import { snapshotName, type ServerLatest } from './backups';
import { loadBackups, type BackupsDeps, type BackupsView } from './panel';

const NOW = 1_790_000_000; // 2026-09-21 14:13 UTC
const KEYS = { backupAgeRecipient: vectors.phrase.backupAgeRecipient, backupAgeIdentity: vectors.phrase.backupAgeIdentity };
const STATE: OnboardingState = { step: 'done', payDays: 30, installed: [], vmId: 1009 };
/** A snapshot's bytes as the phone keeps them: encrypted to the phrase's backup key (the fake opener reads it as VM 1009's). */
const SNAPSHOT = ageEncrypt(utf8ToBytes('cardd.db'), KEYS.backupAgeRecipient);
const offline = () => new TypeError('fetch failed: no answer from vm-1009.lnvps.cloud in 30 s');

function setup() {
  const server = new FakeCardd(() => NOW * 1000);
  server.devices.set(vectors.deviceAuth.keyId, vectors.deviceAuth.publicKey);
  const client = (fetch = server.http.fetch) => new CarddClient({ fetch, host: 'vm-1009.lnvps.cloud', key: vectorDeviceKey(), now: () => NOW * 1000 });
  const files = memoryFiles();
  const store = {
    flag: false,
    recipients: [] as string[],
    latest: [] as ServerLatest[],
    revoked: async () => store.flag,
    setRevoked: async (r: boolean) => void (store.flag = r),
    saveBackupRecipient: async (r: string) => void store.recipients.push(r),
    saveServerLatest: async (l: ServerLatest) => void store.latest.push(l),
  };
  const task: string[] = [];
  const shown: Partial<BackupsView>[] = [];
  const d: BackupsDeps = {
    store, files, openDb: async () => '1009', now: () => NOW * 1000,
    registerTask: async () => void task.push('register'),
    unregisterTask: async () => void task.push('unregister'),
  };
  const load = (o: { state?: OnboardingState; cardd?: ReturnType<typeof client> | Pick<CarddClient, 'backups' | 'backupFile'> } = {}) =>
    loadBackups(d, { state: o.state ?? STATE, keys: KEYS, cardd: o.cardd ?? client() }, (p) => shown.push(p));
  return { server, client, files, store, task, shown, d, load };
}

describe('loadBackups', () => {
  it('shows what the phone keeps at once, then fetches the latest and checks it', async () => {
    const { server, store, task, shown, load } = setup();
    server.addSnapshot(SNAPSHOT);
    await load();
    expect(shown).toEqual([
      { lines: ['No backup on this phone yet'], warnings: [], lastFetch: null, checking: true }, // before the fetch: checking can take seconds
      { lines: [expect.stringMatching(/^Last one today at /), '1 kept on this phone'], warnings: [], lastFetch: NOW, unreachable: false, noApi: false, failure: null, checking: false },
    ]);
    expect([store.recipients, task, store.latest]).toEqual([[KEYS.backupAgeRecipient], ['register'], [{ installId: server.backupInstallId, version: 1, created: NOW }]]);
  });

  it('stops at once on a phone another phone has unpaired', async () => {
    const { server, store, task, shown, load } = setup();
    store.flag = true;
    await load();
    expect([shown, task, store.recipients, server.lastCheckIn]).toEqual([[{ revoked: true, checking: false }], [], [], 0]);
  });

  it('marks the phone unpaired when the server says so, and stops the background job', async () => {
    const { server, store, task, shown, load } = setup();
    server.revoked.add(vectors.deviceAuth.keyId);
    await load();
    expect([shown.at(-1), store.flag, task]).toEqual([{ revoked: true, checking: false }, true, ['register', 'unregister']]);
  });

  it("shows what the phone keeps when the server can't be reached", async () => {
    const { files, shown, load } = setup();
    await files.write(snapshotName('aa', 1, NOW - 3600), SNAPSHOT);
    await load({ cardd: { backups: async () => { throw offline(); }, backupFile: async () => new Uint8Array() } });
    expect(shown.at(-1)).toEqual({ lines: ['1 kept on this phone'], warnings: [], lastFetch: null, unreachable: true, noApi: false, failure: null, checking: false });
  });

  it('warns when the latest backup could not be fetched', async () => {
    const { server, files, shown, load, d } = setup();
    server.addSnapshot(SNAPSHOT);
    d.files = { ...files, write: async () => { throw new Error('disk full'); } };
    await load();
    expect(shown.at(-1)).toMatchObject({ warnings: ["Couldn't fetch the latest backup: disk full."], unreachable: false });
  });

  it("says quietly that a server from before backups makes none", async () => {
    const { server, client, shown, load } = setup();
    const old = client(async (url, init) => (String(url).includes('/api/v1/backups') ? new Response('404 page not found\n', { status: 404 }) : server.http.fetch(url, init)));
    await load({ cardd: old });
    expect(shown.at(-1)).toMatchObject({ noApi: true, unreachable: false });
  });

  it('says why when the check itself fails', async () => {
    const { store, shown, load } = setup();
    store.saveBackupRecipient = async () => { throw new Error('database is locked'); };
    await load();
    expect(shown).toEqual([{ failure: "Couldn't check backups: database is locked.", checking: false }]);
  });

  it('does nothing before the server has a VM', async () => {
    const { task, shown, load } = setup();
    await load({ state: { ...STATE, vmId: undefined } });
    expect([shown, task]).toEqual([[], []]);
  });
});
