// The hold-the-card screen's decisions, apart from React so
// they are tested: the name screen before it, its five jobs, what it reads from its link, each job's steps in plain words, which moment the
// screen is at and what that shows, how each job ends, where leaving goes, and a wipe's page before the lock.
// The screen (app/card.tsx) holds the state and draws.
import type { CardState } from '../cardd/client';
import { validCardId } from '../cardphoto/screen';
import type { Rated } from '../money/fiat';
import type { ResultView } from '../money/steps';
import { viewText, type View } from '../money/view';
import type { NfcSession, SessionEnd, SheetCall } from '../native/nfc';
import { ADD_STEPS, type AddStep } from './add';
import { ADOPT_STEPS, type AdoptStep } from './adopt';
import type { SheetAction } from './labels';
import { REPOINT_STEPS, type RepointStep } from './repoint';
import { WIPE_STEPS, type WipeStep } from './wipe';

export type Op = 'add' | 'finish-add' | 'wipe' | 'repoint' | 'adopt';
export const OPS: readonly Op[] = ['add', 'finish-add', 'wipe', 'repoint', 'adopt'];

/** Add card's three steps, across the top of the name screen, the hold screen and the photo screen (ui/money.tsx StepBar). */
export const ADD_BAR: readonly string[] = ['Name', 'Hold', 'Photo'];

/** The name field's hint. */
export const NAME_HINT = '“Daily” or “Kids”';

/**
 * The name screen (app/card-add.tsx). adopt: a card the server doesn't know is being added back, which asks only
 * its name, "Card" with none. hide: the row's switch. row: the switch's name and line, in place of the Advanced
 * button and its Random UID switch. next: what the hold screen is opened with.
 */
export function nameView(adopt: boolean, name: string, hide: boolean) {
  const trimmed = name.trim();
  return {
    band: adopt ? 'Add the card back' : 'Add a card',
    outline: { name: trimmed, placeholder: adopt ? 'Card' : undefined },
    intro: adopt ? "Your server doesn't know this card yet. Give it a name you'll recognise." : null,
    note: adopt ? 'Its balance starts at zero.' : null,
    row: adopt
      ? null
      : {
          name: "Hide the card's ID from readers",
          line: "Readers see a random ID each time (“random UID”), so a shop can't follow the card by it. Once on, it can't be turned off on that card.",
        },
    canContinue: adopt || trimmed !== '',
    next: adopt ? { op: 'adopt', name: trimmed || 'Card' } : { op: 'add', name: trimmed, randomUid: hide ? '1' : '0' },
  };
}

/** The band's title. */
export const HOLD_TITLES: Record<Op, string> = {
  add: 'Add a card', 'finish-add': 'Finish adding the card', wipe: 'Wipe the card', repoint: 'Re-point the card', adopt: 'Add the card back',
};

/**
 * The two names the screen has. shown: on the screen, the name just typed or, for a screen opened for a card, that
 * card's name in the card list. sent: what the server is given with the card held, which is only ever a name the
 * person typed: the server renames a part-way card it is sent a name for, and the card held to a Finish setup
 * opened for one card may be another.
 */
export const holdNames = (p: HoldParams | null, listName: string | undefined): { shown: string; sent: string } =>
  p ? { shown: p.name || listName || '', sent: p.name } : { shown: '', sent: '' };

/** One step of a job: the line shown while it runs and in the Done fold's rows, and its short word in the Done line. */
export type HoldStep = { key: string; line: string; short: string };
type Words = readonly [line: string, short: string];

const ADD: Record<AddStep, Words> = {
  check: ['Checking the card is blank', 'blank card'],
  'random-uid': ['Hiding its ID from readers', 'ID hidden'],
  reserve: ['Reserving it on your server', 'reserved'],
  url: ["Writing your server's address", 'address written'],
  keys: ['Setting its keys', 'keys set'],
  key0: ['Locking it with your key', 'locked'],
  confirm: ['Checking it with your server', 'checked'],
};
/** Finish setup's first step: the card isn't blank, and the hold reads where its add stopped. */
const FINISH_CHECK: Words = ['Checking where the add stopped', 'card checked'];

