// The hold-the-card screen's decisions.
import { describe, expect, it } from 'vitest';
import { ADD_STEPS } from './add';
import { ADOPT_STEPS } from './adopt';
import { ADD_BAR, confirmingAfter, endMessage, HOLD_TITLES, holdButton, holdSheet, NAME_HINT, nameView, sheetOpens, holdNames, holdParams, holdResult, holdSteps, holdView, leaveTo, OPS, sheetLink, wipeIntro } from './hold';
import { REPOINT_STEPS } from './repoint';
import { WIPE_STEPS } from './wipe';

const ID = '0123456789abcdef0123456789abcdef';
const keys = (s: { key: string }[]) => s.map((x) => x.key);
const lines = (s: { line: string }[]) => s.map((x) => x.line);
const shorts = (s: { short: string }[]) => s.map((x) => x.short);

describe('holdSteps', () => {
  it("says an add's seven steps in plain words, each with a short word for the Done line", () => {
    const s = holdSteps('add', true);
    expect(keys(s)).toEqual(ADD_STEPS);
    expect(lines(s)).toEqual([
      'Checking the card is blank', 'Hiding its ID from readers', 'Reserving it on your server', "Writing your server's address",
      'Setting its keys', 'Locking it with your key', 'Checking it with your server',
    ]);
    expect(shorts(s)).toEqual(['blank card', 'ID hidden', 'reserved', 'address written', 'keys set', 'locked', 'checked']);
  });

  it('shows six steps when the ID is not being hidden', () => {
    const s = holdSteps('add', false);
    expect(keys(s)).toEqual(ADD_STEPS.filter((k) => k !== 'random-uid'));
    expect(lines(s)).not.toContain('Hiding its ID from readers');
  });

  it('gives Finish setup six steps whatever it is told, and a first line of its own', () => {
    for (const hide of [true, false]) {
      const s = holdSteps('finish-add', hide);
      expect(keys(s)).toEqual(ADD_STEPS.filter((k) => k !== 'random-uid'));
      expect(s[0]).toEqual({ key: 'check', line: 'Checking where the add stopped', short: 'card checked' });
      expect(lines(s).slice(1)).toEqual(lines(holdSteps('add', false)).slice(1));
    }
  });

  it("says a wipe's, a re-point's and an add back's steps", () => {
    const wipe = holdSteps('wipe', false);
    expect(keys(wipe)).toEqual(WIPE_STEPS);
    expect(lines(wipe)).toEqual([
      'Checking which card this is', 'Telling your server', 'Clearing its keys', 'Unlocking it', 'Resetting its settings',
      "Clearing your server's address", "Telling your server it's blank",
    ]);
    expect(shorts(wipe)).toEqual(['card checked', 'server told', 'keys cleared', 'unlocked', 'settings reset', 'address cleared', 'finished']);

    const repoint = holdSteps('repoint', false);
    expect(keys(repoint)).toEqual(REPOINT_STEPS);
    expect(lines(repoint)).toEqual(['Checking which card this is', "Writing this server's address", 'Matching its settings to the address', 'Checking it with your server']);
    expect(shorts(repoint)).toEqual(['card checked', 'address written', 'settings matched', 'checked']);

    const adopt = holdSteps('adopt', false);
    expect(keys(adopt)).toEqual(ADOPT_STEPS);
    expect(lines(adopt)).toEqual(['Checking which card this is', 'Adding it back to your server', ...lines(repoint).slice(1)]);
    expect(shorts(adopt)).toEqual(['card checked', 'added back', ...shorts(repoint).slice(1)]);
  });

  it('has a band title for every job', () => {
    expect(OPS.map((op) => HOLD_TITLES[op])).toEqual(['Add a card', 'Finish adding the card', 'Wipe the card', 'Re-point the card', 'Add the card back']);
  });
});

describe('ADD_BAR', () => {
  it('names Add card\'s three steps', () => {
    expect(ADD_BAR).toEqual(['Name', 'Hold', 'Photo']);
  });
});

