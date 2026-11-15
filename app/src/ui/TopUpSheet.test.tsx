// The Top up sheet rendered: the address, Copy address and Share, the first top-up's warning,
// and the Received page in place of all that.
import { fireEvent, render, screen } from '@testing-library/react';
import * as Clipboard from 'expo-clipboard';
import { Share } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopUpSheet } from './TopUpSheet';

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));

const address = 'pool@karto.example';
const open = { channel: true, usable: true, inboundSat: 100_000, feeCreditSat: 0, firstChannelFeeSat: 0 };

describe('TopUpSheet', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the address, and Copy address puts it on the clipboard', () => {
    render(<TopUpSheet name="Pool" address={address} liquidity={open} onClose={() => {}} />);
    expect(screen.getByText('Top up Pool')).toBeTruthy();
    expect(screen.getByText(address)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy address' }));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(address);
  });

  it('Share hands the address to the phone', () => {
    const share = vi.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    render(<TopUpSheet name="Pool" address={address} liquidity={open} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(share).toHaveBeenCalledWith({ message: address });
  });

  it('warns about the first channel while there is none, and shows the fee credit', () => {
    render(<TopUpSheet name="Pool" address={address} liquidity={{ ...open, channel: false, feeCreditSat: 1_200, firstChannelFeeSat: 21_000 }} onClose={() => {}} />);
    expect(screen.getByText(/about 21,000 sat at today's fees/)).toBeTruthy();
    expect(screen.getByText(/^Fee credit: 1,200 sat/)).toBeTruthy();
  });

  it("says so when the server can't check its channel, still showing the address", () => {
    render(<TopUpSheet name="Pool" address={address} liquidity={null} onClose={() => {}} />);
    expect(screen.getByText("Your server can't check its Lightning channel right now. If this is the first top-up, send over 50,000 sat.")).toBeTruthy();
    expect(screen.getByText(address)).toBeTruthy();
  });

  it('says Received once a top-up lands, and Done closes it', () => {
    const onClose = vi.fn();
    render(<TopUpSheet name="Pool" address={address} liquidity={open} received={{ title: 'Received 5,000 sat', line: 'In Pool now.', label: 'Received 5,000 sat in Pool' }} onClose={onClose} />);
    expect(screen.getByText('Received 5,000 sat')).toBeTruthy();
    expect(screen.queryByText(address)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('turns to Received in place when a top-up lands while it is open, and back, without a hook-order error', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const words = { title: 'Received 5,000 sat', line: 'In Pool now.', label: 'Received 5,000 sat in Pool' };
      const { rerender } = render(<TopUpSheet name="Pool" address={address} liquidity={open} onClose={() => {}} />);
      rerender(<TopUpSheet name="Pool" address={address} liquidity={open} received={words} onClose={() => {}} />);
      expect(screen.getByText('Received 5,000 sat')).toBeTruthy();
      rerender(<TopUpSheet name="Pool" address={address} liquidity={open} onClose={() => {}} />);
      expect(screen.getByText(address)).toBeTruthy();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
