import { describe, expect, it } from 'vitest';
import { MailTmClient, verifyLinks } from './client';
import { FakeMailTm } from '../testing/fakeMailTm';

const LINK = (token: string) => `https://api.lnvps.net/api/v1/account/verify-email?token=${token}`;

const setup = () => {
  const fake = new FakeMailTm();
  return { fake, client: new MailTmClient({ fetch: fake.http.fetch }) };
};

describe('MailTmClient', () => {
  it('uses the first active public domain', async () => {
    const { fake, client } = setup();
    fake.domains = [
      { domain: 'old.com', isActive: false, isPrivate: false },
      { domain: 'priv.com', isActive: true, isPrivate: true },
      { domain: 'uberip.com', isActive: true, isPrivate: false },
    ];
    expect(await client.domain()).toBe('uberip.com');
    fake.domains = [];
    await expect(client.domain()).rejects.toThrow('no public domain');
  });

  it('opens the same inbox again after the app restarts', async () => {
    const { client } = setup();
    const a = await client.open('f6ygjrifabn6ne2s@uberip.com', 'pw');
    const b = await client.open('f6ygjrifabn6ne2s@uberip.com', 'pw');
    expect(a).toBe(b);
    await expect(client.open('f6ygjrifabn6ne2s@uberip.com', 'other')).rejects.toThrow('401');
  });

  // Each poll opens the inbox: one that exists costs one request, so polling doesn't add to mail.tm's rate limit.
  it('logs in to an existing inbox with one request, and makes a new one only when the login is refused', async () => {
    const { fake, client } = setup();
    await client.open('x@uberip.com', 'pw');
    expect(fake.http.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['POST /token', 'POST /accounts', 'POST /token']);
    fake.http.requests.length = 0;
    await client.open('x@uberip.com', 'pw');
    expect(fake.http.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['POST /token']);
  });

  it('finds the verification link in text or HTML, and nothing before it arrives', async () => {
    const { fake, client } = setup();
    const token = await client.open('x@uberip.com', 'pw');
    const links = async (skip: string[] = []) => (await client.findVerificationLinks(token, skip)).links.map((l) => l.link);
    expect(await links()).toEqual([]);
    fake.deliver('x@uberip.com', 'Welcome', 'no link here');
    fake.deliver('x@uberip.com', 'Verify', '', [`<a href="${LINK('Ab_9-z')}">verify</a>`]);
    expect(await client.findVerificationLinks(token)).toEqual({ links: [{ link: LINK('Ab_9-z'), message: 'm2' }], spent: [] });
  });

  // Every one is tried in turn (machine.ts), so a look-alike can't hide LNVPS's; LNVPS allows 10 verify-email requests a minute.
  it("gives every LNVPS link in mail.tm's order, each once, at most five", async () => {
    const { fake, client } = setup();
    const token = await client.open('x@uberip.com', 'pw');
    const links = async () => (await client.findVerificationLinks(token, [])).links.map((l) => l.link);
    fake.deliver('x@uberip.com', 'Decoy', `${LINK('a')} https://evil.example/api/v1/account/verify-email?token=b`);
    fake.deliver('x@uberip.com', 'Verify', `Open ${LINK('c')} to verify.`, [`<a href="${LINK('c')}">verify</a>`]);
    expect(await links()).toEqual([LINK('a'), LINK('c')]);
    fake.deliver('x@uberip.com', 'More', ['d', 'e', 'f', 'g'].map(LINK).join('\n'));
    expect(await links()).toEqual(['a', 'c', 'd', 'e', 'f'].map(LINK));
  });

  // Five refused look-alikes ahead of LNVPS's link must not fill the five every pass.
  it('passes over links already refused, so they never count toward the five, and names the messages they spent', async () => {
    const { fake, client } = setup();
    const token = await client.open('x@uberip.com', 'pw');
    const bogus = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map(LINK);
    for (const b of bogus) fake.deliver('x@uberip.com', 'Verify', b);
    fake.deliver('x@uberip.com', 'Mixed', `${LINK('b1')} ${LINK('m')}`);
    fake.deliver('x@uberip.com', 'Verify', LINK('real'));
    expect(await client.findVerificationLinks(token, bogus)).toEqual({
      links: [{ link: LINK('m'), message: 'm7' }, { link: LINK('real'), message: 'm8' }],
      spent: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'], // m7 still holds a link to try
    });
  });

  // A message carrying over 100 look-alikes must still be spent after a few refusals.
  it('takes at most five links from one message, so it is spent once those five are refused', async () => {
    const { fake, client } = setup();
    const token = await client.open('x@uberip.com', 'pw');
    const bogus = Array.from({ length: 30 }, (_, i) => LINK(`b${i}`));
    fake.deliver('x@uberip.com', 'Flood', bogus[0], Array.from({ length: 6 }, (_, p) => bogus.slice(p * 5, p * 5 + 5).join(' ')));
    expect(await client.findVerificationLinks(token)).toEqual({ links: bogus.slice(0, 5).map((link) => ({ link, message: 'm1' })), spent: [] });
    expect(await client.findVerificationLinks(token, bogus.slice(0, 5))).toEqual({ links: [], spent: ['m1'] });
  });

  // A link opened that didn't verify this account is passed over, its message kept.
  it('passes over links opened before without counting their message spent', async () => {
    const { fake, client } = setup();
    const token = await client.open('x@uberip.com', 'pw');
    fake.deliver('x@uberip.com', 'Other', LINK('foreign'));
    fake.deliver('x@uberip.com', 'Verify', LINK('real'));
    expect(await client.findVerificationLinks(token, [], [LINK('foreign')])).toEqual({ links: [{ link: LINK('real'), message: 'm2' }], spent: [] });
  });

  it('deletes a message', async () => {
    const { fake, client } = setup();
    const token = await client.open('x@uberip.com', 'pw');
    fake.deliver('x@uberip.com', 'Verify', LINK('b1'));
    fake.deliver('x@uberip.com', 'Verify', LINK('real'));
    await client.deleteMessage(token, 'm1');
    expect(fake.accounts.get('x@uberip.com')!.messages.map((m) => m.id)).toEqual(['m2']);
    await expect(client.deleteMessage(token, 'm1')).rejects.toThrow('404');
  });
});