describe('holdParams', () => {
  it('takes each job, and an unknown or missing one as an add', () => {
    for (const op of OPS) expect(holdParams({ op, id: ID })?.op).toBe(op);
    expect(holdParams({ op: 'format' })?.op).toBe('add');
    expect(holdParams({})?.op).toBe('add');
  });

  it("hides a new card's ID unless the switch said not to", () => {
    expect(holdParams({ op: 'add', name: 'Daily' })).toEqual({ op: 'add', name: 'Daily', randomUid: true });
    expect(holdParams({ op: 'add', name: 'Daily', randomUid: '1' })?.randomUid).toBe(true);
    expect(holdParams({ op: 'add', name: 'Daily', randomUid: '0' })?.randomUid).toBe(false);
  });

  // Finish setup once ran with the hiding on, and turned it on for good on a card begun with it off.
  it("never lets Finish setup change the card's ID setting, whatever its link says", () => {
    expect(holdParams({ op: 'finish-add' })?.randomUid).toBe(false);
    expect(holdParams({ op: 'finish-add', randomUid: '1' })?.randomUid).toBe(false);
    expect(holdParams({ op: 'finish-add', randomUid: '0' })?.randomUid).toBe(false);
    expect(holdParams({ op: 'adopt', name: 'Daily', randomUid: '1' })?.randomUid).toBe(false);
    expect(holdParams({ op: 'repoint', id: ID, randomUid: '1' })?.randomUid).toBe(false);
  });

  it('takes a name from the link only where the person has just typed it', () => {
    expect(holdParams({ op: 'adopt', name: 'Daily' })?.name).toBe('Daily');
    expect(holdParams({ op: 'adopt' })?.name).toBe('');
    expect(holdParams({ op: 'finish-add', id: ID, name: 'Spoof' })?.name).toBe('');
    expect(holdParams({ op: 'repoint', id: ID, name: 'Spoof' })?.name).toBe('');
    expect(holdParams({ op: 'wipe', id: ID, name: 'Spoof' })?.name).toBe('');
  });

  it("keeps a card's id only when it is one, for the name on the screen", () => {
    expect(holdParams({ op: 'finish-add', id: ID })?.id).toBe(ID);
    expect(holdParams({ op: 'repoint', id: ID })?.id).toBe(ID);
    expect(holdParams({ op: 'repoint', id: 'pool' })).toEqual({ op: 'repoint', name: '', randomUid: false });
    expect(holdParams({ op: 'finish-add', id: ID.toUpperCase() })?.id).toBeUndefined();
    expect(holdParams({ op: 'add', name: 'Daily', id: ID })?.id).toBeUndefined();
  });

  it('has no wipe without its card: the screen goes to the wallet', () => {
    expect(holdParams({ op: 'wipe', id: ID })).toEqual({ op: 'wipe', id: ID, name: '', randomUid: false });
    expect(holdParams({ op: 'wipe' })).toBeNull();
    expect(holdParams({ op: 'wipe', id: 'daily' })).toBeNull();
    expect(holdParams({ op: 'wipe', id: `${ID}0` })).toBeNull();
  });
});

