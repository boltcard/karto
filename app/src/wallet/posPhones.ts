// The PoS phones page and Add a PoS phone: each phone's lines, the
// name a new one is offered and what is wrong with a typed one, the note after a restore, the pairing link and its
// countdown, and the Add screen's steps. The screens hold only state and calls.
import { CarddError, noShopRoutes, type PosPhone, type ShopPhones } from '../cardd/client';
import { moneyError, shortDate, whenText } from '../money/format';
import type { ResultView } from '../money/steps';

/** cardd's limit on a PoS phone's name, in characters (store's phoneName). */
const NAME_MAX = 24;

/** line: under the name in the list; foot: the sheet's last line. */
export type PhoneRow = { keyId: string; name: string; line: string; foot: string };

/** Each PoS phone as the list and its sheet say it: when it was added, and its last sale or how many it has taken. */
export function phoneRows(phones: PosPhone[], nowS: number, offsetMin: number): PhoneRow[] {
  return phones.map((p) => ({
    keyId: p.keyId,
    name: p.name,
    line: `Added ${shortDate(p.created, nowS, offsetMin)} · ${p.lastSale ? `last sale ${whenText(p.lastSale, nowS, offsetMin)}` : 'no sales yet'}`,
    foot: `Added ${whenText(p.created, nowS, offsetMin)} · ${p.sales > 0 ? `${p.sales} ${p.sales === 1 ? 'sale' : 'sales'}` : 'no sales yet'}`,
  }));
}

/** The name a new PoS phone is offered: the first of "Till 1", "Till 2", … no PoS phone has. */
export function nextTillName(phones: Pick<PosPhone, 'name'>[]): string {
  for (let n = 1; ; n++) if (!phones.some((p) => p.name === `Till ${n}`)) return `Till ${n}`;
}

/**
 * Whether a typed name can be a PoS phone's, as cardd judges it (trimmed, 1 to 24 characters, no other PoS phone's),
 * and the line that says why not: none for an empty one. except: the phone being renamed, which may keep its name.
 */
export function nameProblem(typed: string, phones: Pick<PosPhone, 'keyId' | 'name'>[], except = ''): { ok: boolean; line: string } {
  const name = typed.trim();
  if (name === '') return { ok: false, line: '' };
  if ([...name].length > NAME_MAX) return { ok: false, line: `A name is up to ${NAME_MAX} characters.` };
  if (phones.some((p) => p.name === name && p.keyId !== except)) return { ok: false, line: 'Another PoS phone has this name.' };
  return { ok: true, line: '' };
}

/**
 * Whether the page says the server was restored: a listed phone is older than the restore, so it may be one the
 * person removed after that backup was made, and this phone hasn't said it checked that restore (checked: the
 * restore's time kept by I've checked, null for none).
 */
export const restoreNote = (list: ShopPhones, checked: number | null): boolean =>
  list.restored !== undefined && list.restored !== checked && list.phones.some((p) => p.created < list.restored!);

/** What Karto PoS scans to pair: the server's hostname and the one-use code. */
export const pairLink = (host: string, code: string): string => `kartopos://pair?host=${encodeURIComponent(host)}&code=${encodeURIComponent(code)}`;

/** Beside the dot under the code: "Waiting for Till 3 · good for 9:48, one phone". */
export function codeLine(name: string, expires: number, nowS: number): string {
  const left = Math.max(0, expires - nowS);
  return `Waiting for ${name} · good for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}, one phone`;
}

/**
 * Add a PoS phone, where it stands: at Name, at Code with the code showing, the code run out, or paired. asking: a
 * code has been asked of cardd and hasn't come; error: its last refusal. code and expires only at Code. ask: how
 * many codes this screen has asked for, so an answer is known for the newest ask or an earlier one.
 */
export type AddState = { at: 'name' | 'code' | 'ran-out' | 'paired'; name: string; error: string; asking: boolean; code: string; expires: number; ask: number };

export const ADD_START = (name: string, ask = 0): AddState => ({ at: 'name', name, error: '', asking: false, code: '', expires: 0, ask });

/**
 * After the code ran out the phones are read twice more, this long after: a phone that scanned in the code's last
 * second is paired a moment after the screen says it ran out.
 */
export const LATE_READS_MS = [2000, 6000] as const;

