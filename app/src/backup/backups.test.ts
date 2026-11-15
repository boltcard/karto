import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { CarddClient, CarddError, type BackupStatus } from '../cardd/client';
import { FakeCardd, vectorDeviceKey } from '../testing/fakeCardd';
import { vectors } from '../testing/vectors';
import { ageEncrypt } from './age';
import { memoryFiles } from '../testing/memoryFiles';
import { backupJob, backupView, checkKept, fetchLatest, foregroundBackups, MAX_SNAPSHOT_BYTES, snapshotName, toRemove, type FetchDeps, type Kept, type ServerLatest } from './backups';

const NOW = 1_790_000_000; // 2026-09-21 14:13 UTC
const RECIPIENT = vectors.phrase.backupAgeRecipient;
const IDENTITY = vectors.phrase.backupAgeIdentity;

/** A snapshot as cardd makes one: an SQLite database with meta vm.id (none: null), encrypted to the phrase's backup key. */
function snapshot(vmId: string | null = '1009', recipient = RECIPIENT): Uint8Array {
  const path = join(mkdtempSync(join(tmpdir(), 'snap-')), 'cardd.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  if (vmId !== null) db.prepare(`INSERT INTO meta VALUES ('vm.id', ?, 0)`).run(vmId);
  db.close();
  return ageEncrypt(new Uint8Array(readFileSync(path)), recipient);
}

/** meta vm.id of a decrypted snapshot, as the app's expo-sqlite opener answers: '' without one, null if it isn't a database. */
async function openDb(bytes: Uint8Array): Promise<string | null> {
  const path = join(mkdtempSync(join(tmpdir(), 'open-')), 'x.db');
  writeFileSync(path, bytes);
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'vm.id'`).get() as { value: string } | undefined;
    db.close();
    return row?.value ?? '';
  } catch {
    return null;
  }
}

function setup() {
  let nowMs = NOW * 1000;
  const cardd = new FakeCardd(() => nowMs);
  cardd.devices.set(vectors.deviceAuth.keyId, vectors.deviceAuth.publicKey);
  const client = new CarddClient({ fetch: cardd.http.fetch, host: 'vm-1009.lnvps.cloud', key: vectorDeviceKey(), now: () => nowMs });
  const files = memoryFiles();
  return { cardd, client, files, deps: { cardd: client, files, recipient: RECIPIENT }, tick: (s: number) => (nowMs += s * 1000) };
}

describe('fetchLatest', () => {
  it('fetches the latest snapshot once, checking its size and hash', async () => {
    const { cardd, files, deps } = setup();
    expect((await fetchLatest(deps)).result).toEqual({ kind: 'none' });
    const v = cardd.addSnapshot(snapshot());
    const name = snapshotName(cardd.backupInstallId, v, NOW);
    expect((await fetchLatest(deps)).result).toEqual({ kind: 'fetched', name });
    expect(await files.read(name)).toEqual(cardd.snapshots.get(v));
    cardd.lastDownload = 0;
    expect((await fetchLatest(deps)).result).toEqual({ kind: 'up_to_date' });
    expect(cardd.lastDownload).toBe(0); // not downloaded again
  });

  it('fetches nothing encrypted to another key, too big, or not what the server described', async () => {
    const { cardd, files, deps } = setup();
    cardd.addSnapshot(snapshot());
    cardd.backupRecipient = 'age1someoneelse';
    expect((await fetchLatest(deps)).result).toEqual({ kind: 'foreign_recipient' });
    cardd.backupRecipient = RECIPIENT;
    cardd.backupLatest = { ...cardd.backupLatest!, size: MAX_SNAPSHOT_BYTES + 1 };
    expect((await fetchLatest(deps)).result).toMatchObject({ kind: 'bad_download', reason: expect.stringContaining('too big') });
    const v = cardd.addSnapshot(snapshot());
    cardd.snapshots.set(v, snapshot()); // other bytes than described
    expect((await fetchLatest(deps)).result).toMatchObject({ kind: 'bad_download', reason: expect.stringContaining("doesn't match") });
    expect(await files.list()).toEqual([]);
    expect(cardd.lastDownload).toBe(NOW); // only the mismatched one was downloaded
  });

  // The file's name comes from what the server says: a server that names a
  // snapshot with a path, or with no real version or time, gets nothing saved.
  it('saves nothing the server names oddly', async () => {
    const { cardd, files, deps } = setup();
    cardd.addSnapshot(snapshot());
    for (const odd of [
      () => (cardd.backupInstallId = '../../../../databases/card-app'),
      () => (cardd.backupInstallId = 'AABBCCDDEEFF00112233445566778899'),
      () => (cardd.backupLatest = { ...cardd.backupLatest!, version: 0 }),
      () => (cardd.backupLatest = { ...cardd.backupLatest!, version: 1.5 }),
      () => (cardd.backupLatest = { ...cardd.backupLatest!, created: -1 }),
    ]) {
      const keep = { id: cardd.backupInstallId, latest: cardd.backupLatest };
      odd();
      expect((await fetchLatest(deps)).result).toMatchObject({ kind: 'bad_download', reason: expect.stringContaining('oddly') });
      cardd.backupInstallId = keep.id;
      cardd.backupLatest = keep.latest;
    }
    expect(await files.list()).toEqual([]);
    expect(cardd.lastDownload).toBe(0);
  });

  // A download cut short (the app killed mid-write) must not count as held for ever.
  it('fetches again a kept file of the wrong size', async () => {
    const { cardd, files, deps } = setup();
    const v = cardd.addSnapshot(snapshot());
    await files.write(snapshotName(cardd.backupInstallId, v, NOW), new Uint8Array(10));
    expect((await fetchLatest(deps)).result).toMatchObject({ kind: 'fetched' });
    expect((await files.read(snapshotName(cardd.backupInstallId, v, NOW))).length).toBe(cardd.backupLatest!.size);
  });

  it('reports a download refused for its length', async () => {
    const { cardd, files, deps } = setup();
    cardd.addSnapshot(snapshot());
    cardd.backupNoLength = true;
    expect((await fetchLatest(deps)).result).toMatchObject({ kind: 'bad_download', reason: expect.stringContaining('no stated') });
    expect(await files.list()).toEqual([]);
  });

  // A rebuilt VM starts its versions again at 1, with a new install id.
  it('fetches a new install\'s snapshot 1 though it holds version 1 of the old', async () => {
    const { cardd, deps } = setup();
    cardd.addSnapshot(snapshot());
    await fetchLatest(deps);
    cardd.backupInstallId = 'ffeeddccbbaa99887766554433221100';
    cardd.snapshots.clear();
    cardd.backupLatest = null;
    cardd.addSnapshot(snapshot());
    expect((await fetchLatest(deps)).result).toMatchObject({ kind: 'fetched' });
  });

  // The name is only (install, version, created): a server re-serving a version must not replace a checked file.
  it('keeps a snapshot that passed its check when the server describes its version differently', async () => {
    const { cardd, files, deps } = setup();
    const v = cardd.addSnapshot(snapshot());
    const name = snapshotName(cardd.backupInstallId, v, NOW);
    await fetchLatest(deps);
    const original = await files.read(name);
    await files.mark(name, 'ok');
    cardd.snapshots.set(v, snapshot());
    cardd.backupLatest = { ...cardd.backupLatest!, size: cardd.snapshots.get(v)!.length + 7, sha256: 'ab'.repeat(32) };
    cardd.snapshots.set(v, new Uint8Array(cardd.backupLatest.size));
    expect((await fetchLatest(deps)).result).toMatchObject({ kind: 'bad_download', reason: expect.stringContaining('changed snapshot') });
    expect(await files.read(name)).toEqual(original);
    expect((await files.list())[0].checked).toBe('ok');
  });

  it('write clears a file\'s check mark', async () => {
    const files = memoryFiles();
    await files.write('aa-1-1.age', new Uint8Array(3));
    await files.mark('aa-1-1.age', 'ok');
    await files.write('aa-1-1.age', new Uint8Array(4));
    expect((await files.list())[0].checked).toBeUndefined();
  });

  it('knows when another phone revoked this one, and the job stops', async () => {
    const { cardd, deps } = setup();
    cardd.revoked.add(vectors.deviceAuth.keyId);
    expect((await fetchLatest(deps)).result).toEqual({ kind: 'revoked' });
    let stopped = 0;
    expect(await backupJob({ ...deps, onRevoked: async () => void stopped++ })).toEqual({ kind: 'revoked' });
    expect(stopped).toBe(1);
  });
});

describe('toRemove', () => {
  const kept = (created: number, version: number): Kept => ({ name: snapshotName('aa', version, created), installId: 'aa', version, created });
  it('keeps the last 24 and the newest of each of the 7 days before', () => {
    const day = 86400;
    const today = Math.floor(NOW / day) * day; // 2026-09-21 00:00 UTC
    const all: Kept[] = [];
    let v = 0;
    for (let d = 9; d >= 1; d--) {
      all.push(kept(today - d * day + 6 * 3600, ++v), kept(today - d * day + 12 * 3600, ++v)); // two a day before today
    }
    for (let i = 0; i < 26; i++) all.push(kept(today + i * 1200, ++v)); // 26 today, every 20 minutes
    const removed = toRemove(all, NOW, 0);
    const keptNow = all.filter((k) => !removed.includes(k.name));
    // Today's two oldest go (the last 24 stay); days 1–7 before keep their noon one; days 8–9 go.
    expect(removed.length).toBe(2 + 7 + 4);
    expect(keptNow.length).toBe(24 + 7);
    for (let d = 1; d <= 7; d++) expect(keptNow.some((k) => k.created === today - d * day + 12 * 3600)).toBe(true);
    expect(keptNow.some((k) => k.created < today - 7 * day)).toBe(false);
  });

  // A day's copy is a good one when it has one, whatever times a server claims.
  it('keeps a good copy of a day rather than a newer bad one', () => {
    const day = 86400;
    const yesterday = Math.floor(NOW / day) * day - day;
    const ok = { ...kept(yesterday + 3600, 1), checked: 'ok' as const };
    const bad = { ...kept(yesterday + 7200, 2), checked: 'unreadable' as const };
    const today = Array.from({ length: 24 }, (_, i) => kept(NOW - 60 * (i + 1), i + 3));
    const removed = toRemove([ok, bad, ...today], NOW, 0);
    expect(removed).toContain(bad.name);
    expect(removed).not.toContain(ok.name);
  });

  // Snapshots are checked only while the app is open: a broken or hostile
  // server's 24 bad ones must not push out the last one known good.
  it('always keeps the newest snapshot that passed its check', () => {
    const good = { ...kept(NOW - 30 * 86400, 1), checked: 'ok' as const };
    const all = [good, ...Array.from({ length: 30 }, (_, i) => kept(NOW - 3600 * (30 - i), i + 2))];
    expect(toRemove(all, NOW, 0)).not.toContain(good.name);
    const newer = { ...kept(NOW - 20 * 86400, 40), checked: 'ok' as const };
    expect(toRemove([...all, newer], NOW, 0)).toContain(good.name);
  });

  // The snapshot a rebuild chose is read again at its install, whatever its age.
  it('never removes the snapshot a rebuild chose', () => {
    const chosen = kept(NOW - 30 * 86400, 1);
    const all = [chosen, ...Array.from({ length: 30 }, (_, i) => kept(NOW - 3600 * (30 - i), i + 2))];
    expect(toRemove(all, NOW, 0)).toContain(chosen.name);
    expect(toRemove(all, NOW, 0, chosen.name)).not.toContain(chosen.name);
    expect(toRemove(all, NOW, 0, chosen.name).length).toBe(toRemove(all, NOW, 0).length - 1);
  });

  it('keeps it when the job fetches and thins', async () => {
    const { cardd, files, deps, tick } = setup();
    const chosen = snapshotName('cd'.repeat(16), 1, NOW - 30 * 86400);
    await files.write(chosen, snapshot());
    for (let i = 0; i < 25; i++) {
      cardd.addSnapshot(snapshot());
      await backupJob({ ...deps, keep: chosen, onRevoked: async () => {} });
      tick(3600);
    }
    expect((await files.list()).map((k) => k.name)).toContain(chosen);
    cardd.addSnapshot(snapshot());
    await backupJob({ ...deps, onRevoked: async () => {} });
    expect((await files.list()).map((k) => k.name)).not.toContain(chosen);
  }, 30_000); // 26 backup jobs with age decryption: more than vitest's default 5 s alongside the other test files
});

// The server page suggests a rebuild when cardd hasn't answered for over an hour.
describe('the background job\'s note of cardd answering', () => {
  it('notes whether cardd answered at all, an error being an answer', async () => {
    const { cardd, deps } = setup();
    const notes: boolean[] = [];
    const job = (c: FetchDeps['cardd'] = deps.cardd) => backupJob({ ...deps, cardd: c, noteAnswered: async (a) => void notes.push(a), onRevoked: async () => {} });
    await job();
    cardd.addSnapshot(snapshot());
    const downloadFails = { backups: () => deps.cardd.backups(), backupFile: async () => { throw new TypeError('fetch failed'); } };
    await expect(job(downloadFails)).rejects.toThrow('fetch failed');
    const offline = { backups: async () => { throw new TypeError('fetch failed: no answer from vm-1009.lnvps.cloud in 40 s'); }, backupFile: deps.cardd.backupFile };
    await expect(job(offline)).rejects.toThrow('fetch failed');
    const refuses = { backups: async () => { throw new CarddError(500, 'internal', 'boom'); }, backupFile: deps.cardd.backupFile };
    await expect(job(refuses)).rejects.toThrow('boom');
    cardd.revoked.add(vectors.deviceAuth.keyId);
    await job();
    expect(notes).toEqual([true, true, false, true, true]);
  });
});

describe('checkKept', () => {
  it('opens each new snapshot with the phrase and checks it is this server\'s database', async () => {
    const files = memoryFiles();
    const put = async (name: string, bytes: Uint8Array) => files.write(name, bytes);
    await put(snapshotName('aa', 1, NOW), snapshot());
    await put(snapshotName('aa', 2, NOW + 1), snapshot('1009', 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p'));
    await put(snapshotName('aa', 3, NOW + 2), snapshot('1017'));
    await put(snapshotName('aa', 4, NOW + 3), ageEncrypt(new TextEncoder().encode('not a database'), RECIPIENT));
    const checked = await checkKept({ files, identity: IDENTITY, vmIds: ['1009'], openDb, limit: 10 });
    expect(checked.map((k) => [k.version, k.checked])).toEqual([[1, 'ok'], [2, 'unreadable'], [3, 'other'], [4, 'unreadable']]);
    let reads = 0;
    const counting = { ...files, read: async (n: string) => (reads++, files.read(n)) };
    await checkKept({ files: counting, identity: IDENTITY, vmIds: ['1009'], openDb });
    expect(reads).toBe(0); // checked once
  });

  // After a rebuild the newest kept file can be the old server's final snapshot.
  it("takes a snapshot of this phrase's old servers as its own, and tells another server's apart", async () => {
    const files = memoryFiles();
    await files.write(snapshotName('aa', 1, NOW), snapshot('1003'));
    await files.write(snapshotName('aa', 2, NOW + 1), snapshot('1017'));
    await files.write(snapshotName('aa', 3, NOW + 2), snapshot(null));
    const checked = await checkKept({ files, identity: IDENTITY, vmIds: ['1009', '1003'], openDb });
    expect(checked.map((k) => k.checked)).toEqual(['ok', 'other', 'other']);
  });

  // Decryption takes seconds on the phone: a few at a time, newest first (the newest decides the warning).
  it('checks at most a few a visit, newest first', async () => {
    const files = memoryFiles();
    for (let v = 1; v <= 5; v++) await files.write(snapshotName('aa', v, NOW + v), snapshot());
    const first = await checkKept({ files, identity: IDENTITY, vmIds: ['1009'], openDb, limit: 3 });
    expect(first.map((k) => [k.version, k.checked])).toEqual([[1, undefined], [2, undefined], [3, 'ok'], [4, 'ok'], [5, 'ok']]);
    const second = await checkKept({ files, identity: IDENTITY, vmIds: ['1009'], openDb, limit: 3 });
    expect(second.every((k) => k.checked === 'ok')).toBe(true);
  });
});

describe('checkKept with errors', () => {
  it('leaves a snapshot unmarked when reading or opening it throws, and checks it on the next visit', async () => {
    for (const fail of ['read', 'open']) {
      const files = memoryFiles();
      await files.write(snapshotName('aa', 1, NOW), snapshot());
      let broken = true;
      const flaky = { ...files, read: async (n: string) => (fail === 'read' && broken ? Promise.reject(new Error('io')) : files.read(n)) };
      const open = async (b: Uint8Array) => {
        if (fail === 'open' && broken) throw new Error('native');
        return openDb(b);
      };
      expect((await checkKept({ files: flaky, identity: IDENTITY, vmIds: ['1009'], openDb: open })).map((k) => k.checked)).toEqual([undefined]);
      expect((await files.list()).map((k) => k.checked)).toEqual([undefined]);
      broken = false;
      expect((await checkKept({ files: flaky, identity: IDENTITY, vmIds: ['1009'], openDb: open })).map((k) => k.checked)).toEqual(['ok']);
    }
  });

  it('marks unreadable a file that cannot be decrypted, or isn\'t a database', async () => {
    const files = memoryFiles();
    const bytes = snapshot();
    const corrupt = bytes.slice();
    corrupt[corrupt.length - 5] ^= 0xff;
    await files.write(snapshotName('aa', 1, NOW), corrupt);
    await files.write(snapshotName('aa', 2, NOW + 1), snapshot());
    const open = async (b: Uint8Array) => (b.length ? null : 'x');
    const r = await checkKept({ files, identity: IDENTITY, vmIds: ['1009'], openDb: open });
    expect(r.map((k) => k.checked)).toEqual(['unreadable', 'unreadable']);
  });
});

describe('backupView', () => {
  const status = (o: Partial<BackupStatus> = {}): BackupStatus => ({
    installId: 'aa', recipient: RECIPIENT, latest: { version: 3, created: NOW - 3600, size: 10, sha256: '' },
    lastCheckIn: NOW - 1800, lastDownload: NOW - 1800, problem: '', ...o,
  });
  const k = (checked?: 'ok' | 'unreadable' | 'other'): Kept[] => [{ name: 'n', installId: 'aa', version: 3, created: NOW - 3600, checked }];

  // The check-in before this one is the background job's, when the app was closed.
  it('says when the last backup was fetched, how many are kept, and when the phone last checked in', () => {
    expect(backupView(status(), k('ok'), RECIPIENT, NOW, 0)).toEqual({
      lines: ['Last one today at 13:43', '1 kept on this phone', 'This phone last checked today at 13:43'], warnings: [], lastFetch: NOW - 1800,
    });
    expect(backupView(status({ lastCheckIn: 0 }), k('ok'), RECIPIENT, NOW, 0).lines).toEqual(['Last one today at 13:43', '1 kept on this phone']);
    expect(backupView(null, [], RECIPIENT, NOW, 0)).toEqual({ lines: ['No backup on this phone yet'], warnings: [], lastFetch: null });
    expect(backupView(status({ lastDownload: 0 }), k('ok'), RECIPIENT, NOW, 0).lastFetch).toBeNull();
  });

  it('warns after 24 hours without backups reaching a phone, and of every other problem', () => {
    const day = 86400;
    expect(backupView(status({ latest: { version: 3, created: NOW - day - 60, size: 10, sha256: '' }, lastDownload: NOW - 2 * day }), k('ok'), RECIPIENT, NOW, 0).warnings)
      .toEqual(['A backup waited over a day for this phone. Android may be holding the app back: open it now and then.']);
    expect(backupView(status({ lastCheckIn: NOW - day - 60 }), k('ok'), RECIPIENT, NOW, 0).warnings)
      .toEqual(['No phone checked for backups for over a day. Android may be holding the app back: open it now and then.']);
    expect(backupView(status({ lastCheckIn: 0 }), k('ok'), RECIPIENT, NOW, 0).warnings).toEqual([]); // the first check-in
    expect(backupView(status({ problem: 'no backup key yet' }), k('ok'), RECIPIENT, NOW, 0).warnings).toEqual(["Your server can't make backups: no backup key yet."]);
    // The server's own words, cut short: a compromised VM can't write paragraphs into the app.
    expect(backupView(status({ problem: 'x'.repeat(500) }), k('ok'), RECIPIENT, NOW, 0).warnings[0].length).toBeLessThan(250);
    expect(backupView(status({ recipient: 'age1other' }), k('ok'), RECIPIENT, NOW, 0).warnings)
      .toEqual(["Your server's backups aren't locked to your recovery phrase. Update your server to fix it."]);
    expect(backupView(status(), k('unreadable'), RECIPIENT, NOW, 0).warnings).toEqual(["The latest backup on this phone can't be opened with your recovery phrase."]);
    expect(backupView(status(), k('other'), RECIPIENT, NOW, 0).warnings)
      .toEqual(["The latest backup on this phone opens with your recovery phrase, but it is another server's, not this one's."]);
  });

  // The server's status is from before this visit's download: a fetch just made shows its own time.
  it('shows this visit\'s fetch time, while the warnings still come from the status before it', () => {
    const old = status({ latest: { version: 3, created: NOW - 86400 - 60, size: 10, sha256: '' }, lastDownload: NOW - 3 * 86400 });
    const v = backupView(old, k('ok'), RECIPIENT, NOW, 0, NOW);
    expect(v.lines).toEqual(['Last one today at 14:13', '1 kept on this phone', 'This phone last checked today at 13:43']);
    expect(v.warnings).toEqual(['A backup waited over a day for this phone. Android may be holding the app back: open it now and then.']);
    expect(backupView(status({ lastDownload: 0 }), k('ok'), RECIPIENT, NOW, 0, NOW)).toMatchObject({ lines: ['Last one today at 14:13', '1 kept on this phone', 'This phone last checked today at 13:43'], lastFetch: NOW });
  });
});

describe('foregroundBackups', () => {
  // When the server page opens: fetch, then check what was fetched with the phrase.
  it('fetches and checks, giving the server\'s answer and what is kept', async () => {
    const { cardd, deps } = setup();
    cardd.addSnapshot(snapshot());
    let checks = 0;
    const r = await foregroundBackups({ ...deps, identity: IDENTITY, vmIds: ['1009'], openDb: async (p) => (checks++, openDb(p)), onRevoked: async () => {} });
    expect(r.result).toMatchObject({ kind: 'fetched' });
    expect(r.status?.latest?.version).toBe(1);
    expect(r.kept.map((k) => k.checked)).toEqual(['ok']);
    expect(checks).toBe(1);
  });

  it('stops at a revoked phone, checking nothing', async () => {
    const { cardd, deps } = setup();
    cardd.revoked.add(vectors.deviceAuth.keyId);
    let stopped = 0;
    const r = await foregroundBackups({ ...deps, identity: IDENTITY, vmIds: ['1009'], openDb, onRevoked: async () => void stopped++ });
    expect([r.result.kind, stopped, r.kept]).toEqual(['revoked', 1, []]);
  });

  // The server can't be reached: what the phone keeps is still checked and shown.
  it('still checks what is kept when the server can\'t be reached', async () => {
    const { files, deps } = setup();
    await files.write(snapshotName('aa', 1, NOW), snapshot());
    const offline = { backups: async () => { throw new Error('fetch failed'); }, backupFile: async () => new Uint8Array() };
    const r = await foregroundBackups({ ...deps, cardd: offline, identity: IDENTITY, vmIds: ['1009'], openDb, onRevoked: async () => {} });
    expect([r.status, r.result.kind, r.kept.map((k) => k.checked)]).toEqual([null, 'unreachable', ['ok']]);
  });

  it('keeps the server\'s answer when a later step fails for another reason than the network', async () => {
    const { cardd, files, deps } = setup();
    cardd.addSnapshot(snapshot());
    cardd.backupProblem = 'no backup key yet';
    const broken = { ...files, write: async () => { throw new Error('disk full'); } };
    const r = await foregroundBackups({ ...deps, files: broken, identity: IDENTITY, vmIds: ['1009'], openDb, onRevoked: async () => {} });
    expect(r.result).toEqual({ kind: 'failed', reason: 'disk full' });
    expect(r.status?.latest?.version).toBe(1);
    expect(backupView(r.status, r.kept, RECIPIENT, NOW, 0).warnings).toEqual(["Your server can't make backups: no backup key yet."]);
  });

  it('counts a network failure after the status, and an aborted download, as unreachable, keeping the status', async () => {
    for (const err of [new TypeError('fetch failed: ECONNRESET'), Object.assign(new Error('aborted'), { name: 'AbortError' })]) {
      const { cardd, files, deps } = setup();
      cardd.addSnapshot(snapshot());
      await files.write(snapshotName('aa', 1, NOW), snapshot());
      const flaky = { backups: (...a: []) => deps.cardd.backups(...a), backupFile: async () => { throw err; } };
      const r = await foregroundBackups({ ...deps, cardd: flaky, identity: IDENTITY, vmIds: ['1009'], openDb, onRevoked: async () => {} });
      expect([r.result.kind, r.status?.latest?.version, r.kept.map((k) => k.checked)]).toEqual(['unreachable', 1, ['ok']]);
    }
  });

  // Caddy answers 502 (or 503, 504) while cardd restarts, as during Update server: cardd didn't answer.
  it("counts the proxy's 502 for the status or the download as unreachable, and the job notes that cardd didn't answer", async () => {
    const { cardd, files } = setup();
    cardd.addSnapshot(snapshot());
    await files.write(snapshotName('aa', 1, NOW), snapshot());
    const proxied = (down: string) =>
      new CarddClient({
        fetch: async (url, init) => (String(url).includes(down) ? new Response('', { status: 502 }) : cardd.http.fetch(url, init)),
        host: 'vm-1009.lnvps.cloud', key: vectorDeviceKey(), now: () => NOW * 1000,
      });
    for (const down of ['/api/v1/backups', '/api/v1/backups/']) {
      const r = await foregroundBackups({ cardd: proxied(down), files, recipient: RECIPIENT, identity: IDENTITY, vmIds: ['1009'], openDb, onRevoked: async () => {} });
      expect(r.result.kind).toBe('unreachable');
    }
    const noted: boolean[] = [];
    const job = backupJob({ cardd: proxied('/api/v1/backups'), files, recipient: RECIPIENT, onRevoked: async () => {}, noteAnswered: async (a) => void noted.push(a) });
    await expect(job).rejects.toThrow('HTTP 502'); // the task runner sees it, as a network failure
    expect(noted).toEqual([false]);
  });

  // An older cardd, without the backups API, authenticates, then answers Go's text 404.
  it('says quietly that a server without the backups API makes none, still checking what is kept', async () => {
    const { cardd, files } = setup();
    await files.write(snapshotName('aa', 1, NOW), snapshot());
    const old = new CarddClient({
      fetch: async (url, init) => (String(url).includes('/api/v1/backups') ? new Response('404 page not found\n', { status: 404 }) : cardd.http.fetch(url, init)),
      host: 'vm-1009.lnvps.cloud', key: vectorDeviceKey(), now: () => NOW * 1000,
    });
    const r = await foregroundBackups({ cardd: old, files, recipient: RECIPIENT, identity: IDENTITY, vmIds: ['1009'], openDb, onRevoked: async () => {} });
    expect([r.status, r.result.kind, r.kept.map((k) => k.checked)]).toEqual([null, 'no_backups_api', ['ok']]);
    expect(await backupJob({ cardd: old, files, recipient: RECIPIENT, onRevoked: async () => {} })).toEqual({ kind: 'no_backups_api' });
  });
});

// A rebuild compares its backup with the newest the server last reported
//, so the phone notes it at every answer: the
// note outlives the VM.
describe("the server's latest note", () => {
  const noting = () => {
    const notes: ServerLatest[] = [];
    return { notes, noteLatest: async (l: ServerLatest) => void notes.push(l) };
  };

  it('is noted by the background job at every answer that names a snapshot, whatever the download does', async () => {
    const { cardd, deps, tick } = setup();
    const { notes, noteLatest } = noting();
    const job = (cardd: FetchDeps['cardd'] = deps.cardd) => backupJob({ ...deps, cardd, noteLatest, onRevoked: async () => {} });
    expect(await job()).toEqual({ kind: 'none' });
    expect(notes).toEqual([]);
    cardd.addSnapshot(snapshot());
    await job();
    await job(); // up to date
    tick(3600);
    cardd.addSnapshot(snapshot());
    cardd.backupRecipient = 'age1someoneelse';
    expect(await job()).toEqual({ kind: 'foreign_recipient' });
    cardd.backupRecipient = RECIPIENT;
    tick(3600);
    cardd.addSnapshot(snapshot());
    const offline = { backups: () => deps.cardd.backups(), backupFile: async () => { throw new TypeError('fetch failed'); } };
    await expect(job(offline)).rejects.toThrow('fetch failed');
    const id = cardd.backupInstallId;
    expect(notes).toEqual([
      { installId: id, version: 1, created: NOW },
      { installId: id, version: 1, created: NOW },
      { installId: id, version: 2, created: NOW + 3600 },
      { installId: id, version: 3, created: NOW + 7200 },
    ]);
  });

  it('is noted when the server page fetches', async () => {
    const { cardd, deps } = setup();
    const { notes, noteLatest } = noting();
    cardd.addSnapshot(snapshot());
    await foregroundBackups({ ...deps, noteLatest, identity: IDENTITY, vmIds: ['1009'], openDb, onRevoked: async () => {} });
    expect(notes).toEqual([{ installId: cardd.backupInstallId, version: 1, created: NOW }]);
  });
});
