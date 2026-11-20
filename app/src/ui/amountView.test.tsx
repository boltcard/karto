// The wallet's one view of every amount, rendered: the unit
// and hidden are set (Settings' rows, the Wallet page's eye) and the phone keeps them; an amount is text, not a
// button; the currency becoming none moves £ to sat; the last rate stays while the server can't be read; the rate's
// age once it is old.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { CurrencyCode, Fiat } from '../money/fiat';
import { memoryViewKv } from '../testing/viewKv';
import { AmountViewWith, useAmountView, type ViewKv } from './amountView';
import { Amount, RateAgeLine, ReadBack } from './money';

const nowS = () => Math.floor(Date.now() / 1000);
/** The server's pound at mempool's price of 15 Oct 2026, age seconds old. */
const GBP = (age = 0): Fiat => ({ currency: 'GBP', price: 61_352, time: nowS() - age });

/** Settings' rows and the eye, as buttons: a unit, and hide or show. */
function Controls() {
  const { unit, hidden, setUnit, setHidden } = useAmountView();
  return (
    <>
      <span>{`unit ${unit}${hidden ? ' hidden' : ''}`}</span>
      {(['fiat', 'sat', 'msat'] as const).map((u) => <button key={u} onClick={() => setUnit(u)}>{`in ${u}`}</button>)}
      <button onClick={() => setHidden(!hidden)}>{hidden ? 'show' : 'hide'}</button>
    </>
  );
}

const With = ({ kv, fiat, children }: { kv: ViewKv; fiat: Fiat | null; children: ReactNode }) => (
  <AmountViewWith kv={kv} answer={fiat === null ? null : { fiat }} server={null}>
    {children}
  </AmountViewWith>
);

