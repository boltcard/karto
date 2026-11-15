// A tiny in-memory HTTP server for tests: routes "METHOD /path" to handlers
// and records every request. Handlers get the parsed URL, the request init and
// the body text.
import type { FetchFn } from '../lightning/lightning';

export type Handler = (req: { url: URL; init: RequestInit; body: string | undefined }) => unknown | Response;

export class FakeHttp {
  readonly requests: { method: string; url: string; body?: string; headers: Record<string, string> }[] = [];
  private routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  /** If set, every response carries this Date header. */
  date?: () => string;

  on(method: string, pattern: string | RegExp, handler: Handler): this {
    const re = typeof pattern === 'string' ? new RegExp(`^${pattern.replace(/[.?]/g, '\\$&')}$`) : pattern;
    this.routes.push({ method, pattern: re, handler });
    return this;
  }

  fetch: FetchFn = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : undefined;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    this.requests.push({ method, url: url.toString(), body, headers });
    const target = url.origin + url.pathname;
    const route = this.routes.find((r) => r.method === method && r.pattern.test(target));
    let res: Response;
    if (!route) res = json(404, { error: `no route for ${method} ${target}` });
    else {
      try {
        const out = await route.handler({ url, init, body });
        res = out instanceof Response ? out : json(200, out);
      } catch (e) {
        res = json(e instanceof HttpError ? e.status : 500, (e instanceof HttpError && e.body) || { error: (e as Error).message });
      }
    }
    if (this.date) res.headers.set('date', this.date());
    // As a real fetch does: the response says where it came from (a handler may have said otherwise: a redirect).
    if (!res.url) Object.defineProperty(res, 'url', { value: url.toString() });
    return res;
  };
}

export class HttpError extends Error {
  /** body, if given, is the reply instead of {error: message}. */
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
  }
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
