// Bolt Card key derivation, boltcard docs/DETERMINISTIC.md. Must match server/internal/cardkeys.
import { cmac } from '@noble/ciphers/aes.js';
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js';

export type CardKeys = {
  k0: Uint8Array; k1: Uint8Array; k2: Uint8Array; k3: Uint8Array; k4: Uint8Array;
  id: Uint8Array; cardKey: Uint8Array;
};

/** PRF(key, message) = AES-CMAC (NIST SP 800-38B). */
export const prf = (key: Uint8Array, message: Uint8Array): Uint8Array => cmac(message, key);

function checkUid(uid: Uint8Array) {
  if (uid.length !== 7) throw new Error(`uid must be 7 bytes, got ${uid.length}`);
}

/** K1 is the same for every card of this issuer. */
export const k1For = (issuer: Uint8Array) => prf(issuer, hexToBytes('2d003f77'));

/** The only identifier cardd stores: PRF(IssuerKey, '2d003f7b' || UID). */
export function cardId(issuer: Uint8Array, uid: Uint8Array): Uint8Array {
  checkUid(uid);
  return prf(issuer, concatBytes(hexToBytes('2d003f7b'), uid));
}

export function deriveCardKeys(issuer: Uint8Array, uid: Uint8Array, version: number): CardKeys {
  checkUid(uid);
  const v = new Uint8Array(4);
  new DataView(v.buffer).setUint32(0, version, true); // little endian
  const cardKey = prf(issuer, concatBytes(hexToBytes('2d003f75'), uid, v));
  const sub = (tag: string) => prf(cardKey, hexToBytes(tag));
  return {
    k0: sub('2d003f76'),
    k1: k1For(issuer),
    k2: sub('2d003f78'),
    k3: sub('2d003f79'),
    k4: sub('2d003f7a'),
    id: cardId(issuer, uid),
    cardKey,
  };
}
