import { describe, expect, it } from 'vitest';
import { CarddError } from '../cardd/client';
import { CardError, TagLostError } from '../ntag424/apdu';
import { ACTION_LABELS, cardsLine, describeError, feeCreditText, listError, lnurlEncode, lnurlFor, pausedText, satText, sheetFor, tapCheckText } from './labels';
import { CardFlowError } from './deps';
import type { Identity } from './identify';
import type { CardRead } from './read';
import { WrongCardError } from './wipe';

const base = { read: null, serverDown: false, needsRepoint: false };

describe('labels', () => {
  // One shape for every card held to the phone: one line, one button, Wipe as a row, the version small.
  const known = { state: 'active' as const, version: 2, name: 'Daily' };
  const all = { versions: [1, 1, 1, 1, 1] } as CardRead;

  it('offers a blank card the one thing that fits it', () => {
    expect(sheetFor({ ...base, kind: 'blank' } as Identity)).toEqual({
      face: 'outline', title: 'A blank card', body: "It can be added to your server. You'll give it a name, then hold it once more.", main: 'add', wipe: false,
    });
  });

  it('finishes a card part-way through being added, or wipes it; and only finishes a wipe', () => {
    expect(sheetFor({ ...base, kind: 'half-added', known } as Identity)).toEqual({
      face: 'none', title: 'Daily, part-way through being added', body: 'Finish setting it up, or wipe it.', main: 'finish-add', wipe: true,
    });
    expect(sheetFor({ ...base, kind: 'half-added' } as Identity).title).toBe('A card part-way through being added');
    expect(sheetFor({ ...base, kind: 'half-wiped', known } as Identity)).toEqual({
      face: 'none', title: 'Daily, part-way through a wipe', body: 'Finish the wipe to make it blank again.', main: 'finish-wipe', wipe: false,
    });
  });

  // The cards to re-point must stand out.
  it("re-points one of the person's cards that still points at another server, its state and version small", () => {
    expect(sheetFor({ ...base, kind: 'ours', known, version: 2, needsRepoint: true } as Identity)).toEqual({
      face: 'card', title: 'Daily', warning: 'This card still points at another server. Re-point it to pay through this one.', main: 'repoint', wipe: true, foot: 'Active · card version 2',
    });
    expect(sheetFor({ ...base, kind: 'ours', known: { ...known, name: '' }, version: 2, needsRepoint: true } as Identity).title).toBe('Your card');
  });

  it('offers no re-point while the server is out of reach: the hold screen refused it at once', () => {
    const frozen = { ...known, state: 'frozen' as const };
    expect(sheetFor({ ...base, kind: 'ours', known: frozen, version: 3, serverDown: true } as Identity)).toEqual({
      face: 'card', title: 'Daily', body: "Your server can't be reached, so this is what the phone remembers.", wipe: true, foot: 'Frozen · card version 3',
    });
    const s = sheetFor({ ...base, kind: 'ours', known, version: 2, serverDown: true, needsRepoint: true } as Identity);
    expect(s.main).toBeUndefined();
    expect(s.warning).toBe('This card still points at another server. Re-point it once your server can be reached.');
  });

  it("adds back a card the server doesn't know, or only wipes it when its keys are part-way through a wipe", () => {
    expect(sheetFor({ ...base, kind: 'unknown-ours', version: 3, read: all } as Identity)).toEqual({
      face: 'none', title: "One of your cards, but your server doesn't know it",
      body: 'It was set up with your recovery phrase. Add it back to this server, or wipe it.', main: 'adopt', wipe: true, foot: 'Card version 3',
    });
    // Keys part-way through a wipe: cardd couldn't verify its tap, so only the wipe fits.
    const partWiped = { versions: [1, 0, 0, 1, 1] } as CardRead;
    expect(sheetFor({ ...base, kind: 'unknown-ours', read: partWiped } as Identity)).toEqual({
      face: 'none', title: "One of your cards, but your server doesn't know it",
      body: 'It was set up with your recovery phrase. Wipe it to add it again.', wipe: true, foot: 'Card version unknown',
    });
  });

  it("says only what another service's card is", () => {
    expect(sheetFor({ ...base, kind: 'foreign' } as Identity)).toEqual({ face: 'none', title: 'A card from another service', body: "Karto Wallet can't use it, and won't change it.", wipe: false });
  });

  // A tag read as a plain one is shown, and never changed.
  describe('a tag that is not an NTAG 424', () => {
    const plain = { ...base, plain: true as const };
    const phone = Uint8Array.of(0x00, 1, 2, 3, 4, 5, 6);
    const chip = Uint8Array.of(0x04, 1, 2, 3, 4, 5, 6);

    it("shows one of the person's as a card, with nothing to wipe or re-point, and says when it is a phone", () => {
      expect(sheetFor({ ...plain, kind: 'ours', known, version: 0, uid: phone } as Identity)).toEqual({ face: 'card', title: 'Daily', wipe: false, foot: 'Active · a phone' });
      expect(sheetFor({ ...plain, kind: 'ours', known: { ...known, state: 'frozen' }, version: 0, uid: phone, serverDown: true } as Identity)).toEqual({
        face: 'card', title: 'Daily', body: "Your server can't be reached, so this is what the phone remembers.", wipe: false, foot: 'Frozen · a phone',
      });
      expect(sheetFor({ ...plain, kind: 'ours', known, version: 2, uid: chip } as Identity)).toEqual({ face: 'card', title: 'Daily', wipe: false, foot: 'Active · card version 2' });
    });

    it("says a card of the person's that the server doesn't list can't pay, and offers nothing", () => {
      const body = "Your server doesn't list it, so it can't pay.";
      expect(sheetFor({ ...plain, kind: 'unknown-ours', version: 0, uid: phone } as Identity)).toEqual({ face: 'none', title: 'A phone that was one of your cards', body, wipe: false });
      expect(sheetFor({ ...plain, kind: 'unknown-ours', version: 1, uid: chip } as Identity)).toEqual({ face: 'none', title: "One of your cards that this wallet can't change", body, wipe: false });
    });

    it("says another service's card as it always did, and a tag that is no Bolt Card in words of its own", () => {
      expect(sheetFor({ ...plain, kind: 'foreign' } as Identity)).toEqual({ face: 'none', title: 'A card from another service', body: "Karto Wallet can't use it, and won't change it.", wipe: false });
      expect(sheetFor({ ...plain, kind: 'not-a-card' } as Identity)).toEqual({ face: 'none', title: 'Not a Bolt Card', body: 'Karto Wallet found nothing on it that it can read.', wipe: false });
    });
  });

  it('names each button, and has none called Wipe: that is the red row', () => {
    expect(ACTION_LABELS).toEqual({ add: 'Add card', 'finish-add': 'Finish setup', 'finish-wipe': 'Finish wipe', repoint: 'Re-point', adopt: 'Add back to this server' });
  });

  it('says whether holding the card again carries on', () => {
    expect(describeError(new TagLostError())).toEqual({ text: 'The card moved away. Hold it again to carry on.', again: true });
    expect(describeError(new TypeError('fetch failed: no answer'))).toEqual({ text: "Can't reach your server. Hold the card again once it's back.", again: true });
    expect(describeError(new CardFlowError('This card is already blank.'))).toEqual({ text: 'This card is already blank.', again: false });
    expect(describeError(new CardError('ChangeKey', 0x91ae))).toEqual({ text: 'The card refused: ChangeKey: the card answered 91AE (authentication error)', again: false });
    expect(describeError(new CarddError(409, 'conflict', 'store: conflicting state'))).toEqual({ text: 'Your server refused: store: conflicting state', again: false });
    // The wrong card for a wipe is a refusal in its own words; holding that card again changes nothing.
    expect(describeError(new WrongCardError('Kids', 'Daily'))).toEqual({ text: 'This is Kids, not Daily. Hold Daily to wipe it.', again: false });
  });
});

