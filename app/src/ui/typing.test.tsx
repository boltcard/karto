// Typing an amount, rendered: an amount field's unit chip, what it
// types and the sats a price comes to; a card's limits set in the currency or in sat, said in their own unit.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardLimits, CardInfo, LimitsRequest } from '../cardd/client';
import type { Fiat } from '../money/fiat';
import { memoryViewKv } from '../testing/viewKv';
import { AmountViewWith, type ViewKv } from './amountView';
import { LimitsSheet } from './LimitsSheet';
import { screenLock } from './lock';
import { AmountField } from './money';

// The phone's screen lock, which raising a card's limits asks for: confirmed, unless a test says otherwise.
vi.mock('./lock', () => ({ screenLock: vi.fn(async () => null) }));

const GBP: Fiat = { currency: 'GBP', price: 61_352, time: Math.floor(Date.now() / 1000) };
const With = ({ kv, fiat, children }: { kv: ViewKv; fiat: Fiat; children: ReactNode }) => (
  <AmountViewWith kv={kv} answer={{ fiat }} server={null}>
    {children}
  </AmountViewWith>
);

/** An amount field holding what is typed, as Send out's and Move's do. */
function Typed() {
  const [text, setText] = useState('');
  return <AmountField value={text} onChangeText={setText} placeholder="Amount" />;
}

describe('AmountField', () => {
  it('types in the currency with its chip and the sats it comes to; the chip switches to sat, turning what is typed into sats', async () => {
    const kv = memoryViewKv();
    render(<With kv={kv} fiat={GBP}><Typed /></With>);
    const chip = await screen.findByRole('button', { name: 'Typing in GBP. Tap to type in sat.' });
    expect(chip.textContent).toBe('£ GBP');
    expect(screen.getByText('1 BTC = £61,352')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '5.00' } });
    expect(screen.getByText('≈ 8,150 sat at 1 BTC = £61,352')).toBeTruthy();
    fireEvent.click(chip);
    expect(screen.getByDisplayValue('8150')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Typing in sat. Tap to type in GBP.' }).textContent).toBe('sat');
    expect(screen.queryByText(/1 BTC/)).toBeNull();
    expect(kv.saved.typing).toBe('sat');
    fireEvent.click(screen.getByRole('button', { name: 'Typing in sat. Tap to type in GBP.' }));
    expect(screen.getByDisplayValue('5.00')).toBeTruthy();
  });

  it('empties what was typed in £ when the rate goes, rather than reading "5" as 5 sat', async () => {
    const kv = memoryViewKv();
    const { rerender } = render(<With kv={kv} fiat={GBP}><Typed /></With>);
    await screen.findByRole('button', { name: 'Typing in GBP. Tap to type in sat.' });
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '5' } });
    expect(screen.getByDisplayValue('5')).toBeTruthy();
    rerender(<With kv={kv} fiat={{ currency: 'GBP' }}><Typed /></With>);
    expect(screen.queryByRole('button', { name: /^Typing in/ })).toBeNull();
    await waitFor(() => expect((screen.getByPlaceholderText('Amount') as HTMLInputElement).value).toBe(''));
  });

  it('empties what was typed in sat when a rate arrives and the phone types in £, rather than reading 8150 as £8,150', async () => {
    const kv = memoryViewKv();
    const { rerender } = render(<With kv={kv} fiat={{ currency: 'GBP' }}><Typed /></With>);
    // Let the kept values load (the phone last typed in £), with no rate yet: sat.
    await act(async () => {});
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '8150' } });
    expect(screen.getByDisplayValue('8150')).toBeTruthy();
    rerender(<With kv={kv} fiat={GBP}><Typed /></With>);
    expect(await screen.findByRole('button', { name: 'Typing in GBP. Tap to type in sat.' })).toBeTruthy();
    await waitFor(() => expect((screen.getByPlaceholderText('Amount') as HTMLInputElement).value).toBe(''));
    expect(screen.queryByText(/≈ 13,/)).toBeNull();
  });

  it('opens in the unit the phone last typed in', async () => {
    render(<With kv={memoryViewKv({ typing: 'sat' })} fiat={GBP}><Typed /></With>);
    expect(await screen.findByRole('button', { name: 'Typing in sat. Tap to type in GBP.' })).toBeTruthy();
  });

  it('has no chip, and types sat, with the currency none or no rate', () => {
    for (const fiat of [{ currency: 'none' }, { currency: 'GBP' }] as Fiat[]) {
      render(<With kv={memoryViewKv()} fiat={fiat}><Typed /></With>);
      expect(screen.queryByRole('button', { name: /^Typing in/ })).toBeNull();
      expect(screen.queryByText(/1 BTC/)).toBeNull();
      cleanup();
    }
  });
});