describe('holdView', () => {
  const add = holdSteps('add', true);
  const base = { name: 'Daily', steps: add, unlocked: true, running: false, done: [] as string[], message: null, finished: false };
  const stopped = { text: 'The card moved away. Hold it again to carry on.', again: true };

  it('asks for the lock first on a wipe, and nothing else shows until it is given', () => {
    expect(holdView({ ...base, unlocked: false })).toEqual({ moment: 'lock' });
    expect(holdView({ ...base, unlocked: false, message: { text: 'The screen lock was not confirmed.', again: false } })).toEqual({ moment: 'lock' });
  });

  it('waits for the card by name, or for "the card"', () => {
    expect(holdView(base)).toEqual({
      moment: 'waiting', picture: 'coming', lead: 'Hold Daily flat against the back of the phone',
      note: "Keep it there until this screen says it's done. It takes a few seconds.",
    });
    expect(holdView({ ...base, name: '' })).toMatchObject({ lead: 'Hold the card flat against the back of the phone' });
  });

  it('shows the step it is on while it writes, from the first, and folds away what is done', () => {
    expect(holdView({ ...base, running: true })).toEqual({
      moment: 'writing', picture: 'on', lead: 'Keep holding the card…',
      progress: { text: 'Step 1 of 7', n: 1, of: 7, stopped: false, label: 'Step 1 of 7, Checking the card is blank' },
      line: 'Checking the card is blank', fold: null,
    });
    expect(holdView({ ...base, running: true, done: ['check', 'random-uid', 'reserve'] })).toEqual({
      moment: 'writing', picture: 'on', lead: 'Keep holding the card…',
      progress: { text: 'Step 4 of 7', n: 4, of: 7, stopped: false, label: "Step 4 of 7, Writing your server's address" },
      line: "Writing your server's address",
      fold: { summary: 'Done: blank card, ID hidden, reserved', rows: ['Checking the card is blank', 'Hiding its ID from readers', 'Reserving it on your server'] },
    });
    // The last step's report and the result arrive together; until then the count stays on the last step.
    expect(holdView({ ...base, running: true, done: add.map((s) => s.key) })).toMatchObject({ progress: { text: 'Step 7 of 7', n: 7 }, line: 'Checking it with your server' });
  });

  it('counts six steps when the ID is not hidden, though the hold still reports that step', () => {
    const six = holdSteps('add', false);
    expect(holdView({ ...base, steps: six, running: true, done: ['check', 'random-uid'] })).toMatchObject({
      progress: { text: 'Step 2 of 6', n: 2, of: 6 }, line: 'Reserving it on your server', fold: { summary: 'Done: blank card', rows: ['Checking the card is blank'] },
    });
  });

  it('says in amber why it stopped when holding the card again carries on, with where it stopped', () => {
    expect(holdView({ ...base, done: ['check', 'random-uid', 'reserve'], message: stopped })).toEqual({
      moment: 'stopped', picture: 'away', reason: stopped.text,
      progress: { text: 'Stopped at step 4 of 7', n: 4, of: 7, stopped: true, label: 'Stopped at step 4 of 7' },
      fold: { summary: 'Done: blank card, ID hidden, reserved', rows: ['Checking the card is blank', 'Hiding its ID from readers', 'Reserving it on your server'] },
    });
    const down = { text: "Can't reach your server. Hold the card again once it's back.", again: true };
    expect(holdView({ ...base, done: ['check'], message: down })).toMatchObject({ moment: 'stopped', reason: down.text, progress: { text: 'Stopped at step 2 of 7' } });
  });

  it('shows no progress for a stop before any step: a tag that is not a card, a card lifted at once', () => {
    const notACard = { text: "That isn't a card this app can use.", again: true };
    expect(holdView({ ...base, message: notACard })).toEqual({ moment: 'stopped', picture: 'away', reason: notACard.text, progress: null, fold: null });
    expect(holdView({ ...base, message: stopped })).toMatchObject({ progress: null, fold: null });
  });

  it('says in red why a card was refused, with what was done before it', () => {
    const refused = { text: 'This card is already one of yours.', again: false };
    expect(holdView({ ...base, message: refused })).toEqual({ moment: 'refused', picture: 'on', reason: refused.text, fold: null });
    const card = { text: 'The card refused: ChangeKey: the card answered 91AE (authentication error)', again: false };
    expect(holdView({ ...base, done: ['check', 'random-uid', 'reserve', 'url'], message: card })).toMatchObject({
      moment: 'refused', reason: card.text, fold: { summary: 'Done: blank card, ID hidden, reserved, address written' },
    });
  });

  it('starts the count again when a new hold begins, and is finished when the job is', () => {
    expect(holdView({ ...base, running: true, done: [], message: null })).toMatchObject({ moment: 'writing', progress: { n: 1 }, fold: null });
    expect(holdView({ ...base, finished: true, done: add.map((s) => s.key) })).toEqual({ moment: 'finished' });
    expect(holdView({ ...base, finished: true, message: stopped })).toEqual({ moment: 'finished' });
  });
});

