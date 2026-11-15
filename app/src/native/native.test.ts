import { describe, expect, it } from 'vitest';
import { p256 } from '@noble/curves/nist.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { deviceKey, NoDeviceKeyError } from './deviceKey';
import { nativeScanHostKey, nativeSsh } from './ssh';
import { nativeWords } from './words';
import type { CardNativeApi, SshUploadProgressEvent } from './api';
import { HostKeyMismatchError, SshAuthError, SshDropped, SshUploadRefused } from '../onboarding/ssh';
import { vectors } from '../testing/vectors';

const d = vectors.deviceAuth;

describe('deviceKey', () => {
  it('produces the same header cardd verifies in the Go vector test', async () => {
    const signed: string[] = [];
    const key = deviceKey({
      deviceKeyCreate: async () => d.publicKey,
      devicePublicKey: async () => d.publicKey,
      // The Keystore's SHA256withECDSA; RFC 6979 makes noble's signature the vector's.
      deviceSign: async (m) => {
        signed.push(m);
        return bytesToHex(p256.sign(utf8ToBytes(m), hexToBytes(d.privateKey), { format: 'der' }));
      },
    });
    expect(await key.keyId()).toBe(d.keyId);
    expect(await key.authorize(d.method, d.path, d.body, d.ts)).toBe(`Device ${d.keyId}.${d.ts}.${d.signatureDer}`);
    expect(signed).toEqual([d.canonical]);
  });

  it('asks the Keystore for the public key once', async () => {
    let calls = 0;
    const key = deviceKey({ deviceKeyCreate: async () => d.publicKey, devicePublicKey: async () => (calls++, d.publicKey), deviceSign: async () => '30' });
    await key.keyId();
    await key.publicKeyHex();
    expect(calls).toBe(1);
  });

  // Keystore keys are never in Android's backup: a restored app finds none, and must say so
  // instead of quietly making a new key that cardd has never seen.
  it('reports a missing key as NoDeviceKeyError and never creates one implicitly', async () => {
    const noKey = Object.assign(new Error('no device key'), { code: 'ERR_NO_DEVICE_KEY' });
    let created = 0;
    const key = deviceKey({
      deviceKeyCreate: async () => (created++, d.publicKey),
      devicePublicKey: async () => { throw noKey; },
      deviceSign: async () => { throw noKey; },
    });
    await expect(key.publicKeyHex()).rejects.toBeInstanceOf(NoDeviceKeyError);
    await expect(key.authorize('GET', '/api/v1/server', '', 1)).rejects.toBeInstanceOf(NoDeviceKeyError);
    expect(created).toBe(0);
  });

  // An iPhone's key stays when the app is deleted.
  describe('remove', () => {
    /** A module that can delete its key, as the iPhone's does: the key it holds, and how often each call was made. */
    function module(o: { deleteFails?: boolean } = {}) {
      const m = { key: d.publicKey as string | null, made: 0, deleted: 0 };
      const native = {
        deviceKeyCreate: async () => (m.key ??= (m.made++, 'aa'.repeat(65))),
        devicePublicKey: async () => {
          if (m.key === null) throw Object.assign(new Error('no device key'), { code: 'ERR_NO_DEVICE_KEY' });
          return m.key;
        },
        deviceSign: async () => '30',
        deviceKeyDelete: async () => {
          if (o.deleteFails) throw new Error('errSecInteractionNotAllowed');
          m.deleted++;
          m.key = null;
        },
      };
      return { m, native };
    }

    it('deletes the key, and forgets the public half it had read', async () => {
      const { m, native } = module();
      const key = deviceKey(native);
      expect(await key.publicKeyHex()).toBe(d.publicKey);
      await key.remove();
      expect(m.deleted).toBe(1);
      await expect(key.publicKeyHex()).rejects.toBeInstanceOf(NoDeviceKeyError);
    });

    it('makes a new key after one was removed', async () => {
      const { m, native } = module();
      const key = deviceKey(native);
      await key.remove();
      expect(await key.create()).toBe('aa'.repeat(65));
      expect(await key.publicKeyHex()).toBe('aa'.repeat(65));
      expect(m.made).toBe(1);
    });

    it('passes on a delete that failed, the key still there', async () => {
      const { m, native } = module({ deleteFails: true });
      const key = deviceKey(native);
      await expect(key.remove()).rejects.toThrow('errSecInteractionNotAllowed');
      expect(m.key).toBe(d.publicKey);
      expect(await key.publicKeyHex()).toBe(d.publicKey);
    });

    it('refuses on a phone whose module cannot delete its key', async () => {
      const key = deviceKey({ deviceKeyCreate: async () => d.publicKey, devicePublicKey: async () => d.publicKey, deviceSign: async () => '30' });
      await expect(key.remove()).rejects.toThrow("This phone can't remove its key.");
      expect(await key.publicKeyHex()).toBe(d.publicKey);
    });
  });

  it('asks again after a failed read instead of caching the failure', async () => {
    let calls = 0;
    const key = deviceKey({
      deviceKeyCreate: async () => d.publicKey,
      devicePublicKey: async () => {
        if (calls++ === 0) throw new Error('Keystore busy');
        return d.publicKey;
      },
      deviceSign: async () => '30',
    });
    await expect(key.publicKeyHex()).rejects.toThrow('Keystore busy');
    expect(await key.publicKeyHex()).toBe(d.publicKey);
  });

  it('create() makes the key and remembers it', async () => {
    let created = 0;
    const key = deviceKey({ deviceKeyCreate: async () => (created++, d.publicKey), devicePublicKey: async () => '', deviceSign: async () => '30' });
    expect(await key.create()).toBe(d.publicKey);
    expect(await key.keyId()).toBe(d.keyId);
    expect(created).toBe(1);
  });
});

