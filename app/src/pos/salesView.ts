// The Sales screen's words: the paid sales this till took, by day, with their prices
// (a till's history is only the payments taken on it; cardd lists no other's). A till never sees Shop's balance, nor what a sale brought in. The day and time words are Karto
// Wallet's (money/words.ts), so a day reads the same in both apps. With a shop currency
// a sale rung up in it shows its price, and one typed in sats its value
// now; the screen doesn't cycle.
import { dayStart, dayText, localTime, satText, thousands } from '../money/words';
import { fiatSpoken, fiatText, isCode, minorSpoken, minorText, type Rated } from '../money/fiat';
import type { PosDay, PosSale } from './client';

/**
 * line: the time and how it was paid; amount: the price with its plus, in the currency it was
 * rung up in or in sat; under: a priced sale's sats, or a sats sale's value now when the shop has a currency;
 * label: what TalkBack reads.
 */
export type SaleRow = { id: string; name: string; line: string; amount: string; under: string | null; label: string; refunded: boolean };
export type SalesDay = { day: string; rows: SaleRow[] };

const count = (n: number) => `${n} ${n === 1 ? 'sale' : 'sales'}`;

/** The panel over the list: "Today · 5 sales" with the day's total, or "No sales today" when the shop's newest day isn't this phone's today. */
export function salesHead(days: PosDay[], nowS: number, offsetMin: number, sales: PosSale[] = []): { title: string; total: string } {
  const start = dayStart(nowS, offsetMin);
  const today = days[0]?.day === start ? days[0] : null;
  if (today) return { title: `Today · ${count(today.count)}`, total: satText(today.totalMsat) };
  // Today's sales all refunded (the day count leaves them out): none counted, but not "No sales today" above them.
  if (allRefundedToday(sales, start, offsetMin)) return { title: `Today · ${count(0)}`, total: satText(0) };
  return { title: 'No sales today', total: '' };
}

/**
 * The till's paid sales, newest first as the shop lists them, grouped by the phone's day. A day the shop counted (days,
 * from sales/days in the phone's offset) says its count and total in its heading; another has its plain heading.
 * r: the shop's rate, for a sats sale's value now.
 */
export function salesDays(sales: PosSale[], days: PosDay[], nowS: number, offsetMin: number, r: Rated | null = null): SalesDay[] {
  const out: SalesDay[] = [];
  let lastStart = NaN;
  for (const s of sales) {
    const paidAt = s.paidAt ?? s.created;
    const { time } = localTime(paidAt, nowS, offsetMin);
    const under = [time, s.method === 'card' ? 'Card' : 'QR'];
    const sats = `${thousands(Math.floor(s.amountMsat / 1000))} sat`;
    // A currency a newer cardd knows and this app doesn't: shown as a sale typed in sats.
    const p = s.price && isCode(s.price.currency) ? s.price : null;
    // Refunded from Karto Wallet: marked once the refund is paid, not while it is on its way.
    const refunded = s.refund?.state === 'paid';
    const said = refunded ? ['refunded'] : [];
    const row: SaleRow = p
      ? { id: s.id, name: 'Sale', line: under.join(' · '), amount: `+${minorText(p.minor, p.currency)}`, under: sats, label: ['Sale', ...under, `plus ${minorSpoken(p.minor, p.currency)}`, sats, ...said].join(', '), refunded }
      : {
          id: s.id, name: 'Sale', line: under.join(' · '), amount: `+${sats}`, under: r ? `${fiatText(s.amountMsat, r)} now` : null,
          label: ['Sale', ...under, `plus ${sats}`, ...(r ? [`worth ${fiatSpoken(s.amountMsat, r)} now`] : []), ...said].join(', '), refunded,
        };
    // A sale dated a moment ahead of the phone's clock is today's (dayText), so it joins today's rows and heading.
    const start = Math.min(dayStart(paidAt, offsetMin), dayStart(nowS, offsetMin));
    if (start === lastStart) {
      out[out.length - 1].rows.push(row);
      continue;
    }
    lastStart = start;
    const counted = days.find((d) => d.day === start);
    out.push({ day: dayText(paidAt, nowS, offsetMin) + (counted ? ` · ${count(counted.count)} · ${satText(counted.totalMsat)}` : ''), rows: [row] });
  }
  // Today with no count and only refunded sales: counted as none, as salesHead says.
  const today = dayStart(nowS, offsetMin);
  if (out.length && !days.some((d) => d.day === today) && allRefundedToday(sales, today, offsetMin)) out[0].day += ` · ${count(0)} · ${satText(0)}`;
  return out;
}

/**
 * Whether the list has sales of today (the day starting at today, in the phone's offset; one dated a moment ahead of
 * the clock is today's too) and every one of them is refunded.
 */
function allRefundedToday(sales: PosSale[], today: number, offsetMin: number): boolean {
  const todays = sales.filter((s) => dayStart(s.paidAt ?? s.created, offsetMin) >= today);
  return todays.length > 0 && todays.every((s) => s.refund?.state === 'paid');
}