describe('holdResult', () => {
  const ok = { tone: 'ok', mark: 'check' } as const;
  const photo = 'Next, its photo, so you can tell your cards apart.';

  it('ends an add on Card added, then the photo', () => {
    for (const op of ['add', 'finish-add'] as const) {
      expect(holdResult({ op, name: 'Daily', active: true })).toEqual({
        view: { ...ok, title: 'Card added', line: `Daily is ready to pay with. You can take it away from the phone. ${photo}` }, button: 'Continue', next: 'photo', step: 'add',
      });
    }
    expect(holdResult({ op: 'add', name: '', active: true }).view.line).toBe(`The card is ready to pay with. You can take it away from the phone. ${photo}`);
  });

  it('ends an add the server left inactive without the photo step', () => {
    expect(holdResult({ op: 'add', name: 'Daily', active: false })).toEqual({
      view: { ...ok, title: 'Card added', line: 'Daily is ready to pay with. You can take it away from the phone.' }, button: 'Done', next: 'wallet',
    });
  });

  it('ends an add back and a re-point on what the card now does', () => {
    expect(holdResult({ op: 'adopt', name: 'Daily' })).toEqual({
      view: { ...ok, title: 'Card added back', line: `Daily now pays through this server. Its balance starts at zero: Move sets it again. ${photo}` }, button: 'Continue', next: 'photo', step: 'adopt',
    });
    expect(holdResult({ op: 'repoint', name: 'Daily' })).toEqual({ view: { ...ok, title: 'Card re-pointed', line: 'Daily now pays through this server.' }, button: 'Done', next: 'wallet' });
    expect(holdResult({ op: 'repoint', name: '' }).view.line).toBe('The card now pays through this server.');
  });

  it('ends a wipe on where the money is, or on who tells the server', () => {
    const wipe = { op: 'wipe', name: 'Daily', serverTold: true, local: false, balanceMsat: 13_291_000 } as const;
    expect(holdResult(wipe)).toEqual({ view: { ...ok, title: 'Card wiped', line: 'Daily is blank again. Its 13,291 sat are in Pool.' }, button: 'Done', next: 'wallet' });
    expect(holdResult({ ...wipe, balanceMsat: 999 }).view.line).toBe('Daily is blank again.');
    expect(holdResult({ ...wipe, balanceMsat: null }).view.line).toBe('Daily is blank again.');
    expect(holdResult({ ...wipe, serverTold: false }).view.line).toBe('Daily is blank again. Your server will be told once it can be reached.');
    expect(holdResult({ ...wipe, serverTold: false, local: true }).view.line).toBe('Daily is blank again. Your server hears of it from the phone that began the wipe.');
    expect(holdResult({ ...wipe, name: '', balanceMsat: null }).view.line).toBe('The card is blank again.');
  });
});

// The iPhone's way: the hold screen drives Apple's sheet.
describe('holdView where cards are read in a session', () => {
  const state = { name: 'Daily', steps: holdSteps('add', true), unlocked: true, running: false, done: [], message: null, finished: false };
  it('says where on the phone to hold the card, and that the phone says when it is done', () => {
    expect(holdView({ ...state, sessions: true })).toEqual({
      moment: 'waiting', picture: 'coming', lead: 'Hold Daily against the top of the back of the phone',
      note: "Keep it there until the phone says it's done. It takes a few seconds.",
    });
    expect(holdView({ ...state, name: '', sessions: true })).toMatchObject({ lead: 'Hold the card against the top of the back of the phone' });
  });
  it('keeps Android\'s words where cards are read all the time', () => {
    expect(holdView(state)).toMatchObject({ lead: 'Hold Daily flat against the back of the phone', note: "Keep it there until this screen says it's done. It takes a few seconds." });
  });
});

