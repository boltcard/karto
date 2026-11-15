import { describe, expect, it } from 'vitest';
import { p256 } from '@noble/curves/nist.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { parseTarget, runChecks, sheetCheck } from './checks';
import type { CardNativeApi } from '../native/api';
import type { CardNfcApi, NfcEndEvent } from '../native/nfc';
import { vectors } from '../testing/vectors';

const d = vectors.deviceAuth;
const native = (over: Partial<CardNativeApi> = {}): CardNativeApi => ({
  deviceKeyCreate: async () => d.publicKey,
  devicePublicKey: async () => d.publicKey,
  deviceKeyIsStrongBox: async () => true,
  signedLikeThisApp: async () => 'absent',
  deviceSign: async (m) => bytesToHex(p256.sign(utf8ToBytes(m), hexToBytes(d.privateKey), { format: 'der' })),
  sshConnect: async (_h, _p, _u, _t, blob, seed) => {
    if (blob !== 'GOOD') throw Object.assign(new Error('mismatch'), { code: 'ERR_HOST_KEY_MISMATCH' });
    if (seed !== vectors.phrase.sshEd25519Seed) throw Object.assign(new Error('auth'), { code: 'ERR_SSH_AUTH' });
    return 1;
  },
  sshExec: async (_id, cmd) =>
    cmd.startsWith('wc') ? { code: 3, stdout: '19\n', stderr: '' }
      : cmd.startsWith('sleep') ? new Promise((r) => setTimeout(() => r({ code: 0, stdout: '', stderr: '' }), 30))
      : { code: 0, stdout: '755 11088034 card-app/bin/cardd\n', stderr: '' },
  sshUploadBytes: async () => {},
  sshUploadAsset: async () => {},
  sshClose: async () => {},
  sshScanHostKey: async () => ({ keyType: 'ssh-ed25519', publicKey: 'AAAA' }),
  readAssetText: async () => '[]',
  cardThumbnail: async () => '',
  addListener: () => ({ remove: () => {} }),
  ...over,
});
const bundle = [{ path: 'bin/cardd', mode: 0o755, sha256: 'bb', asset: 'deploy/bin/cardd', size: 1 }];
const target = parseTarget(`127.0.0.1:12222:debian:GOOD:${vectors.phrase.sshEd25519Seed}`)!;

describe('runChecks', () => {
  it('passes every check against a working native layer', async () => {
    const r = await runChecks(native(), bundle, target);
    expect(r.map((x) => [x.name, x.ok])).toEqual([
      ['random', true], ['date-header', true], ['device-key', true],
      ['ssh-exec', true], ['ssh-upload-bundle', true], ['ssh-pin', true], ['ssh-auth', true],
      ['ssh-concurrent', true], ['device-key-after-ssh', true],
    ]);
  });
  it('fails ssh-concurrent when a running SSH command holds up other native calls', async () => {
    // Expo runs plain AsyncFunctions one at a time on a shared queue.
    let queue = Promise.resolve();
    const serial = <T>(f: () => Promise<T>) => { const r = queue.then(f); queue = r.then(() => {}, () => {}); return r; };
    const n = native();
    const r = await runChecks(
      native({ sshExec: (...a) => serial(() => n.sshExec(...a)), deviceSign: (m) => serial(() => n.deviceSign(m)) }),
      bundle, target);
    expect(r.find((x) => x.name === 'ssh-concurrent')).toMatchObject({ ok: false, detail: expect.stringContaining('waited') });
  });
  it('accepts a high-S signature, as the Android Keystore makes about half the time', async () => {
    const highS = (m: string) => {
      const sig = p256.Signature.fromBytes(p256.sign(utf8ToBytes(m), hexToBytes(d.privateKey), { format: 'der' }), 'der');
      const flipped = new p256.Signature(sig.r, p256.Point.Fn.ORDER - sig.s);
      expect(p256.verify(flipped.toBytes('der'), utf8ToBytes(m), hexToBytes(d.publicKey), { format: 'der' })).toBe(false);
      return bytesToHex(flipped.toBytes('der'));
    };
    const r = await runChecks(native({ deviceSign: async (m) => highS(m) }), bundle, target);
    expect(r.find((x) => x.name === 'device-key')).toMatchObject({ ok: true });
  });

  it('reports a signature that does not verify', async () => {
    const r = await runChecks(native({ deviceSign: async () => '3006020101020101' }), bundle, target);
    expect(r.find((x) => x.name === 'device-key')).toMatchObject({ ok: false, detail: expect.stringContaining('does not verify') });
  });
  it('fails ssh-pin if a wrong key is accepted', async () => {
    const r = await runChecks(native({ sshConnect: async () => 1 }), bundle, target);
    expect(r.find((x) => x.name === 'ssh-pin')).toMatchObject({ ok: false, detail: expect.stringContaining('not pinned') });
  });
  it('fails ssh-auth if a login with another key is let in', async () => {
    const r = await runChecks(native({ sshConnect: async () => 1 }), bundle, target);
    expect(r.find((x) => x.name === 'ssh-auth')).toMatchObject({ ok: false, detail: expect.stringContaining('let in') });
  });
  it('says so when built without an SSH target', async () => {
    const r = await runChecks(native(), bundle, parseTarget(''));
    expect(r.at(-1)).toMatchObject({ name: 'ssh', ok: false });
  });
});

