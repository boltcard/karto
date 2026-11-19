// Send out and Move in three steps, To, Amount and Check:
// which step comes next and which Back returns to, what each step reads back, and how a request's
// outcome ends: on the result page, or back at Check with cardd's reason. The screens hold the state and draw.
import type { ResultView } from '../ui/result';
import type { Lookup, SendAnswer, Wallet } from '../cardd/client';
import { bolt11ExpiresAtMs } from '../lightning/lightning';
import type { Destination } from './destination';
import type { Rated } from './fiat';
import { availableMsat, moneyError, thousands } from './format';
import type { RequestOutcome } from './requests';
import { feeEstimateSat, type SendOutcome } from './send';
import { aboutText, feeViewText, viewText, type View } from './view';

export type Step = 'to' | 'amount' | 'check';
export const STEPS: readonly { key: Step; label: string }[] = [
  { key: 'to', label: 'To' },
  { key: 'amount', label: 'Amount' },
  { key: 'check', label: 'Check' },
];

/** The bar's names, and where a step stands in it (ui/money.tsx StepBar). */
export const STEP_NAMES: readonly string[] = STEPS.map((s) => s.label);
export const stepAt = (step: Step): number => STEPS.findIndex((s) => s.key === step);

/** What TalkBack reads for a step bar of any names: "Step 2 of 3, Amount". at: the current step, from 0. */
export const barLabel = (names: readonly string[], at: number): string => `Step ${at + 1} of ${names.length}, ${names[at]}`;

/** What TalkBack reads for Send's and Move's step bar. */
export const stepLabel = (step: Step): string => barLabel(STEP_NAMES, stepAt(step));

/** An offer as cardd's lookup read it. name: the BIP353 name it came from (₿user@domain). */
export type OfferPayable = { kind: 'offer'; to: string; name: string | null; amountMsat: number | null; description: string; issuer: string };
/** An LNURL address or link; with the lookup's answer, what it takes and what it says it is for. */
export type LinkPayable = { kind: 'address' | 'payurl'; to: string; minMsat?: number; maxMsat?: number; description?: string };
/** A destination Send out can pay. */
export type Payable = Extract<Destination, { kind: 'invoice' }> | LinkPayable | OfferPayable;

/** The amount a destination fixes (an invoice's, an offer's), or null when the person chooses it. */
export const fixedAmount = (p: Payable): number | null => (p.kind === 'invoice' || p.kind === 'offer' ? p.amountMsat || null : null);

/** Whether To's destination is looked up by cardd before Amount: names, links and offers. The server's schema 10 is the screen's gate (`canLookUp`), not this function's. */
export const needsLookup = (dest: Destination): boolean =>
  dest.kind === 'address' || dest.kind === 'payurl' || dest.kind === 'offer';

/** What an older server can't pay: offers and ₿ names (it has no lookup). */
export const oldServerProblem = (dest: Destination | null, canLookUp: boolean): string | null =>
  !canLookUp && (dest?.kind === 'offer' || (dest?.kind === 'address' && dest.bip353Only)) ? 'Update your server to pay offers and ₿ addresses.' : null;

/** What the lookup is asked: a ₿ name keeps its ₿, so cardd tries BIP353 alone. */
export const lookupText = (dest: Destination): string => (dest.kind === 'address' && dest.bip353Only ? `₿${dest.to}` : 'to' in dest ? dest.to : '');

/** The lookup's answer as something to pay. */
export function payableFrom(l: Lookup): Payable {
  if (l.kind === 'offer') return { kind: 'offer', to: l.offer, name: l.name ?? null, amountMsat: l.amountMsat, description: l.description, issuer: l.issuer };
  const kind = l.to.includes('@') && !l.to.includes('://') ? 'address' : 'payurl';
  return { kind, to: l.to, minMsat: l.minMsat, maxMsat: l.maxMsat, description: l.description };
}

/** An LNURL amount outside what the address or link takes, as the lookup said; null within, and for anything else. */
export function linkAmountProblem(p: Payable, amountMsat: number): string | null {
  if ((p.kind !== 'address' && p.kind !== 'payurl') || p.minMsat === undefined || p.maxMsat === undefined) return null;
  if (amountMsat >= p.minMsat && amountMsat <= p.maxMsat) return null;
  return `Between ${thousands(Math.ceil(p.minMsat / 1000))} and ${thousands(Math.floor(p.maxMsat / 1000))} sat for this ${p.kind === 'address' ? 'address' : 'link'}.`;
}

