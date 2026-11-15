// Moves, sends and renewals that happen once:
// one request id each, saved on the phone before the
// first try, asked again with the same id and body until there is an answer.
// When the app reopens, a saved move is asked again; a saved send or Renew now
// is dropped (by design: a payment that may not have gone out is
// never finished later). cardd answers a repeated id from the first time, and
// the refs on its moves and payments keep a retry from acting twice.
import { CarddError, type CarddClient, type MoveRequest, type RenewRequest, type SendAnswer, type SendRequest } from '../cardd/client';
import { isNetworkFailure } from '../lightning/lightning';
import type { AppStore } from '../store/store';

export type MoneyRequest = ((MoveRequest & { kind: 'move' }) | (SendRequest & { kind: 'send' }) | (RenewRequest & { kind: 'renew' })) & {
  started: number;
};

export type RequestOutcome =
  | { at: 'answered'; answer: { status: 'moved' } | SendAnswer }
  | { at: 'refused'; error: CarddError }
  /** No answer within the time allowed: the request stays saved, and the history will show what happened. */
  | { at: 'unknown' }
  /** A send or renewal saved before the app closed, not asked again: it may or may not have gone out. */
  | { at: 'dropped' };

export type MoneyDeps = {
  cardd: Pick<CarddClient, 'move' | 'send' | 'renewNow'>;
  store: Pick<AppStore, 'pendingRequests' | 'savePending' | 'dropPending'>;
};

type Clock = { now?: () => number; sleep?: (ms: number) => Promise<void>; capMs?: number; retryMs?: number };

/** cardd keeps a request id's answer for 7 days. */
const KEEP_MS = 7 * 24 * 3600_000;

/**
 * Caddy's 5xx while cardd restarts (or is down): cardd's own answers are JSON
 * {error, message}; Caddy's are not (CarddError codes 'http' or 'bad_response').
 */
export const isGatewayError = (e: unknown) => e instanceof CarddError && e.status >= 500 && (e.code === 'http' || e.code === 'bad_response');

/** A random UUID v4 for one move or send. */
export function requestId(random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  const b = random(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Saves the request, then asks cardd with the same id and body until it
 * answers: again after a network failure or a gateway error (Caddy's 5xx while
 * cardd restarts, which may come after cardd acted), and every retryMs (1.5 s)
 * while cardd is still handling the id. Any answer from cardd itself, a 5xx
 * included, is final: cardd stored it under the id. After capMs (a
 * minute) it stops, leaving the request saved.
 */
export async function runRequest(deps: MoneyDeps, req: MoneyRequest, o: Clock = {}): Promise<RequestOutcome> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + (o.capMs ?? 60_000);
  await deps.store.savePending(req);
  for (;;) {
    try {
      const answer =
        req.kind === 'move'
          ? await deps.cardd.move({ id: req.id, from: req.from, to: req.to, amountMsat: req.amountMsat })
          : req.kind === 'send'
            ? await deps.cardd.send({ id: req.id, to: req.to, name: req.name, amountMsat: req.amountMsat, comment: req.comment })
            : await deps.cardd.renewNow({ id: req.id, days: req.days });
      await deps.store.dropPending(req.id);
      return { at: 'answered', answer };
    } catch (e) {
      if (e instanceof CarddError && !isGatewayError(e) && e.code !== 'request_in_progress') {
        await deps.store.dropPending(req.id);
        return { at: 'refused', error: e };
      }
      if (!(e instanceof CarddError) && !isNetworkFailure(e)) throw e;
    }
    if (now() >= until) return { at: 'unknown' };
    await sleep(o.retryMs ?? 1500);
  }
}

/**
 * The requests saved when the app was closed, oldest first: a move is asked
 * again with its own id; a send or renewal is dropped unasked (outcome
 * 'dropped'); and any older than cardd keeps ids for is dropped without a word.
 */
export async function resumePending(deps: MoneyDeps, o: Clock = {}): Promise<{ req: MoneyRequest; outcome: RequestOutcome }[]> {
  const now = o.now ?? Date.now;
  const out: { req: MoneyRequest; outcome: RequestOutcome }[] = [];
  for (const req of (await deps.store.pendingRequests()).sort((a, b) => a.started - b.started)) {
    if (now() - req.started > KEEP_MS) await deps.store.dropPending(req.id);
    else if (req.kind !== 'move') {
      await deps.store.dropPending(req.id);
      out.push({ req, outcome: { at: 'dropped' } });
    } else out.push({ req, outcome: await runRequest(deps, req, o) });
  }
  return out;
}
