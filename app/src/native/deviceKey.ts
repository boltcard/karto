// Signs requests to cardd with the Keystore device key.
// The private key never leaves the Keystore.
import { hexToBytes } from '@noble/hashes/utils.js';
import { nativeWords } from './words';
import { authHeader, canonical, keyId } from '../cardd/deviceauth';
import type { CardNativeApi } from './api';

/**
 * The phone has no device key. Keystore keys are never in Android's backup,
 * so an app restored onto a phone has paired state but no key: it must be
 * paired again, not handed a new key cardd has never seen.
 */
export class NoDeviceKeyError extends Error {}

export type DeviceKey = {
  /** Makes the key if there is none (onboarding, before pairing). Returns the public key. */
  create(): Promise<string>;
  publicKeyHex(): Promise<string>;
  keyId(): Promise<string>;
  /** The Authorization header for one request. ts is unix seconds. */
  authorize(method: string, path: string, body: string, ts: number): Promise<string>;
  /**
   * Deletes the key (an iPhone, where it outlives the app): before a wallet found there is carried on with a new
   * key, and when a wallet is removed. Fails with the phone's reason if the delete did, the key then still there.
   */
  remove(): Promise<void>;
};

const mapNoKey = (e: unknown): never => {
  if ((e as { code?: string }).code === 'ERR_NO_DEVICE_KEY') throw new NoDeviceKeyError(nativeWords(e));
  throw e;
};

export function deviceKey(native: Pick<CardNativeApi, 'deviceKeyCreate' | 'devicePublicKey' | 'deviceSign' | 'deviceKeyDelete'>): DeviceKey {
  let pub: string | undefined;
  const publicKeyHex = async () => (pub ??= await native.devicePublicKey().catch(mapNoKey));
  return {
    create: async () => (pub = await native.deviceKeyCreate()),
    publicKeyHex,
    keyId: async () => keyId(hexToBytes(await publicKeyHex())),
    authorize: async (method, path, body, ts) => {
      const id = keyId(hexToBytes(await publicKeyHex()));
      const sig = await native.deviceSign(canonical(method, path, ts, body)).catch(mapNoKey);
      return authHeader(id, ts, hexToBytes(sig));
    },
    remove: async () => {
      if (!native.deviceKeyDelete) throw new Error("This phone can't remove its key.");
      await native.deviceKeyDelete();
      pub = undefined;
    },
  };
}
