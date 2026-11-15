// A request to cardd signed by the phone's device key, as both apps' clients
// make it: Karto Wallet's (cardd/client.ts) and Karto PoS's (pos/client.ts). It knows no route of its own.
import type { FetchFn } from '../lightning/lightning';
import type { DeviceKey } from '../native/deviceKey';
import { CarddError } from './error';

/** detail: the push test's word for what the endpoint said (push.go), in place of a message. */
type Reply = { error?: string; message?: string; detail?: string };

/** A reply's JSON; anything else (Caddy's HTML while cardd restarts, say) is a bad_response. */
export async function readJson(res: Response, method: string, path: string): Promise<Reply> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new CarddError(res.status, 'bad_response', `${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** cardd's refusal as an error: its code and message, or the HTTP status when it gave none. */
export const refusal = (res: Response, r: Reply) => new CarddError(res.status, r.error ?? 'http', r.message ?? r.detail ?? r.error ?? `HTTP ${res.status}`, r as Record<string, unknown>);


export class SignedCalls {
  /** Server clock minus phone clock (ms), learnt from a Date header after a refused signature. */
  private clockOffsetMs = 0;

  constructor(private readonly o: { fetch: FetchFn; host: string; key: Pick<DeviceKey, 'authorize'>; now?: () => number }) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** A signed request's JSON answer; cardd's refusal is thrown as a CarddError. */
  async call<T>(method: string, path: string, body?: unknown, fetchFn = this.o.fetch): Promise<T> {
    const res = await this.request(method, path, body, fetchFn);
    const parsed = await readJson(res, method, path);
    if (!res.ok) throw refusal(res, parsed);
    return parsed as T;
  }

  /** A signed request, signed again on cardd's clock if it refused ours. */
  async request(method: string, path: string, body: unknown, fetchFn: FetchFn): Promise<Response> {
    const json = body === undefined ? '' : JSON.stringify(body);
    const send = async () => {
      const ts = Math.floor((this.now() + this.clockOffsetMs) / 1000);
      const headers: Record<string, string> = { accept: 'application/json', authorization: await this.o.key.authorize(method, path, json, ts) };
      if (json) headers['content-type'] = 'application/json';
      return fetchFn(`https://${this.o.host}${path}`, { method, headers, body: json || undefined });
    };
    let res = await send();
    // cardd accepts ts within ±60 s. If it refuses while its Date header is well
    // away from our clock, sign again on its time, once.
    if (res.status === 401) {
      const serverMs = Date.parse(res.headers.get('date') ?? '');
      const offset = serverMs - this.now();
      if (Number.isFinite(serverMs) && Math.abs(offset - this.clockOffsetMs) > 30_000) {
        this.clockOffsetMs = offset;
        res = await send();
      }
    }
    return res;
  }
}