export type AddEvent =
  /** The name's field changed. */
  | { kind: 'typed'; name: string }
  /** Continue, or New code: a code is asked of cardd. */
  | { kind: 'asked' }
  /** cardd's answer to the ask numbered `ask` (the state's, when it was asked). */
  | { kind: 'code'; ask: number; code: string; expires: number }
  | { kind: 'refused'; ask: number; text: string }
  /** The list as just read: every 2 seconds at Code, and twice after the code ran out. */
  | { kind: 'phones'; phones: Pick<PosPhone, 'name'>[] }
  | { kind: 'tick'; nowS: number }
  /** ← or Android's Back; Done on the result. */
  | { kind: 'back' };

/**
 * What an event makes of the Add screen. state null: leave the screen. drop: ask cardd to drop the open code (not
 * waited for): Back at Code; Back while a code is on its way; and a code that lands when nothing waits for one,
 * which was never shown. A late code is left alone while a newer one is wanted or showing: cardd replaced it when
 * the newer was asked, and a drop would take the newer.
 */
export function addStep(s: AddState, e: AddEvent): { state: AddState | null; drop: boolean } {
  const to = (state: AddState | null, drop = false) => ({ state, drop });
  const waiting = s.at === 'name' || s.at === 'ran-out';
  const awaited = (ask: number) => waiting && s.asking && ask === s.ask;
  switch (e.kind) {
    case 'typed':
      return to(s.at === 'name' && !s.asking ? { ...s, name: e.name, error: '' } : s);
    case 'asked':
      return to(waiting && !s.asking ? { ...s, name: s.name.trim(), error: '', asking: true, ask: s.ask + 1 } : s);
    case 'code':
      if (awaited(e.ask)) return to({ ...s, at: 'code', asking: false, code: e.code, expires: e.expires });
      return to(s, !s.asking && s.at !== 'code');
    case 'refused':
      return to(awaited(e.ask) ? { ...s, asking: false, error: e.text } : s);
    case 'phones':
      // A code was shown for this name, which no phone had when it was made: one of that name is the phone that scanned it.
      return to((s.at === 'code' || s.at === 'ran-out') && e.phones.some((p) => p.name === s.name) ? { ...ADD_START(s.name, s.ask), at: 'paired' } : s);
    case 'tick':
      // cardd takes the code through the second it expires in.
      return to(s.at === 'code' && e.nowS > s.expires ? { ...ADD_START(s.name, s.ask), at: 'ran-out' } : s);
    case 'back':
      if (s.at === 'code') return to(ADD_START(s.name, s.ask), true);
      if (s.at === 'ran-out') return to(ADD_START(s.name, s.ask));
      return to(null, s.asking);
  }
}

/** The result page once the phone is listed. The wallet knows only that a phone of that name appeared: note says what to do if it wasn't the person's. */
export const pairedView = (name: string): ResultView & { note: string } => ({
  tone: 'ok',
  mark: 'check',
  title: `${name} is paired`,
  line: 'It can take payments into Shop now. Remove it at any time under PoS phones.',
  note: `If the other phone says the code didn't work, something else used it: remove ${name} under PoS phones.`,
});

/** What the PoS phones page says on an older server, without the point of sale, with a button to the Server page. */
export const UPDATE_FIRST = 'Update your server to use the point of sale.';

/** A refusal (or failure) of the shop's calls in a sentence: cardd's own of a name, a server not yet updated, else as the money screens say it. */
export function posError(e: unknown): string {
  if (noShopRoutes(e)) return UPDATE_FIRST;
  if (e instanceof CarddError) {
    if (e.code === 'name_taken') return 'Another PoS phone has this name.';
    if (e.code === 'bad_name') return `A name is 1 to ${NAME_MAX} characters.`;
    if (e.code === 'not_found') return 'That PoS phone is no longer in the list.';
  }
  return moneyError(e);
}

/**
 * Whether the shop's pages may show on this server. 'wait': the server isn't known yet (a link opened the page
 * before the watch read the saved state): not knowing is not a yes. stopped: its SSH key isn't the one LNVPS
 * published, so it may not be the person's (the wallet shows none of its money, and Settings no Point of sale row);
 * the notice's own words. The pages ask this themselves, with the watch awake under them, so a link is held to it
 * as the row is, and a mismatch found while a page is open closes it. view: serverView's.
 */
export function posGate(view: { keyNotice: { kind: string; text: string } } | null): 'wait' | 'open' | { stopped: string } {
  if (!view) return 'wait';
  return view.keyNotice.kind === 'mismatch' ? { stopped: view.keyNotice.text } : 'open';
}
