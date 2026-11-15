// Keeps something fresh while a screen is showing: the card list's balances.

/**
 * Calls fn every ms while active() says so, never two at once: the next call is
 * timed from the end of the last. A failure is ignored (the next call tries
 * again). Returns stop.
 */
export function poll(fn: () => Promise<unknown>, ms: number, active: () => boolean): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    if (active()) await fn().catch(() => {});
    if (!stopped) timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** The clock and the timer a held loop runs on: the phone's, unless its caller has its own (ServerWatch, a test). */
export type LoopClock = { now: () => number; setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (timer: unknown) => void };

/**
 * How long a held read asks the server to wait, in seconds: with nothing happening it is one request every 5
 * seconds, as the refresh was, kept open where that one was answered at once. Under the 30 seconds the wallet's
 * client gives a call (services.tsx fetchFn); never for the client a held card's calls use, which gives up after 5.
 */
export const HELD_WAIT_S = 5;
/** After an answer that came at once with nothing new (a server that does not hold), after a failure, and between looks while not active. */
export const HELD_IDLE_MS = 5000;
/** An answer that took this long was held by the server: the next ask follows at once. */
const HELD_ANSWER_MS = 1000;
/** Two asks never start closer than this, whatever the server answers: 4 a second at most. */
const HELD_GAP_MS = 250;

/**
 * What an ask of a held loop came to: 'moved', its answer brought something new to ask past (a new rev, a newer
 * transaction); 'held', a read the server was asked to hold, with nothing new; 'plain', a read it was not asked to
 * hold (a server from before held reads), however long it took.
 */
export type Asked = 'moved' | 'held' | 'plain';

/**
 * Keeps something fresh by asking a server that may hold its answer until there is news.
 * It is asked at once (or startIn ms on); then again at once
 * after an answer that moved on, or a held one that took a second or more (the server held it: the wait ran out),
 * and HELD_IDLE_MS after a held one that came at once with nothing new (a server that does not hold), a plain one,
 * or a failure. Only while active(), never two at once.
 * ask must settle: the loop has no timeout of its own, and one that never answers stalls it (its callers' clients
 * give a call 30 seconds).
 * stop: an ask under way then is not followed by another (what becomes of its answer is ask's own business).
 * kick: there is something to ask now (its caller learned what to ask past): a loop waiting for its next turn asks
 * at once; one already asking goes on.
 */
export function heldLoop(o: { ask: () => Promise<Asked>; active: () => boolean; clock?: LoopClock; startIn?: number }): { stop: () => void; kick: () => void } {
  const clock: LoopClock = o.clock ?? {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
  let stopped = false;
  let asking = false;
  let started = -Infinity;
  let timer: unknown;
  const later = (ms: number) => {
    if (stopped) return;
    if (ms <= 0) return void turn();
    timer = clock.setTimeout(() => void turn(), ms);
  };
  const turn = async () => {
    if (stopped) return;
    if (!o.active()) return later(HELD_IDLE_MS);
    started = clock.now();
    asking = true;
    let again = false;
    try {
      const asked = await o.ask();
      again = asked === 'moved' || (asked === 'held' && clock.now() - started >= HELD_ANSWER_MS);
    } catch {
      again = false;
    }
    asking = false;
    later(again ? Math.max(0, HELD_GAP_MS - (clock.now() - started)) : HELD_IDLE_MS);
  };
  later(o.startIn ?? 0);
  return {
    stop: () => {
      stopped = true;
      clock.clearTimeout(timer);
    },
    kick: () => {
      if (stopped || asking) return;
      clock.clearTimeout(timer);
      later(Math.max(0, HELD_GAP_MS - (clock.now() - started)));
    },
  };
}
