import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { memoryFiles } from '../testing/memoryFiles';
import { nodeInspectSnapshot } from '../testing/snapshotSqlite';
import { vectors } from '../testing/vectors';
import { ageEncrypt, ageRecipientOf } from './age';
import { parseName, snapshotName } from './backups';
import { CARDD_SCHEMA_VERSION } from '../deploy/schema';
import { contentsOf, importName, keepImported, inspectKept, QUICK_CHECK_SQL, readContents, SnapshotUnreadable, SUMMARY_SQL } from './summary';

const vector = (name: string) => readFileSync(join(__dirname, '..', '..', '..', 'testvectors', name));
/** A snapshot cardd made, and what cardd's own functions read from it (server/internal/store/snapshotvector_test.go). */
const db = new Uint8Array(vector('snapshot.db'));
const want = JSON.parse(vector('snapshot.json').toString('utf8'));
const RECIPIENT = vectors.phrase.backupAgeRecipient;
const IDENTITY = vectors.phrase.backupAgeIdentity;
const OTHER = ageRecipientOf(bech32.encode('age-secret-key-', bech32.toWords(new Uint8Array(32).fill(7)), false).toUpperCase());

/** An SQLite database made by create, as bytes. */
function sqlite(create: string): Uint8Array {
  const path = join(mkdtempSync(join(tmpdir(), 'summary-')), 'x.db');
  const d = new DatabaseSync(path);
  d.exec(create);
  d.close();
  return new Uint8Array(readFileSync(path));
}

/**
 * cardd's snapshot with a table the summary doesn't read, whose root page is then
 * damaged: the summary still reads, but the database isn't whole.
 */
function damaged(): Uint8Array {
  const path = join(mkdtempSync(join(tmpdir(), 'summary-')), 'x.db');
  writeFileSync(path, db);
  const d = new DatabaseSync(path);
  d.exec(`CREATE TABLE extra (x TEXT); INSERT INTO extra VALUES ('a'), ('b')`);
  const { rootpage } = d.prepare(`SELECT rootpage FROM sqlite_schema WHERE name = 'extra'`).get() as { rootpage: number };
  d.close();
  const bytes = new Uint8Array(readFileSync(path));
  const pageSize = ((bytes[16] << 8) | bytes[17]) === 1 ? 65536 : (bytes[16] << 8) | bytes[17];
  bytes[(rootpage - 1) * pageSize] = 0; // no such b-tree page type
  return bytes;
}

