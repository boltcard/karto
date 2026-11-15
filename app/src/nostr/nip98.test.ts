import { describe, expect, it } from 'vitest';
import { nip98Event, nip98Header, verifyNip98Header } from './nip98';
import { vectors } from '../testing/vectors';

const sk = vectors.phrase.nostrPrivateKey;
const url = 'https://api.lnvps.net/api/v1/account';
const body = JSON.stringify({ country_code: 'GBR' });

describe('nip98', () => {
  it('matches nostr-tools for fixed inputs', () => {
    // nostr-tools finalizeEvent with the same key, tags and created_at gave this id
    // (computed 2026-10-03 with nostr-tools).
    const e = nip98Event(sk, url, 'PATCH', body, { createdAt: 1790000000, nonce: '0011223344556677' });
    expect(e.pubkey).toBe(vectors.phrase.nostrPublicKey);
    expect(e.id).toBe('ebedfe7180be44ced3c578e8840b40b637fa8b0c7e2492399b450906bf267d35');
    expect(e.tags).toEqual([
      ['u', url],
      ['method', 'PATCH'],
      ['nonce', '0011223344556677'],
      ['payload', '5cb38af16cba5553ae785182da8a87eb4474fe541ceac953eb29e92de17b6c52'], // sha256 of the body
    ]);
  });
  it('round-trips through the header and verifies', () => {
    const h = nip98Header(sk, url, 'PATCH', body);
    const e = verifyNip98Header(h, url, 'PATCH', body);
    expect(e.pubkey).toBe(vectors.phrase.nostrPublicKey);
  });
  it('omits the payload tag when there is no body', () => {
    const e = nip98Event(sk, url, 'GET', undefined);
    expect(e.tags.map((t) => t[0])).toEqual(['u', 'method', 'nonce']);
  });
  it('gives two requests in the same second different ids', () => {
    const a = nip98Event(sk, url, 'GET', undefined, { createdAt: 1 });
    const b = nip98Event(sk, url, 'GET', undefined, { createdAt: 1 });
    expect(a.id).not.toBe(b.id);
  });
  it('detects a tampered body, url or method', () => {
    const h = nip98Header(sk, url, 'PATCH', body);
    expect(() => verifyNip98Header(h, url, 'PATCH', body + ' ')).toThrow('payload mismatch');
    expect(() => verifyNip98Header(h, url + '?x', 'PATCH', body)).toThrow('u tag');
    expect(() => verifyNip98Header(h, url, 'POST', body)).toThrow('method tag');
  });
});