/** An offer as Check and the result name it: its BIP353 name, else who issued it, else "An offer". */
const offerName = (p: OfferPayable, start: boolean): string =>
  p.name ?? `${start ? 'An' : 'an'} offer${p.issuer ? ` from ${p.issuer}` : ''}`;

const expired = (dest: Destination, nowMs: number) => {
  if (dest.kind !== 'invoice') return false;
  const at = bolt11ExpiresAtMs(dest.to);
  return at !== null && nowMs >= at;
};

/** Where Next goes from To: Amount, or Check for an invoice that carries its amount; null when there is nothing to pay. */
export function sendNext(dest: Destination | null, nowMs: number): 'amount' | 'check' | null {
  if (!dest || dest.kind === 'unsupported' || dest.kind === 'own' || expired(dest, nowMs)) return null;
  return dest.kind === 'invoice' && dest.amountMsat ? 'check' : 'amount';
}

/** Why To's destination can't be paid, in red; null for one that can, for an own address (its panel says it) and for nothing typed. */
export function sendToProblem(dest: Destination | null, nowMs: number): string | null {
  if (dest?.kind === 'unsupported') return `That is ${dest.what}: Send out can't pay it.`;
  return dest && expired(dest, nowMs) ? 'This invoice has expired.' : null;
}

/** The account one of this server's own addresses names, for Move to it instead: null for pool itself, or when Move wouldn't list it. */
export function ownTarget(dest: Extract<Destination, { kind: 'own' }>, wallet: Wallet | null): string | null {
  if (!wallet || dest.account === 'pool') return null;
  if (dest.account === 'hosting') return 'hosting';
  return moveTargets(wallet, 'pool').find((a) => a.card && a.id.startsWith(dest.account.slice(1)))?.id ?? null;
}

/**
 * Who a Check note's line says can't see it: an address's name part ("sam" of sam@example.com), an offer's
 * from the ₿ name it came from ("alice" of ₿alice@phoenixwallet.me), else "the payee".
 */
export function noteWho(dest: Payable): string {
  if (dest.kind === 'address') return dest.to.split('@')[0];
  if (dest.kind === 'offer' && dest.name) return dest.name.replace(/^₿/, '').split('@')[0];
  return 'the payee';
}

/**
 * The step Send shows: the one last reached, while its destination is still the text in the field and can still be
 * paid; else To. So a destination that stops being payable (an invoice expiring while Check shows) and any new one
 * (pasted, typed or scanned) start at To: a new destination never lands on the step the last one had reached.
 */
export const sendAt = (reached: { step: Step; raw: string }, raw: string, payable: Payable | null): Step =>
  payable && reached.raw === raw ? reached.step : 'to';

/** Where Back goes: a step back, or null to leave the screen. A destination that fixes its amount has no Amount step. */
export const sendBack = (step: Step, fixed: boolean): Step | null =>
  step === 'check' ? (fixed ? 'to' : 'amount') : step === 'amount' ? 'to' : null;

export const moveBack = (step: Step): Step | null => (step === 'check' ? 'amount' : step === 'amount' ? 'to' : null);

/** An account a move is from or to. availableMsat: its balance less what is held. */
export type MoveAccount = { id: string; name: string; availableMsat: number; card: boolean; frozen: boolean };
/** A Check line's value: words, or an amount the screen draws large with the other figure under it. */
export type ReadRow = [string, string | { msat: number }];

function account(wallet: Wallet, id: string): MoveAccount | null {
  if (id === 'pool') return { id, name: 'Pool', availableMsat: availableMsat(wallet.pool), card: false, frozen: false };
  if (id === 'hosting') return { id, name: 'Hosting', availableMsat: availableMsat(wallet.hosting), card: false, frozen: false };
  if (id === 'shop') return wallet.shop ? { id, name: 'Shop', availableMsat: availableMsat(wallet.shop), card: false, frozen: false } : null;
  const c = wallet.cards.find((x) => x.id === id);
  return c ? { id, name: c.name || 'Unnamed card', availableMsat: availableMsat(c), card: true, frozen: c.state === 'frozen' } : null;
}

