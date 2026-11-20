// Settings' Show amounts in list, rendered.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UnitSheet } from './UnitSheet';

const GBP = { currency: 'GBP' as const, price: 61_352, time: 1_792_037_404 };

describe('UnitSheet', () => {
  it("lists the currency, sat and msat, the kept one ticked; a choice is made and the sheet closes", () => {
    const onChoose = vi.fn();
    const onClose = vi.fn();
    render(<UnitSheet unit="sat" fiat={GBP} onChoose={onChoose} onClose={onClose} />);
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['Pound £', 'sat', 'msat']);
    expect(screen.getByRole('radio', { name: 'sat' }).querySelector('svg')).not.toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Pound £' }));
    expect(onChoose).toHaveBeenCalledWith('fiat');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has the currency off, saying why, while the server has none', () => {
    const onChoose = vi.fn();
    render(<UnitSheet unit="sat" fiat={{ currency: 'none' }} onChoose={onChoose} onClose={() => {}} />);
    expect(screen.getByText('Choose a currency first')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Currency/ }));
    expect(onChoose).not.toHaveBeenCalled();
  });
});
