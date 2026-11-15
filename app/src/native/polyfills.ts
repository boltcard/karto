// Hermes has no crypto.getRandomValues; noble (NIP-98 nonces, Schnorr
// signatures) and BIP-39 (newPhrase) need it. expo-crypto's comes from the
// platform's secure random, with no Google Play Services. Import this first.
import { getRandomValues } from 'expo-crypto';

const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (typeof g.crypto?.getRandomValues !== 'function') {
  g.crypto = { ...(g.crypto ?? {}), getRandomValues };
}
