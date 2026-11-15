// The URL a Bolt Card carries and the NDEF file that holds it (one short URI
// record, URI code 00), with the SUN mirror offsets (AN12196).
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { parseSun } from '../boltcard/sun';
import { le24 } from './crypto';
import type { FileSettings } from './card';

export const lnurlwFor = (host: string) => `lnurlw://${host}/ln`;
export const cardUrl = (lnurlw: string) => `${lnurlw}?p=${'0'.repeat(32)}&c=${'0'.repeat(16)}`;

/** NLEN = 0: no NDEF message. */
export const EMPTY_NDEF = Uint8Array.of(0, 0);
/** File 2 as it leaves the factory: no SDM, free read and write, key 0 to change settings. */
export const FACTORY_FILE_SETTINGS = hexToBytes('00e0ee');

const HEADER = 2 + 4 + 1; // NLEN, record header (D1 01 len 55), URI code

const ascii = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

export function ndefFile(url: string): { file: Uint8Array; piccOffset: number; macOffset: number } {
  const payload = concatBytes(Uint8Array.of(0x00), ascii(url));
  if (payload.length > 255) throw new Error('URL too long for one short NDEF record');
  const message = concatBytes(Uint8Array.of(0xd1, 0x01, payload.length, 0x55), payload);
  const at = (marker: string) => {
    const i = url.indexOf(marker);
    if (i < 0) throw new Error(`URL has no ${marker}`);
    return HEADER + i + marker.length;
  };
  return { file: concatBytes(Uint8Array.of(message.length >> 8, message.length & 0xff), message), piccOffset: at('?p='), macOffset: at('&c=') };
}

/**
 * ChangeFileSettings data for file 2: SDM on, CommMode.Plain; read free, write
 * and change with key 0; UID and counter mirrored in ASCII; p under K1, c under
 * K2; the MAC covers nothing before c (input offset = c's offset).
 */
export const sunFileSettings = (piccOffset: number, macOffset: number) =>
  concatBytes(hexToBytes('4000e0c1ff12'), le24(piccOffset), le24(macOffset), le24(macOffset));

/** p and c where the file settings say the card mirrors them; null if there is no valid SUN there. */
export function readSun(file: Uint8Array, s: FileSettings): { p: string; c: string } | null {
  if (!s.sdm || s.piccOffset === undefined || s.macOffset === undefined) return null;
  const text = (o: number, n: number) => (o + n <= file.length ? String.fromCharCode(...file.subarray(o, o + n)) : '');
  const p = text(s.piccOffset, 32);
  const c = text(s.macOffset, 16);
  return parseSun(p, c) ? { p, c } : null;
}

export function urlOf(file: Uint8Array): string | null {
  const nlen = file.length >= 2 ? (file[0] << 8) | file[1] : 0;
  const m = file.subarray(2, 2 + nlen);
  if (nlen < 5 || m[0] !== 0xd1 || m[1] !== 0x01 || m[3] !== 0x55 || m[4] !== 0x00) return null;
  return String.fromCharCode(...m.subarray(5, 4 + m[2]));
}

/**
 * The p and c a Bolt Card's link carries, for a tag whose settings can't be asked for where they are:
 * lnurlw:// or https://, with a host, and a tap in its query.
 * Null for anything else.
 */
export function sunOfUrl(url: string | null): { p: string; c: string } | null {
  const query = /^(?:lnurlw|https):\/\/[^/?#\s]+[^?#\s]*\?([^#\s]*)/i.exec(url ?? '')?.[1];
  if (query === undefined) return null;
  const value = (key: string) => query.split('&').find((part) => part.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
  const sun = { p: value('p'), c: value('c') };
  return parseSun(sun.p, sun.c) ? sun : null;
}

export const urlHost = (url: string): string | null => /^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1]?.toLowerCase() ?? null;

/** Do the SUN offsets point at this URL's p= and c=? Not after a re-point cut between its two writes. */
export function offsetsMatch(file: Uint8Array, s: FileSettings): boolean {
  const url = urlOf(file);
  if (!url || !s.sdm) return false;
  try {
    const n = ndefFile(url);
    return n.piccOffset === s.piccOffset && n.macOffset === s.macOffset;
  } catch {
    return false;
  }
}