describe('verifyLinks', () => {
  // The old regex took 16 s on 320 KB of "https://".
  it('reads a hostile megabyte in linear time', () => {
    const path = '/api/v1/account/verify-email?token=';
    for (const body of ['https://'.repeat(131_072), path.repeat(29_000), `${'a'.repeat(300)}${path}`.repeat(3_000), `https://${'a.'.repeat(130)}lnvps.net${path} `.repeat(3_500), 'a'.repeat(1 << 20)]) {
      const t0 = performance.now();
      expect(verifyLinks(body)).toEqual([]);
      // Linear takes milliseconds; the old regex took seconds. Generous, so a busy machine can't flake it.
      expect(performance.now() - t0).toBeLessThan(2_000);
    }
  });

  // The real email's origin isn't confirmed: any https host of lnvps.net, that path exactly (revision 2).
  it('takes a link on lnvps.net or a host under it, with the path exactly', () => {
    const at = (origin: string) => `${origin}/api/v1/account/verify-email?token=abc`;
    for (const ok of ['https://api.lnvps.net', 'https://lnvps.net', 'https://LNVPS.net', 'https://lnvps.net:443', 'https://www.lnvps.net']) {
      expect(verifyLinks(`<a href="${at(ok)}">verify</a>`)).toEqual([at(ok)]);
    }
  });

  it('never takes a link on another host, with a user part, a port, plain http or another path', () => {
    for (const bad of [
      'https://evil.example', 'https://lnvps.net.evil.example', 'https://api.lnvps.net.evil.example', 'https://xlnvps.net',
      'https://a@lnvps.net', 'https://evil.example@api.lnvps.net', 'https://lnvps.net:8443', 'http://lnvps.net', 'https://.lnvps.net', 'https://a..lnvps.net',
    ]) {
      expect(verifyLinks(`${bad}/api/v1/account/verify-email?token=abc`)).toEqual([]);
    }
    expect(verifyLinks('https://lnvps.net/verify-email?token=abc')).toEqual([]);
    expect(verifyLinks('https://lnvps.net/x/api/v1/account/verify-email?token=abc')).toEqual([]);
  });

  it('finds LNVPS\'s link after a decoy, and every one in order', () => {
    expect(verifyLinks(`https://evil.example/verify-email?token=x ${LINK('real')}`)).toEqual([LINK('real')]);
    expect(verifyLinks(`${LINK('decoy')}\n${LINK('real')}`)).toEqual([LINK('decoy'), LINK('real')]);
  });

  it('refuses an empty token or one over 256 characters', () => {
    expect(verifyLinks(`${LINK('')} `)).toEqual([]);
    expect(verifyLinks(LINK('a'.repeat(257)))).toEqual([]);
    expect(verifyLinks(LINK('a'.repeat(256)))).toEqual([LINK('a'.repeat(256))]);
  });
});