// The iPhone's card reader with no card.
describe('sheetCheck', () => {
  /** A module that reads cards in a session: its sheet's end is reported `ends` times, a moment after the app asks for it. */
  const reader = (o: { ends?: number; scan?: () => Promise<void> } = {}) => {
    const calls: string[] = [];
    let listener: ((e: NfcEndEvent) => void) | null = null;
    const nfc = {
      nfcMode: 'session',
      nfcScan: async (line: string) => {
        calls.push(`scan ${line}`);
        await o.scan?.();
      },
      nfcFail: async (line: string) => {
        calls.push(`fail ${line}`);
        for (let i = 0; i < (o.ends ?? 1); i++) setTimeout(() => listener?.({ code: 200, text: 'Session invalidated by user' }), 0);
      },
      addListener: (event: string, l: (e: NfcEndEvent) => void) => {
        if (event === 'nfcEnd') listener = l;
        return { remove: () => void (listener = null) };
      },
    } as unknown as CardNfcApi;
    return { nfc, calls, listening: () => listener !== null };
  };
  /** Waits that take no time but let the end arrive. */
  const sleep = () => new Promise<void>((r) => setTimeout(r, 0));

  it('opens the sheet, ends it, and passes on exactly one end', async () => {
    const x = reader();
    expect(await sheetCheck(x.nfc, sleep)).toBe('the sheet opened and ended when asked (iOS code 200)');
    expect(x.calls).toEqual(['scan Karto Diagnostics is checking the card reader.', 'fail The check is done. No card is needed.']);
    expect(x.listening()).toBe(false);
  });

  it('fails when no end is reported, by a clock of its own', async () => {
    const x = reader({ ends: 0 });
    await expect(sheetCheck(x.nfc, sleep)).rejects.toThrow('no end was reported within 10 seconds of asking for it');
    expect(x.listening()).toBe(false);
  });

  it('fails when more than one end is reported for the one sheet', async () => {
    await expect(sheetCheck(reader({ ends: 2 }).nfc, sleep)).rejects.toThrow('2 ends were reported for one sheet');
  });

  it('fails with the phone\'s words when the sheet would not open', async () => {
    const x = reader({ scan: async () => { throw new Error('this phone would not open a card session'); } });
    await expect(sheetCheck(x.nfc, sleep)).rejects.toThrow('this phone would not open a card session');
    expect(x.calls).toEqual(['scan Karto Diagnostics is checking the card reader.']);
  });
});

describe('runChecks, the card reader', () => {
  it('checks the sheet on a phone that reads cards in a session, straight after the key', async () => {
    const nfc = { nfcMode: 'session', nfcState: async () => 'on', nfcScan: async () => {}, nfcFail: async () => {}, addListener: (_e: string, l: (e: NfcEndEvent) => void) => (setTimeout(() => l({ code: 200, text: '' }), 0), { remove: () => {} }) } as unknown as CardNfcApi;
    const r = await runChecks(native(), bundle, target, nfc, () => new Promise<void>((x) => setTimeout(x, 0)));
    expect(r.map((x) => [x.name, x.ok]).slice(0, 4)).toEqual([['random', true], ['date-header', true], ['device-key', true], ['nfc-sheet', true]]);
    expect(r).toHaveLength(10);
  });

  // A simulator's module reads cards in a session too, and has no reader: there is no sheet to open.
  it('has no such check where the phone cannot read cards', async () => {
    let scans = 0;
    const simulator = { nfcMode: 'session', nfcState: async () => 'unsupported', nfcScan: async () => void scans++, addListener: () => ({ remove: () => {} }) } as unknown as CardNfcApi;
    expect((await runChecks(native(), bundle, target, simulator)).map((x) => x.name)).not.toContain('nfc-sheet');
    expect(scans).toBe(0);
  });

  it('has no such check where cards are read all the time', async () => {
    const android = { nfcState: async () => 'on', addListener: () => ({ remove: () => {} }) } as unknown as CardNfcApi;
    expect((await runChecks(native(), bundle, target, android)).map((x) => x.name)).not.toContain('nfc-sheet');
    expect((await runChecks(native(), bundle, target)).map((x) => x.name)).not.toContain('nfc-sheet');
  });
});
