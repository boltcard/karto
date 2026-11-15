// SshConnect (src/onboarding/ssh.ts) over the card-native module's SSH sessions. Whatever fails here that is not one
// of the server's named refusals (its key, the phrase's key, an upload) is the connection failing: an SshDropped.
// Every failure carries the module's own words, without what Expo puts around them (words.ts).
import { base64 } from '@scure/base';
import { HostKeyMismatchError, SshAuthError, SshDropped, SshUploadRefused, type SshConnect, type SshScan } from '../onboarding/ssh';
import type { CardNativeApi } from './api';
import { nativeWords as words } from './words';

const dropped = (during: SshDropped['during']) => (e: unknown): never => {
  throw new SshDropped(during, words(e));
};
/** An upload's failure: the server's refusal as itself, anything else as a drop. */
const uploadFailed = (e: unknown): never => {
  if ((e as { code?: string }).code === 'ERR_UPLOAD_REFUSED') throw new SshUploadRefused(words(e));
  return dropped('upload')(e);
};

export function nativeSsh(native: CardNativeApi): SshConnect {
  return async (o) => {
    let id: number;
    try {
      id = await native.sshConnect(o.host, o.port, o.user, o.hostKey.keyType, o.hostKey.publicKey, o.ed25519Seed);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ERR_HOST_KEY_MISMATCH') throw new HostKeyMismatchError(words(e));
      if (code === 'ERR_SSH_AUTH') throw new SshAuthError(words(e));
      return dropped('connect')(e);
    }
    return {
      exec: (command, stdin) => native.sshExec(id, command, stdin ?? null).catch(dropped('command')),
      upload: (path, data, mode) => native.sshUploadBytes(id, path, base64.encode(data), mode).catch(uploadFailed),
      uploadAsset: async (path, asset, size, mode, onProgress) => {
        const sub = onProgress && native.addListener('sshUploadProgress', (e) => {
          if (e.id === id && e.remotePath === path) onProgress(e.sent);
        });
        try {
          await native.sshUploadAsset(id, path, asset, size, mode).catch(uploadFailed);
        } finally {
          sub?.remove();
        }
      },
      close: () => native.sshClose(id),
    };
  };
}

/** SshScan over the card-native module: trust on first use until LNVPS publishes the key. */
export const nativeScanHostKey = (native: CardNativeApi): SshScan => (host, port) => native.sshScanHostKey(host, port);
