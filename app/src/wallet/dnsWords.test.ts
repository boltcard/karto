import { describe, expect, it } from 'vitest';
import { dnsWords } from './dnsWords';

const TITLE = "Your server's name doesn't work on every network";

// The Server page's card when the server's name has no IPv4 address, or one that isn't the server's.
describe('dnsWords', () => {
  it('says nothing when the name is right, or the server says nothing of it', () => {
    expect(dnsWords('vm-1005.lnvps.cloud', '45.67.89.83', { ipv4: 'ok' })).toBeNull();
    expect(dnsWords('vm-1005.lnvps.cloud', '45.67.89.83', undefined)).toBeNull();
  });

  it('names the missing record and asks LNVPS, for one of its names', () => {
    expect(dnsWords('vm-1005.lnvps.cloud', '45.67.89.83', { ipv4: 'missing' })).toEqual({
      title: TITLE,
      text:
        "vm-1005.lnvps.cloud has no IPv4 address in DNS, so phones on networks without IPv6 (many mobile and home networks) can't reach your server. " +
        'LNVPS looks after this name: write to their support. Ask them to add an A record for vm-1005.lnvps.cloud pointing to 45.67.89.83.',
    });
  });

  it('names where the name points instead', () => {
    expect(dnsWords('vm-1005.lnvps.cloud', '45.67.89.83', { ipv4: 'other', got: ['1.2.3.4', '5.6.7.8'] })).toEqual({
      title: TITLE,
      text:
        "vm-1005.lnvps.cloud points to 1.2.3.4, not to your server's IPv4 address 45.67.89.83, so phones on networks without IPv6 (many mobile and home networks) can't reach your server. " +
        'LNVPS looks after this name: write to their support. Ask them to point it to 45.67.89.83.',
    });
  });

  it("sends the person to whoever manages a name that isn't LNVPS's", () => {
    expect(dnsWords('pay.example.com', '45.67.89.83', { ipv4: 'missing' })?.text).toBe(
      "pay.example.com has no IPv4 address in DNS, so phones on networks without IPv6 (many mobile and home networks) can't reach your server. " +
        'Whoever manages DNS for pay.example.com can fix it. Ask them to add an A record for pay.example.com pointing to 45.67.89.83.',
    );
  });
});
