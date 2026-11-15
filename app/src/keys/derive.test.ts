import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { bip85Entropy, deriveKeys, isValidPhrase, newPhrase, normalisePhrase } from './derive';
import { vectors } from '../testing/vectors';

// Official BIP-85 test vectors (bip-0085.mediawiki).
const BIP85_XPRV =
  'xprv9s21ZrQH143K2LBWUUQRFXhucrQqBpKdRRxNVq2zBqsx8HVqFk2uYo8kmbaLLHRdqtQpUm98uKfu3vca1LqdGhUtyoFnCNkfmXRyPXLjbKb';

describe('bip85Entropy', () => {
  it('matches the BIP-85 HEX vector', () => {
    const root = HDKey.fromExtendedKey(BIP85_XPRV);
    expect(bytesToHex(bip85Entropy(root, "m/83696968'/128169'/64'/0'", 64))).toBe(
      '492db4698cf3b73a5a24998aa3e9d7fa96275d85724a91e71aa2d645442f878555d078fd1f1f67e368976f04137b1f7a0d19232136ca50c44614af72b5582a5c',
    );
  });
  it('matches the BIP-85 BIP39 12-word vector', () => {
    const root = HDKey.fromExtendedKey(BIP85_XPRV);
    expect(entropyToMnemonic(bip85Entropy(root, "m/83696968'/39'/0'/12'/0'", 16), wordlist)).toBe(
      'girl mad pet galaxy egg matter matrix prison refuse sense ordinary nose',
    );
  });
});

describe('NIP-06', () => {
  it('matches the NIP-06 vector', () => {
    const root = HDKey.fromMasterSeed(
      mnemonicToSeedSync('leader monkey parrot ring guide accident before fence cannon height naive bean'),
    );
    expect(bytesToHex(root.derive("m/44'/1237'/0'/0/0").privateKey!)).toBe(
      '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a',
    );
  });
});

describe('deriveKeys', () => {
  it('matches every value in testvectors/vectors.json', () => {
    const { phrase, ...expected } = vectors.phrase;
    expect(deriveKeys(phrase)).toEqual(expected);
  });
  it('ignores case and extra whitespace in the phrase', () => {
    const messy = '  ' + vectors.phrase.phrase.toUpperCase().replace(/ /g, '   ') + '\n';
    expect(deriveKeys(messy).issuerKey).toBe(vectors.phrase.issuerKey);
  });
  it('rejects a phrase with a bad checksum', () => {
    expect(() => deriveKeys('abandon '.repeat(12).trim())).toThrow('invalid recovery phrase');
  });
});

describe('phrases', () => {
  it('makes valid, different 12-word phrases', () => {
    const a = newPhrase();
    expect(a.split(' ')).toHaveLength(12);
    expect(isValidPhrase(a)).toBe(true);
    expect(newPhrase()).not.toBe(a);
  });
  it('normalises', () => {
    expect(normalisePhrase(' A  b\tC\n')).toBe('a b c');
  });
});
