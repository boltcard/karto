// The Server page's card when the server's name has no IPv4 address, or one that isn't the server's.
// A phone on a network without IPv6 can't reach such a server by
// name; the person can't fix it themselves, so the words say who can and what to ask for.
import type { DnsAnswer } from '../cardd/client';

const NETWORKS = 'phones on networks without IPv6 (many mobile and home networks)';

/** LNVPS's own names: vm-N.lnvps.cloud, as cardd's check tells them (server/internal/namecheck). */
const lnvpsName = (host: string) => host.toLowerCase().replace(/\.$/, '').endsWith('.lnvps.cloud');

/** host and ipv4: the server's name and IPv4 address as setup saved them. Null when there is nothing to say. */
export function dnsWords(host: string, ipv4: string, dns: DnsAnswer | undefined): { title: string; text: string } | null {
  if (!dns || (dns.ipv4 !== 'missing' && dns.ipv4 !== 'other')) return null;
  const who = lnvpsName(host) ? 'LNVPS looks after this name: write to their support.' : `Whoever manages DNS for ${host} can fix it.`;
  const text =
    dns.ipv4 === 'missing'
      ? `${host} has no IPv4 address in DNS, so ${NETWORKS} can't reach your server. ${who} Ask them to add an A record for ${host} pointing to ${ipv4}.`
      : `${host} points to ${dns.got?.[0] ?? 'another address'}, not to your server's IPv4 address ${ipv4}, so ${NETWORKS} can't reach your server. ${who} Ask them to point it to ${ipv4}.`;
  return { title: "Your server's name doesn't work on every network", text };
}