describe('the summary SQL', () => {
  // The rebuild's step 1 shows the time, the cards and the total balance, worked out as cardd does.
  it("reads a snapshot cardd made as cardd's own functions do", async () => {
    expect(await nodeInspectSnapshot(db)).toEqual(want);
    expect(want).toMatchObject({ vmId: '1004', cards: 3 });
  });

  it("is null for anything that isn't a cardd database", async () => {
    expect(await nodeInspectSnapshot(new Uint8Array())).toBeNull();
    expect(await nodeInspectSnapshot(new TextEncoder().encode('not a database'))).toBeNull();
    expect(await nodeInspectSnapshot(sqlite(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`))).toBeNull();
  });

  // A damaged file must not be restored, nor kept as if it were a backup.
  it('is null for a database that fails its quick check, even where the summary reads', async () => {
    const bytes = damaged();
    const path = join(mkdtempSync(join(tmpdir(), 'summary-')), 'x.db');
    writeFileSync(path, bytes);
    const d = new DatabaseSync(path, { readOnly: true });
    expect(contentsOf(d.prepare(SUMMARY_SQL).get())).toEqual(want);
    expect(d.prepare(QUICK_CHECK_SQL).get()).not.toEqual({ quick_check: 'ok' });
    d.close();
    expect(await nodeInspectSnapshot(bytes)).toBeNull();
  });

  // The phone failing to read a database (its memory, the native module) says nothing about the backup: never taken for one that isn't.
  it("throws when reading fails other than by SQLite's verdict on the file", async () => {
    const failing = (message: string) => ({ get: async () => { throw new Error(message); } });
    const closed = 'Call to function \'NativeStatement.getFirstAsync\' has been rejected. Caused by: Access to closed resource';
    await expect(readContents(failing(closed))).rejects.toThrow(SnapshotUnreadable);
    await expect(readContents(failing(closed))).rejects.toThrow(`The backup couldn't be opened on this phone: ${closed}`);
    for (const verdict of ['Error code \u001a: file is not a database', 'no such table: cards', 'database disk image is malformed', 'unsupported file format']) {
      expect(await readContents(failing(verdict))).toBeNull();
    }
  });
});

describe('a newer schema', () => {
  // A newer cardd may rename a column the summary reads: only its version is read then.
  it('is reported as newer, not as unreadable, even where the summary SQL fails', async () => {
    const newer = sqlite(`CREATE TABLE meta (k TEXT); PRAGMA user_version = ${CARDD_SCHEMA_VERSION + 1}`);
    expect(await nodeInspectSnapshot(newer)).toMatchObject({ userVersion: CARDD_SCHEMA_VERSION + 1 });
    const file = ageEncrypt(newer, RECIPIENT);
    await expect(importName('x.age', file, { identity: IDENTITY, open: nodeInspectSnapshot })).rejects.toThrow('newer version of the server');
  });
});

describe('inspectKept', () => {
  const open = nodeInspectSnapshot;

  // The time is the kept file's: the database doesn't hold when its snapshot was taken.
  it('opens a kept snapshot with the phrase, its time from its name', async () => {
    const files = memoryFiles();
    const name = snapshotName('ab'.repeat(16), 7, 1_790_100_000);
    await files.write(name, ageEncrypt(db, RECIPIENT));
    expect(await inspectKept({ files, identity: IDENTITY, open }, name)).toEqual({
      vmId: want.vmId, userVersion: want.userVersion, cards: want.cards, totalMsat: want.totalMsat, created: 1_790_100_000,
    });
  });

  it("is null for one the phrase can't open or that isn't a cardd database, and throws when the file can't be read", async () => {
    const files = memoryFiles();
    const foreign = snapshotName('ab'.repeat(16), 1, 1_790_000_000);
    const junk = snapshotName('ab'.repeat(16), 2, 1_790_000_000);
    await files.write(foreign, ageEncrypt(db, OTHER));
    await files.write(junk, ageEncrypt(new TextEncoder().encode('not a database'), RECIPIENT));
    expect(await inspectKept({ files, identity: IDENTITY, open }, foreign)).toBeNull();
    expect(await inspectKept({ files, identity: IDENTITY, open }, junk)).toBeNull();
    await expect(inspectKept({ files, identity: IDENTITY, open }, snapshotName('ab'.repeat(16), 3, 1))).rejects.toThrow('no ');
  });

  it("throws when the phone can't open a database the phrase decrypts", async () => {
    const files = memoryFiles();
    const name = snapshotName('ab'.repeat(16), 7, 1_790_100_000);
    await files.write(name, ageEncrypt(db, RECIPIENT));
    const unreadable = async () => {
      throw new SnapshotUnreadable('out of memory');
    };
    await expect(inspectKept({ files, identity: IDENTITY, open: unreadable }, name)).rejects.toThrow(SnapshotUnreadable);
    await expect(importName(name, await files.read(name), { identity: IDENTITY, open: unreadable })).rejects.toThrow(SnapshotUnreadable);
  });
});

describe('importName', () => {
  const file = ageEncrypt(db, RECIPIENT);
  const d = { identity: IDENTITY, open: nodeInspectSnapshot };

  it('keeps the name of an exported snapshot', async () => {
    const name = snapshotName('ab'.repeat(16), 7, 1_790_100_000);
    expect(await importName(name, file, d)).toBe(name);
  });

  // Renamed by the person: named from its content, never as a real snapshot (version 0), the same each time.
  it('names a renamed one from its content: its hash, version 0 and its last change', async () => {
    const name = await importName('backup (1).age', file, d);
    expect(name).toBe(`${bytesToHex(sha256(file)).slice(0, 32)}-0-${want.changed}.age`);
    expect(parseName(name)).toEqual({ installId: bytesToHex(sha256(file)).slice(0, 32), version: 0, created: want.changed });
    expect(await importName('', file, d)).toBe(name);
  });

  it("refuses a renamed file the phrase can't open, or that isn't a cardd database", async () => {
    await expect(importName('x.age', ageEncrypt(db, OTHER), d)).rejects.toThrow("isn't a backup your recovery phrase opens");
    await expect(importName('x.age', ageEncrypt(new Uint8Array(10), RECIPIENT), d)).rejects.toThrow("isn't a backup your recovery phrase opens");
  });
});

describe('importName and keepImported: a file never replaces a kept backup', () => {
  const d = { identity: IDENTITY, open: nodeInspectSnapshot };
  const name = snapshotName('ab'.repeat(16), 7, 1_790_100_000);

  it("opens a file with a snapshot's name too: one the phrase can't open is refused", async () => {
    await expect(importName(name, ageEncrypt(db, OTHER), d)).rejects.toThrow("isn't a backup your recovery phrase opens");
    await expect(importName(name, new Uint8Array(10), d)).rejects.toThrow("isn't a backup your recovery phrase opens");
  });

  it('leaves a kept file of that name untouched, and accepts the identical file again', async () => {
    const files = memoryFiles();
    const good = ageEncrypt(db, RECIPIENT);
    await files.write(name, good);
    await files.mark(name, 'ok');
    await expect(keepImported(name, good.slice(0, 50), files)).rejects.toThrow('already kept');
    expect(await files.read(name)).toEqual(good);
    expect(await keepImported(name, good.slice(), files)).toBe(name);
    expect((await files.list())[0].checked).toBe('ok');
    const other = snapshotName('cd'.repeat(16), 1, 1_790_000_000);
    expect(await keepImported(other, good, files)).toBe(other);
    expect((await files.list()).map((k) => k.name).sort()).toEqual([name, other].sort());
  });
});