describe('holdSheet', () => {
  const add = { name: 'Daily', steps: holdSteps('add', true) };
  const TOP = 'against the top of the back of the phone';
  it('opens the sheet when the screen first waits, saying where to hold the card', () => {
    expect(holdSheet({ on: 'waiting' }, add)).toEqual({ call: 'open', line: `Hold Daily ${TOP}.` });
    expect(holdSheet({ on: 'waiting' }, { ...add, name: '' })).toEqual({ call: 'open', line: `Hold the card ${TOP}.` });
  });
  it('says the step it is on from the card\'s arrival, in the step\'s own words', () => {
    expect(holdSheet({ on: 'card' }, add)).toEqual({ call: 'say', line: 'Step 1 of 7: checking the card is blank. Keep holding the card.' });
    expect(holdSheet({ on: 'step', done: ['check', 'random-uid', 'reserve'] }, add)).toEqual({ call: 'say', line: "Step 4 of 7: writing your server's address. Keep holding the card." });
    expect(holdSheet({ on: 'card' }, { name: 'Daily', steps: holdSteps('wipe', false) })).toEqual({ call: 'say', line: 'Step 1 of 7: checking which card this is. Keep holding the card.' });
  });
  it('counts six steps when the ID is not hidden, though the hold still reports that step', () => {
    const six = { name: 'Daily', steps: holdSteps('add', false) };
    expect(holdSheet({ on: 'step', done: ['check', 'random-uid'] }, six)).toEqual({ call: 'say', line: 'Step 2 of 6: reserving it on your server. Keep holding the card.' });
  });
  it('says nothing new after the last step: the end follows', () => {
    expect(holdSheet({ on: 'step', done: ADD_STEPS }, add)).toBeNull();
    // An add that ends after a lost confirm reports the last step alone.
    expect(holdSheet({ on: 'step', done: ['confirm'] }, add)).toBeNull();
  });
  it.each([
    ['add', 'Card added. You can take it away.'],
    ['finish-add', 'Card added. You can take it away.'],
    ['adopt', 'Card added back. You can take it away.'],
    ['repoint', 'Card re-pointed. You can take it away.'],
    ['wipe', 'Card wiped. You can take it away.'],
  ] as const)('ends a finished %s with the tick and what was done', (op, line) => {
    expect(holdSheet({ on: 'finished', op }, add)).toEqual({ call: 'done', line });
  });
  it('keeps the sheet and looks again for a card that moved away, or for what is not a card', () => {
    expect(holdSheet({ on: 'stopped', lost: true, text: 'The card moved away. Hold it again to carry on.' }, add)).toEqual({ call: 'again', line: `The card moved away. Hold it ${TOP} again.` });
    expect(holdSheet({ on: 'not-a-card' }, add)).toEqual({ call: 'again', line: `That isn't a card this app can use. Hold Daily ${TOP}.` });
    expect(holdSheet({ on: 'not-a-card' }, { ...add, name: '' })).toEqual({ call: 'again', line: `That isn't a card this app can use. Hold the card ${TOP}.` });
  });
  it('closes the sheet with the screen\'s own reason for any other stop or refusal', () => {
    const late = "Your server didn't answer in time. Hold the card again to carry on.";
    expect(holdSheet({ on: 'stopped', lost: false, text: late }, add)).toEqual({ call: 'fail', line: late });
    expect(holdSheet({ on: 'stopped', lost: false, text: 'This card is already one of yours.' }, add)).toEqual({ call: 'fail', line: 'This card is already one of yours.' });
  });
  it('opens the sheet again from the button, with a line for where the screen stands', () => {
    expect(holdSheet({ on: 'press', moment: 'waiting' }, add)).toEqual({ call: 'open', line: `Hold Daily ${TOP}.` });
    expect(holdSheet({ on: 'press', moment: 'stopped' }, add)).toEqual({ call: 'open', line: `Hold Daily ${TOP} again.` });
    expect(holdSheet({ on: 'press', moment: 'refused' }, add)).toEqual({ call: 'open', line: `Hold Daily ${TOP}.` });
  });
  it('closes the sheet when the screen is left', () => {
    expect(holdSheet({ on: 'leave' }, add)).toEqual({ call: 'close' });
  });
});

describe('holdButton', () => {
  const state = { name: 'Daily', steps: holdSteps('add', true), unlocked: true, running: false, done: [] as string[], message: null as { text: string; again: boolean } | null, finished: false, sessions: true };
  const waiting = holdView(state);
  const stopped = holdView({ ...state, message: { text: 'The card moved away. Hold it again to carry on.', again: true } });
  const refused = holdView({ ...state, message: { text: 'This card is already one of yours.', again: false } });
  it('offers to open the sheet again whenever it has closed without the job done', () => {
    expect(holdButton(waiting, 'none')).toEqual({ title: 'Hold the card', on: true });
    expect(holdButton(stopped, 'none')).toEqual({ title: 'Hold the card again', on: true });
    expect(holdButton(refused, 'none')).toEqual({ title: 'Try again', on: true });
  });
  it('is off while the last sheet is still on its way out', () => {
    expect(holdButton(waiting, 'ending')).toEqual({ title: 'Hold the card', on: false });
    expect(holdButton(stopped, 'ending')).toEqual({ title: 'Hold the card again', on: false });
  });
  it('is not shown while the sheet is up, before the lock, while a hold runs or once the job is done', () => {
    expect(holdButton(waiting, 'open')).toBeNull();
    expect(holdButton(holdView({ ...state, unlocked: false }), 'none')).toBeNull();
    expect(holdButton(holdView({ ...state, running: true }), 'none')).toBeNull();
    expect(holdButton(holdView({ ...state, finished: true }), 'none')).toBeNull();
  });
  it('is never shown where cards are read all the time', () => {
    expect(holdButton(waiting, null)).toBeNull();
    expect(holdButton(stopped, null)).toBeNull();
    expect(holdButton(refused, null)).toBeNull();
  });
});

