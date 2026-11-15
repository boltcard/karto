// NIP-98 HTTP auth: a kind-27235 event signed with the account's Nostr key,
// sent as "Authorization: Nostr <base64(event JSON)>". LNVPS rejects a reused
// event id and a created_at more than 60 s from its clock (API docs, 2026).
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

/** NIP-01 event id: sha256 of [0, pubkey, created_at, kind, tags, content]. */
export function eventId(e: Omit<NostrEvent, 'id' | 'sig'>): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
}

export type Nip98Options = {
  /** Unix seconds; defaults to the current time. */
  createdAt?: number;
  /** 8 random bytes as hex by default. Makes two identical requests in one second differ. */
  nonce?: string;
};

export function nip98Event(
  secretKeyHex: string,
  url: string,
  method: string,
  body: string | undefined,
  opts: Nip98Options = {},
): NostrEvent {
  const sk = hexToBytes(secretKeyHex);
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
    ['nonce', opts.nonce ?? bytesToHex(randomBytes(8))],
  ];
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(utf8ToBytes(body)))]);
  const unsigned = {
    pubkey: bytesToHex(schnorr.getPublicKey(sk)),
    created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
    kind: 27235,
    tags,
    content: '',
  };
  const id = eventId(unsigned);
  return { ...unsigned, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
}

export function nip98Header(
  secretKeyHex: string,
  url: string,
  method: string,
  body: string | undefined,
  opts: Nip98Options = {},
): string {
  return 'Nostr ' + base64.encode(utf8ToBytes(JSON.stringify(nip98Event(secretKeyHex, url, method, body, opts))));
}

/** Decodes and checks a NIP-98 header (used by the test fakes). Returns the event or throws. */
export function verifyNip98Header(header: string, url: string, method: string, body: string | undefined): NostrEvent {
  if (!header.startsWith('Nostr ')) throw new Error('not a Nostr header');
  const e = JSON.parse(new TextDecoder().decode(base64.decode(header.slice(6)))) as NostrEvent;
  const tag = (name: string) => e.tags.find((t) => t[0] === name)?.[1];
  if (e.kind !== 27235) throw new Error('wrong kind');
  if (tag('u') !== url) throw new Error(`u tag ${tag('u')} != ${url}`);
  if (tag('method') !== method) throw new Error('method tag mismatch');
  const payload = tag('payload');
  if (payload !== undefined && payload !== bytesToHex(sha256(utf8ToBytes(body ?? '')))) throw new Error('payload mismatch');
  if (eventId(e) !== e.id) throw new Error('bad id');
  if (!schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey))) throw new Error('bad signature');
  return e;
}