/** Where a move from `from` can go: Pool, Hosting and the active and frozen cards, but `from` itself. Never Shop: its sales alone pay it. */
export function moveTargets(wallet: Wallet, from: string): MoveAccount[] {
  const ids = ['pool', 'hosting', ...wallet.cards.filter((c) => c.state === 'active' || c.state === 'frozen').map((c) => c.id)];
  return ids.filter((id) => id !== from).map((id) => account(wallet, id)!);
}

/**
 * How Move opens from its link's parameters: from pool when none is named; at Amount when `to` names a target (Send's
 * Move to it instead), else at To with any other `to` dropped. Null when `from` isn't pool, hosting, the server's
 * shop or a card the wallet lists: there is no such account.
 */
export function moveStart(params: { from?: string; to?: string }, wallet: Wallet): { from: MoveAccount; to: MoveAccount | null; step: 'to' | 'amount' } | null {
  const from = account(wallet, params.from ?? 'pool');
  if (!from) return null;
  const to = moveTargets(wallet, from.id).find((a) => a.id === params.to) ?? null;
  return { from, to, step: to ? 'amount' : 'to' };
}

const within = (a: MoveAccount) => `${a.card ? 'on' : 'in'} ${a.name}`;

/**
 * The screen lock a move asks for: money moved onto a card is money that card can then spend at any till, so it is
 * confirmed as Send out's is, its prompt Check's button. Money moved off a card, to Pool or Hosting, asks for none,
 * and so does money moved onto this phone's own card (ownPhoneCard: its id, the watch's phoneCard.own), which pays
 * only behind the lock each time it is armed. Another phone's card asks, as a plastic one does.
 */
export const moveLock = (to: MoveAccount, title: string, ownPhoneCard: string | null = null): { prompt: string; needs: string } | null =>
  to.card && to.id !== ownPhoneCard ? { prompt: title, needs: 'moving money onto a card' } : null;

/** "13,292 sat available on Daily card.", "£29.76 available in Pool.": in the view Move shows (confirmView's). */
export const moveAvailable = (a: MoveAccount, v: View = 'sat', r: Rated | null = null): string => `${viewText(a.availableMsat, v, r)} available ${within(a)}.`;

/** The Amount step's panel: where the money goes. An invoice with no description has an empty value: its label stands alone. */
export const destinationPanel = (dest: Payable): { label: string; value: string } =>
  dest.kind === 'invoice' ? { label: 'Invoice', value: dest.description } : { label: 'To', value: dest.kind === 'offer' ? offerName(dest, true) : dest.to };

/**
 * Send's Check: label and value lines, the amount as an amount (ui/money.tsx ReadBack draws it), the fee to expect
 * and what is left in the view. An offer is named by its ₿ name, else its issuer; For says what an offer or an LNURL
 * address says it is for, when it says. poolAvailableMsat: null before the wallet answered. What is left is left out
 * then, and when pool can't pay it (the problem line says so).
 */
export function sendReadBack(dest: Payable, amountMsat: number, poolAvailableMsat: number | null, v: View = 'sat', r: Rated | null = null): ReadRow[] {
  const feeSat = feeEstimateSat(amountMsat);
  const left = poolAvailableMsat === null ? null : poolAvailableMsat - amountMsat - feeSat * 1000;
  const where: ReadRow[] =
    dest.kind === 'invoice' ? [['Invoice', dest.description || 'No description']]
    : dest.kind === 'offer' ? [['To', offerName(dest, true)], ...(dest.description ? [['For', dest.description] as ReadRow] : [])]
    : [['To', dest.to], ...(dest.description ? [['For', dest.description] as ReadRow] : [])];
  return [
    ...where,
    ['Amount', { msat: amountMsat }],
    ['Fee', aboutText(feeSat * 1000, v, r)],
    ...(left === null || left < 0 ? [] : [['Left in Pool', aboutText(left, v, r)] as ReadRow]),
  ];
}

/** Move's Check: the amount as an amount (All moves the exact msat), what is left in the view. */
export function moveReadBack(from: MoveAccount, to: MoveAccount, amountMsat: number, v: View = 'sat', r: Rated | null = null): ReadRow[] {
  return [
    ['From', from.name],
    ['To', to.name],
    ['Amount', { msat: amountMsat }],
    ['Fee', 'none'],
    [`Left ${within(from)}`, viewText(from.availableMsat - amountMsat, v, r)],
  ];
}