describe('sheetOpens', () => {
  const arriving = { session: 'none' as const, ready: true, moment: 'waiting' as const, focused: true, active: true, opened: false, pressed: true };
  it('opens the sheet by itself the first time the screen waits for a card', () => {
    expect(sheetOpens(arriving)).toBe(true);
  });
  it('waits for the lock, and for the app to be active again after the lock\'s own prompt', () => {
    expect(sheetOpens({ ...arriving, moment: 'lock' })).toBe(false);
    expect(sheetOpens({ ...arriving, active: false })).toBe(false);
    expect(sheetOpens({ ...arriving, active: true })).toBe(true);
  });
  it('waits for the last sheet to go when it arrives while one is still up or on its way out', () => {
    expect(sheetOpens({ ...arriving, session: 'ending' })).toBe(false);
    expect(sheetOpens({ ...arriving, session: 'open' })).toBe(false);
    expect(sheetOpens({ ...arriving, session: 'none' })).toBe(true);
  });
  it('opens once: after that the button does', () => {
    expect(sheetOpens({ ...arriving, opened: true })).toBe(false);
  });
  it('does not open behind another screen, before the screen can act, or at any other moment', () => {
    expect(sheetOpens({ ...arriving, focused: false })).toBe(false);
    expect(sheetOpens({ ...arriving, ready: false })).toBe(false);
    for (const moment of ['writing', 'stopped', 'refused', 'finished'] as const) expect(sheetOpens({ ...arriving, moment })).toBe(false);
  });
  it('never opens where cards are read all the time', () => {
    expect(sheetOpens({ ...arriving, session: null })).toBe(false);
  });
  it('never opens for a screen a link opened: no press in the app led to it', () => {
    expect(sheetOpens({ ...arriving, pressed: false })).toBe(false);
  });
});

describe('endMessage', () => {
  it('shows iOS\'s own words as a refusal when it ended a waiting sheet for a reason of its own', () => {
    expect(endMessage({ why: 'error', error: 'Missing required entitlement' }, 'waiting')).toEqual({ text: 'Missing required entitlement', again: false });
  });
  it('changes nothing for a Cancel, the 60 seconds or the app leaving the front: the button is there', () => {
    for (const why of ['cancelled', 'timeout', 'interrupted', 'done', 'failed', 'closed'] as const) expect(endMessage({ why }, 'waiting')).toBeNull();
  });
  it('never overwrites a stop or a refusal with the end\'s own reason', () => {
    for (const moment of ['writing', 'stopped', 'refused', 'finished', 'lock'] as const) expect(endMessage({ why: 'error', error: 'Session invalidated unexpectedly' }, moment)).toBeNull();
  });
});

describe('confirmingAfter', () => {
  const id = 'ab'.repeat(16);
  const upToTheLock = ['check', 'random-uid', 'reserve', 'url', 'keys', 'key0'];
  it("remembers the card whose add stopped at its last call, for the next hold", () => {
    expect(confirmingAfter({ done: upToTheLock, id, again: true })).toBe(id);
    expect(confirmingAfter({ done: ['check', 'reserve', 'url', 'keys', 'key0'], id, again: true })).toBe(id);
  });
  // The next hold's own call may get no answer too, before it reports any step.
  it('keeps what it remembered through a hold that reported no step, whatever ended it', () => {
    expect(confirmingAfter({ done: [], id: null, again: true, before: id })).toBe(id);
    expect(confirmingAfter({ done: [], id: null, again: false, before: id })).toBe(id);
    expect(confirmingAfter({ done: [], id: null, again: true, before: null })).toBeNull();
  });
  it('forgets it once a hold has reported a step and did not stop at the last call again', () => {
    expect(confirmingAfter({ done: ['check'], id, again: true, before: id })).toBeNull();
    expect(confirmingAfter({ done: ['check', 'reserve'], id: 'cd'.repeat(16), again: false, before: id })).toBeNull();
    expect(confirmingAfter({ done: upToTheLock, id: 'cd'.repeat(16), again: true, before: id })).toBe('cd'.repeat(16));
  });
  it('remembers none for a hold that stopped sooner, was refused, or told no id', () => {
    expect(confirmingAfter({ done: upToTheLock.slice(0, -1), id, again: true })).toBeNull();
    expect(confirmingAfter({ done: [], id, again: true })).toBeNull();
    expect(confirmingAfter({ done: upToTheLock, id, again: false })).toBeNull();
    expect(confirmingAfter({ done: upToTheLock, id: null, again: true })).toBeNull();
  });
});