describe('LimitsSheet', () => {
  type Card = Pick<CardInfo, 'id'> & { perTapSat: number; dailySat: number; spent24hMsat: number; limits?: CardLimits };
  const card = (limits?: CardLimits): Card => ({ id: 'c1', perTapSat: limits ? 8_149 : 20_000, dailySat: limits ? 32_598 : 50_000, spent24hMsat: 1_500_000, limits });
  beforeEach(() => vi.mocked(screenLock).mockClear());
  function open(c: Card, fiat: Fiat = GBP) {
    const setLimits = vi.fn(async (_id: string, _limits: LimitsRequest) => ({}) as CardInfo);
    const onSaved = vi.fn();
    render(
      <With kv={memoryViewKv()} fiat={fiat}>
        <LimitsSheet card={c} cardd={{ setLimits }} off={false} onSaved={onSaved} onClose={() => {}} />
      </With>,
    );
    return { setLimits, onSaved };
  }

  it('opens a card limited in the currency in it, said in it, and saves new limits in it', async () => {
    const { setLimits, onSaved } = open(card({ currency: 'GBP', perTapMinor: 500, dailyMinor: 2_000 }));
    expect(screen.getByText('Now £20 a day · £5 a tap')).toBeTruthy();
    expect(screen.getByText('Per payment (£)')).toBeTruthy();
    expect(screen.getByDisplayValue('20.00')).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('5.00'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(setLimits).toHaveBeenCalledWith('c1', { currency: 'GBP', perTapMinor: 600, dailyMinor: 2_000 });
  });

  it('opens a card limited in sat in sat; the chip turns what is typed into £, and the limits are saved in £', async () => {
    const { setLimits } = open(card());
    expect(screen.getByText('Now 50,000 sat a day · 20,000 sat a tap')).toBeTruthy();
    expect(screen.getByText('Per payment (sat)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Typing in sat. Tap to type in GBP.' }));
    expect(screen.getByDisplayValue('12.27')).toBeTruthy();
    expect(screen.getByDisplayValue('30.68')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(setLimits).toHaveBeenCalledWith('c1', { currency: 'GBP', perTapMinor: 1_227, dailyMinor: 3_068 }));
  });

  it('refuses £ limits over the 2,000,000 sat a card may spend at the rate, naming the cap in £', () => {
    const { setLimits } = open(card({ currency: 'GBP', perTapMinor: 500, dailyMinor: 2_000 }));
    fireEvent.change(screen.getByDisplayValue('20.00'), { target: { value: '1227.05' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    expect(screen.getByText('Limits are up to 2,000,000 sat (£1,227.04).')).toBeTruthy();
    expect(setLimits).not.toHaveBeenCalled();
  });

  it("says a card limited in a currency that is no longer the server's in it, and offers sat or the server's currency", () => {
    open(card({ currency: 'EUR', perTapMinor: 500, dailyMinor: 2_000 }));
    expect(screen.getByText('Now €20 a day · €5 a tap')).toBeTruthy();
    expect(screen.getByText("Set in euros, which is no longer your server's currency: change them in sat or GBP.")).toBeTruthy();
    expect(screen.getByText('Per payment (sat)')).toBeTruthy();
    expect(screen.getByDisplayValue('8149')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Typing in sat. Tap to type in GBP.' })).toBeTruthy();
  });

  it("doesn't call limits in the server's currency another's while the server has no rate for a moment, and says to set them in sat", () => {
    open(card({ currency: 'GBP', perTapMinor: 500, dailyMinor: 2_000 }), { currency: 'GBP' });
    expect(screen.getByText('Now £20 a day · £5 a tap')).toBeTruthy();
    expect(screen.queryByText(/no longer your server's currency/)).toBeNull();
    expect(screen.getByText('No £ rate yet: set the limits in sat.')).toBeTruthy();
    expect(screen.getByText('Per payment (sat)')).toBeTruthy();
  });

  it('empties what was typed in £ when the rate goes, and keeps sats typed then in sat when it comes back', async () => {
    const setLimits = vi.fn(async (_id: string, _limits: LimitsRequest) => ({}) as CardInfo);
    const kv = memoryViewKv();
    const sheet = (fiat: Fiat) => (
      <With kv={kv} fiat={fiat}>
        <LimitsSheet card={card({ currency: 'GBP', perTapMinor: 500, dailyMinor: 2_000 })} cardd={{ setLimits }} off={false} onSaved={() => {}} onClose={() => {}} />
      </With>
    );
    const { rerender } = render(sheet(GBP));
    expect(screen.getByDisplayValue('20.00')).toBeTruthy();
    rerender(sheet({ currency: 'GBP' }));
    expect(screen.getByText('Per payment (sat)')).toBeTruthy();
    expect(screen.getByText('No £ rate yet: set the limits in sat.')).toBeTruthy();
    const [perTap, daily] = screen.getAllByRole('textbox') as HTMLInputElement[];
    await waitFor(() => expect([perTap.value, daily.value]).toEqual(['', '']));
    fireEvent.change(perTap, { target: { value: '8000' } });
    fireEvent.change(daily, { target: { value: '30000' } });
    rerender(sheet(GBP));
    expect(await screen.findByRole('button', { name: 'Typing in sat. Tap to type in GBP.' })).toBeTruthy();
    expect(screen.queryByText(/rate yet/)).toBeNull();
    expect(screen.getByText('Per payment (sat)')).toBeTruthy();
    expect([perTap.value, daily.value]).toEqual(['8000', '30000']);
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(setLimits).toHaveBeenCalledWith('c1', { perTapSat: 8_000, dailySat: 30_000 }));
  });

  it('sets limits in sat as before with no currency, and has no chip', async () => {
    const { setLimits } = open(card(), { currency: 'none' });
    expect(screen.queryByRole('button', { name: /^Typing in/ })).toBeNull();
    fireEvent.change(screen.getByDisplayValue('20000'), { target: { value: '25000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(setLimits).toHaveBeenCalledWith('c1', { perTapSat: 25_000, dailySat: 50_000 }));
  });
  it('asks for the screen lock before limits go up, naming them, then saves them', async () => {
    const { setLimits, onSaved } = open(card(), { currency: 'none' });
    fireEvent.change(screen.getByDisplayValue('20000'), { target: { value: '25000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screenLock).toHaveBeenCalledWith('Raise limits to 50,000 sat a day · 25,000 sat a tap', "raising a card's limits");
    expect(vi.mocked(screenLock).mock.invocationCallOrder[0]).toBeLessThan(setLimits.mock.invocationCallOrder[0]);
  });

  it('saves nothing when the screen lock is refused, and says why', async () => {
    vi.mocked(screenLock).mockResolvedValueOnce('The screen lock was not confirmed.');
    const { setLimits, onSaved } = open(card({ currency: 'GBP', perTapMinor: 500, dailyMinor: 2_000 }));
    fireEvent.change(screen.getByDisplayValue('20.00'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    expect(await screen.findByText('The screen lock was not confirmed.')).toBeTruthy();
    expect(screenLock).toHaveBeenCalledWith('Raise limits to £50 a day · £5 a tap', "raising a card's limits");
    expect(setLimits).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save limits' }).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('asks for no lock to lower limits', async () => {
    const { setLimits } = open(card({ currency: 'GBP', perTapMinor: 500, dailyMinor: 2_000 }));
    fireEvent.change(screen.getByDisplayValue('20.00'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(setLimits).toHaveBeenCalledWith('c1', { currency: 'GBP', perTapMinor: 500, dailyMinor: 1_000 }));
    expect(screenLock).not.toHaveBeenCalled();
  });
});
