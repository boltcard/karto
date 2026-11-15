// The phone diagnostics' backup check (make phone-backup-probe):
// before the screens rely on it, prove on the phone that the
// app's own age decryption and expo-sqlite's opening from memory work on
// Hermes for a database of a few MB, and how long they take.
import { bech32 } from '@scure/base';
import { randomBytes } from '@noble/hashes/utils.js';
import { ageDecrypt, ageEncrypt, ageRecipientOf } from '../backup/age';
import type { CheckResult } from './checks';

export async function probeBackup(d: {
  /** A database of `rows` 1,000-byte rows with meta vm.id, serialised. */
  makeDb: (rows: number, vmId: string) => Promise<Uint8Array>;
  /** meta vm.id of a serialised database, opened from memory. */
  openDb: (plain: Uint8Array) => Promise<string | null>;
  rows: number;
  now: () => number;
}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const timed = async <T>(name: string, fn: () => Promise<T> | T, detail: (v: T, ms: number) => string, ok: (v: T) => boolean = () => true) => {
    const t0 = d.now();
    try {
      const v = await fn();
      out.push({ name, ok: ok(v), detail: detail(v, Math.round(d.now() - t0)) });
      return v;
    } catch (e) {
      out.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };
  const identity = bech32.encode('age-secret-key-', bech32.toWords(randomBytes(32)), false).toUpperCase();
  const db = await timed('make', () => d.makeDb(d.rows, 'probe'), (b, ms) => `${(b.length / 1e6).toFixed(1)} MB in ${ms} ms`);
  if (!db) return out;
  const enc = await timed('encrypt', () => ageEncrypt(db, ageRecipientOf(identity)), (_, ms) => `${ms} ms`);
  if (!enc) return out;
  const plain = await timed('decrypt', () => ageDecrypt(enc, identity), (p, ms) => `${ms} ms`, (p) => p.length === db.length);
  if (!plain) return out;
  await timed('open', () => d.openDb(plain), (v, ms) => `vm.id ${v} in ${ms} ms`, (v) => v === 'probe');
  return out;
}