describe('listError', () => {
  // The card list on the server page: only a network failure means "showing what the phone remembers".
  it('says the server is out of reach only for a network failure', () => {
    expect(listError(new TypeError('fetch failed: no answer'))).toBe("Can't reach your server, so this is what the phone remembers. Adding a card needs the server.");
  });
  it('shows what the server said when it answered', () => {
    expect(listError(new CarddError(404, 'http', 'HTTP 404'))).toBe("Your server couldn't list the cards: HTTP 404");
  });
  it('shows any other failure as itself', () => {
    expect(listError(new Error('database is locked'))).toBe("Couldn't load your cards: database is locked");
  });
});

describe('cardsLine', () => {
  const down = listError(new TypeError('fetch failed: no answer'));
  // The wallet's red "Can't reach your server" banner already says it: the line under it doesn't say it again.
  it('is muted under the red unreachable banner when the list failed for the same reason', () => {
    expect(cardsLine(down, true)).toEqual({ text: 'These are the cards this phone remembers. Adding a card needs the server.', muted: true });
  });
  it('stays red without the banner (an update running, or the status answered)', () => {
    expect(cardsLine(down, false)).toEqual({ text: down, muted: false });
  });
  it('stays red when cardd refused the list, or Set the books, whatever the banner', () => {
    const refused = listError(new CarddError(500, 'http', 'HTTP 500'));
    expect(cardsLine(refused, true)).toEqual({ text: refused, muted: false });
    expect(cardsLine(refused, false)).toEqual({ text: refused, muted: false });
    expect(cardsLine("Couldn't set the books: HTTP 409", true)).toEqual({ text: "Couldn't set the books: HTTP 409", muted: false });
  });
  it('is nothing when the list loaded', () => {
    expect(cardsLine(null, true)).toBeNull();
  });
});