describe('Amount and the view', () => {
  it('starts on sat, shown, on a new phone; a unit chosen and hiding are kept apart, so showing comes back to the unit', async () => {
    const kv = memoryViewKv();
    render(
      <With kv={kv} fiat={GBP()}>
        <Amount msat={13_291_204} size="large" alt />
        <Amount msat={4_412} sign="−" />
        <Controls />
      </With>,
    );
    const big = await screen.findByLabelText('13,291 sat');
    // Phoenix's way: the number, then its unit.
    expect(big.textContent).toBe('13,291 sat');
    expect(screen.getByText('≈ £8.15')).toBeTruthy();
    expect(screen.getByLabelText('minus 4 sat').textContent).toBe('−4 sat');
    fireEvent.click(screen.getByText('in fiat'));
    expect(screen.getByLabelText("8 pounds 15 at today's rate").textContent).toBe('8.15 GBP');
    expect(screen.getByText('13,291 sat')).toBeTruthy();
    expect(screen.getByLabelText("minus under 1 penny at today's rate").textContent).toBe('−under 0.01 GBP');
    expect(kv.saved).toMatchObject({ unit: 'fiat', hidden: false });
    fireEvent.click(screen.getByText('hide'));
    expect(screen.getAllByLabelText('amount hidden').map((b) => b.textContent)).toEqual(['***', '***']);
    expect(screen.queryByText('≈ £8.15')).toBeNull();
    expect(kv.saved).toMatchObject({ unit: 'fiat', hidden: true });
    expect(screen.getByText('unit fiat hidden')).toBeTruthy();
    fireEvent.click(screen.getByText('show'));
    expect(screen.getByLabelText("8 pounds 15 at today's rate")).toBeTruthy();
    fireEvent.click(screen.getByText('in msat'));
    expect(screen.getByLabelText('13,291,204 millisat').textContent).toBe('13,291,204 msat');
    expect(screen.getByText('≈ £8.15')).toBeTruthy();
  });

  it('is text, not a button: a tap on an amount changes nothing', async () => {
    const kv = memoryViewKv();
    render(<With kv={kv} fiat={GBP()}><Amount msat={13_291_204} size="large" alt /></With>);
    const big = await screen.findByLabelText('13,291 sat');
    expect(screen.queryByRole('button', { name: '13,291 sat' })).toBeNull();
    fireEvent.click(big);
    expect(screen.getByLabelText('13,291 sat')).toBeTruthy();
    expect(kv.saved).toMatchObject({ unit: 'sat', hidden: false });
  });

  it('opens in the unit and hidden the phone kept', async () => {
    const kv = memoryViewKv({ unit: 'msat', hidden: true });
    render(<With kv={kv} fiat={GBP()}><Amount msat={13_291_204} /><Controls /></With>);
    expect(await screen.findByText('unit msat hidden')).toBeTruthy();
    expect(screen.getByLabelText('amount hidden')).toBeTruthy();
    fireEvent.click(screen.getByText('show'));
    expect(screen.getByLabelText('13,291,204 millisat')).toBeTruthy();
  });

  it('keeps an eye press made before the kept values were read, and still reads the unit', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const inner = memoryViewKv({ unit: 'msat', hidden: false });
    const kv = { ...inner, amountUnit: async () => (await gate, inner.amountUnit()), amountsHidden: async () => (await gate, inner.amountsHidden()) };
    render(<With kv={kv} fiat={GBP()}><Controls /></With>);
    fireEvent.click(screen.getByText('hide'));
    await act(async () => release());
    expect(await screen.findByText('unit msat hidden')).toBeTruthy();
    expect(inner.saved.hidden).toBe(true);
  });

  it('draws sat while £ has no rate yet and keeps £; the currency none moves £ to sat and keeps hidden', async () => {
    const kv = memoryViewKv({ unit: 'fiat' });
    const { rerender } = render(<With kv={kv} fiat={GBP()}><Amount msat={13_291_204} /><Controls /></With>);
    expect(await screen.findByLabelText("8 pounds 15 at today's rate")).toBeTruthy();
    rerender(<With kv={kv} fiat={{ currency: 'GBP' }}><Amount msat={13_291_204} /><Controls /></With>);
    expect(screen.getByLabelText('13,291 sat')).toBeTruthy();
    expect(screen.getByText('unit fiat')).toBeTruthy();
    expect(kv.saved.unit).toBe('fiat');
    fireEvent.click(screen.getByText('hide'));
    rerender(<With kv={kv} fiat={{ currency: 'none' }}><Amount msat={13_291_204} /><Controls /></With>);
    expect(screen.getByText('unit sat hidden')).toBeTruthy();
    expect(kv.saved).toMatchObject({ unit: 'sat', hidden: true });
    rerender(<With kv={kv} fiat={GBP()}><Amount msat={13_291_204} /><Controls /></With>);
    expect(screen.getByLabelText('amount hidden')).toBeTruthy();
  });

  it("keeps the last rate while the server can't be read: an old rate is still used", async () => {
    const kv = memoryViewKv({ unit: 'fiat' });
    const { rerender } = render(<With kv={kv} fiat={GBP()}><Amount msat={13_291_204} /></With>);
    await screen.findByLabelText("8 pounds 15 at today's rate");
    rerender(<With kv={kv} fiat={null}><Amount msat={13_291_204} /></With>);
    expect(screen.getByLabelText("8 pounds 15 at today's rate")).toBeTruthy();
  });

  it("shows the rate's age once it is over an hour, and not while every amount is hidden", async () => {
    const kv = memoryViewKv();
    const { rerender } = render(<With kv={kv} fiat={GBP(600)}><RateAgeLine /><Amount msat={1_000} /><Controls /></With>);
    await screen.findByLabelText('1 sat');
    expect(screen.queryByText(/at a rate/)).toBeNull();
    rerender(<With kv={kv} fiat={GBP(2 * 3600 + 60)}><RateAgeLine /><Amount msat={1_000} /><Controls /></With>);
    expect(screen.getByText('£ at a rate 2 h old')).toBeTruthy();
    fireEvent.click(screen.getByText('hide'));
    expect(screen.queryByText(/at a rate/)).toBeNull();
  });

  it("reads a read-back row as one element: its label, the figure and the other figure under it", async () => {
    render(<With kv={memoryViewKv()} fiat={GBP()}><ReadBack rows={[['Amount', { msat: 13_291_204 }]]} /></With>);
    expect(await screen.findByLabelText('Amount: 13,291 sat, ≈ £8.15')).toBeTruthy();
  });

  it('draws sat with no rate outside any provider', () => {
    render(<Amount msat={13_291_204} size="large" alt />);
    expect(screen.getByLabelText('13,291 sat')).toBeTruthy();
    expect(screen.queryByText(/≈/)).toBeNull();
  });
});

