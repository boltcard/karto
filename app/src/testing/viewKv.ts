// The phone's kept view of amounts, for screen tests: AppStore's
// six calls in memory, with what was last saved to look at.
import type { Unit } from '../money/view';
import type { ViewKv } from '../ui/amountView';

export type SavedView = { unit: Unit; hidden: boolean; typing: 'fiat' | 'sat' };

/** A new phone's (sat, shown, typing in the currency) unless start says otherwise. */
export function memoryViewKv(start: Partial<SavedView> = {}): ViewKv & { saved: SavedView } {
  const saved: SavedView = { unit: 'sat', hidden: false, typing: 'fiat', ...start };
  return {
    saved,
    amountUnit: async () => saved.unit,
    setAmountUnit: async (unit) => void (saved.unit = unit),
    amountsHidden: async () => saved.hidden,
    setAmountsHidden: async (on) => void (saved.hidden = on),
    typingUnit: async () => saved.typing,
    setTypingUnit: async (unit) => void (saved.typing = unit),
  };
}