/** How a send or a move ended, for the result page. */
export type Result =
  | { kind: 'sent'; amountMsat: number; feeMsat: number; dest: Payable }
  | { kind: 'moved'; amountMsat: number; from: string; to: string }
  | { kind: 'failed'; what: 'send' | 'move'; text: string }
  | { kind: 'unknown'; text: string };

/** runRequest's outcome, or what it threw. */
export type Ran = RequestOutcome | { at: 'failed'; e: unknown };

/**
 * Where a request's outcome leads: the result page; back to Check with the reason in red, for a refusal from cardd
 * (the amount or the destination can then be changed: an address's limits are only known to cardd, at send time);
 * or, for a send still on its way, watching it.
 */
export type After = { at: 'result'; result: Result } | { at: 'check'; error: string } | { at: 'watch'; answer: SendAnswer };

// A failed send writes no history line: it shows only as the held amount coming back. Not sent says phoenixd's
// reason instead, when cardd gave one.
const SEND_FAILED = 'The payment failed: nothing left Pool.';
const SEND_UNKNOWN = "In Pool, a “Sent out” line in its history means it went; the held amount coming back with no line means it didn't.";
const MOVE_UNKNOWN = "The accounts' history will show whether it moved.";

export function afterSend(out: Ran, dest: Payable): After {
  if (out.at === 'failed') return { at: 'result', result: { kind: 'failed', what: 'send', text: moneyError(out.e) } };
  if (out.at === 'refused') return { at: 'check', error: moneyError(out.error) };
  if (out.at !== 'answered') return { at: 'result', result: { kind: 'unknown', text: SEND_UNKNOWN } };
  const answer = out.answer as SendAnswer;
  if (answer.status === 'pending') return { at: 'watch', answer };
  return {
    at: 'result',
    result: answer.status === 'sent' ? { kind: 'sent', amountMsat: answer.amountMsat, feeMsat: answer.feeMsat ?? 0, dest } : { kind: 'failed', what: 'send', text: answer.reason ?? SEND_FAILED },
  };
}

/** How a send that was still on its way ended (money/send.ts watchSend, or followSend by its request id). */
export function afterWatch(w: SendOutcome, answer: SendAnswer, dest: Payable): Result {
  if (w.kind === 'sent') return { kind: 'sent', amountMsat: answer.amountMsat, feeMsat: w.feeMsat, dest };
  return w.kind === 'failed' ? { kind: 'failed', what: 'send', text: w.reason ?? SEND_FAILED } : { kind: 'unknown', text: SEND_UNKNOWN };
}

export function afterMove(out: Ran, from: MoveAccount, to: MoveAccount, amountMsat: number): After {
  if (out.at === 'failed') return { at: 'result', result: { kind: 'failed', what: 'move', text: moneyError(out.e) } };
  if (out.at === 'refused') return { at: 'check', error: moneyError(out.error) };
  if (out.at !== 'answered') return { at: 'result', result: { kind: 'unknown', text: MOVE_UNKNOWN } };
  return { at: 'result', result: { kind: 'moved', amountMsat, from: from.name, to: to.name } };
}

export type { ResultView };

const capitalised = (text: string) => text[0].toUpperCase() + text.slice(1);

export function resultView(r: Result, v: View = 'sat', rate: Rated | null = null): ResultView {
  switch (r.kind) {
    case 'sent': {
      const paid = r.dest.kind === 'invoice' ? r.dest.description : r.dest.kind === 'offer' ? `to ${offerName(r.dest, false)}` : `to ${r.dest.to}`;
      return { tone: 'ok', mark: 'check', title: `Sent ${viewText(r.amountMsat, v, rate)}`, line: [capitalised(feeViewText(r.feeMsat, v, rate)), ...(paid ? [paid] : [])].join(' · ') };
    }
    case 'moved':
      return { tone: 'ok', mark: 'check', title: `Moved ${viewText(r.amountMsat, v, rate)}`, line: `From ${r.from} to ${r.to} · no fee` };
    case 'failed':
      return { tone: 'error', mark: 'cross', title: r.what === 'send' ? 'Not sent' : 'Not moved', line: r.text };
    case 'unknown':
      return { tone: 'warn', mark: 'dots', title: 'Not known yet', line: r.text };
  }
}
