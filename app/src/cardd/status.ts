// What the app shows about its server on open: reachable, paired, and
// whether this app carries a newer server ("Update server").
import { NoDeviceKeyError } from '../native/deviceKey';
import { CarddClient, CarddError, type DnsAnswer } from './client';

export type ServerStatus =
  | {
      kind: 'ok'; version: string; updateAvailable: boolean; /** cardd's schema (Send's note needs 8); an older cardd doesn't say. */ schema?: number;
      /** Whether the server's name has an IPv4 address pointing at it; an older cardd doesn't say. */ dns?: DnsAnswer;
    }
  /** noKey: the phone has no key to sign with; without it, the server refused the key it has. */
  | { kind: 'not_paired'; message: string; noKey?: true }
  | { kind: 'unreachable'; message: string };

export async function serverStatus(cardd: CarddClient, appBundleSha: string): Promise<ServerStatus> {
  try {
    const s = await cardd.server();
    return { kind: 'ok', version: s.version, updateAvailable: s.bundle !== appBundleSha, schema: s.schema, ...(s.dns ? { dns: s.dns } : {}) };
  } catch (e) {
    if (e instanceof NoDeviceKeyError) {
      return { kind: 'not_paired', noKey: true, message: 'This phone has no device key (was the app restored from a backup?). Pairing again comes with restore.' };
    }
    if (e instanceof CarddError && e.status === 401) return { kind: 'not_paired', message: `The server does not accept this phone's key: ${e.message}` };
    return { kind: 'unreachable', message: e instanceof Error ? e.message : String(e) };
  }
}

/** The line under the server after Update server, from a fresh status check. */
export function updateOutcome(after: ServerStatus): { ok: boolean; text: string } {
  if (after.kind !== 'ok') return { ok: false, text: `The update ran, but the server can't be checked: ${after.message}` };
  if (after.updateAvailable) return { ok: false, text: 'The server still runs the old version. Try Update server again.' };
  return { ok: true, text: `Updated to cardd ${after.version}.` };
}
