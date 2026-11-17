// A stand-in for api.mail.tm with the responses the onboarding flow relies on.
import { FakeHttp, HttpError, json, type Handler } from './http';

const API = 'https://api.mail.tm';

export type MailTmCall = 'GET /domains' | 'POST /accounts' | 'POST /token' | 'GET /messages' | 'GET /messages/{id}';

export class FakeMailTm {
  readonly http = new FakeHttp();
  domains = [{ domain: 'uberip.com', isActive: true, isPrivate: false }];
  accounts = new Map<string, { password: string; messages: { id: string; subject: string; text: string; html: string[] }[] }>();
  /** Set: DELETE /messages/{id} answers 500. */
  deleteFails = false;
  /** The calls that answer 429 (mail.tm's rate limit) while named here. */
  readonly busy = new Set<MailTmCall>();
  /** The calls that answer with this status (503, say) while named here. */
  readonly fails = new Map<MailTmCall, number>();
  private nextMessage = 1;

  constructor() {
    const http = this.http;
    // Each route answers 429 while its name is in busy, before anything else.
    const h = {
      on: (method: string, pattern: string | RegExp, handler: Handler, name?: string) => {
        http.on(method, pattern, (req) => {
          if (name && this.busy.has(name as MailTmCall)) throw new HttpError(429, 'Too Many Requests');
          const fail = name ? this.fails.get(name as MailTmCall) : undefined;
          if (fail) throw new HttpError(fail, 'failed');
          return handler(req);
        });
        return h;
      },
    };
    const user = (init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization ?? '';
      const address = auth.replace(/^Bearer tok:/, '');
      const acct = this.accounts.get(address);
      if (!acct) throw new HttpError(401, 'bad token');
      return acct;
    };
    h.on('GET', `${API}/domains`, () => ({ 'hydra:member': this.domains }), 'GET /domains');
    h.on('POST', `${API}/accounts`, ({ body }) => {
      const { address, password } = JSON.parse(body!);
      const domain = address.split('@')[1];
      if (!this.domains.some((d) => d.domain === domain && d.isActive)) throw new HttpError(422, 'domain not available');
      if (this.accounts.has(address)) return json(422, { 'hydra:description': 'address: This value is already used.' });
      this.accounts.set(address, { password, messages: [] });
      return json(201, { id: address, address });
    }, 'POST /accounts');
    h.on('POST', `${API}/token`, ({ body }) => {
      const { address, password } = JSON.parse(body!);
      if (this.accounts.get(address)?.password !== password) throw new HttpError(401, 'Invalid credentials.');
      return { token: `tok:${address}`, id: address };
    }, 'POST /token');
    h.on('GET', `${API}/messages`, ({ init }) => ({ 'hydra:member': user(init).messages.map(({ id, subject }) => ({ id, subject })) }), 'GET /messages');
    h.on('GET', /^https:\/\/api\.mail\.tm\/messages\/.+$/, ({ url, init }) => {
      const m = user(init).messages.find((x) => x.id === url.pathname.split('/').pop());
      if (!m) throw new HttpError(404, 'not found');
      return m;
    }, 'GET /messages/{id}');
    h.on('DELETE', /^https:\/\/api\.mail\.tm\/messages\/.+$/, ({ url, init }) => {
      if (this.deleteFails) throw new HttpError(500, 'server error');
      const messages = user(init).messages;
      const i = messages.findIndex((x) => x.id === url.pathname.split('/').pop());
      if (i < 0) throw new HttpError(404, 'not found');
      messages.splice(i, 1);
      return new Response(null, { status: 204 });
    });
  }

  deliver(address: string, subject: string, text: string, html: string[] = []) {
    const acct = this.accounts.get(address);
    if (!acct) return; // mail to a missing inbox is lost, as on the real service
    // Ids are never reused, as a deleted message's isn't.
    acct.messages.push({ id: `m${this.nextMessage++}`, subject, text, html });
  }
}
