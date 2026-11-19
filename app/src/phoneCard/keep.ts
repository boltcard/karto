// Keeping a phone's card in step with the server: one job, run
// each time the wallet has the server's own list of cards, on both phones. It removes a phone's card that is not
// this phone's (only one phone is paired with a server at a time, so such a card belongs to a phone that is
// unpaired and could otherwise go on paying), and brings this phone's own back to what the person set up. Nothing
// here asks for the screen lock: each step removes a way to spend or restores what was there.
import { CarddError, type CardInfo, type CarddClient } from '../cardd/client';
import { isNetworkFailure } from '../lightning/lightning';
import { CounterSpent, checkCounters, firstCounter, lowestFree, phoneCardId, phonesCardsWide } from './id';
import type { PhoneCardRecord, PhoneCardRecordStore } from './record';
import { tapSuns } from './taps';

/** Another phone's card that this run removed, for the Wallet page: its name and what moved to Pool (null: the server wouldn't say). */
export type Removed = { name: string; amountMsat: number | null };

export type KeepDeps = {
  issuer: Uint8Array;
  /** The server the wallet is paired with. */
  host: string;
  cardd: Pick<CarddClient, 'wallet' | 'reserveCard' | 'confirmCard' | 'checkCard' | 'wipeCard' | 'wipedCard' | 'freezeCard' | 'setCardHost'>;
  record: PhoneCardRecordStore;
  /** The name the phone remembers for a card (its cache), for one the server has forgotten. */
  rememberedName(id: string): Promise<string | undefined>;
  /** The phone's own name, for a card nothing remembers. */
  phoneName: string;
  /** The phone's clock, in ms. */
  now(): number;
  /** Told of each card removed, once its balance has moved. */
  noteRemoved(removed: Removed): Promise<void>;
  random?: (n: number) => Uint8Array;
};

/**
 * What a run did. stopped: it left something for the next run, because the record couldn't be read (which is not
 * a missing record: nothing was done), the server couldn't be reached, a payment holds some of a balance to be
 * wiped (the card is frozen meanwhile, and the other cards were still seen to), or the card's counter is used up.
 */
export type Kept = { removed: Removed[]; registered: boolean; stopped?: 'unreadable' | 'network' | 'busy' | 'counter' };

const LIVE = ['programming', 'active', 'frozen', 'wiping'];
class Busy extends Error {}

/** Removes a card, its balance moving to Pool as a wipe's does. Busy while cardd refuses the wipe for a payment in progress. */
async function wipe(d: KeepDeps, id: string): Promise<void> {
  try {
    await d.cardd.wipeCard(id);
  } catch (e) {
    if (e instanceof CarddError && e.status === 409) throw new Busy();
    throw e;
  }
}

/** cards: the server's own list, never the phone's cache. */
export async function keepPhoneCard(d: KeepDeps, cards: CardInfo[]): Promise<Kept> {
  const kept: Kept = { removed: [], registered: false };
  const read = await d.record.read();
  if (!read.ok) return { ...kept, stopped: 'unreadable' };
  const rec = read.record;
  // What one card could not have done to it does not stop the others: a card that stays is one that can pay.
  let busy = false;
  let refused: unknown;
  try {
    // 1. Another phone's card. The wider look: a card past a gap in the numbers is removed too.
    const others = phonesCardsWide(d.issuer, cards).filter((p) => p.n !== rec?.n && LIVE.includes(p.card.state));
    const balances = others.some((p) => p.card.state !== 'wiping') ? await balancesOf(d) : null;
    for (const { card } of others) {
      try {
        await wipe(d, card.id);
        // A card found wiping was noted by the run that began its wipe.
        if (card.state !== 'wiping') {
          const removed = { name: card.name, amountMsat: balances ? (balances.get(card.id) ?? 0) : null };
          await d.noteRemoved(removed);
          kept.removed.push(removed);
        }
        await d.cardd.wipedCard(card.id);
      } catch (e) {
        if (e instanceof Busy) {
          // It can't be wiped while a payment holds some of its balance, but it can be stopped from starting another.
          busy = true;
          if (card.state === 'active') await d.cardd.freezeCard(card.id).catch((x) => (refused ??= orThrowNetwork(x)));
        } else if (e instanceof CarddError) refused ??= e;
        else throw e;
      }
    }
    if (rec) kept.registered = await keepOwn(d, cards, rec);
  } catch (e) {
    if (e instanceof Busy) return { ...kept, stopped: 'busy' };
    if (e instanceof CounterSpent) return { ...kept, stopped: 'counter' };
    if (isNetworkFailure(e)) return { ...kept, stopped: 'network' };
    throw e;
  }
  if (refused) throw refused;
  return busy ? { ...kept, stopped: 'busy' } : kept;
}

/** A refusal is kept for the end of the run; an unreachable server ends the run. */
function orThrowNetwork(e: unknown): unknown {
  if (e instanceof CarddError) return e;
  throw e;
}

/**
 * The cards' balances, for the notices: null when the server won't say (its wallet asks phoenixd, which may be
 * down), and the removals go on without the amounts. An unreachable server ends the run.
 */