describe('tapCheckText', () => {
  // The same words on the tap sheet and on the card's account page.
  it("says the server checked the tap, with the card's tap number, or why not", () => {
    const card = { id: 'c1', version: 1, state: 'active', counter: 42, name: 'Daily', created: 1, updated: 1, host: 'h' } as const;
    expect(tapCheckText({ ok: true, card })).toBe('✓ Your server checked this tap (tap 42).');
    expect(tapCheckText({ ok: false, reason: 'This tap was seen before: the card may have been copied.' })).toBe('✗ This tap was seen before: the card may have been copied.');
  });
});

describe('satText', () => {
  it('shows whole sats with thousands separators, rounding msat down', () => {
    expect(satText(5_012_345)).toBe('5,012 sat');
    expect(satText(999)).toBe('0 sat');
    expect(satText(21_411_000_000)).toBe('21,411,000 sat');
  });
});

describe('feeCreditText', () => {
  it('says what fee credit is, and nothing when there is none', () => {
    expect(feeCreditText(2_000)).toBe("Fee credit: 2,000 sat (not spendable; it pays toward the server's first channel)");
    expect(feeCreditText(0)).toBe('');
    const GBP = { currency: 'GBP' as const, price: 61_352, time: 1_792_037_404 };
    expect(feeCreditText(2_000, 'fiat', GBP)).toBe("Fee credit: £1.23 (not spendable; it pays toward the server's first channel)");
    expect(feeCreditText(2_000, 'hidden', GBP)).toBe("Fee credit: *** (not spendable; it pays toward the server's first channel)");
  });
});

describe('pausedText', () => {
  it('says spending is paused and why', () => {
    expect(pausedText('not checked yet')).toBe("Spending is paused: the server's books and its Lightning balance don't agree (not checked yet).");
  });
});

describe('lnurlFor', () => {
  it('encodes a URL as LUD-01 bech32 (the spec\'s own example)', () => {
    expect(lnurlEncode('https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df')).toBe(
      'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS',
    );
  });

  it('turns a Lightning address into its lnurlp URL, encoded', () => {
    expect(lnurlFor('ce07ce1279d@vm-1009.lnvps.cloud')).toBe(lnurlEncode('https://vm-1009.lnvps.cloud/.well-known/lnurlp/ce07ce1279d'));
    expect(lnurlFor('ce07ce1279d@vm-1009.lnvps.cloud')).toMatch(/^LNURL1[02-9AC-HJ-NP-Z]+$/);
  });
});
