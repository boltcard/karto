// The phone's kept view of amounts, for screen tests: AppStore's
// six calls in memory, with what was last saved to look at.
import type { View } from '../money/view';
import type { ViewKv } from '../ui/amountView';

export type SavedView = { view: View; showMsat: boolean; typing: 'fiat' | 'sat' };

/** A new phone's (sat, msat off, typing in the currency) unless start says otherwise. */
export function memoryViewKv(start: Partial<SavedView> = {}): ViewKv & { saved: SavedView } {
  const saved: SavedView = { view: 'sat', showMsat: false, typing: 'fiat', ...start };
  return {
    saved,
    amountView: async () => saved.view,
    setAmountView: async (view) => void (saved.view = view),
    showMsat: async () => saved.showMsat,
    setShowMsat: async (on) => void (saved.showMsat = on),
    typingUnit: async () => saved.typing,
    setTypingUnit: async (unit) => void (saved.typing = unit),
  };
}
