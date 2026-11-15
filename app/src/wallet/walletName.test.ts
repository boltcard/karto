import { describe, expect, it } from 'vitest';
import { nameAskDue, namePrefill, NAME_PAGE, walletNameProblem, walletNameRow } from './walletName';

describe('namePrefill', () => {
  it("is the phone's model, cut to 24 characters and trimmed", () => {
    expect(namePrefill('Pixel 9a')).toBe('Pixel 9a');
    expect(namePrefill('Galaxy Tab S9 FE 5G Plus Edition')).toBe('Galaxy Tab S9 FE 5G Plus');
    expect(namePrefill('a'.repeat(23) + ' bcd')).toBe('a'.repeat(23));
  });

  it("never splits a character made of two UTF-16 units", () => {
    expect(namePrefill('a'.repeat(23) + '😀😀')).toBe('a'.repeat(23) + '😀');
  });
});

describe('walletNameProblem', () => {
  it('says nothing for a good name or an empty field, and why for the rest', () => {
    expect(walletNameProblem('Pixel 9a')).toEqual({ ok: true, line: '' });
    expect(walletNameProblem(' Pixel 9a ')).toEqual({ ok: true, line: '' });
    expect(walletNameProblem('  ')).toEqual({ ok: false, line: '' });
    expect(walletNameProblem('a'.repeat(25))).toEqual({ ok: false, line: 'A name is up to 24 characters.' });
    expect(walletNameProblem('a\u200bb')).toEqual({ ok: false, line: "A name can't hold hidden characters." });
    expect(walletNameProblem('a\u0007b')).toEqual({ ok: false, line: "A name can't hold hidden characters." });
  });
});

describe('walletNameRow', () => {
  it("says the name, or that it needs one, or that the server can't keep one yet", () => {
    expect(walletNameRow({ name: 'Café' }, null)).toEqual({ line: 'Café', off: false });
    expect(walletNameRow({ name: '' }, null)).toEqual({ line: 'Not named yet', off: false });
    expect(walletNameRow({}, null)).toEqual({ line: 'Needs a server update', off: true });
    expect(walletNameRow(null, null)).toEqual({ line: 'Checking…', off: true });
  });

  it('shows a name just saved before the wallet answer has it', () => {
    expect(walletNameRow({ name: '' }, 'Café')).toEqual({ line: 'Café', off: false });
    expect(walletNameRow(null, 'Café')).toEqual({ line: 'Café', off: true });
  });
});

describe('nameAskDue', () => {
  const h = 'vm-1.lnvps.cloud';
  it('asks an unnamed wallet, once per run, and never one whose server has no names', () => {
    expect(nameAskDue({ name: '' }, h, new Set())).toBe(true);
    expect(nameAskDue({ name: '' }, h, new Set([h]))).toBe(false);
    expect(nameAskDue({ name: '' }, h, new Set(['vm-2.lnvps.cloud']))).toBe(true);
    expect(nameAskDue({ name: 'X' }, h, new Set())).toBe(false);
    expect(nameAskDue({}, h, new Set())).toBe(false);
    expect(nameAskDue(null, h, new Set())).toBe(false);
  });
});

// The name reaches customers in a refund's note, so its page says so.
it("has the page's words", () => {
  expect(NAME_PAGE).toEqual({
    title: 'Name this wallet',
    body: "Karto PoS phones show this name, and a refund's note to the customer names it.",
    save: 'Save',
  });
});