describe('leaveTo', () => {
  it('goes back one screen until a hold has reported a step: nothing was written and the server heard nothing', () => {
    // Before any hold; after a lock that wasn't confirmed; after a tag that isn't a card; after the wrong card for a wipe.
    expect(leaveTo({ reported: false, running: false })).toBe('back');
  });
  it('goes to the wallet once a hold has reported a step, stopped or refused after it or not', () => {
    expect(leaveTo({ reported: true, running: false })).toBe('wallet');
  });
  it('stays while a hold runs', () => {
    expect(leaveTo({ reported: false, running: true })).toBe('stay');
    expect(leaveTo({ reported: true, running: true })).toBe('stay');
  });
});

describe('wipeIntro', () => {
  const card = { name: 'Daily', state: 'active', balanceMsat: 13_291_000, unreachable: false } as const;
  const blank = 'The card becomes blank, and can be added again.';

  it('names the card, says where its money goes and what the wipe needs', () => {
    expect(wipeIntro(card)).toEqual({
      lead: 'Wipe Daily', body: `Its 13,291 sat move to Pool. ${blank}`, note: 'Wiping needs your screen lock, then Daily held to the phone.', prompt: 'Wipe Daily',
    });
  });
  it('leaves the money out under 1 sat, or when the wallet does not list the card', () => {
    expect(wipeIntro({ ...card, balanceMsat: 999 }).body).toBe(blank);
    expect(wipeIntro({ ...card, balanceMsat: null }).body).toBe(blank);
  });
  it('names the lock as an iPhone does when told to', () => {
    expect(wipeIntro({ ...card, lock: 'Face ID or your passcode' }).note).toBe('Wiping needs Face ID or your passcode, then Daily held to the phone.');
  });
  it('finishes a wipe already begun', () => {
    expect(wipeIntro({ ...card, state: 'wiping', balanceMsat: null })).toMatchObject({ lead: 'Finish wiping Daily', body: blank, prompt: 'Wipe Daily' });
  });
  it('has words for a card no list names', () => {
    expect(wipeIntro({ name: '', balanceMsat: null, unreachable: false })).toEqual({
      lead: 'Wipe this card', body: blank, note: 'Wiping needs your screen lock, then the card held to the phone.', prompt: 'Wipe the card',
    });
  });
  it('says the card can still be wiped with the server out of reach', () => {
    expect(wipeIntro({ ...card, unreachable: true }).body).toBe(
      "Your server can't be reached. The card can still be wiped; your server is told, and its balance moved to Pool, once it can be reached.",
    );
  });
});