// What Expo puts around a module's own words was seen on both phones: Android's on a Pixel 8 Pro's log,
// the iPhone's on an iPhone 12's diagnostics run.
describe('nativeWords', () => {
  const IOS = 'SshException: could not connect to 192.168.1.43:12225: No route to host (at CardNative/CardNativeModule.swift:24)';
  const ANDROID = "Call to function 'CardNative.sshExec' has been rejected.\n→ Caused by: net.schmizz.sshj.common.SSHException: Software caused connection abort";

  it("gives the module's own words, without the iPhone's class name in front and file and line behind", () => {
    expect(nativeWords(new Error(IOS))).toBe('could not connect to 192.168.1.43:12225: No route to host');
    expect(nativeWords(new Error('NfcScanException: System resource unavailable (at CardNative/CardNativeModule.swift:163)'))).toBe('System resource unavailable');
  });

  it("gives what follows Android's last \"Caused by\"", () => {
    expect(nativeWords(new Error(ANDROID))).toBe('net.schmizz.sshj.common.SSHException: Software caused connection abort');
    expect(nativeWords(new Error('Call to function x has been rejected.\n→ Caused by: one\n→ Caused by: Permission denied'))).toBe('Permission denied');
  });

  it('leaves words that are not dressed as they are', () => {
    for (const words of ['Broken pipe', 'connect to 45.67.89.164:22 timed out', 'the command ended (at once)', 'Error: something (at home)', 'SshException: no file and line']) {
      expect(nativeWords(new Error(words))).toBe(words);
    }
    expect(nativeWords('NIOSSHError error 1')).toBe('NIOSSHError error 1');
  });
});

