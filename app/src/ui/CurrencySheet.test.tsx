// Settings' Currency list, rendered.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CarddError } from '../cardd/error';
import { CurrencySheet } from './CurrencySheet';

describe('CurrencySheet', () => {
  it('lists None and the seven, the current one chosen; a choice goes to the server, then the sheet closes', async () => {
    const onChoose = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<CurrencySheet current="EUR" onChoose={onChoose} onClose={onClose} />);
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual([
      'None', 'US dollar $', 'Euro €', 'Pound £', 'Canadian dollar CA$', 'Swiss franc CHF', 'Australian dollar A$', 'Yen ¥',
    ]);
    // The chosen row carries the tick (react-native-web draws no aria-checked from accessibilityState).
    expect(screen.getByRole('radio', { name: 'Euro €' }).querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Pound £' }).querySelector('svg')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Pound £' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onChoose).toHaveBeenCalledWith('GBP');
  });

  it("says why when the server refuses, and stays open", async () => {
    const onChoose = vi.fn(async () => {
      throw new CarddError(404, 'bad_response', 'PUT /api/v1/currency: the answer is not JSON');
    });
    const onClose = vi.fn();
    render(<CurrencySheet current="GBP" onChoose={onChoose} onClose={onClose} />);
    fireEvent.click(screen.getByRole('radio', { name: 'None' }));
    expect(await screen.findByText('The server refused: PUT /api/v1/currency: the answer is not JSON')).toBeTruthy();
    expect(onChoose).toHaveBeenCalledWith('none');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes without asking the server when the current one is chosen again', () => {
    const onChoose = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<CurrencySheet current="GBP" onChoose={onChoose} onClose={onClose} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Pound £' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });
});