async function balancesOf(d: KeepDeps): Promise<Map<string, number> | null> {
  try {
    return new Map((await d.cardd.wallet()).cards.map((c) => [c.id, c.balanceMsat]));
  } catch (e) {
    if (e instanceof CarddError) return null;
    throw e;
  }
}

/** Steps 2 to 7, for this phone's own card. Answers whether the card was registered or confirmed. */
async function keepOwn(d: KeepDeps, cards: CardInfo[], rec: PhoneCardRecord): Promise<boolean> {
  const id = phoneCardId(d.issuer, rec.n);
  const mine = cards.find((c) => c.id === id);
  const confirm = (n: number, version: number, counter: number) =>
    d.cardd.confirmCard(phoneCardId(d.issuer, n), tapSuns({ issuer: d.issuer, n, version }, counter, 1, d.random)[0]);

  // 4. A removal cut off, or one the person asked for: the wipe is finished and the record deleted.
  if (rec.removing || mine?.state === 'wiping' || mine?.state === 'reset') {
    if (mine && mine.state !== 'reset') {
      await wipe(d, id);
      await d.cardd.wipedCard(id);
    }
    await d.record.update(() => null);
    return false;
  }
  // 2. Missing from the list (a server rebuilt from the phrase alone, or from a snapshot older than the card):
  // registered again at the lowest number the server does not list, so the numbers listed stay the first few.
  if (!mine) {
    const n = lowestFree(d.issuer, cards);
    // The record as it stands now, not as this run first read it: the pay screen may have reserved counters since.
    const written = await d.record.update((r) => {
      const from = firstCounter(Math.max(rec.next, r?.next ?? 0), d.now());
      checkCounters(from, 1);
      return { n, version: 0, next: from + 1 };
    });
    const first = written!.next - 1;
    const reserved = await d.cardd.reserveCard(phoneCardId(d.issuer, n), (await d.rememberedName(id)) ?? d.phoneName);
    if (reserved.version !== 0) await d.record.update((r) => r && { ...r, version: reserved.version });
    await confirm(n, reserved.version, first);
    return true;
  }
  // 3. A set-up cut off before its confirm.
  if (mine.state === 'programming') {
    // The record's next as it stands now, not as this run first read it: the pay screen may have reserved counters since.
    const written = await d.record.update((r) => {
      if (!r) return r;
      checkCounters(r.next, 1);
      return { ...r, version: mine.version, next: r.next + 1 };
    });
    if (!written) return false;
    await confirm(rec.n, mine.version, written.next - 1);
    return true;
  }
  // 5. At another host (a rebuilt server has a new hostname): no hold is needed, the phone makes its own links.
  if (mine.host !== undefined && mine.host !== d.host) await d.cardd.setCardHost(id, d.host);
  // 6. Restored from a backup: the server's counter is the backup's, behind taps this phone may have handed out
  // since, so it lets the card pay only once checked. A tap past them all and past the server's counter is the
  // check; the record is written one higher first, as for a confirm, so a cut run's tap is never made again.
  if (mine.needsCheck) {
    const written = await d.record.update((r) => {
      if (!r) return r;
      const at = Math.max(r.next, mine.counter + 1);
      checkCounters(at, 1);
      return { ...r, version: mine.version, next: at + 1 };
    });
    if (written) await d.cardd.checkCard(tapSuns({ issuer: d.issuer, n: rec.n, version: mine.version }, written.next - 1, 1, d.random)[0]);
  }
  // 7. The record never behind the server: its key version, and a next past the server's counter.
  await d.record.update((r) => r && { ...r, version: mine.version, next: Math.max(r.next, mine.counter + 1) });
  return false;
}

/**
 * The job as the wallet runs it: one run at a time, and none while the phone is armed as a card (the pay screen
 * is writing the record then). Null for a run that was not made. changed: the server changed something at the
 * run's asking, so the list it was given is out of date and the wallet asks for it again.
 */
export function phoneCardKeeper(d: KeepDeps & { armed(): boolean }): (cards: CardInfo[]) => Promise<(Kept & { changed: boolean }) | null> {
  let running = false;
  return async (cards) => {
    if (running || d.armed()) return null;
    running = true;
    let changed = false;
    // Only a call the server took: one it refused changed nothing, and a wallet that asked again after each such
    // run would ask without end while a payment holds a card's balance.
    const noting = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
      const answer = await call(...args);
      changed = true;
      return answer;
    };
    const c = d.cardd;
    const cardd: KeepDeps['cardd'] = {
      wallet: () => c.wallet(),
      reserveCard: noting((id, name) => c.reserveCard(id, name)),
      confirmCard: noting((id, sun) => c.confirmCard(id, sun)),
      checkCard: noting((sun) => c.checkCard(sun)),
      wipeCard: noting((id) => c.wipeCard(id)),
      wipedCard: noting((id) => c.wipedCard(id)),
      freezeCard: noting((id) => c.freezeCard(id)),
      setCardHost: noting((id, host) => c.setCardHost(id, host)),
    };
    try {
      return { ...(await keepPhoneCard({ ...d, cardd }, cards)), changed };
    } finally {
      running = false;
    }
  };
}
