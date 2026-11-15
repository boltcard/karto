// What a history line's own page shows, worked out
// without React from the line the account page had and, once they come, its details: so every kind and state is
// tested here, and app/src/app/payment.tsx only draws it.
import type { Tx, TxDetail } from '../cardd/client';
import { fiatText, isCode, minorText, type Rated } from './fiat';
import { kindOf, lineAmount, otherName } from './format';
import { quotedPayerNote } from './note';
import { refundButton, returnAddressText, type RefundOffer } from './refund';
import { feeViewText, viewText, type View } from './view';
import { fullTime, whenText } from './words';

export type PaymentState =
  | { at: 'loading' }
  | { at: 'loaded'; detail: TxDetail }
  /** A cardd from before schema 8: no line routes. */
  | { at: 'old-server' }
  | { at: 'unreachable' }
  /** cardd answered with an error other than a 404: reason is its words. */
  | { at: 'failed'; reason: string }
  /** cardd has no such line on this account (a restore from an older backup). */
  | { at: 'gone' };

/**
 * One PROOF row: full is what Copy puts on the clipboard; null when there's nothing to copy (short then says why).
 * spoken is what TalkBack reads of it: the characters shown, never a whole invoice.
 */
export type ProofRow = { label: string; short: string; spoken: string; full: string | null; copyName: string };

/**
 * amount: the figure in the app's view as text, with its plus ("+19,000 sat", "+£11.66", "***"); msat: its size and
 * sign ('+', or '' for money out and while hidden), for the Amount that draws it; now: in £ view it is today's value,
 * marked "now" as a history row's.
 */
export type PaymentView = {
  title: string;
  amount: string;
  msat: number;
  sign: '+' | '';
  now: boolean;
  incoming: boolean;
  status: string;
  paid: boolean;
  facts: [string, string][];
  factsNote: string | null;
  proof: ProofRow[];
  record: string | null;
  notice: string | null;
  retry: boolean;
  note: { shown: boolean; editable: boolean; value: string };
  /** A till sale's refund: the button and its line, Refunding…, Refunded, or the older server's line; null for any other kind. */
  refund: RefundOffer | null;
  /** A refunded sale's "Refund" fact opens the refund's own page. */
  refundLink: { account: string; txId: number } | null;
};

/** view and rated: the app's view and its rate (ui/amountView.tsx), sat with no rate when not given, as historyRows. */
export type PaymentAt = { nowS: number; offsetMin: number; account: string; cards: { id: string; name: string }[]; view?: View; rated?: Rated | null };

/** A long value as a PROOF row shows it: its first 8 and last 6 characters. */
export function shortValue(v: string): string {
  return v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v;
}

/** A long value as TalkBack reads a PROOF row: the characters shortValue shows, in words. */
export function spokenValue(v: string): string {
  return v.length > 16 ? `starts ${v.slice(0, 8)}, ends ${v.slice(-6)}` : v;
}

/** A PROOF row for a value, or, when there is none, for the words saying why. */
function proofRow(label: string, copyName: string, value: string | null, why = ''): ProofRow {
  return value ? { label, short: shortValue(value), spoken: spokenValue(value), full: value, copyName } : { label, short: why, spoken: why, full: null, copyName };
}

const NOTICES: Record<'old-server' | 'unreachable' | 'gone', string> = {
  'old-server': "Update server to see this payment's details.",
  unreachable: "Can't reach your server: the details show when it can.",
  gone: "This payment isn't in your server's books any more.",
};

