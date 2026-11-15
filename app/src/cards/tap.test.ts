import { describe, expect, it } from 'vitest';
import { CardError, TagLostError } from '../ntag424/apdu';
import type { TapCheck } from './check';
import type { Identity } from './identify';
import { readTap, tapOpens, tapSheet, tapWaits, type TapIo } from './tap';

const ours: Identity = { kind: 'ours', id: 'c1', read: null, serverDown: false, needsRepoint: false };
const passed: TapCheck = { ok: false, reason: 'already used' };

/** The tap's I/O, each step letting go of the claim first when asked to. */
function io(opts: { releaseOn?: 'identify' | 'check'; fail?: Error } = {}) {
  let held = true;
  const calls: string[] = [];
  const t: TapIo = {
    identify: async () => {
      calls.push('identify');
      if (opts.releaseOn === 'identify') held = false;
      if (opts.fail) throw opts.fail;
      return ours;
    },
    checkTap: async () => {
      calls.push('check');
      if (opts.releaseOn === 'check') held = false;
      return passed;
    },
    held: () => held,
  };
  return { t, calls };
}

describe('readTap', () => {
  it('reads and checks one of the person’s cards while a screen still holds the claim', async () => {
    const { t, calls } = io();
    expect(await readTap(t)).toEqual({ identity: ours, check: passed });
    expect(calls).toEqual(['identify', 'check']);
  });

  it('drops a tap whose claim was let go while the card was read, and checks nothing with cardd', async () => {
    const { t, calls } = io({ releaseOn: 'identify' });
    expect(await readTap(t)).toBeNull();
    expect(calls).toEqual(['identify']);
  });

  it('drops a tap whose claim was let go while cardd checked it', async () => {
    const { t } = io({ releaseOn: 'check' });
    expect(await readTap(t)).toBeNull();
  });

  it('says why a card could not be read while the claim is held', async () => {
    const { t } = io({ fail: new CardError('ReadData', 0x91ae) });
    const tap = await readTap(t);
    expect(tap && 'error' in tap && tap.error.length).toBeGreaterThan(0);
    expect(tap).toMatchObject({ lost: false });
  });

  it('says when the read failed because the card moved away', async () => {
    const { t } = io({ fail: new TagLostError() });
    expect(await readTap(t)).toEqual({ error: 'The card moved away. Hold it again to carry on.', lost: true });
  });

  it('says nothing about a failed read once the claim was let go', async () => {
    const { t } = io({ releaseOn: 'identify', fail: new CardError('ReadData', 0x91ae) });
    expect(await readTap(t)).toBeNull();
  });
});

// The iPhone's way: Read a card on the Wallet.
describe('tapSheet', () => {
  const TOP = 'against the top of the back of the phone';
  const known = { state: 'active' as const, version: 0, name: 'Daily' };
  it('opens the sheet from the button, for any card', () => {
    expect(tapSheet({ on: 'press' })).toEqual({ call: 'open', line: `Hold any card ${TOP}.` });
  });
  it('says the card is being read once one arrives', () => {
    expect(tapSheet({ on: 'card' })).toEqual({ call: 'say', line: 'Reading the card…' });
  });
  it('ends with the tick and the card\'s name for one of the person\'s cards', () => {
    expect(tapSheet({ on: 'read', tap: { identity: { ...ours, known }, check: passed } })).toEqual({ call: 'done', line: 'Daily' });
    expect(tapSheet({ on: 'read', tap: { identity: ours, check: passed } })).toEqual({ call: 'done', line: 'Your card' });
  });
  it('ends with the tick and what the card is for any other card that was read', () => {
    const blank: Identity = { kind: 'blank', read: null, serverDown: false, needsRepoint: false };
    const foreign: Identity = { kind: 'foreign', read: null, serverDown: false, needsRepoint: false };
    expect(tapSheet({ on: 'read', tap: { identity: blank, check: null } })).toEqual({ call: 'done', line: 'A blank card' });
    expect(tapSheet({ on: 'read', tap: { identity: foreign, check: null } })).toEqual({ call: 'done', line: 'A card from another service' });
  });
  it('keeps the sheet and looks again when the card moved away', () => {
    expect(tapSheet({ on: 'read', tap: { error: 'The card moved away. Hold it again to carry on.', lost: true } })).toEqual({ call: 'again', line: `The card moved away. Hold it ${TOP} again.` });
  });
  it('closes the sheet with the reason for any other error', () => {
    expect(tapSheet({ on: 'read', tap: { error: 'The card refused: ReadData', lost: false } })).toEqual({ call: 'fail', line: 'The card refused: ReadData' });
  });
  it('closes the sheet for a card let go unread, or a read no one wants any more', () => {
    expect(tapSheet({ on: 'read', tap: null })).toEqual({ call: 'close' });
  });
});

describe('tapWaits', () => {
  it('lets a card be read with no sheet open, or over a read error that asks to hold it again', () => {
    expect(tapWaits(null)).toBe(false);
    expect(tapWaits({ error: 'The card moved away. Hold it again to carry on.', lost: true })).toBe(false);
  });

  it('keeps a card’s sheet until the person closes it', () => {
    expect(tapWaits({ identity: ours, check: passed })).toBe(true);
  });
});

describe('tapOpens', () => {
  const known = { state: 'active' as const, version: 1, name: 'Daily' };
  const ready: Identity = { ...ours, version: 1, known };

  it("opens the account page of one of the person's ready cards, active or frozen", () => {
    expect(tapOpens(ready)).toBe('account');
    expect(tapOpens({ ...ready, known: { ...known, state: 'frozen' } })).toBe('account');
  });

  it('opens the tap sheet for one that needs a re-point', () => {
    expect(tapOpens({ ...ready, needsRepoint: true })).toBe('sheet');
  });

  it("opens the tap sheet while the server can't be reached (what it knows is the phone's cache)", () => {
    expect(tapOpens({ ...ready, serverDown: true })).toBe('sheet');
  });

  it('opens the tap sheet for every other kind of card', () => {
    for (const kind of ['blank', 'half-added', 'half-wiped', 'unknown-ours', 'foreign', 'not-a-card'] as const) {
      expect(tapOpens({ ...ready, kind })).toBe('sheet');
    }
  });

  // A phone that is one of the person's ready cards is a ready card.
  it("opens the account page of one of the person's ready cards that was read as a plain tag", () => {
    expect(tapOpens({ ...ready, read: null, plain: true, sun: { p: '0'.repeat(32), c: '0'.repeat(16) } })).toBe('account');
    expect(tapOpens({ ...ready, read: null, plain: true, kind: 'unknown-ours', known: undefined })).toBe('sheet');
  });

  it('opens the tap sheet when the card has no id or cardd lists it in no ready state', () => {
    expect(tapOpens({ ...ready, id: undefined })).toBe('sheet');
    expect(tapOpens({ ...ready, known: undefined })).toBe('sheet');
    expect(tapOpens({ ...ready, known: { ...known, state: 'programming' } })).toBe('sheet');
  });
});
