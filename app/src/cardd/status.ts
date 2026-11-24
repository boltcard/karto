// What the app shows about its server on open: reachable, paired, and
// whether this app carries a newer server ("Update server").
import { NoDeviceKeyError } from '../native/deviceKey';
import { CarddClient, CarddError, type DiskAnswer, type DnsAnswer } from './client';

export type ServerStatus =
  | {
      kind: 'ok'; version: string; updateAvailable: boolean; /** cardd's schema (Send's note needs 8); an older cardd doesn't say. */ schema?: number;
      /** Whether the server's name has an IPv4 address pointing at it; an older cardd doesn't say. */ dns?: DnsAnswer;
      /** How full the server's disk is; an older cardd doesn't say. */ disk?: DiskAnswer;
    }
  /** noKey: the phone has no key to sign with; without it, the server refused the key it has. */
  | { kind: 'not_paired'; message: string; noKey?: true }
  | { kind: 'unreachable'; message: string };

export async function serverStatus(cardd: CarddClient, appBundleSha: string): Promise<ServerStatus> {
  try {
    const s = await cardd.server();
    const disk = parseDisk(s.disk);
    return { kind: 'ok', version: s.version, updateAvailable: s.bundle !== appBundleSha, schema: s.schema, ...(s.dns ? { dns: s.dns } : {}), ...(disk ? { disk } : {}) };
  } catch (e) {
    if (e instanceof NoDeviceKeyError) {
      return { kind: 'not_paired', noKey: true, message: 'This phone has no device key (was the app restored from a backup?). Pairing again comes with restore.' };
    }
    if (e instanceof CarddError && e.status === 401) return { kind: 'not_paired', message: `The server does not accept this phone's key: ${e.message}` };
    return { kind: 'unreachable', message: e instanceof Error ? e.message : String(e) };
  }
}

const bytes = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

/** cardd's disk answer as the wallet takes it; anything not that shape is dropped, never shown. */
export function parseDisk(x: unknown): DiskAnswer | undefined {
  if (typeof x !== 'object' || x === null) return undefined;
  const d = x as Record<string, unknown>;
  if (!bytes(d.freeBytes) || !bytes(d.totalBytes)) return undefined;
  if (d.level !== undefined && d.level !== 'low' && d.level !== 'critical') return undefined;
  const known = d.freeableBytes !== undefined || d.rebuildHelps !== undefined;
  if (known && (!bytes(d.freeableBytes) || typeof d.rebuildHelps !== 'boolean')) return undefined;
  return {
    freeBytes: d.freeBytes, totalBytes: d.totalBytes,
    ...(known ? { freeableBytes: d.freeableBytes as number, rebuildHelps: d.rebuildHelps as boolean } : {}),
    ...(d.level ? { level: d.level as 'low' | 'critical' } : {}),
  };
}

/** The line under the server after Update server, from a fresh status check. */
export function updateOutcome(after: ServerStatus): { ok: boolean; text: string } {
  if (after.kind !== 'ok') return { ok: false, text: `The update ran, but the server can't be checked: ${after.message}` };
  if (after.updateAvailable) return { ok: false, text: 'The server still runs the old version. Try Update server again.' };
  return { ok: true, text: `Updated to cardd ${after.version}.` };
}