export function paymentView(line: Tx | null, state: PaymentState, at: PaymentAt): PaymentView {
  const detail = state.at === 'loaded' ? state.detail : null;
  const t: TxDetail | null = detail ?? line;
  const notice =
    state.at === 'failed' ? `Your server couldn't give this payment's details. ${state.reason}` : state.at === 'old-server' || state.at === 'unreachable' || state.at === 'gone' ? NOTICES[state.at] : null;
  // Try again for a call that may answer next time: no answer, or an error cardd may not give again.
  const retry = state.at === 'unreachable' || state.at === 'failed';
  const note = {
    shown: state.at === 'loading' || state.at === 'loaded' || retry,
    editable: state.at === 'loaded',
    value: t?.comment ?? '',
  };
  if (!t) {
    return { title: 'Payment', amount: '', msat: 0, sign: '', now: false, incoming: false, status: '', paid: false, facts: [], factsNote: null, proof: [], record: null, notice, retry, note, refund: null, refundLink: null };
  }
  const here = otherName(at.account, at.cards);
  const { name } = kindOf(t, at.cards);
  const { msat, plus } = lineAmount(t);
  // The page's amounts in the app's view, as the history row's:
  // a £ view needs a rate; an amount of the past in £ is today's value, marked "now"; fees follow the view; *** hides.
  const r = at.rated ?? null;
  const v: View = at.view === 'fiat' && !r ? 'sat' : (at.view ?? 'sat');
  const past = (m: number) => (v === 'fiat' && r ? `${fiatText(m, r)} now` : viewText(m, v, r));
  const when = whenText(t.created, at.nowS, at.offsetMin);
  const whenFull: [string, string] = ['When', fullTime(t.created, at.offsetMin)];
  const fee = t.feeMsat ? feeViewText(t.feeMsat, v, r).replace(/^fee /, '') : 'none';
  const p = detail?.payment;
  // A refund's line is on the side its sign says: the receiving card's (an own-card refund) is
  // money in, not a payment made.
  const refundIn = t.kind === 'refund' && t.amountMsat > 0;
  const charge = t.kind === 'send' || t.kind === 'spend' || t.kind === 'renew' || (t.kind === 'refund' && !refundIn);
  // A refund names the sale it gave back, first: when it was paid and the till that took it.
  const saleRow: [string, string][] = t.kind === 'refund' && t.sale?.paidAt ? [['Sale', `${whenText(t.sale.paidAt, at.nowS, at.offsetMin)} · ${t.sale.device}`]] : [];
  // An own-card refund is booked inside the server: no payment, so no invoice to say what it was For.
  const bookedInside = t.kind === 'refund' && !!detail && !detail.payment;
  let refund: RefundOffer | null = null;
  let refundLink: { account: string; txId: number } | null = null;

  let status = when;
  let facts: [string, string][] = [whenFull];
  let factsNote: string | null = null;
  if (charge) {
    status = `Paid · ${when} · from ${here}`;
    facts = [
      ...saleRow,
      // An offer with no description has no For row, as Send's Check has none.
      ...(detail && !bookedInside && (p?.description || !p?.offer) ? [['For', p?.description || 'No description'] as [string, string]] : []),
      ...(t.kind === 'spend' ? [['Card', here] as [string, string]] : []),
      ...(p?.destination ? [['To', p.destination] as [string, string]] : t.kind === 'refund' && t.other ? [['To', otherName(t.other, at.cards)] as [string, string]] : []),
      ['Fee', fee],
      whenFull,
    ];
  } else if (refundIn) {
    status = `Received · ${when} · into ${here}`;
    facts = [...saleRow, ...(t.other ? [['From', otherName(t.other, at.cards)] as [string, string]] : []), whenFull];
  } else if (t.kind === 'topup') {
    status = `Received · ${when} · into ${here}`;
    if (t.feeMsat) {
      const added = t.amountMsat === 0 ? 'nothing' : past(t.amountMsat);
      // receivedWords' wording for when the channel's state isn't known (wallet/topUp.ts): a page can't tell a first channel from more room.
      facts = [[`Added to ${here}`, added], ['To ACINQ for the channel', fee], whenFull];
      factsNote = `${fee} went to ACINQ for more room in your server's Lightning channel.`;
    } else if (t.amountMsat === 0) {
      facts = [[`Added to ${here}`, 'nothing: to fee credit'], whenFull];
    }
    // Through one of this server's refund links: a shop gave a sale back. A card wiped since has it in Pool.
    if (t.via === 'refund') {
      const onCard = !['pool', 'hosting', 'shop'].includes(at.account);
      const said = `A refund from a shop, paid to ${onCard ? "this card's" : "a card's"} return address.`;
      factsNote = factsNote ? `${said} ${factsNote}` : said;
    }
    // The payer's note, first: what the payer said the money is for. Plain text, never a link.
    const said = quotedPayerNote(t);
    if (said) facts = [["Payer's note", said], ...facts];
  } else if (t.kind === 'sale') {
    status = `Received · ${when} · into ${here}`;
    const s = t.sale;
    // A sale rung up in a currency this app knows is "Priced £2.50", as it was set and never converted; one
    // typed in sat has its price in the view.
    const priced = s?.price && isCode(s.price.currency) ? s.price : null;
    const price: [string, string] | null = !s ? null : priced ? ['Priced', v === 'hidden' ? '***' : minorText(priced.minor, priced.currency)] : ['Price', past(s.priceMsat)];
    facts = s && price
      ? [price, ['Paid by', s.method === 'card' ? 'Card' : 'QR'], ['Till', s.device], ...(s.priceMsat > t.amountMsat ? [['To channel fees', past(s.priceMsat - t.amountMsat)] as [string, string]] : []), whenFull]
      : [whenFull];
    // Its refund: where it would go, the button, or the refund once paid with a link to its page.
    if (s) {
      if (s.returnAddress) facts.splice(facts.length - 1, 0, ['Return address', returnAddressText(s.returnAddress)]);
      refund = refundButton(s);
      if (s.refund?.state === 'paid' && s.refund.txId) {
        status += ` · Refunded · ${whenText(s.refund.at ?? t.created, at.nowS, at.offsetMin)}`;
        facts.splice(facts.length - 1, 0, ['Refund', viewText(s.refund.amountMsat ?? 0, v, r)]);
        refundLink = { account: s.refund.from ?? 'shop', txId: s.refund.txId };
      }
    }
  } else if (t.kind === 'move') {
    status = `Moved · ${when}`;
    if (t.other) {
      const other = otherName(t.other, at.cards);
      facts = [['From', t.amountMsat > 0 ? other : here], ['To', t.amountMsat > 0 ? here : other], whenFull];
    }
    factsNote = 'A move between your own accounts: no Lightning payment, no fee.';
  }

  const proof: ProofRow[] = [];
  if (p) {
    if (charge) {
      const why = p.preimage === '' ? 'Not recorded: paid before your server kept it' : 'Not read yet: open this page again in a minute';
      proof.push(proofRow('Proof of payment (preimage)', 'the proof of payment', p.preimage ?? null, why));
    }
    if (p.hash) proof.push(proofRow('Payment hash', 'the payment hash', p.hash));
    if (p.invoice) proof.push(proofRow('Invoice', 'the invoice', p.invoice));
    if (p.offer) proof.push(proofRow('Offer', 'the offer', p.offer));
  }

  return {
    title: name,
    amount: `${plus && v !== 'hidden' ? '+' : ''}${viewText(Math.abs(msat), v, r)}`,
    msat: Math.abs(msat),
    sign: plus && v !== 'hidden' ? '+' : '',
    now: v === 'fiat',
    incoming: plus,
    status,
    paid: charge,
    facts,
    factsNote,
    proof,
    record: t.note ? `Server's record: ${t.note}` : null,
    notice,
    retry,
    note,
    refund,
    refundLink,
  };
}