const WIPE: Record<WipeStep, Words> = {
  check: ['Checking which card this is', 'card checked'],
  server: ['Telling your server', 'server told'],
  keys: ['Clearing its keys', 'keys cleared'],
  key0: ['Unlocking it', 'unlocked'],
  settings: ['Resetting its settings', 'settings reset'],
  url: ["Clearing your server's address", 'address cleared'],
  done: ["Telling your server it's blank", 'finished'],
};

const REPOINT: Record<RepointStep, Words> = {
  check: ['Checking which card this is', 'card checked'],
  url: ["Writing this server's address", 'address written'],
  settings: ['Matching its settings to the address', 'settings matched'],
  confirm: ['Checking it with your server', 'checked'],
};

const ADOPT: Record<AdoptStep, Words> = { ...REPOINT, adopt: ['Adding it back to your server', 'added back'] };

const steps = <K extends string>(order: readonly K[], words: Record<K, Words>): HoldStep[] => order.map((key) => ({ key, line: words[key][0], short: words[key][1] }));

/**
 * A job's steps, in the order its hold reports them. randomUid: an add is hiding the card's ID. One that isn't
 * shows six steps: the hold still reports random-uid, which is then no step of the list. Finish setup never
 * hides (holdParams), so it has six whatever it is told.
 */
export function holdSteps(op: Op, randomUid: boolean): HoldStep[] {
  switch (op) {
    case 'add':
      return steps(randomUid ? ADD_STEPS : ADD_STEPS.filter((k) => k !== 'random-uid'), ADD);
    case 'finish-add':
      return steps(ADD_STEPS.filter((k) => k !== 'random-uid'), { ...ADD, check: FINISH_CHECK });
    case 'wipe':
      return steps(WIPE_STEPS, WIPE);
    case 'repoint':
      return steps(REPOINT_STEPS, REPOINT);
    case 'adopt':
      return steps(ADOPT_STEPS, ADOPT);
  }
}

/** id: the card the screen was opened for. name: the name just typed (an add, an add back); otherwise the screen reads the card's name from the card list by its id, never from the link. */
export type HoldParams = { op: Op; id?: string; name: string; randomUid: boolean };

/**
 * What the screen reads from its link, once, when it opens. Null: a wipe with no card to wipe, which only a
 * karto:// link can ask for; the screen goes to the wallet. randomUid is the name screen's switch, for an add
 * alone: a finished add never turns the hiding on, as the first hold applied the person's choice before the
 * server knew the card.
 */
export function holdParams(p: { op?: string; id?: string; name?: string; randomUid?: string }): HoldParams | null {
  const op = OPS.find((x) => x === p.op) ?? 'add';
  const typed = op === 'add' || op === 'adopt';
  const id = !typed && validCardId(p.id) ? p.id : undefined;
  if (op === 'wipe' && !id) return null;
  return { op, ...(id && { id }), name: typed ? (p.name ?? '') : '', randomUid: op === 'add' && p.randomUid !== '0' };
}

/** What the screen holds. name: the card's, '' when none is known. done: the steps the hold in progress, or the last one, reported. message: why the last hold ended without finishing, or the lock's refusal. sessions: cards are read in a session (an iPhone), which changes the waiting words. */
export type HoldState = {
  name: string; steps: HoldStep[]; unlocked: boolean; running: boolean; done: readonly string[];
  message: { text: string; again: boolean } | null; finished: boolean; sessions?: boolean;
};

/** Where a job stands: n of `of`, the parts before n done; stopped: part n is where it stopped, in amber. label: what TalkBack reads. */
export type HoldProgress = { text: string; n: number; of: number; stopped: boolean; label: string };
/** The Done fold: its line, and the finished steps' lines it unfolds into. */
export type HoldFold = { summary: string; rows: string[] };

/** The screen's moment and what it shows. picture: the card coming to the phone, on it, or away from it. */
export type HoldView =
  | { moment: 'lock' }
  | { moment: 'waiting'; picture: 'coming'; lead: string; note: string }
  | { moment: 'writing'; picture: 'on'; lead: string; progress: HoldProgress; line: string; fold: HoldFold | null }
  | { moment: 'stopped'; picture: 'away'; reason: string; progress: HoldProgress | null; fold: HoldFold | null }
  | { moment: 'refused'; picture: 'on'; reason: string; fold: HoldFold | null }
  | { moment: 'finished' };

