// The pay screen's days, rendered: a change of days shows what they cost at once, at the price of a day
// already asked for, and each press carries its time so the machine asks for one invoice once the presses stop.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { initialState, type OnboardingState } from '../onboarding/machine';
import type { OnboardingRunner } from '../onboarding/runner';
import { PayPanel } from './PayPanel';

const NOW = 1_800_000_000_000;

function panel(s: OnboardingState) {
  const updates: OnboardingState[] = [];
  const runner = {
    deps: { now: () => NOW },
    update: async (f: (x: OnboardingState) => OnboardingState) => void updates.push(f(s)),
  } as unknown as OnboardingRunner;
  render(<PayPanel s={s} runner={runner} serverTime={() => NOW} />);
  return updates;
}

describe('PayPanel', () => {
  const choosing: OnboardingState = { ...initialState('GBR'), step: 'pay', vmId: 1001, payDays: 6, payPrice: { vmId: 1001, satPerDay: 6_863 / 31 } };

  it('shows what the days cost before their invoice comes, at the price of a day kept', () => {
    panel(choosing);
    expect(screen.getByText('1,329 sat')).toBeTruthy();
    expect(screen.getByText(/for 6 days of hosting/)).toBeTruthy();
    expect(screen.queryByText('Copy invoice')).toBeNull();
  });

  it('shows no figure before a price of a day for this VM is known', () => {
    panel({ ...choosing, payPrice: { vmId: 1, satPerDay: 300 } });
    expect(screen.getByText('…')).toBeTruthy();
  });

  it('times each press of a day button', () => {
    const updates = panel(choosing);
    fireEvent.click(screen.getByRole('button', { name: 'One day fewer' }));
    expect(updates[0]).toMatchObject({ payDays: 5, payDaysAt: NOW, invoice: undefined });
  });
});
