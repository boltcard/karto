import { describe, expect, it } from 'vitest';
import { CarddError, type PosPhone } from '../cardd/client';
import { addStep, ADD_START, codeLine, nameProblem, nextTillName, pairedView, pairLink, phoneRows, posError, posGate, restoreNote, UPDATE_FIRST, type AddState } from './posPhones';

const NOW = 1_790_000_000; // 2026-09-21 14:13:20 UTC
const at = (daysAgo: number, h: number, m: number) => Date.UTC(2026, 8, 21 - daysAgo, h, m) / 1000;
const phone = (name: string, o: Partial<PosPhone> = {}): PosPhone => ({ keyId: name.toLowerCase().replace(/\W/g, '').padEnd(16, '0'), name, created: at(10, 9, 12), sales: 0, ...o });

// The PoS phones page and Add a PoS phone.
describe('phoneRows', () => {
  it('says when each phone was added and when it last took a sale', () => {
    const rows = phoneRows([phone('Till 1', { sales: 3, lastSale: at(0, 14, 2) }), phone('Front', { created: at(0, 9, 0), sales: 1, lastSale: at(1, 22, 52) }), phone('Till 3')], NOW, 0);
    expect(rows).toEqual([
      { keyId: 'till100000000000', name: 'Till 1', line: 'Added 11 Sep · last sale today at 14:02', foot: 'Added 11 Sep at 09:12 · 3 sales' },
      { keyId: 'front00000000000', name: 'Front', line: 'Added 21 Sep · last sale yesterday at 22:52', foot: 'Added today at 09:00 · 1 sale' },
      { keyId: 'till300000000000', name: 'Till 3', line: 'Added 11 Sep · no sales yet', foot: 'Added 11 Sep at 09:12 · no sales yet' },
    ]);
  });

  it("reads the times in the phone's time zone, and a date from another year with its year", () => {
    const [row] = phoneRows([phone('Till 1', { created: Date.UTC(2025, 11, 31, 23, 30) / 1000 })], NOW, 60);
    expect(row.line).toBe('Added 1 Jan · no sales yet');
    expect(phoneRows([phone('Till 1', { created: Date.UTC(2025, 11, 31, 23, 30) / 1000 })], NOW, 0)[0].foot).toBe('Added 31 Dec 2025 at 23:30 · no sales yet');
  });
});

describe('nextTillName', () => {
  it('is the first of Till 1, Till 2, … no PoS phone has', () => {
    expect(nextTillName([])).toBe('Till 1');
    expect(nextTillName([phone('Till 1'), phone('Till 2')])).toBe('Till 3');
  });

  it('fills a gap, and counts a renamed phone as gone from the numbers', () => {
    expect(nextTillName([phone('Till 1'), phone('Till 3')])).toBe('Till 2');
    expect(nextTillName([phone('Front'), phone('Till 2')])).toBe('Till 1');
  });
});

describe('nameProblem', () => {
  const phones = [phone('Till 1'), phone('Front')];

  it('passes a name of 1 to 24 characters no listed phone has, trimmed as cardd trims it', () => {
    expect(nameProblem('Till 2', phones)).toEqual({ ok: true, line: '' });
    expect(nameProblem('  Back room  ', phones)).toEqual({ ok: true, line: '' });
    expect(nameProblem('x'.repeat(24), phones)).toEqual({ ok: true, line: '' });
    // 24 characters, not 24 UTF-16 units.
    expect(nameProblem('🙂'.repeat(24), phones).ok).toBe(true);
  });

  it('stops an empty name with no line, and says why of one too long or taken', () => {
    expect(nameProblem('', phones)).toEqual({ ok: false, line: '' });
    expect(nameProblem('   ', phones)).toEqual({ ok: false, line: '' });
    expect(nameProblem('x'.repeat(25), phones)).toEqual({ ok: false, line: 'A name is up to 24 characters.' });
    expect(nameProblem(' Till 1 ', phones)).toEqual({ ok: false, line: 'Another PoS phone has this name.' });
  });

  it("lets a phone keep its own name: a rename to the same isn't taken", () => {
    expect(nameProblem('Till 1', phones, phones[0].keyId)).toEqual({ ok: true, line: '' });
    expect(nameProblem('Front', phones, phones[0].keyId).ok).toBe(false);
  });
});

describe('restoreNote', () => {
  const RESTORED = at(1, 12, 0);
  const before = phone('Till 1', { created: at(10, 9, 12) });
  const after = phone('Till 2', { created: at(0, 9, 0) });

  it('shows after a restore while a listed phone is older than it and this phone has not said it checked', () => {
    expect(restoreNote({ phones: [before, after], restored: RESTORED }, null)).toBe(true);
  });

  it('stays away with no restore, with phones all newer than it, and once checked', () => {
    expect(restoreNote({ phones: [before] }, null)).toBe(false);
    expect(restoreNote({ phones: [after], restored: RESTORED }, null)).toBe(false);
    expect(restoreNote({ phones: [], restored: RESTORED }, null)).toBe(false);
    expect(restoreNote({ phones: [before], restored: RESTORED }, RESTORED)).toBe(false);
  });

  it('comes back for a later restore', () => {
    expect(restoreNote({ phones: [before], restored: RESTORED + 3600 }, RESTORED)).toBe(true);
  });
});

