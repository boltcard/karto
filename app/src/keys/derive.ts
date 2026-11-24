// Every key the app needs, derived from one BIP-39 phrase.
import { entropyToMnemonic, generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { base64, bech32 } from '@scure/base';

export type DerivedKeys = {
  nostrPrivateKey: string; // hex, NIP-06 m/44'/1237'/0'/0/0
  nostrPublicKey: string; // hex x-only
  phoenixdSeed: string; // 12 words, BIP-85 BIP39 index 0
  issuerKey: string; // hex 16 bytes, BIP-85 HEX index 0
  backupAgeIdentity: string; // AGE-SECRET-KEY-1..., BIP-85 HEX index 1
  backupAgeRecipient: string; // age1...
  sshEd25519Seed: string; // hex 32 bytes, BIP-85 HEX index 2
  sshAuthorizedKey: string; // "ssh-ed25519 AAAA..."
  // BIP-85 HEX indexes 3 and 4 are spent: older versions made the mail.tm inbox's name and password from them, for
  // the verified email LNVPS once asked for. Accounts set up then still hold that address, so never use 3 or 4 again.
};

export function newPhrase(): string {
  return generateMnemonic(wordlist, 128);
}

export function isValidPhrase(phrase: string): boolean {
  return validateMnemonic(normalisePhrase(phrase), wordlist);
}

/** Lower-case, single spaces, no leading or trailing whitespace. */
export function normalisePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}

/** BIP-85: HMAC-SHA512("bip-entropy-from-k", private key at path), truncated. */
export function bip85Entropy(root: HDKey, path: string, bytes: number): Uint8Array {
  const key = root.derive(path).privateKey;
  if (!key) throw new Error(`no private key at ${path}`);
  return hmac(sha512, utf8ToBytes('bip-entropy-from-k'), key).slice(0, bytes);
}

const hexApp = (root: HDKey, bytes: number, index: number) =>
  bip85Entropy(root, `m/83696968'/128169'/${bytes}'/${index}'`, bytes);

function sshString(data: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  return concatBytes(len, data);
}

export function deriveKeys(phrase: string): DerivedKeys {
  const normal = normalisePhrase(phrase);
  if (!validateMnemonic(normal, wordlist)) throw new Error('invalid recovery phrase');
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(normal));

  const nostr = root.derive("m/44'/1237'/0'/0/0").privateKey!;
  const backup = hexApp(root, 32, 1);
  const sshSeed = hexApp(root, 32, 2);
  const sshBlob = concatBytes(sshString(utf8ToBytes('ssh-ed25519')), sshString(ed25519.getPublicKey(sshSeed)));

  return {
    nostrPrivateKey: bytesToHex(nostr),
    nostrPublicKey: bytesToHex(schnorr.getPublicKey(nostr)),
    phoenixdSeed: entropyToMnemonic(bip85Entropy(root, "m/83696968'/39'/0'/12'/0'", 16), wordlist),
    issuerKey: bytesToHex(hexApp(root, 16, 0)),
    backupAgeIdentity: bech32.encode('age-secret-key-', bech32.toWords(backup), false).toUpperCase(),
    backupAgeRecipient: bech32.encode('age', bech32.toWords(x25519.getPublicKey(backup)), false),
    sshEd25519Seed: bytesToHex(sshSeed),
    sshAuthorizedKey: 'ssh-ed25519 ' + base64.encode(sshBlob),
  };
}
