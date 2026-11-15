// How long Charge takes to the sale screen, for adb logcat (a price in the shop's currency must not be measurably slower than one in sat). One line a sale:
// CARDAPP-CHARGE {"unit":"fiat","answerMs":212,"drawnMs":251}, from the press to cardd's answer to POST
// /api/v1/pos/sales, and to the sale screen's first frame.

type Started = { at: number; unit: 'fiat' | 'sat'; id?: string; answered?: number };
let started: Started | null = null;

const now = () => performance.now();

/** Charge was pressed, for a price in the shop's currency or in sat. */
export function chargePressed(unit: 'fiat' | 'sat', at = now()): void {
  started = { at, unit };
}

/** cardd answered with the sale. */
export function chargeAnswered(id: string, at = now()): void {
  if (started && started.answered === undefined) started = { ...started, id, answered: at };
}

/** The sale screen's first frame: the line for this sale once, or null (a sale not opened by Charge, or said already). */
export function saleDrawn(id: string, at = now()): string | null {
  const s = started;
  if (!s || s.id !== id || s.answered === undefined) return null;
  started = null;
  return `CARDAPP-CHARGE ${JSON.stringify({ unit: s.unit, answerMs: Math.round(s.answered - s.at), drawnMs: Math.round(at - s.at) })}`;
}