describe('pairLink and codeLine', () => {
  it("makes Karto PoS's pairing link of the server and the code", () => {
    expect(pairLink('vm-1001.lnvps.cloud', '0123456789abcdef0123456789abcdef')).toBe('kartopos://pair?host=vm-1001.lnvps.cloud&code=0123456789abcdef0123456789abcdef');
  });

  it('says who the code waits for and how long it is good', () => {
    expect(codeLine('Till 3', NOW + 588, NOW)).toBe('Waiting for Till 3 · good for 9:48, one phone');
    expect(codeLine('Till 3', NOW + 9, NOW)).toBe('Waiting for Till 3 · good for 0:09, one phone');
    expect(codeLine('Till 3', NOW - 5, NOW)).toBe('Waiting for Till 3 · good for 0:00, one phone');
  });
});

describe('addStep', () => {
  const start = ADD_START('Till 3');
  const run = (s: AddState, ...events: Parameters<typeof addStep>[1][]) => events.reduce((acc, e) => addStep(acc.state!, e), { state: s as AddState | null, drop: false });
  const CODE = { kind: 'code', ask: 1, code: 'ab'.repeat(16), expires: NOW + 600 } as const;
  const atCode = run(start, { kind: 'asked' }, CODE).state!;

  it('starts at Name with the next till name, nothing asked', () => {
    expect(start).toEqual({ at: 'name', name: 'Till 3', error: '', asking: false, code: '', expires: 0, ask: 0 });
  });

  it('takes what is typed, and clears the last refusal', () => {
    const refused = run(start, { kind: 'asked' }, { kind: 'refused', ask: 1, text: 'Another PoS phone has this name.' }).state!;
    expect(refused).toMatchObject({ at: 'name', asking: false, error: 'Another PoS phone has this name.' });
    expect(addStep(refused, { kind: 'typed', name: 'Back' }).state).toMatchObject({ at: 'name', name: 'Back', error: '' });
  });

  it('asks for a code under the trimmed name, and shows it when it comes', () => {
    const asking = addStep({ ...start, name: '  Till 3 ' }, { kind: 'asked' }).state!;
    expect(asking).toMatchObject({ at: 'name', name: 'Till 3', asking: true });
    expect(addStep(asking, CODE)).toEqual({ state: { at: 'code', name: 'Till 3', error: '', asking: false, code: 'ab'.repeat(16), expires: NOW + 600, ask: 1 }, drop: false });
    // Nothing typed, and no second ask, while the first is on its way.
    expect(addStep(asking, { kind: 'typed', name: 'x' }).state).toBe(asking);
    expect(addStep(asking, { kind: 'asked' }).state).toBe(asking);
  });

  it('is paired once a phone of the name is listed, and not before', () => {
    expect(addStep(atCode, { kind: 'phones', phones: [phone('Till 1')] }).state).toBe(atCode);
    expect(addStep(atCode, { kind: 'phones', phones: [phone('Till 1'), phone('Till 3')] }).state).toMatchObject({ at: 'paired', name: 'Till 3', code: '' });
    // A phone listed before any code was asked for isn't this pairing.
    expect(addStep(start, { kind: 'phones', phones: [phone('Till 3')] }).state).toBe(start);
  });

  it('runs out once its last second has passed, forgets the code, and takes a new one', () => {
    // cardd takes the code through the second it expires in, so the screen shows it that long.
    expect(addStep(atCode, { kind: 'tick', nowS: NOW + 600 }).state).toBe(atCode);
    const out = addStep(atCode, { kind: 'tick', nowS: NOW + 601 }).state!;
    expect(out).toMatchObject({ at: 'ran-out', name: 'Till 3', code: '', asking: false });
    // The phone that scanned in the code's last second is still found: the screen reads the phones again, twice.
    expect(addStep(out, { kind: 'phones', phones: [phone('Till 3')] }).state).toMatchObject({ at: 'paired' });
    const again = run(out, { kind: 'asked' }, { kind: 'code', ask: 2, code: 'cd'.repeat(16), expires: NOW + 1200 }).state!;
    expect(again).toMatchObject({ at: 'code', code: 'cd'.repeat(16), expires: NOW + 1200 });
    expect(run(out, { kind: 'asked' }, { kind: 'refused', ask: 2, text: "Can't reach your server." }).state).toMatchObject({ at: 'ran-out', error: "Can't reach your server.", asking: false });
  });

  it('has a code that nothing waits for dropped: it was never shown, and would stay open', () => {
    // Back from the run-out screen while a new code was on its way: at Name, asking nothing.
    const out = addStep(atCode, { kind: 'tick', nowS: NOW + 601 }).state!;
    const back = run(out, { kind: 'asked' }, { kind: 'back' }).state!;
    expect(back).toMatchObject({ at: 'name', asking: false, ask: 2 });
    expect(addStep(back, { kind: 'code', ask: 2, code: 'cd'.repeat(16), expires: NOW + 1200 })).toEqual({ state: back, drop: true });
    // Its refusal, as late, changes nothing.
    expect(addStep(back, { kind: 'refused', ask: 2, text: 'late' })).toEqual({ state: back, drop: false });
  });

  it("leaves a late code alone when a newer one is wanted or showing: cardd replaced it, and a drop would take the newer", () => {
    const out = addStep(atCode, { kind: 'tick', nowS: NOW + 601 }).state!;
    // New code, Back, Continue: the third ask is on its way when the second's answer lands.
    const asking = run(out, { kind: 'asked' }, { kind: 'back' }, { kind: 'asked' }).state!;
    expect(asking).toMatchObject({ at: 'name', asking: true, ask: 3 });
    const late = { kind: 'code', ask: 2, code: 'cd'.repeat(16), expires: NOW + 1200 } as const;
    expect(addStep(asking, late)).toEqual({ state: asking, drop: false });
    expect(addStep(asking, { kind: 'refused', ask: 2, text: 'late' }).state).toBe(asking);
    const shown = addStep(asking, { kind: 'code', ask: 3, code: 'ef'.repeat(16), expires: NOW + 1300 }).state!;
    expect(shown).toMatchObject({ at: 'code', code: 'ef'.repeat(16) });
    expect(addStep(shown, late)).toEqual({ state: shown, drop: false });
  });

  it('goes back from Code to Name and has the code dropped; from Name, and from the result, it leaves', () => {
    expect(addStep(atCode, { kind: 'back' })).toEqual({ state: { at: 'name', name: 'Till 3', error: '', asking: false, code: '', expires: 0, ask: 1 }, drop: true });
    const out = addStep(atCode, { kind: 'tick', nowS: NOW + 601 }).state!;
    expect(addStep(out, { kind: 'back' })).toMatchObject({ state: { at: 'name', name: 'Till 3' }, drop: false });
    expect(addStep(start, { kind: 'back' })).toEqual({ state: null, drop: false });
    const paired = addStep(atCode, { kind: 'phones', phones: [phone('Till 3')] }).state!;
    expect(addStep(paired, { kind: 'back' })).toEqual({ state: null, drop: false });
  });

  it('drops a code that comes after the person went back, and ignores what no longer applies', () => {
    // Back while the code was on its way leaves the screen: the code, never shown, is dropped all the same.
    const asking = addStep(start, { kind: 'asked' }).state!;
    expect(addStep(asking, { kind: 'back' })).toEqual({ state: null, drop: true });
    expect(addStep(atCode, { kind: 'typed', name: 'x' }).state).toBe(atCode);
    expect(addStep(start, { kind: 'tick', nowS: NOW + 9999 }).state).toBe(start);
    // A code no one asked for: dropped, never shown.
    expect(addStep(start, CODE)).toEqual({ state: start, drop: true });
  });
});

