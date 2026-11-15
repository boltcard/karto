// The wallet's one view of every amount, rendered: a tap on any
// amount moves them all to the next view and the phone keeps it; Show msat amounts adds msat; the currency becoming
// none moves a £ view to sat; the last rate stays while the server can't be read; the rate's age once it is old.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { CurrencyCode, Fiat } from '../money/fiat';
import { memoryViewKv } from '../testing/viewKv';
import { AmountViewWith, useAmountView, type ViewKv } from './amountView';
import { Amount, RateAgeLine } from './money';

const nowS = () => Math.floor(Date.now() / 1000);
/** The server's pound at mempool's price of 15 Oct 2026, age seconds old. */
const GBP = (age = 0): Fiat => ({ currency: 'GBP', price: 61_352, time: nowS() - age });

/** Show msat amounts, as Settings' switch turns it. */
function MsatSwitch() {
  const { showMsat, setShowMsat } = useAmountView();
  return <button onClick={() => setShowMsat(!showMsat)}>{showMsat ? 'msat on' : 'msat off'}</button>;
}

const With = ({ kv, fiat, children }: { kv: ViewKv; fiat: Fiat | null; children: ReactNode }) => (
  <AmountViewWith kv={kv} answer={fiat === null ? null : { fiat }} server={null}>
    {children}
  </AmountViewWith>
);

describe('Amount and the view', () => {
  it('starts on sat on a new phone; a tap on any amount moves every amount to the next view, and the phone keeps it', async () => {
    const kv = memoryViewKv();
    render(
      <With kv={kv} fiat={GBP()}>
        <Amount msat={13_291_204} size="large" alt />
        <Amount msat={4_412} sign="−" />
      </With>,
    );
    const big = await screen.findByRole('button', { name: '13,291 sat' });
    // Phoenix's way: the number, then its unit.
    expect(big.textContent).toBe('13,291 sat');
    expect(screen.getByText('≈ £8.15')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'minus 4 sat' }).textContent).toBe('−4 sat');
    // Show msat amounts is off: sat, then ***, then £.
    fireEvent.click(big);
    expect(screen.getAllByRole('button', { name: 'amount hidden' }).map((b) => b.textContent)).toEqual(['***', '***']);
    expect(screen.queryByText('≈ £8.15')).toBeNull();
    expect(kv.saved.view).toBe('hidden');
    fireEvent.click(screen.getAllByRole('button', { name: 'amount hidden' })[1]);
    expect(screen.getByRole('button', { name: "8 pounds 15 at today's rate" }).textContent).toBe('8.15 GBP');
    expect(screen.getByText('13,291 sat')).toBeTruthy();
    expect(screen.getByRole('button', { name: "minus under 1 penny at today's rate" }).textContent).toBe('−under 0.01 GBP');
    expect(kv.saved.view).toBe('fiat');
  });

  it('puts msat in the cycle only while Show msat amounts is on; turning it off in msat view goes to sat', async () => {
    const kv = memoryViewKv({ showMsat: true });
    render(
      <With kv={kv} fiat={GBP()}>
        <Amount msat={13_291_204} size="large" alt />
        <MsatSwitch />
      </With>,
    );
    await screen.findByText('msat on');
    fireEvent.click(screen.getByRole('button', { name: '13,291 sat' }));
    expect(screen.getByRole('button', { name: '13,291,204 millisat' }).textContent).toBe('13,291,204 msat');
    expect(screen.getByText('≈ £8.15')).toBeTruthy();
    fireEvent.click(screen.getByText('msat on'));
    expect(kv.saved).toMatchObject({ showMsat: false, view: 'sat' });
    expect(screen.getByRole('button', { name: '13,291 sat' })).toBeTruthy();
  });

  it('opens in the view the phone kept; a currency with no rate yet draws sat and keeps £, the currency none moves £ to sat', async () => {
    const kv = memoryViewKv({ view: 'fiat' });
    const { rerender } = render(<With kv={kv} fiat={GBP()}><Amount msat={13_291_204} /></With>);
    expect(await screen.findByRole('button', { name: "8 pounds 15 at today's rate" })).toBeTruthy();
    rerender(<With kv={kv} fiat={{ currency: 'GBP' }}><Amount msat={13_291_204} /></With>);
    expect(screen.getByRole('button', { name: '13,291 sat' })).toBeTruthy();
    expect(kv.saved.view).toBe('fiat');
    rerender(<With kv={kv} fiat={{ currency: 'none' }}><Amount msat={13_291_204} /></With>);
    expect(screen.getByRole('button', { name: '13,291 sat' })).toBeTruthy();
    expect(kv.saved.view).toBe('sat');
    rerender(<With kv={kv} fiat={GBP()}><Amount msat={13_291_204} /></With>);
    expect(screen.getByRole('button', { name: '13,291 sat' })).toBeTruthy();
  });

  it("keeps the last rate while the server can't be read: an old rate is still used", async () => {
    const kv = memoryViewKv({ view: 'fiat' });
    const { rerender } = render(<With kv={kv} fiat={GBP()}><Amount msat={13_291_204} /></With>);
    await screen.findByRole('button', { name: "8 pounds 15 at today's rate" });
    rerender(<With kv={kv} fiat={null}><Amount msat={13_291_204} /></With>);
    expect(screen.getByRole('button', { name: "8 pounds 15 at today's rate" })).toBeTruthy();
  });

  it("shows the rate's age once it is over an hour, and not while every amount is hidden", async () => {
    const kv = memoryViewKv();
    const { rerender } = render(<With kv={kv} fiat={GBP(600)}><RateAgeLine /><Amount msat={1_000} /></With>);
    await screen.findByRole('button', { name: '1 sat' });
    expect(screen.queryByText(/at a rate/)).toBeNull();
    rerender(<With kv={kv} fiat={GBP(2 * 3600 + 60)}><RateAgeLine /><Amount msat={1_000} /></With>);
    expect(screen.getByText('£ at a rate 2 h old')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1 sat' }));
    expect(screen.queryByText(/at a rate/)).toBeNull();
  });

  it('draws sat with no rate outside any provider, and a tap there changes nothing', () => {
    render(<Amount msat={13_291_204} size="large" alt />);
    fireEvent.click(screen.getByRole('button', { name: '13,291 sat' }));
    expect(screen.getByRole('button', { name: '13,291 sat' })).toBeTruthy();
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