describe('nativeSsh', () => {
  const calls: unknown[][] = [];
  const listeners: { event: string; listener: (e: SshUploadProgressEvent) => void }[] = [];
  const fake = (connectError?: Error & { code?: string }): CardNativeApi => ({
    deviceKeyCreate: async () => '',
    devicePublicKey: async () => '',
    deviceKeyIsStrongBox: async () => false,
    signedLikeThisApp: async () => 'absent',
    deviceSign: async () => '',
    sshConnect: async (...a) => {
      calls.push(['connect', ...a]);
      if (connectError) throw connectError;
      return 7;
    },
    sshExec: async (...a) => (calls.push(['exec', ...a]), { code: 0, stdout: 'ok', stderr: '' }),
    sshUploadBytes: async (...a) => void calls.push(['bytes', ...a]),
    sshUploadAsset: async (...a) => void calls.push(['asset', ...a]),
    sshClose: async (...a) => void calls.push(['close', ...a]),
    sshScanHostKey: async (...a) => (calls.push(['scan', ...a]), { keyType: 'ssh-ed25519', publicKey: 'AAAAscanned' }),
    readAssetText: async () => '[]',
    cardThumbnail: async () => '',
    addListener: (event, listener) => {
      listeners.push({ event, listener });
      return { remove: () => void listeners.splice(listeners.findIndex((l) => l.listener === listener), 1) };
    },
  });
  const opts = { host: '45.67.89.164', port: 22, user: 'debian', hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAA' }, ed25519Seed: 'ab' };

  it('passes the pinned key and seed through, and routes every call to the session', async () => {
    calls.length = 0;
    const s = await nativeSsh(fake())(opts);
    await s.exec('ls');
    await s.exec('cat', 'in');
    await s.upload('card-app/x', new Uint8Array([1, 2, 255]), 0o644);
    await s.uploadAsset('card-app/bin/cardd', 'deploy/bin/cardd', 42, 0o755);
    await s.close();
    expect(calls).toEqual([
      ['connect', '45.67.89.164', 22, 'debian', 'ssh-ed25519', 'AAAA', 'ab'],
      ['exec', 7, 'ls', null],
      ['exec', 7, 'cat', 'in'],
      ['bytes', 7, 'card-app/x', base64.encode(new Uint8Array([1, 2, 255])), 0o644],
      ['asset', 7, 'card-app/bin/cardd', 'deploy/bin/cardd', 42, 0o755],
      ['close', 7],
    ]);
  });

  it("passes on this upload's progress events, and stops listening when it ends", async () => {
    const native = fake();
    let finish!: () => void;
    native.sshUploadAsset = () => new Promise((r) => (finish = r));
    const s = await nativeSsh(native)(opts);
    const seen: number[] = [];
    const upload = s.uploadAsset('card-app/bin/cardd', 'deploy/bin/cardd', 42, 0o755, (sent) => seen.push(sent));
    const emit = (e: SshUploadProgressEvent) => listeners.forEach((l) => l.event === 'sshUploadProgress' && l.listener(e));
    emit({ id: 7, remotePath: 'card-app/bin/cardd', sent: 10 });
    emit({ id: 8, remotePath: 'card-app/bin/cardd', sent: 99 }); // another session
    emit({ id: 7, remotePath: 'card-app/install.sh', sent: 99 }); // another file
    emit({ id: 7, remotePath: 'card-app/bin/cardd', sent: 42 });
    finish();
    await upload;
    expect(seen).toEqual([10, 42]);
    expect(listeners).toEqual([]);
  });

  it('turns the native mismatch error into HostKeyMismatchError', async () => {
    const e = Object.assign(new Error('server presented ssh-ed25519 BBBB'), { code: 'ERR_HOST_KEY_MISMATCH' });
    await expect(nativeSsh(fake(e))(opts)).rejects.toBeInstanceOf(HostKeyMismatchError);
    const other = Object.assign(new Error('timeout'), { code: 'ERR_UNEXPECTED' });
    await expect(nativeSsh(fake(other))(opts)).rejects.not.toBeInstanceOf(HostKeyMismatchError);
  });

  it('turns the native login refusal into SshAuthError', async () => {
    const e = Object.assign(new Error('Exhausted available authentication methods'), { code: 'ERR_SSH_AUTH' });
    await expect(nativeSsh(fake(e))(opts)).rejects.toBeInstanceOf(SshAuthError);
  });
});

// A drop is the connection failing, not the server answering.
describe('nativeSsh, a connection that fails', () => {
  const opts = { host: '45.67.89.164', port: 22, user: 'debian', hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAA' }, ed25519Seed: 'ab' };
  /** A module whose named call fails with the phone's own words. */
  const failing = (call: 'sshConnect' | 'sshExec' | 'sshUploadBytes' | 'sshUploadAsset' | 'sshClose', e: unknown = new Error('Broken pipe')) =>
    ({
      sshConnect: async () => 7,
      sshExec: async () => ({ code: 0, stdout: '', stderr: '' }),
      sshUploadBytes: async () => {},
      sshUploadAsset: async () => {},
      sshClose: async () => {},
      addListener: () => ({ remove: () => {} }),
      [call]: async () => {
        throw e;
      },
    }) as unknown as CardNativeApi;
  const dropped = async (run: Promise<unknown>) => run.then(() => null, (e: unknown) => e as SshDropped);

  it('says a connect that fails for any other reason is a drop, with which it was and the phone\'s words', async () => {
    const e = await dropped(nativeSsh(failing('sshConnect', Object.assign(new Error('connect to 45.67.89.164:22 timed out'), { code: 'ERR_UNEXPECTED' })))(opts));
    expect(e).toBeInstanceOf(SshDropped);
    expect([e!.during, e!.message]).toEqual(['connect', 'connect to 45.67.89.164:22 timed out']);
  });

  it('says a command that fails is a drop, and an upload of either kind', async () => {
    const exec = await dropped((await nativeSsh(failing('sshExec'))(opts)).exec('ls'));
    const bytes = await dropped((await nativeSsh(failing('sshUploadBytes'))(opts)).upload('card-app/x', new Uint8Array([1]), 0o644));
    const asset = await dropped((await nativeSsh(failing('sshUploadAsset'))(opts)).uploadAsset('card-app/bin/cardd', 'deploy/bin/cardd', 42, 0o755));
    for (const e of [exec, bytes, asset]) expect(e).toBeInstanceOf(SshDropped);
    expect([exec!.during, bytes!.during, asset!.during]).toEqual(['command', 'upload', 'upload']);
    expect([exec!.message, bytes!.message, asset!.message]).toEqual(['Broken pipe', 'Broken pipe', 'Broken pipe']);
  });

  it('keeps the words of a failure that is not an Error', async () => {
    const e = await dropped((await nativeSsh(failing('sshExec', 'NIOSSHError error 1'))(opts)).exec('ls'));
    expect([e instanceof SshDropped, e!.message]).toEqual([true, 'NIOSSHError error 1']);
  });

  it('leaves the two named refusals as they are, and a close that fails', async () => {
    const mismatch = Object.assign(new Error('server presented ssh-ed25519 BBBB'), { code: 'ERR_HOST_KEY_MISMATCH' });
    const auth = Object.assign(new Error('Exhausted available authentication methods'), { code: 'ERR_SSH_AUTH' });
    expect(await dropped(nativeSsh(failing('sshConnect', mismatch))(opts))).toBeInstanceOf(HostKeyMismatchError);
    expect(await dropped(nativeSsh(failing('sshConnect', auth))(opts))).toBeInstanceOf(SshAuthError);
    const close = await dropped((await nativeSsh(failing('sshClose', new Error('connection reset while closing')))(opts)).close());
    expect([close instanceof SshDropped, close!.message]).toEqual([false, 'connection reset while closing']);
  });

  // The server answered, so the connection was there: a full disk or a folder that cannot be written is no drop
  //.
  it('says an upload the server refused is that, of either kind, with the server\'s words', async () => {
    const refused = Object.assign(new Error('cat: write error: No space left on device'), { code: 'ERR_UPLOAD_REFUSED' });
    const bytes = await dropped((await nativeSsh(failing('sshUploadBytes', refused))(opts)).upload('card-app/x', new Uint8Array([1]), 0o644));
    const asset = await dropped((await nativeSsh(failing('sshUploadAsset', refused))(opts)).uploadAsset('card-app/bin/cardd', 'deploy/bin/cardd', 42, 0o755));
    for (const e of [bytes, asset]) {
      expect(e).toBeInstanceOf(SshUploadRefused);
      expect(e).not.toBeInstanceOf(SshDropped);
      expect(e!.message).toBe('cat: write error: No space left on device');
    }
    // Expo wraps what a module's function throws: the server's words are what follows its last "Caused by".
    const wrapped = Object.assign(new Error("Call to function 'CardNative.sshUploadAsset' has been rejected.\n→ Caused by: Permission denied"), { code: 'ERR_UPLOAD_REFUSED' });
    const e = await dropped((await nativeSsh(failing('sshUploadAsset', wrapped))(opts)).uploadAsset('card-app/bin/cardd', 'deploy/bin/cardd', 42, 0o755));
    expect([e instanceof SshUploadRefused, e!.message]).toEqual([true, 'Permission denied']);
    // The code on a command is not an upload's: that stays a drop.
    expect(await dropped((await nativeSsh(failing('sshExec', refused))(opts)).exec('ls'))).toBeInstanceOf(SshDropped);
  });

  it("carries every failure's words without Expo's dressing: a drop's, the two refusals', an upload's", async () => {
    const dressed = (words: string, code?: string) => Object.assign(new Error(`SshException: ${words} (at CardNative/CardNativeModule.swift:24)`), code ? { code } : {});
    const drop = await dropped((await nativeSsh(failing('sshExec', dressed('the connection closed')))(opts)).exec('ls'));
    expect([drop instanceof SshDropped, drop!.message]).toEqual([true, 'the connection closed']);
    const mismatch = await dropped(nativeSsh(failing('sshConnect', dressed('server presented ssh-ed25519 BBBB', 'ERR_HOST_KEY_MISMATCH')))(opts));
    expect([mismatch instanceof HostKeyMismatchError, mismatch!.message]).toEqual([true, 'server presented ssh-ed25519 BBBB']);
    const auth = await dropped(nativeSsh(failing('sshConnect', dressed('the server refused the key for debian', 'ERR_SSH_AUTH')))(opts));
    expect([auth instanceof SshAuthError, auth!.message]).toEqual([true, 'the server refused the key for debian']);
    const refused = await dropped((await nativeSsh(failing('sshUploadBytes', dressed('cat: write error: No space left on device', 'ERR_UPLOAD_REFUSED')))(opts)).upload('card-app/x', new Uint8Array([1]), 0o644));
    expect([refused instanceof SshUploadRefused, refused!.message]).toEqual([true, 'cat: write error: No space left on device']);
  });

  it('stops listening to an asset upload that dropped', async () => {
    const listeners: unknown[] = [];
    const native = failing('sshUploadAsset');
    native.addListener = ((_event: string, l: unknown) => (listeners.push(l), { remove: () => void listeners.splice(listeners.indexOf(l), 1) })) as CardNativeApi['addListener'];
    await dropped((await nativeSsh(native)(opts)).uploadAsset('card-app/bin/cardd', 'deploy/bin/cardd', 42, 0o755, () => {}));
    expect(listeners).toEqual([]);
  });
});

describe('nativeScanHostKey', () => {
  it('reads the server key through the native module', async () => {
    const seen: unknown[] = [];
    const native = { sshScanHostKey: async (host: string, port: number) => (seen.push(host, port), { keyType: 'ssh-ed25519', publicKey: 'AAAAx' }) };
    expect(await nativeScanHostKey(native as unknown as CardNativeApi)('45.67.89.164', 22)).toEqual({ keyType: 'ssh-ed25519', publicKey: 'AAAAx' });
    expect(seen).toEqual(['45.67.89.164', 22]);
  });
});