/**
 * Which moment the screen is at. A hold that ended with `again` (the card moved away, the server out of reach, a
 * tag that isn't a card) is stopped, and holding the card again carries on; any other error is a refusal. The
 * progress of a stopped hold, and the fold, show only once a step was reported: before that nothing was done.
 */
export function holdView(s: HoldState): HoldView {
  if (s.finished) return { moment: 'finished' };
  if (!s.unlocked) return { moment: 'lock' };
  const finished = s.steps.filter((x) => s.done.includes(x.key));
  const n = Math.min(finished.length + 1, s.steps.length);
  const of = s.steps.length;
  const fold = finished.length > 0 ? { summary: `Done: ${finished.map((x) => x.short).join(', ')}`, rows: finished.map((x) => x.line) } : null;
  if (s.running) {
    const line = s.steps[n - 1].line;
    const text = `Step ${n} of ${of}`;
    return { moment: 'writing', picture: 'on', lead: 'Keep holding the card…', progress: { text, n, of, stopped: false, label: `${text}, ${line}` }, line, fold };
  }
  if (s.message?.again) {
    const text = `Stopped at step ${n} of ${of}`;
    return { moment: 'stopped', picture: 'away', reason: s.message.text, progress: fold ? { text, n, of, stopped: true, label: text } : null, fold };
  }
  if (s.message) return { moment: 'refused', picture: 'on', reason: s.message.text, fold };
  if (s.sessions) {
    return { moment: 'waiting', picture: 'coming', lead: `Hold ${s.name || 'the card'} ${TOP}`, note: "Keep it there until the phone says it's done. It takes a few seconds." };
  }
  return {
    moment: 'waiting', picture: 'coming', lead: `Hold ${s.name || 'the card'} flat against the back of the phone`,
    note: "Keep it there until this screen says it's done. It takes a few seconds.",
  };
}

/** Where an iPhone reads a card. */
const TOP = 'against the top of the back of the phone';

/**
 * What happened on the hold screen. waiting: it reached that moment for the first time, the app in front.
 * card: a card arrived and its hold begins. step: the hold reported one (done: all it has reported).
 * stopped: the hold ended without finishing, with the screen's words for it; lost: the card moved away.
 * press: the screen's own button, at that moment. leave: the screen was left or lost the front.
 */
export type HoldEvent =
  | { on: 'waiting' }
  | { on: 'card' }
  | { on: 'step'; done: readonly string[] }
  | { on: 'finished'; op: Op }
  | { on: 'not-a-card' }
  | { on: 'stopped'; lost: boolean; text: string }
  | { on: 'press'; moment: 'waiting' | 'stopped' | 'refused' }
  | { on: 'leave' };

const SHEET_DONE: Record<Op, string> = {
  add: 'Card added', 'finish-add': 'Card added', adopt: 'Card added back', repoint: 'Card re-pointed', wipe: 'Card wiped',
};

/** What the screen tells Apple's sheet for an event, or null when the sheet is left as it is. A call on a sheet that is not open does nothing (native/nfc.ts). */
export function holdSheet(e: HoldEvent, o: { name: string; steps: HoldStep[] }): SheetCall | null {
  const card = o.name || 'the card';
  const stepLine = (done: readonly string[]): SheetCall | null => {
    const n = o.steps.filter((x) => done.includes(x.key)).length;
    // The last step reported, whatever went before it (an add that ends after a lost confirm reports that one alone): the end follows.
    if (n >= o.steps.length || done.includes(o.steps[o.steps.length - 1].key)) return null;
    const line = o.steps[n].line;
    return { call: 'say', line: `Step ${n + 1} of ${o.steps.length}: ${line[0].toLowerCase()}${line.slice(1)}. Keep holding the card.` };
  };
  switch (e.on) {
    case 'waiting':
      return { call: 'open', line: `Hold ${card} ${TOP}.` };
    case 'press':
      return { call: 'open', line: e.moment === 'stopped' ? `Hold ${card} ${TOP} again.` : `Hold ${card} ${TOP}.` };
    case 'card':
      return stepLine([]);
    case 'step':
      return stepLine(e.done);
    case 'finished':
      return { call: 'done', line: `${SHEET_DONE[e.op]}. You can take it away.` };
    case 'not-a-card':
      return { call: 'again', line: `That isn't a card this app can use. Hold ${card} ${TOP}.` };
    case 'stopped':
      return e.lost ? { call: 'again', line: `The card moved away. Hold it ${TOP} again.` } : { call: 'fail', line: e.text };
    case 'leave':
      return { call: 'close' };
  }
}

