import { describe, expect, it } from 'vitest';
import type { Tx } from '../cardd/client';
import { newerOnTop, newestId, received, receivedWords } from './topUp';

const tx = (id: number, kind = 'topup', amountMsat = 1_000_000): Tx => ({ id, kind, note: '', amountMsat, feeMsat: 0, created: 1_790_000_000 + id });
const ids = (txs: Tx[]) => txs.map((t) => t.id);

describe('newerOnTop', () => {
  it('puts the rows of an answer that are newer than the newest shown on top, and keeps everything shown', () => {
    const shown = [tx(7), tx(5), tx(2)];
    expect(ids(newerOnTop(shown, [tx(9), tx(8), tx(7), tx(5)], 50))).toEqual([9, 8, 7, 5, 2]);
  });

  it('loses no row between pages after Load more: the pages under the first stay where they are', () => {
    // Two pages of 3 shown (Load more asked before id 4); the held answer is a new first page of 3.
    const shown = [tx(6), tx(5), tx(4), tx(3), tx(2), tx(1)];
    expect(ids(newerOnTop(shown, [tx(7), tx(6), tx(5)], 3))).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it('is the list shown itself when the answer has nothing newer', () => {
    const shown = [tx(7), tx(5)];
    expect(newerOnTop(shown, [tx(7), tx(5)], 50)).toBe(shown);
    expect(newerOnTop(shown, [], 50)).toBe(shown);
  });

  it('is the first rows of a history that had none', () => {
    expect(ids(newerOnTop([], [tx(3), tx(1)], 50))).toEqual([3, 1]);
  });

  it('starts over from a whole page of newer rows: what lies between it and the rows shown was never read', () => {
    const shown = [tx(2), tx(1)];
    expect(ids(newerOnTop(shown, [tx(9), tx(8), tx(7)], 3))).toEqual([9, 8, 7]);
  });
});

describe('received', () => {
  it('is the newest top-up newer than the history was when the sheet opened', () => {
    const txs = [tx(9), tx(8, 'move'), tx(7), tx(5)];
    expect(received(txs, 5)?.id).toBe(9);
    expect(received(txs, 8)?.id).toBe(9);
    expect(received(txs, 9)).toBeNull();
  });

  it('is none before the history has answered: an old top-up in the first answer is not one just received', () => {
    expect(received([tx(9), tx(7)], null)).toBeNull();
    // The baseline is then that first answer's newest: nothing in it counts.
    expect(received([tx(9), tx(7)], newestId([tx(9), tx(7)]))).toBeNull();
  });

  it('is not a move onto the account, a sale, or anything else that is no top-up', () => {
    expect(received([tx(9, 'move'), tx(8, 'sale'), tx(7, 'wipe')], 5)).toBeNull();
  });

  it('is a top-up the books credited nothing of', () => {
    expect(received([tx(9, 'topup', 0)], 5)?.amountMsat).toBe(0);
  });
});

describe('newestId', () => {
  it('is 0 for a history with nothing in it', () => {
    expect([newestId([]), newestId([tx(4), tx(9), tx(2)])]).toEqual([0, 9]);
  });
});

describe('receivedWords', () => {
  const at = { nowS: 1_790_000_600, offsetMin: 0 };
  it('says the amount the books credited, where it went and when, and what is available once the wallet has it', () => {
    const t = { ...tx(9, 'topup', 3_000_000), created: 1_790_000_520 };
    expect(receivedWords(t, { name: 'Pool', ...at, availableMsat: 7_120_000 })).toEqual({
      title: 'Received 3,000 sat',
      line: 'Into Pool · today at 14:22\n7,120 sat available',
      label: 'Received 3,000 sat, into Pool.',
    });
    expect(receivedWords(t, { name: 'Daily', ...at, availableMsat: null }).line).toBe('Into Daily · today at 14:22');
  });

  it('says the amount and what is available to the nearest whole sat in sat view, and exactly in msat', () => {
    const t = { ...tx(9, 'topup', 99_600), created: 1_790_000_520 };
    expect(receivedWords(t, { name: 'Pool', ...at, availableMsat: 932_496 })).toMatchObject({
      title: 'Received 100 sat',
      line: 'Into Pool · today at 14:22\n932 sat available',
    });
    expect(receivedWords(t, { name: 'Pool', ...at, availableMsat: 932_496, view: 'msat', rated: null })).toMatchObject({
      title: 'Received 99,600 msat',
      line: 'Into Pool · today at 14:22\n932,496 msat available',
    });
  });

  // The sheet is on an account's page, so it follows the view, *** included.
  it('says the top-up in pounds, or hides it', () => {
    const GBP = { currency: 'GBP' as const, price: 61_352, time: 1_792_037_404 };
    const t = { ...tx(9, 'topup', 3_000_000), feeMsat: 4_084, created: 1_790_000_520 };
    expect(receivedWords(t, { name: 'Pool', ...at, availableMsat: 7_120_000, channelBefore: true, view: 'fiat', rated: GBP })).toEqual({
      title: 'Received £1.84',
      line: "Into Pool · today at 14:22\n£4.37 available\nUnder £0.01 went to ACINQ for more room in your server's Lightning channel.",
      label: "Received 1 pound 84 at today's rate, into Pool. Under £0.01 went to ACINQ for more room in your server's Lightning channel.",
    });
    const hidden = receivedWords(t, { name: 'Pool', ...at, availableMsat: 7_120_000, view: 'hidden', rated: GBP });
    expect(hidden.title).toBe('Received ***');
    // A screen reader is told the amount is hidden, not the asterisks.
    expect(hidden.label).toMatch(/^Received amount hidden, into Pool\./);
  });

  it('says what went to ACINQ for the channel: the first one, paid once, or more room', () => {
    const t = { ...tx(9, 'topup', 7_673_000), feeMsat: 22_327_000, created: 1_790_000_520 };
    expect(receivedWords(t, { name: 'Pool', ...at, availableMsat: 7_673_000, channelBefore: false })).toEqual({
      title: 'Received 7,673 sat',
      line: "Into Pool · today at 14:22\n7,673 sat available\n22,327 sat went to ACINQ to open your server's Lightning channel. That is paid once.",
      label: "Received 7,673 sat, into Pool. 22,327 sat went to ACINQ to open your server's Lightning channel. That is paid once.",
    });
    const more = "Into Pool · today at 14:22\n22,327 sat went to ACINQ for more room in your server's Lightning channel.";
    expect(receivedWords(t, { name: 'Pool', ...at, availableMsat: null, channelBefore: true }).line).toBe(more);
    expect(receivedWords(t, { name: 'Pool', ...at, availableMsat: null, channelBefore: null }).line).toBe(more);
    expect(receivedWords(t, { name: 'Pool', ...at, availableMsat: null }).line).toBe(more);
    expect(receivedWords({ ...t, feeMsat: 4_084 }, { name: 'Pool', ...at, availableMsat: null, channelBefore: true }).line).toBe(
      "Into Pool · today at 14:22\nUnder 5 sat went to ACINQ for more room in your server's Lightning channel.",
    );
  });

  it('says a top-up that added nothing and paid for the channel as that, not as fee credit', () => {
    const t = { ...tx(9, 'topup', 0), feeMsat: 22_327_000 };
    const opened = "Nothing was added to Pool: this payment and your earlier fee credit went to ACINQ to open your server's Lightning channel (22,327 sat in all).";
    expect(receivedWords(t, { name: 'Pool', ...at, availableMsat: 0, channelBefore: false })).toEqual({ title: 'Received', line: opened, label: `Received. ${opened}` });
    expect(receivedWords(t, { name: 'Pool', ...at, availableMsat: 0, channelBefore: true }).line).toBe(
      "Nothing was added to Pool: this payment and your earlier fee credit went to ACINQ for more room in your server's Lightning channel (22,327 sat in all).",
    );
  });

  it('says where a top-up went that added nothing', () => {
    const t = tx(9, 'topup', 0);
    expect(receivedWords(t, { name: 'Pool', ...at, availableMsat: 0 })).toEqual({
      title: 'Received',
      line: "It went to phoenixd's fee credit, toward receiving room. Nothing was added to Pool.",
      label: "Received. It went to phoenixd's fee credit, toward receiving room. Nothing was added to Pool.",
    });
  });

  // The payer's note, in quotes, after where and when; read after the amount.
  it("says the payer's note", () => {
    const t = { ...tx(9, 'topup', 5_000_000), created: 1_790_000_520, payerNote: 'float for Saturday' };
    expect(receivedWords(t, { name: 'Pool', ...at, availableMsat: 7_120_000 })).toEqual({
      title: 'Received 5,000 sat',
      line: 'Into Pool · today at 14:22\n“float for Saturday”\n7,120 sat available',
      label: 'Received 5,000 sat, into Pool. Note from the payer, float for Saturday.',
    });
    const fee = { ...t, feeMsat: 2_000_000 };
    expect(receivedWords(fee, { name: 'Pool', ...at, availableMsat: null, channelBefore: true }).label).toBe(
      "Received 5,000 sat, into Pool. Note from the payer, float for Saturday. 2,000 sat went to ACINQ for more room in your server's Lightning channel.",
    );
    const nothing = { ...tx(9, 'topup', 0), payerNote: 'float for Saturday' };
    expect(receivedWords(nothing, { name: 'Pool', ...at, availableMsat: 0 })).toEqual({
      title: 'Received',
      line: "It went to phoenixd's fee credit, toward receiving room. Nothing was added to Pool.\n“float for Saturday”",
      label: "Received. It went to phoenixd's fee credit, toward receiving room. Nothing was added to Pool. Note from the payer, float for Saturday.",
    });
  });
});
