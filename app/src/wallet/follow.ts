// The two asks by which an account's page follows money as it arrives:
// its wallet and its history, each a read the server holds until
// there is something new, run by a held loop (cards/poll.ts). The page draws what they show.
import { revBehind, type Tx, type Wallet } from '../cardd/client';
import { HELD_WAIT_S, type Asked } from '../cards/poll';
import { newerOnTop, newestId } from './topUp';

/**
 * The page's ask for its wallet. With a rev shown, a read the server holds until the books change; with none (a
 * server from before held reads, or no wallet yet), a plain read, as the page's 5-second refresh was. An answer is
 * shown unless it is behind the wallet shown (the page's own load brought a newer one meanwhile). report: the
 * watch is told whether the server answers, as the refresh told it; a failure only while live() (the page in front
 * and the app active: a read cut off by leaving says nothing of the server), and never a held read's: it is open
 * nearly all the time, so every brief drop of the phone's connection lands on one. After a held read that failed
 * the next ask is a plain read, and that one says.
 */
export function walletAsk(o: {
  cardd: { wallet(held?: { since: string; wait: number }): Promise<Wallet> };
  shown: () => Wallet | null;
  show: (wallet: Wallet) => void;
  report: (r: { ok: true } | { ok: false; error: unknown }) => void;
  live: () => boolean;
}): () => Promise<Asked> {
  let dropped = false;
  return async () => {
    const rev = o.shown()?.rev;
    const held = rev && !dropped ? { since: rev, wait: HELD_WAIT_S } : undefined;
    let wallet: Wallet;
    try {
      wallet = await o.cardd.wallet(held);
    } catch (error) {
      if (held) dropped = true;
      else if (o.live()) o.report({ ok: false, error });
      throw error;
    }
    dropped = false;
    o.report({ ok: true });
    if (!revBehind(wallet.rev, o.shown()?.rev)) o.show(wallet);
    const now = o.shown()?.rev;
    if (!held) return now ? 'moved' : 'plain';
    return now !== rev ? 'moved' : 'held';
  };
}

/**
 * The page's ask for its history: a read the server holds until the account has a transaction newer than the
 * newest shown. The newer rows go on top of the list (topUp.ts newerOnTop); show is told whether the list is now
 * a whole page read afresh (Load more is offered) and whether a sale came (Shop's page reads its days' counts
 * again). While the page's own read of the first page has not come (loaded false: it is slow, or it failed), the
 * ask reads that page itself, plainly, so a page that opened on a failed read has its history at the next turn
 * and its Top up sheet a baseline.
 */
export function historyAsk(o: {
  cardd: { history(account: string, page: { limit: number; after?: number; wait?: number }): Promise<Tx[]> };
  id: string;
  page: number;
  shown: () => { txs: Tx[]; loaded: boolean };
  show: (txs: Tx[], o: { startedOver: boolean; sale: boolean }) => void;
}): () => Promise<Asked> {
  return async () => {
    if (!o.shown().loaded) {
      const first = await o.cardd.history(o.id, { limit: o.page });
      // Unless the page's own read came meanwhile: that one is shown, and the next turn asks past it.
      if (!o.shown().loaded) o.show(first, { startedOver: first.length >= o.page, sale: first.some((t) => t.kind === 'sale') });
      return 'moved';
    }
    const newest = newestId(o.shown().txs);
    const answer = await o.cardd.history(o.id, { limit: o.page, after: newest, wait: HELD_WAIT_S });
    const { txs } = o.shown();
    const next = newerOnTop(txs, answer, o.page);
    if (next === txs) return 'held';
    const newer = next.filter((t) => t.id > newestId(txs));
    o.show(next, { startedOver: next.length === newer.length && newer.length >= o.page, sale: newer.some((t) => t.kind === 'sale') });
    return 'moved';
  };
}
