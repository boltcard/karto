// Wires the fakes into onboarding Deps: a fake LNVPS, SSH server, cardd and
// clock.
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { expect } from 'vitest';
import { AgeError, ageDecrypt, ageEncrypt } from '../backup/age';
import type { ServerLatest, SnapshotSummary } from '../backup/backups';
import { CarddClient } from '../cardd/client';
import { deriveKeys } from '../keys/derive';
import type { FetchFn } from '../lightning/lightning';
import { LnvpsClient } from '../lnvps/client';
import type { Deps, OnboardingState } from '../onboarding/machine';
import { FakeCardd, vectorDeviceKey } from './fakeCardd';
import { FakeLnvps } from './fakeLnvps';
import { FakeSsh } from './fakeSsh';
import { json } from './http';
import { memoryFiles } from './memoryFiles';
import { vectors } from './vectors';

export const HOST_KEY = { key_type: 'ssh-ed25519', public_key: 'AAAAC3NzaC1lZDI1NTE5AAAAIM7OaJ', fingerprint_sha256: 'SHA256:81C/im5J' };

/** Another server of this phrase, such as a rebuild's old one: its own SSH and cardd. httpsDown: nothing answers HTTPS. */
export type OtherServer = { ssh: FakeSsh; cardd: FakeCardd; httpsDown: boolean };

/**
 * A snapshot as the world's inspect reads it: the summary itself as JSON, encrypted to
 * `recipient`. (On the phone it is cardd's database, which inspect opens with SQLite.)
 */
export const sealSummary = (x: SnapshotSummary, recipient: string) => ageEncrypt(utf8ToBytes(JSON.stringify(x)), recipient);

export function world() {
  const lnvps = new FakeLnvps();
  const ssh = new FakeSsh();
  ssh.scanKey = { keyType: HOST_KEY.key_type, publicKey: HOST_KEY.public_key };
  const cardd: FakeCardd = new FakeCardd((): number => w.nowMs).serve(ssh);
  // One clock for the phone and LNVPS, moved by tests.
  lnvps.serverNow = () => w.nowMs;
  const w = {
    lnvps,
    ssh,
    cardd,
    healthy: true,
    nowMs: 1_790_000_000_000,
    checkpoints: [] as OnboardingState[],
    /** The phone's kept snapshots (a rebuild restores one). */
    files: memoryFiles(),
    /** The server's latest snapshot as the phone last noted it. */
    serverLatest: null as ServerLatest | null,
    /** Other servers (addServer), by IPv4 address and by hostname; any other address is ssh and cardd's. */
    others: new Map<string, OtherServer>(),
  };
  const fetch: FetchFn = async (url, init) => {
    const u = new URL(url);
    const other = w.others.get(u.hostname);
    if (other) {
      // A retired server's containers are gone, Caddy's with them.
      if (other.httpsDown || other.cardd.retired) throw new TypeError(`fetch failed: connection refused by ${u.host}`);
      return u.pathname === '/health' ? json(200, { ok: true, version: 'test' }) : other.cardd.http.fetch(url, init);
    }
    if (u.origin === 'https://api.lnvps.net') return lnvps.http.fetch(url, init);
    if (u.hostname.endsWith('mail.tm')) {
      // Set-up no longer uses mail.tm (LNVPS stopped asking for a verified email): any call to it fails the test
      // that made it, even where the code under test catches the error thrown here.
      expect.soft(url, 'a call to mail.tm').toBeUndefined();
      throw new TypeError(`fetch failed: no host ${u.origin}`);
    }
    if (u.pathname.startsWith('/api/v1/')) return cardd.http.fetch(url, init);
    if (u.pathname === '/health') {
      if (!w.healthy) throw new TypeError('fetch failed: certificate not ready');
      return json(200, { ok: true, version: 'test' });
    }
    throw new TypeError(`fetch failed: no host ${u.origin}`);
  };
  const keys = deriveKeys(vectors.phrase.phrase);
  const deps: Deps = {
    keys,
    lnvps: new LnvpsClient({ fetch, nostrSecretKey: keys.nostrPrivateKey, now: () => w.nowMs }),
    fetch,
    ssh: (o) => (w.others.get(o.host)?.ssh ?? ssh).connect(o),
    scanHostKey: ssh.scanHostKey,
    bundle: async () => [
      { path: 'install.sh', mode: 0o755, sha256: 'aa'.repeat(32), data: new Uint8Array([1]) },
      { path: 'bin/cardd', mode: 0o755, sha256: 'bb'.repeat(32), asset: 'deploy/bin/cardd', size: 2 },
    ],
    device: { publicKeyHex: vectors.deviceAuth.publicKey, name: 'Pixel 8' },
    backups: {
      ...w.files,
      inspect: async (name) => {
        let plain: Uint8Array;
        try {
          plain = ageDecrypt(await w.files.read(name), keys.backupAgeIdentity);
        } catch (e) {
          if (e instanceof AgeError) return null;
          throw e;
        }
        return JSON.parse(new TextDecoder().decode(plain)) as SnapshotSummary;
      },
    },
    serverLatest: async () => w.serverLatest,
    oldCardd: (host) => new CarddClient({ fetch, host, key: vectorDeviceKey(), now: () => w.nowMs }),
    now: () => w.nowMs,
    checkpoint: async (s) => void w.checkpoints.push(s),
  };
  /** Another server of this phrase at ipv4 and hostname, with this phone paired (a rebuild's old one). */
  const addServer = (ipv4: string, hostname: string): OtherServer => {
    const other = new FakeSsh();
    const server: OtherServer = { ssh: other, cardd: new FakeCardd((): number => w.nowMs).serve(other), httpsDown: false };
    server.cardd.devices.set(vectors.deviceAuth.keyId, vectors.deviceAuth.publicKey);
    w.others.set(ipv4, server).set(hostname, server);
    return server;
  };
  return { ...w, w, deps, keys, addServer };
}