describe('nameView', () => {
  it('asks a new card\'s name, with the row that hides its ID, and goes on only with a name', () => {
    expect(nameView(false, '', true)).toEqual({
      band: 'Add a card', outline: { name: '', placeholder: undefined }, intro: null, note: null,
      row: {
        name: "Hide the card's ID from readers",
        line: "Readers see a random ID each time (“random UID”), so a shop can't follow the card by it. Once on, it can't be turned off on that card.",
      },
      canContinue: false, next: { op: 'add', name: '', randomUid: '1' },
    });
    expect(nameView(false, '   ', true).canContinue).toBe(false);
    expect(nameView(false, ' Daily ', true)).toMatchObject({ outline: { name: 'Daily' }, canContinue: true, next: { op: 'add', name: 'Daily', randomUid: '1' } });
    expect(nameView(false, 'Daily', false).next).toEqual({ op: 'add', name: 'Daily', randomUid: '0' });
  });

  it('asks only a name for a card added back, and calls it Card with none', () => {
    expect(nameView(true, '', true)).toEqual({
      band: 'Add the card back', outline: { name: '', placeholder: 'Card' },
      intro: "Your server doesn't know this card yet. Give it a name you'll recognise.", note: 'Its balance starts at zero.',
      row: null, canContinue: true, next: { op: 'adopt', name: 'Card' },
    });
    expect(nameView(true, ' Kids ', false).next).toEqual({ op: 'adopt', name: 'Kids' });
  });

  it("has the field's hint", () => {
    expect(NAME_HINT).toBe('“Daily” or “Kids”');
  });
});

// The sheet's own way into the hold screen: every wipe is for its card, the sheet's too.
describe('sheetLink', () => {
  it('opens a wipe, and a wipe to finish, for the card just held', () => {
    expect(sheetLink('wipe', ID)).toEqual({ op: 'wipe', id: ID });
    expect(sheetLink('finish-wipe', ID)).toEqual({ op: 'wipe', id: ID });
  });
  it("opens the other jobs with the card's id, for its name", () => {
    expect(sheetLink('finish-add', ID)).toEqual({ op: 'finish-add', id: ID });
    expect(sheetLink('repoint', ID)).toEqual({ op: 'repoint', id: ID });
  });
  it('gives what the hold screen reads back as the same job and card', () => {
    for (const a of ['wipe', 'finish-wipe', 'finish-add', 'repoint'] as const) expect(holdParams(sheetLink(a, ID))).toMatchObject({ id: ID });
    // A card with no id is never offered a wipe; if one were, the hold screen would go to the wallet.
    expect(holdParams(sheetLink('wipe', undefined))).toBeNull();
  });
});

// Finish setup once sent the server the list name of the card the screen was opened for, and
// the server renames whichever part-way card is held: Kids, held on a screen opened for Daily, became Daily.
describe('holdNames', () => {
  it("shows the name of the card the screen was opened for, and sends the server none: the card held may be another", () => {
    expect(holdNames({ op: 'finish-add', id: ID, name: '', randomUid: false }, 'Daily')).toEqual({ shown: 'Daily', sent: '' });
    expect(holdNames({ op: 'repoint', id: ID, name: '', randomUid: false }, 'Daily')).toEqual({ shown: 'Daily', sent: '' });
    expect(holdNames({ op: 'wipe', id: ID, name: '', randomUid: false }, 'Daily')).toEqual({ shown: 'Daily', sent: '' });
  });
  it('shows and sends the name the person has just typed', () => {
    expect(holdNames({ op: 'add', name: 'Kids', randomUid: true }, undefined)).toEqual({ shown: 'Kids', sent: 'Kids' });
    expect(holdNames({ op: 'adopt', name: 'Card', randomUid: false }, undefined)).toEqual({ shown: 'Card', sent: 'Card' });
  });
  it('has neither for a card no list names, or with no parameters', () => {
    expect(holdNames({ op: 'finish-add', name: '', randomUid: false }, undefined)).toEqual({ shown: '', sent: '' });
    expect(holdNames(null, 'Daily')).toEqual({ shown: '', sent: '' });
  });
});

// A wipe confirms money, so the page and its result are given confirmView's view by the screen.
describe("the wipe's money in the app's view", () => {
  const GBP = { currency: 'GBP' as const, price: 61_352, time: 1_792_037_404 };
  it('says where the balance goes, and went, in the view', () => {
    const wipe = { op: 'wipe', name: 'Daily', serverTold: true, local: false, balanceMsat: 13_291_000 } as const;
    expect(holdResult(wipe, 'fiat', GBP).view.line).toBe('Daily is blank again. Its £8.15 are in Pool.');
    expect(holdResult(wipe, 'msat', null).view.line).toBe('Daily is blank again. Its 13,291,000 msat are in Pool.');
    expect(wipeIntro({ name: 'Daily', state: 'active', balanceMsat: 13_291_000, unreachable: false }, 'fiat', GBP).body).toBe('Its £8.15 move to Pool. The card becomes blank, and can be added again.');
  });
});
