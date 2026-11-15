// Where Send out pays: what a pasted, typed or
// scanned destination is. cardd resolves addresses and pay links itself.
import { bolt11AmountMsat, bolt11Description, lnurlDecode } from '../lightning/lightning';

export type Destination =
  | { kind: 'invoice'; to: string; amountMsat: number | null; description: string }
  /** user@domain: cardd's lookup tries BIP353, then LNURL; bip353Only (typed with ₿): BIP353 alone. */
  | { kind: 'address'; to: string; bip353Only?: boolean }
  | { kind: 'payurl'; to: string }
  /** A BOLT12 offer (lno1…), lowercase. */
  | { kind: 'offer'; to: string }
  /** One of this server's own addresses: offer a move instead (no routing fee). account: 'pool', 'hosting' or a card's c<10 hex>. */
  | { kind: 'own'; account: string; address: string }
  | { kind: 'unsupported'; what: string };

const ADDRESS = /^([a-z0-9._+-]+)@([a-z0-9.-]+\.[a-z]{2,}(:[0-9]+)?)$/;
const OWN_NAME = /^(pool|hosting|c[0-9a-f]{10})$/;

function address(name: string, host: string, ownHost: string): Destination {
  return host === ownHost && OWN_NAME.test(name) ? { kind: 'own', account: name, address: `${name}@${host}` } : { kind: 'address', to: `${name}@${host}` };
}

function payLink(url: string, ownHost: string): Destination {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: 'unsupported', what: 'not a Lightning invoice, address or link' };
  }
  if (u.protocol !== 'https:') return { kind: 'unsupported', what: 'a link that is not https' };
  // LUD-16: name@host is https://host/.well-known/lnurlp/name, exactly.
  const m = /^\/\.well-known\/lnurlp\/([a-z0-9._+-]+)$/.exec(u.pathname);
  if (m && !u.search) return address(m[1], u.host, ownHost);
  return { kind: 'payurl', to: u.toString() };
}

/** What raw (pasted, typed or scanned) is. ownHost is this server's hostname. */
export function parseDestination(raw: string, ownHost: string): Destination {
  let s = raw.trim().replace(/^lightning:/i, '');
  // BIP353 line 77: a name is shown with ₿ and accepted with or without it; the ₿ isn't part of the DNS name.
  if (s.startsWith('₿')) {
    const a = ADDRESS.exec(s.slice(1).trim().toLowerCase());
    if (!a) return { kind: 'unsupported', what: "a ₿ address that can't be read" };
    const d = address(a[1], a[2], ownHost);
    return d.kind === 'address' ? { ...d, bip353Only: true } : d;
  }
  const lower = s.toLowerCase();
  if (lower.startsWith('bitcoin:')) {
    const q = s.indexOf('?');
    const params = q < 0 ? [] : [...new URLSearchParams(s.slice(q + 1))];
    // BIP321: a req- parameter the wallet doesn't understand makes the link invalid, and none is understood.
    if (params.some(([k]) => k.toLowerCase().startsWith('req-'))) {
      return { kind: 'unsupported', what: "a link with a requirement Send out doesn't know" };
    }
    // BIP21 keys in any case; an offer is paid before an invoice when the link has both.
    const lno = params.find(([k]) => k.toLowerCase() === 'lno')?.[1];
    const ln = params.find(([k]) => k.toLowerCase() === 'lightning')?.[1];
    if (lno) return parseDestination(lno, ownHost);
    return ln ? parseDestination(ln, ownHost) : { kind: 'unsupported', what: 'a Bitcoin address' };
  }
  if (/^(bc1|[13])[a-z0-9]{25,}$/i.test(s)) return { kind: 'unsupported', what: 'a Bitcoin address' };
  // Before lnbc: a regtest invoice starts lnbcrt.
  if (/^ln(tb|tbs|bcrt|sb)/.test(lower)) return { kind: 'unsupported', what: 'a testnet invoice' };
  if (lower.startsWith('lnbc')) {
    try {
      const amount = bolt11AmountMsat(lower);
      return { kind: 'invoice', to: lower, amountMsat: amount === null ? null : Number(amount), description: bolt11Description(lower) };
    } catch {
      return { kind: 'unsupported', what: "an invoice that can't be read" };
    }
  }
  if (lower.startsWith('lno1')) return { kind: 'offer', to: lower };
  if (lower.startsWith('lni1')) return { kind: 'unsupported', what: 'a BOLT12 invoice request' };
  if (lower.startsWith('lnurl1')) {
    const url = lnurlDecode(lower);
    return url ? payLink(url, ownHost) : { kind: 'unsupported', what: "an LNURL that can't be read" };
  }
  if (lower.startsWith('lnurlp://')) return payLink(`https://${s.slice('lnurlp://'.length)}`, ownHost);
  if (lower.startsWith('lnurlw://')) return { kind: 'unsupported', what: 'a withdraw link' };
  const a = ADDRESS.exec(lower);
  if (a) return address(a[1], a[2], ownHost);
  if (/^[a-z]+:\/\//.test(lower)) return payLink(s, ownHost);
  return { kind: 'unsupported', what: 'not a Lightning invoice, address or link' };
}