// A server that has never had a currency gets the wallet phone's region currency, with nothing to tap.
describe('the region default', () => {
  /** A server whose setCurrency answers as cardd does, and says what it was asked. */
  const serverAsked = (fail = () => false) => {
    const asked: string[] = [];
    const server = {
      host: 'vm-1.lnvps.cloud',
      setCurrency: async (code: CurrencyCode | 'none'): Promise<Fiat> => {
        asked.push(code);
        if (fail()) throw new Error('fetch failed: offline');
        return { currency: code };
      },
    };
    return { asked, server };
  };
  function Currency() {
    const { fiat } = useAmountView();
    return <span>{`currency ${fiat?.currency ?? 'unknown'}`}</span>;
  }

  it("sends the phone's region currency once when the server has never had one, and shows it at once", async () => {
    const { asked, server } = serverAsked();
    const kv = memoryViewKv();
    const unset = { fiat: { currency: null } };
    const { rerender } = render(<AmountViewWith kv={kv} answer={unset} server={server} region={() => 'GBP'}><Currency /></AmountViewWith>);
    expect(await screen.findByText('currency GBP')).toBeTruthy();
    // Another answer from before cardd's change: nothing is sent again to this server.
    rerender(<AmountViewWith kv={kv} answer={{ fiat: { currency: null } }} server={server} region={() => 'GBP'}><Currency /></AmountViewWith>);
    expect(asked).toEqual(['GBP']);
  });

  it('sends none for a region whose currency is not one of the seven, and for no region', async () => {
    for (const region of ['SEK', null]) {
      const { asked, server } = serverAsked();
      render(<AmountViewWith kv={memoryViewKv()} answer={{ fiat: { currency: null } }} server={server} region={() => region}><Currency /></AmountViewWith>);
      expect(await screen.findByText('currency none')).toBeTruthy();
      expect(asked).toEqual(['none']);
      cleanup();
    }
  });

  it('sends nothing to a server with a currency, to one that says nothing of it, or before the server is held', async () => {
    const { asked, server } = serverAsked();
    const kv = memoryViewKv();
    const { rerender } = render(<AmountViewWith kv={kv} answer={{ fiat: { currency: 'EUR' } }} server={server} region={() => 'GBP'}><Currency /></AmountViewWith>);
    expect(await screen.findByText('currency EUR')).toBeTruthy();
    rerender(<AmountViewWith kv={kv} answer={{}} server={server} region={() => 'GBP'}><Currency /></AmountViewWith>);
    rerender(<AmountViewWith kv={kv} answer={{ fiat: { currency: null } }} server={null} region={() => 'GBP'}><Currency /></AmountViewWith>);
    expect(asked).toEqual([]);
  });

  it('tries again with the next wallet answer when sending failed', async () => {
    let failing = true;
    const { asked, server } = serverAsked(() => failing);
    const kv = memoryViewKv();
    const { rerender } = render(<AmountViewWith kv={kv} answer={{ fiat: { currency: null } }} server={server} region={() => 'GBP'}><Currency /></AmountViewWith>);
    await waitFor(() => expect(asked).toEqual(['GBP']));
    await act(async () => {});
    failing = false;
    rerender(<AmountViewWith kv={kv} answer={{ fiat: { currency: null } }} server={server} region={() => 'GBP'}><Currency /></AmountViewWith>);
    expect(await screen.findByText('currency GBP')).toBeTruthy();
    expect(asked).toEqual(['GBP', 'GBP']);
  });

  it("never replaces a currency the person chose with the region's, when a stale answer still says never set", async () => {
    let failing = true;
    const { asked, server } = serverAsked(() => failing);
    const kv = memoryViewKv();
    let choose: (code: CurrencyCode | 'none') => Promise<void> = async () => {};
    function Grab() {
      choose = useAmountView().chooseCurrency;
      return <Currency />;
    }
    const ui = (answer: { fiat?: Fiat }) => <AmountViewWith kv={kv} answer={answer} server={server} region={() => 'GBP'}><Grab /></AmountViewWith>;
    const { rerender } = render(ui({ fiat: { currency: null } }));
    await waitFor(() => expect(asked).toEqual(['GBP']));
    await act(async () => {});
    failing = false;
    await act(async () => {
      await choose('EUR');
    });
    expect(await screen.findByText('currency EUR')).toBeTruthy();
    rerender(ui({ fiat: { currency: null } }));
    await act(async () => {});
    // Nothing more goes to the server: EUR stays its currency (the view follows the answers, as for any stale one).
    expect(asked).toEqual(['GBP', 'EUR']);
  });
});