/**
 * The button that opens the sheet again, above Cancel: there whenever the screen waits, has stopped or has
 * refused and no sheet is up. Off while the last sheet is still going (iOS would refuse another). session: the
 * session's state, null where cards are read all the time, which never shows it.
 */
export function holdButton(v: HoldView, session: ReturnType<NfcSession['state']> | null): { title: string; on: boolean } | null {
  if (session === null || session === 'open') return null;
  const title = v.moment === 'waiting' ? 'Hold the card' : v.moment === 'stopped' ? 'Hold the card again' : v.moment === 'refused' ? 'Try again' : null;
  return title ? { title, on: session === 'none' } : null;
}

/**
 * Whether the sheet opens by itself now: the first time the screen waits for a card with the app in front. Not
 * before the lock has passed; not while the app is inactive (the lock's own prompt takes the front for a moment, and
 * iOS ends a sheet asked for then); not while the last sheet is still up or on its way out (iOS would refuse
 * another), but as soon as it has gone; and once only: after that the button opens it. Never for a screen no
 * press in the app led to: a link can open the hold screen, and must not raise Apple's sheet by doing so. session:
 * the session's state, null where cards are read all the time. ready: the screen has what it needs to act on a
 * card. pressed: a press in the app led here (the screen was sent that press's token: cards/holdPress.ts), or was
 * made on this screen (the unlock).
 */
export const sheetOpens = (o: {
  session: ReturnType<NfcSession['state']> | null; ready: boolean; moment: HoldView['moment']; focused: boolean; active: boolean; opened: boolean; pressed: boolean;
}): boolean => o.session === 'none' && o.ready && o.moment === 'waiting' && o.focused && o.active && !o.opened && o.pressed;

/**
 * What an end the screen did not ask for adds to it. Only iOS ending a waiting sheet for a reason of its own
 * shows, as a refusal in its words; a Cancel, the 60 seconds and the app leaving the front leave the button, and a
 * stop or a refusal already on the screen is never overwritten.
 */
export const endMessage = (e: SessionEnd, moment: HoldView['moment']): { text: string; again: boolean } | null =>
  e.why === 'error' && moment === 'waiting' ? { text: e.error, again: false } : null;

/** How a job ended. name: the card's, '' when none is known. active: cardd made the added card active. balanceMsat: what the wallet listed on the card when the wipe's screen opened, null when it didn't list it. */
export type HoldOutcome =
  | { op: 'add' | 'finish-add'; name: string; active: boolean }
  | { op: 'adopt' | 'repoint'; name: string }
  | { op: 'wipe'; name: string; serverTold: boolean; local: boolean; balanceMsat: number | null };

const PHOTO_NEXT = 'Next, its photo, so you can tell your cards apart.';

/**
 * The result page (ui/money.tsx ResultPage), its button, and where the button goes: Add card's photo step
 * (step: as which, 'add' or after adding a card back 'adopt', which the photo screen's band follows), or the wallet.
 */
export type HoldResult = { view: ResultView; button: 'Continue' | 'Done' } & ({ next: 'photo'; step: 'add' | 'adopt' } | { next: 'wallet' });

