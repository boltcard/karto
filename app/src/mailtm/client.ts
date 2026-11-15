// mail.tm: the throwaway inbox LNVPS sends its verification link to. The
// inbox name and password come from the phrase (keys.mailtmName,
// keys.mailtmPassword); the domain is whichever one mail.tm offers today
//.
import type { FetchFn } from '../lightning/lightning';

export const MAILTM_API = 'https://api.mail.tm';

/**
 * LNVPS's verification link: <public_url>/api/v1/account/verify-email?token=<token> (LNVPS/api,
 * lnvps_api/src/api/routes.rs). Which public URL its emails carry isn't confirmed: any https host of lnvps.net.
 */
const VERIFY_PATH = '/api/v1/account/verify-email?token=';
const MAX_TOKEN = 256;
/** The most links taken from the inbox: LNVPS allows 10 verify-email requests a minute per IP. */
export const MAX_VERIFY_LINKS = 5;
const tokenChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
const MAX_AUTHORITY = 260; // a hostname's 253, ':443' and a little
const authorityChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 46 || c === 58;

/** host[:port] as an LNVPS link may have it: lnvps.net or a host under it, no empty label, no port but 443. */
function lnvpsAuthority(a: string): boolean {
  const [host, port, ...more] = a.toLowerCase().split(':');
  if (more.length || (port !== undefined && port !== '443')) return false;
  if (host !== 'lnvps.net' && !host.endsWith('.lnvps.net')) return false;
  return host.split('.').every((label) => label !== '');
}

/**
 * Every LNVPS verification link in text, in order (at most MAX_VERIFY_LINKS): indexOf and bounded loops, linear
 * whatever the text holds (the regex before took 16 s on 320 KB of "https://": anyone can mail the inbox).
 * A link whose host is in capitals is returned as written; the scheme is "https://" exactly, as LNVPS writes it.
 */
export function verifyLinks(text: string): string[] {
  const out: string[] = [];
  for (let at = text.indexOf(VERIFY_PATH); at >= 0 && out.length < MAX_VERIFY_LINKS; at = text.indexOf(VERIFY_PATH, at + VERIFY_PATH.length)) {
    // Back over the authority (no '@': a user part never passes), at most MAX_AUTHORITY characters, then "https://".
    let start = at;
    while (start > 0 && at - start < MAX_AUTHORITY && authorityChar(text.charCodeAt(start - 1))) start--;
    if (start === at || start < 8 || !text.startsWith('https://', start - 8) || !lnvpsAuthority(text.slice(start, at))) continue;
    const from = at + VERIFY_PATH.length;
    let end = from;
    while (end < text.length && end - from <= MAX_TOKEN && tokenChar(text.charCodeAt(end))) end++;
    if (end > from && end - from <= MAX_TOKEN) out.push(text.slice(start - 8, end));
  }
  return out;
}

/** What a scan of the inbox found (MailTmClient.findVerificationLinks). */
export type VerificationScan = {
  /** LNVPS links not passed over, in mail.tm's order, each once, at most MAX_VERIFY_LINKS, with the message each came in. */
  links: { link: string; message: string }[];
  /** Messages whose LNVPS links were all refused by LNVPS: spent, for deleting. */
  spent: string[];
};

export class MailTmError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class MailTmClient {
  constructor(private readonly opts: { fetch: FetchFn; baseUrl?: string }) {}

  private async call<T>(method: string, path: string, { body, token }: { body?: unknown; token?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/ld+json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await this.opts.fetch((this.opts.baseUrl ?? MAILTM_API) + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new MailTmError(res.status, `mail.tm ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** The first active public domain mail.tm offers right now. */
  async domain(): Promise<string> {
    const { 'hydra:member': domains } = await this.call<{ 'hydra:member': { domain: string; isActive: boolean; isPrivate: boolean }[] }>('GET', '/domains');
    const d = domains.find((x) => x.isActive && !x.isPrivate);
    if (!d) throw new MailTmError(503, 'mail.tm has no public domain right now');
    return d.domain;
  }

  /**
   * Creates the inbox if it does not exist yet, then logs in. Safe to repeat:
   * an existing inbox (422) is fine as long as the derived password works.
   */
  async open(address: string, password: string): Promise<string> {
    try {
      await this.call('POST', '/accounts', { body: { address, password } });
    } catch (e) {
      if (!(e instanceof MailTmError && e.status === 422)) throw e;
    }
    const { token } = await this.call<{ token: string }>('POST', '/token', { body: { address, password } });
    return token;
  }

  /**
   * The LNVPS verification links in the inbox, in mail.tm's order, each once (a link in both a
   * message's text and its HTML counts once), at most MAX_VERIFY_LINKS: none until the email has arrived.
   * Links LNVPS refused, and those opened lately that didn't verify (passOver), are passed over and
   * never count toward MAX_VERIFY_LINKS, so look-alikes can't fill every pass ahead of its own link.
   * A message gives at most MAX_VERIFY_LINKS distinct links, across its text
   * and HTML parts, so one carrying hundreds is spent after at most five refusals;
   * a message whose links were all refused is named spent, for the caller to delete.
   */
  async findVerificationLinks(token: string, refused: readonly string[] = [], passOver: readonly string[] = []): Promise<VerificationScan> {
    const { 'hydra:member': messages } = await this.call<{ 'hydra:member': { id: string }[] }>('GET', '/messages', { token });
    const out: VerificationScan = { links: [], spent: [] };
    for (const m of messages) {
      if (out.links.length >= MAX_VERIFY_LINKS) break;
      const full = await this.call<{ text?: string; html?: string[] }>('GET', `/messages/${encodeURIComponent(m.id)}`, { token });
      const found = [...new Set([full.text ?? '', ...(full.html ?? [])].flatMap(verifyLinks))].slice(0, MAX_VERIFY_LINKS);
      if (found.length && found.every((link) => refused.includes(link))) out.spent.push(m.id);
      const fresh = found.filter((link) => !refused.includes(link) && !passOver.includes(link));
      for (const link of fresh) {
        if (out.links.length < MAX_VERIFY_LINKS && !out.links.some((l) => l.link === link)) out.links.push({ link, message: m.id });
      }
    }
    return out;
  }

  /** Deletes a message: one whose links LNVPS refused, so the inbox's first page stays LNVPS's. */
  async deleteMessage(token: string, id: string): Promise<void> {
    await this.call('DELETE', `/messages/${encodeURIComponent(id)}`, { token });
  }
}
