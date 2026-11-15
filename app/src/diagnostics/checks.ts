// On-phone checks for the native layer: run by the diagnostics
// screen against a throwaway SSH server, reached through `adb reverse` on Android
// (deploy/test/phone-diag.sh) and over the local network on an iPhone
// (deploy/test/iphone-diag.sh). Each check reports instead of throwing.
import { p256 } from '@noble/curves/nist.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { isValidPhrase, newPhrase } from '../keys/derive';
import { canonical } from '../cardd/deviceauth';
import { uploadBundle, type BundleFile } from '../onboarding/install';
import { HostKeyMismatchError, SshAuthError } from '../onboarding/ssh';
import type { CardNativeApi } from '../native/api';
import type { CardNfcApi } from '../native/nfc';
import { nativeSsh } from '../native/ssh';

export type CheckResult = { name: string; ok: boolean; detail: string };

/** "host:port:user:hostKeyBlob:seedHex", from EXPO_PUBLIC_DIAG_SSH at build time. */
export type SshTarget = { host: string; port: number; user: string; hostKeyBlob: string; seed: string };

export function parseTarget(s: string | undefined): SshTarget | undefined {
  const parts = (s ?? '').split(':');
  if (parts.length !== 5) return undefined;
  return { host: parts[0], port: Number(parts[1]), user: parts[2], hostKeyBlob: parts[3], seed: parts[4] };
}