export function holdResult(o: HoldOutcome, v: View = 'sat', r: Rated | null = null): HoldResult {
  const card = o.name || 'The card';
  const page = (title: string, line: string, step: 'add' | 'adopt' | null): HoldResult => ({
    view: { tone: 'ok', mark: 'check', title, line: step ? `${line} ${PHOTO_NEXT}` : line },
    ...(step ? { button: 'Continue', next: 'photo', step } : { button: 'Done', next: 'wallet' }),
  });
  switch (o.op) {
    case 'add':
    case 'finish-add':
      return page('Card added', `${card} is ready to pay with. You can take it away from the phone.`, o.active ? 'add' : null);
    case 'adopt':
      return page('Card added back', `${card} now pays through this server. Its balance starts at zero: Move sets it again.`, 'adopt');
    case 'repoint':
      return page('Card re-pointed', `${card} now pays through this server.`, null);
    case 'wipe': {
      const after = o.local
        ? ' Your server hears of it from the phone that began the wipe.'
        : !o.serverTold
          ? ' Your server will be told once it can be reached.'
          : o.balanceMsat !== null && o.balanceMsat >= 1000
            ? ` Its ${viewText(o.balanceMsat, v, r)} are in Pool.`
            : '';
      return page('Card wiped', `${card} is blank again.${after}`, null);
    }
  }
}

/**
 * The card whose add stopped at its last call, for the next hold on this screen (addCard's `confirming`): the hold
 * had locked the card (its steps done up to key0), told the card's id, and stopped in a way that holding again
 * carries on. That call's answer may have been lost after the server made the card active.
 * before: the card remembered from an earlier hold; a hold that
 * reported no step (its own first call got no answer, or another card was held and refused) leaves it remembered,
 * since it only ever acts for that one card once the server has it active. Null for any other end.
 */
export const confirmingAfter = (o: { done: readonly string[]; id: string | null; again: boolean; before?: string | null }): string | null =>
  o.again && o.id !== null && o.done.includes('key0') && !o.done.includes('confirm') ? o.id : o.done.length === 0 ? (o.before ?? null) : null;

/**
 * Where ← in the band, Android's Back and Cancel go. While a hold runs, nowhere: the card is being read or
 * written, or the server asked. Until a hold has reported a step, back one screen: nothing was written and the
 * server heard nothing (a lock that wasn't confirmed, a tag that isn't a card, the wrong card for a wipe). After
 * that, the wallet, which reads the cards again.
 */
export const leaveTo = (o: { reported: boolean; running: boolean }): 'stay' | 'back' | 'wallet' => (o.running ? 'stay' : o.reported ? 'wallet' : 'back');

/**
 * A wipe's page before the screen lock. name, state: the card's, from the card list by the wipe's id ('' and
 * none for a card no list names). balanceMsat: what the wallet lists on it, null when it doesn't. unreachable:
 * the server can't be reached. lock: what this phone calls its lock (ui/lockName.ts), Android's "your screen lock"
 * when not told. prompt: the lock's own title.
 */
export function wipeIntro(o: { name: string; state?: CardState; balanceMsat: number | null; unreachable: boolean; lock?: string }, v: View = 'sat', r: Rated | null = null): { lead: string; body: string; note: string; prompt: string } {
  const blank = 'The card becomes blank, and can be added again.';
  return {
    lead: !o.name ? 'Wipe this card' : o.state === 'wiping' ? `Finish wiping ${o.name}` : `Wipe ${o.name}`,
    body: o.unreachable
      ? "Your server can't be reached. The card can still be wiped; your server is told, and its balance moved to Pool, once it can be reached."
      : o.balanceMsat !== null && o.balanceMsat >= 1000
        ? `Its ${viewText(o.balanceMsat, v, r)} move to Pool. ${blank}`
        : blank,
    note: `Wiping needs ${o.lock ?? 'your screen lock'}, then ${o.name || 'the card'} held to the phone.`,
    prompt: o.name ? `Wipe ${o.name}` : 'Wipe the card',
  };
}

/**
 * What a button of the sheet for a card held to the phone, or its wipe row, opens the hold screen with (ui/TapSheet.tsx):
 * always for the card just held, so its wipe refuses any other and the others show its name. Finish wipe is a wipe.
 */
export const sheetLink = (a: Exclude<SheetAction, 'add' | 'adopt'> | 'wipe', id: string | undefined): { op: Op; id?: string } => ({
  op: a === 'finish-wipe' ? 'wipe' : a,
  ...(id && { id }),
});
