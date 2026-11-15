import { describe, expect, it } from 'vitest';
import { lnurlEncode } from '../cards/labels';
import { parseDestination } from './destination';

const HOST = 'vm-1009.lnvps.cloud';
// BOLT 11's donation example: no amount, "Please consider supporting this project".
const DONATION =
  'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';
// LUD-01's example: https://service.com/api?q=3fc3…
const LNURL =
  'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS';

describe('parseDestination', () => {
  it('reads an invoice, with or without lightning:, in either case, with its description', () => {
    for (const s of [DONATION, `lightning:${DONATION}`, `  LIGHTNING:${DONATION.toUpperCase()} `]) {
      expect(parseDestination(s, HOST)).toEqual({ kind: 'invoice', to: DONATION, amountMsat: null, description: 'Please consider supporting this project' });
    }
  });

  it('reads a Lightning address, and an LNURL or lnurlp:// link to an address page as that address', () => {
    expect(parseDestination(' Alice@Pay.Example.com ', HOST)).toEqual({ kind: 'address', to: 'alice@pay.example.com' });
    expect(parseDestination(lnurlEncode('https://pay.example.com/.well-known/lnurlp/alice'), HOST)).toEqual({ kind: 'address', to: 'alice@pay.example.com' });
    expect(parseDestination('lnurlp://pay.example.com/.well-known/lnurlp/alice', HOST)).toEqual({ kind: 'address', to: 'alice@pay.example.com' });
  });

  it('reads any other https pay link as an LNURL-pay URL', () => {
    expect(parseDestination(LNURL, HOST)).toEqual({ kind: 'payurl', to: 'https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df' });
    expect(parseDestination('https://shop.example.com/lnurlp/abc', HOST)).toEqual({ kind: 'payurl', to: 'https://shop.example.com/lnurlp/abc' });
  });

  it('takes the invoice out of a bitcoin: link', () => {
    expect(parseDestination(`bitcoin:bc1qxyz?amount=0.0001&lightning=${DONATION.toUpperCase()}`, HOST)).toMatchObject({ kind: 'invoice', to: DONATION });
  });

  it("recognises this server's own addresses", () => {
    expect(parseDestination(`pool@${HOST}`, HOST)).toEqual({ kind: 'own', account: 'pool', address: `pool@${HOST}` });
    expect(parseDestination(lnurlEncode(`https://${HOST}/.well-known/lnurlp/ce07ce1279d`), HOST)).toEqual({ kind: 'own', account: 'ce07ce1279d', address: `ce07ce1279d@${HOST}` });
  });

  it('says what something unpayable is', () => {
    expect(parseDestination('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', HOST)).toEqual({ kind: 'unsupported', what: 'a Bitcoin address' });
    expect(parseDestination('bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', HOST)).toEqual({ kind: 'unsupported', what: 'a Bitcoin address' });
    for (const s of ['lntb1pvjluez', 'lntbs1pvjluez', 'lnsb1pvjluez', 'lnbcrt1pvjluez', 'LNBCRT10U1PVJLUEZ', 'lightning:lnbcrt1pvjluez']) {
      expect(parseDestination(s, HOST)).toEqual({ kind: 'unsupported', what: 'a testnet invoice' });
    }
    expect(parseDestination('lnurlw://shop.example.com/ln?p=1', HOST)).toEqual({ kind: 'unsupported', what: 'a withdraw link' });
    expect(parseDestination('http://shop.example.com/lnurlp/abc', HOST)).toEqual({ kind: 'unsupported', what: 'a link that is not https' });
    expect(parseDestination('hello', HOST)).toEqual({ kind: 'unsupported', what: 'not a Lightning invoice, address or link' });
    // Phoenix's receive screen shows a BOLT12 offer by default: it is paid now.
    expect(parseDestination('lightning:LNO1PGQPVGGZ9JQQRSDPMSFCYQYH', HOST)).toEqual({ kind: 'offer', to: 'lno1pgqpvggz9jqqrsdpmsfcyqyh' });
  });

  it('reads a ₿ name as BIP353 only, and a plain name as a name', () => {
    expect(parseDestination('₿alice@phoenixwallet.me', HOST)).toEqual({ kind: 'address', to: 'alice@phoenixwallet.me', bip353Only: true });
    expect(parseDestination('  ₿Alice@PhoenixWallet.me ', HOST)).toEqual({ kind: 'address', to: 'alice@phoenixwallet.me', bip353Only: true });
    expect(parseDestination('alice@phoenixwallet.me', HOST)).toEqual({ kind: 'address', to: 'alice@phoenixwallet.me' });
    expect(parseDestination('₿not a name', HOST)).toEqual({ kind: 'unsupported', what: "a ₿ address that can't be read" });
  });

  it("refuses a bitcoin: link with a req- parameter, which it can't honour", () => {
    expect(parseDestination(`bitcoin:?lno=lno1qgsq&req-somethingnew=1`, HOST)).toEqual({ kind: 'unsupported', what: "a link with a requirement Send out doesn't know" });
    expect(parseDestination(`bitcoin:bc1qxyz?REQ-pop=x&lightning=${DONATION}`, HOST)).toMatchObject({ kind: 'unsupported' });
    expect(parseDestination(`bitcoin:bc1qxyz?label=req-pop&lightning=${DONATION}`, HOST)).toMatchObject({ kind: 'invoice', to: DONATION });
  });

  it('reads an offer, bare, after lightning:, and in a bitcoin: link', () => {
    expect(parseDestination('LNO1QGSQ', HOST)).toEqual({ kind: 'offer', to: 'lno1qgsq' });
    expect(parseDestination('lightning:lno1qgsq', HOST)).toEqual({ kind: 'offer', to: 'lno1qgsq' });
    expect(parseDestination('bitcoin:?lno=lno1qgsq', HOST)).toEqual({ kind: 'offer', to: 'lno1qgsq' });
    expect(parseDestination('bitcoin:bc1qexample?LNO=lno1qgsq&lightning=lnbc1x', HOST)).toEqual({ kind: 'offer', to: 'lno1qgsq' });
    expect(parseDestination('lni1qgsq', HOST)).toEqual({ kind: 'unsupported', what: 'a BOLT12 invoice request' });
  });
});