async function check(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The iPhone's card reader with no card in hand: Apple's
 * sheet opens when the app asks and ends when the app asks, and exactly one end is reported for it. It shows the
 * reader is allowed for this app and that a session's life is reported as the app counts on. It waits up to ten
 * seconds for the end, and three more for a second end that must not come. sleep: the wait, for a test to shorten.
 */
export async function sheetCheck(nfc: CardNfcApi, sleep: (ms: number) => Promise<void> = pause): Promise<string> {
  let ends = 0;
  let code: number | undefined;
  const sub = nfc.addListener('nfcEnd', (e) => {
    ends++;
    code = e.code;
  });
  try {
    await nfc.nfcScan!('Karto Diagnostics is checking the card reader.');
    await nfc.nfcFail!('The check is done. No card is needed.');
    for (let i = 0; i < 100 && ends === 0; i++) await sleep(100);
    assert(ends > 0, 'no end was reported within 10 seconds of asking for it');
    for (let i = 0; i < 30; i++) await sleep(100);
    assert(ends === 1, `${ends} ends were reported for one sheet`);
    return `the sheet opened and ended when asked (iOS code ${code})`;
  } finally {
    sub.remove();
  }
}

/** nfc: the module's card reader; where it reads cards in a session and the phone has a reader (an iPhone), the sheet is checked too. */
export async function runChecks(
  native: CardNativeApi, bundle: BundleFile[], target?: SshTarget, nfc?: CardNfcApi, sleep?: (ms: number) => Promise<void>,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(await check('random', async () => {
    const a = new Uint8Array(32);
    globalThis.crypto.getRandomValues(a);
    assert(a.some((b) => b !== 0), 'getRandomValues returned zeros');
    const phrase = newPhrase();
    assert(isValidPhrase(phrase), 'newPhrase gave an invalid phrase');
    return '32 random bytes and a valid 12-word phrase';
  }));
  results.push(await check('date-header', async () => {
    // LNVPS's Date header (IMF-fixdate); the clock-skew retry depends on parsing it.
    const t = Date.parse('Sat, 03 Oct 2026 12:00:00 GMT');
    assert(t === Date.UTC(2026, 9, 3, 12, 0, 0), `Date.parse gave ${t}`);
    return 'IMF-fixdate parses';
  }));
  // Run again after the SSH checks: connecting installs the full BouncyCastle, and the Keystore
  // key must still sign afterwards (every request to cardd is signed after onboarding's SSH steps).
  const deviceKeyCheck = async () => {
    const made = await native.deviceKeyCreate();
    const pub = await native.devicePublicKey();
    assert(made === pub, 'deviceKeyCreate and devicePublicKey disagree');
    assert(/^04[0-9a-f]{128}$/.test(pub), `public key is not an uncompressed P-256 point: ${pub}`);
    const msg = canonical('POST', '/api/v1/cards', 1790000000, '{}');
    const sig = await native.deviceSign(msg);
    const strict = p256.verify(hexToBytes(sig), utf8ToBytes(msg), hexToBytes(pub), { format: 'der' });
    const anyS = p256.verify(hexToBytes(sig), utf8ToBytes(msg), hexToBytes(pub), { format: 'der', lowS: false });
    assert(anyS, `signature does not verify (strict=${strict}, anyS=${anyS}, sig=${sig})`);
    const again = await native.devicePublicKey();
    assert(again === pub, 'device key changed between calls');
    return `verifies; StrongBox: ${await native.deviceKeyIsStrongBox()}`;
  };
  results.push(await check('device-key', deviceKeyCheck));
  // Only where there is a reader: a simulator's module reads in a session too, and has none.
  if (nfc?.nfcMode === 'session' && (await nfc.nfcState()) === 'on') results.push(await check('nfc-sheet', () => sheetCheck(nfc, sleep)));
  if (!target) {
    results.push({ name: 'ssh', ok: false, detail: 'no SSH target (build with EXPO_PUBLIC_DIAG_SSH)' });
    return results;
  }
  const connect = nativeSsh(native);
  const opts = { host: target.host, port: target.port, user: target.user, ed25519Seed: target.seed };
  results.push(await check('ssh-exec', async () => {
    const s = await connect({ ...opts, hostKey: { keyType: 'ssh-ed25519', publicKey: target.hostKeyBlob } });
    try {
      const r = await s.exec('wc -c; exit 3', 'prosper short ramp\n');
      assert(r.code === 3 && r.stdout.trim() === '19', `got ${JSON.stringify(r)}`);
    } finally {
      await s.close();
    }
    return 'stdin and exit code come through';
  }));
  results.push(await check('ssh-upload-bundle', async () => {
    const s = await connect({ ...opts, hostKey: { keyType: 'ssh-ed25519', publicKey: target.hostKeyBlob } });
    try {
      await uploadBundle(s, bundle);
      const r = await s.exec('stat -c "%a %s %n" card-app/bin/cardd card-app/install.sh');
      return r.stdout.trim().replace(/\n/g, '; ');
    } finally {
      await s.close();
    }
  }));
  results.push(await check('ssh-pin', async () => {
    const wrong = 'AAAAC3NzaC1lZDI1NTE5AAAAIM7OaJ/OiX8fQqSebMIWCvTHRxCAl3j+ZDKh4HZao3gE';
    try {
      await connect({ ...opts, hostKey: { keyType: 'ssh-ed25519', publicKey: wrong } });
    } catch (e) {
      assert(e instanceof HostKeyMismatchError, `wrong error: ${e}`);
      return 'a server with another key is refused';
    }
    throw new Error('connected to a server whose key was not pinned');
  }));
  results.push(await check('ssh-auth', async () => {
    try {
      const s = await connect({ ...opts, ed25519Seed: '11'.repeat(32), hostKey: { keyType: 'ssh-ed25519', publicKey: target.hostKeyBlob } });
      await s.close();
    } catch (e) {
      assert(e instanceof SshAuthError, `wrong error: ${e}`);
      return 'a key the server does not know is refused as SshAuthError';
    }
    throw new Error('the server let in a key it does not know');
  }));
  results.push(await check('ssh-concurrent', async () => {
    // install.sh docker (the install's long step, once system's) runs for minutes: other native calls (signing, storage) must not queue behind it.
    const s = await connect({ ...opts, hostKey: { keyType: 'ssh-ed25519', publicKey: target.hostKeyBlob } });
    try {
      let execDone = false;
      const running = s.exec('sleep 3').then((r) => { execDone = true; return r; });
      await native.deviceSign('concurrency');
      const signedFirst = !execDone;
      const r = await running;
      assert(r.code === 0, `sleep exited ${r.code}`);
      assert(signedFirst, 'deviceSign waited for the SSH command to finish');
      return 'deviceSign answers while a command runs';
    } finally {
      await s.close();
    }
  }));
  results.push(await check('device-key-after-ssh', deviceKeyCheck));
  return results;
}
