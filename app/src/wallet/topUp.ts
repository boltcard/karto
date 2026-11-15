// What an account's page does with money that arrives while it shows:
// the rows a held read of the history brings are put
// on top of the list, and an open Top up sheet says Received for a top-up newer than the history was when it opened.
import type { Tx } from '../cardd/client';
import type { Rated } from '../money/fiat';
import { payerNoteText, quotedPayerNote } from '../money/note';
import { feeViewText, shown, viewText, type View } from '../money/view';
import { whenText } from '../money/words';

/** The newest id of a history; 0 for one with nothing in it. */
export const newestId = (txs: Tx[]): number => txs.reduce((newest, t) => Math.max(newest, t.id), 0);

/**
 * The list shown with the rows of a held answer that are newer than its newest put on top. Everything shown stays
 * as it is, so the pages Load more brought keep their place and no row is lost between them and a new first page.
 * The list itself when the answer has nothing newer. page: how many rows a read asks for; a whole page of newer
 * rows (that many came in at once) starts the list over from it, since what lies between it and the rows shown was
 * never read: Load more is offered again.
 */
export function newerOnTop(shown: Tx[], answer: Tx[], page: number): Tx[] {
  const newest = newestId(shown);
  const newer = answer.filter((t) => t.id > newest);
  if (newer.length === 0) return shown;
  if (shown.length > 0 && newer.length >= page) return newer;
  return [...newer, ...shown];
}

/**
 * The top-up an open Top up sheet says Received for: the newest in the history (newest first) newer than baseline,
 * which is the newest id of the history as the server had answered it when the sheet opened. null: none, or no
 * baseline yet (the history had not answered: its first answer's newest is then the baseline, and nothing in that
 * answer counts). A move onto the account is not a top-up.
 */
export function received(txs: Tx[], baseline: number | null): Tx | null {
  if (baseline === null) return null;
  return txs.find((t) => t.kind === 'topup' && t.id > baseline) ?? null;
}

/**
 * The sheet's words for a top-up received: the amount the books credited, exactly, the account and the time, and
 * what is available, in the app's view (the sheet is on an
 * account's page), once the wallet's answer with it
 * has come (availableMsat null until then). One the books credited
 * nothing of went to phoenixd's fee credit, and the sheet says so in place of a figure. label: what a screen
 * reader is told. A top-up with a fee paid ACINQ for room in the channel: the first channel when the
 * server had none as the sheet opened (channelBefore false), more room otherwise or when that wasn't known; with
 * nothing credited, this payment and earlier fee credit paid for it together. A payer's note is a line in
 * curly quotes after where and when (after the sentence, with nothing credited), and read after the amount.
 */
export function receivedWords(
  tx: Tx,
  o: { name: string; nowS: number; offsetMin: number; availableMsat: number | null; channelBefore?: boolean | null; view?: View; rated?: Rated | null },
): { title: string; line: string; label: string } {
  const v = o.view ?? 'sat';
  const r = o.rated ?? null;
  const fee = tx.feeMsat ? feeViewText(tx.feeMsat, v, r).replace(/^fee /, '') : '';
  const what = o.channelBefore === false ? "to open your server's Lightning channel" : "for more room in your server's Lightning channel";
  const quoted = quotedPayerNote(tx);
  const said = quoted ? [quoted] : [];
  const heard = quoted ? [`Note from the payer, ${payerNoteText(tx)}.`] : [];
  if (tx.amountMsat === 0) {
    const sentence = fee
      ? `Nothing was added to ${o.name}: this payment and your earlier fee credit went to ACINQ ${what} (${fee} in all).`
      : `It went to phoenixd's fee credit, toward receiving room. Nothing was added to ${o.name}.`;
    return { title: 'Received', line: [sentence, ...said].join('\n'), label: [`Received. ${sentence}`, ...heard].join(' ') };
  }
  const title = `Received ${viewText(tx.amountMsat, v, r)}`;
  const available = o.availableMsat === null ? [] : [`${viewText(o.availableMsat, v, r)} available`];
  const paid = fee ? [`${fee[0].toUpperCase()}${fee.slice(1)} went to ACINQ ${what}.${o.channelBefore === false ? ' That is paid once.' : ''}`] : [];
  return {
    title,
    line: [`Into ${o.name} · ${whenText(tx.created, o.nowS, o.offsetMin)}`, ...said, ...available, ...paid].join('\n'),
    label: [`Received ${shown(tx.amountMsat, v, r).spoken}, into ${o.name}.`, ...heard, ...paid].join(' '),
  };
}
