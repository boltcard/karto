import { describe, expect, it } from 'vitest';
import type { Tx } from '../cardd/client';
import { cutNote, NOTE_MAX, PAYER_NOTE_MAX, payerNoteText, quotedPayerNote } from './note';

describe('cutNote', () => {
  it('keeps 200 emoji, not 100: it counts code points, as cardd does', () => {
    const emoji = '😀'.repeat(NOTE_MAX);
    expect(emoji.length).toBe(400); // UTF-16 units: what maxLength counted
    expect(cutNote(emoji)).toBe(emoji);
    expect(cutNote(emoji + '😀')).toBe(emoji);
  });

  it('cuts plain text at 200 and leaves shorter text as it is', () => {
    expect(cutNote('x'.repeat(201))).toBe('x'.repeat(200));
    expect(cutNote('rent')).toBe('rent');
    expect(cutNote('')).toBe('');
  });
});

describe("a payer's note", () => {
  const top: Tx = { id: 1, kind: 'topup', note: 'received 5000 sat', amountMsat: 5_000_000, feeMsat: 0, created: 0 };

  it('cutNote takes a limit: cardd keeps 140 and its …, 141 in all', () => {
    expect([...cutNote('x'.repeat(150), PAYER_NOTE_MAX)].length).toBe(141);
    expect(cutNote('x'.repeat(201))).toBe('x'.repeat(200));
  });

  it('is quoted for showing, plain for reading out, and nothing without one', () => {
    expect(quotedPayerNote({ ...top, payerNote: 'refund' })).toBe('“refund”');
    expect(payerNoteText({ ...top, payerNote: 'refund' })).toBe('refund');
    expect(quotedPayerNote(top)).toBe('');
    expect(quotedPayerNote({ ...top, payerNote: '' })).toBe('');
    expect(payerNoteText(top)).toBe('');
  });
});
