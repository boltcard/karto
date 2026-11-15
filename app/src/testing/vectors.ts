// Loads the shared test vectors in testvectors/vectors.json (tests only).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Vectors = {
  phrase: Record<string, string>;
  deterministic: { issuerKey: string; uid: string; version: number; expected: Record<string, string> };
  sun: { name: string; k1: string; k2: string; p: string; c: string; uid: string; counter: number }[];
  deviceAuth: {
    privateKey: string; publicKey: string; keyId: string; method: string; path: string;
    ts: number; body: string; canonical: string; signatureDer: string;
  };
};

export const vectors: Vectors = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'testvectors', 'vectors.json'), 'utf8'),
);

/**
 * A phone's card (testvectors/phonecard.json): the IDs of numbers 0 and 1, and number 0's taps at key version 0,
 * each with the same random bytes: a batch of 16 from `first`, and the first of the batch after it.
 */
export type PhoneCardVectors = {
  issuerKey: string; lnurlw: string; cards: { n: number; uid: string; id: string }[];
  random: string; first: number; batch: string[]; nextBatchFirst: string;
};
export const PHONE_CARD_VECTORS = join(__dirname, '..', '..', '..', 'testvectors', 'phonecard.json');
/** Read when asked for, so the test that writes the file can run without it. */
export const phoneCardVectors = (): PhoneCardVectors => JSON.parse(readFileSync(PHONE_CARD_VECTORS, 'utf8'));