describe('pairedView', () => {
  it("is the result page's green tick, with what to do if the other phone says otherwise", () => {
    expect(pairedView('Till 3')).toEqual({
      tone: 'ok', mark: 'check', title: 'Till 3 is paired',
      line: 'It can take payments into Shop now. Remove it at any time under PoS phones.',
      note: "If the other phone says the code didn't work, something else used it: remove Till 3 under PoS phones.",
    });
  });
});

describe('posError', () => {
  it("says cardd's refusals of a name plainly, and a server not yet updated", () => {
    expect(posError(new CarddError(409, 'name_taken', 'store: a PoS phone already has this name'))).toBe('Another PoS phone has this name.');
    expect(posError(new CarddError(400, 'bad_name', "store: a PoS phone's name is 1 to 24 characters"))).toBe('A name is 1 to 24 characters.');
    expect(posError(new CarddError(404, 'not_found', 'store: not found'))).toBe('That PoS phone is no longer in the list.');
    expect(posError(new CarddError(404, 'bad_response', 'POST /api/v1/shop/codes → HTTP 404: 404 page not found'))).toBe(UPDATE_FIRST);
    expect(UPDATE_FIRST).toBe('Update your server to use the point of sale.');
  });

  it('says anything else as the money screens do', () => {
    expect(posError(new Error('fetch failed: no answer from vm-1001.lnvps.cloud in 30 s'))).toBe("Can't reach your server.");
    expect(posError(new CarddError(500, 'internal', 'boom'))).toBe('The server refused: boom');
  });
});

// The pages themselves, not only the row that opens them: a link (karto://pos-add) reaches a page whatever Settings shows.
describe('posGate', () => {
  it("stops the shop's pages on a server that may not be the person's, in the notice's own words", () => {
    expect(posGate({ keyNotice: { kind: 'mismatch', text: "This server's SSH key isn't the one LNVPS published. Stop using it." } })).toEqual({
      stopped: "This server's SSH key isn't the one LNVPS published. Stop using it.",
    });
  });

  it('opens them on any other server', () => {
    for (const kind of ['ok', 'pending', 'overdue']) expect(posGate({ keyNotice: { kind, text: 'x' } })).toBe('open');
  });

  // A link can open a page before the watch has read the saved server: not knowing is not a yes.
  it('has them wait until the server is known', () => {
    expect(posGate(null)).toBe('wait');
  });
});
