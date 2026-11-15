// The words both apps say: amounts in whole sats, and times
// and days in the phone's time zone. A leaf: it imports nothing of the project, so Karto PoS can use it without
// Karto Wallet's code coming with it. money/format.ts and cards/labels.ts hand these on under their old names.

/** A whole number with its thousands split by commas: "13,438". A regex, not toLocaleString: Hermes's Intl support depends on how it was built. */
export const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** An msat amount as whole sats, rounded down: "5,012 sat". */
export function satText(msat: number): string {
  return `${thousands(Math.floor(msat / 1000))} sat`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The first second of the phone's day a time falls in (offsetMin: minutes east of UTC), as cardd's sales/days names a day. */
export const dayStart = (unixS: number, offsetMin: number) => Math.floor((unixS + offsetMin * 60) / 86_400) * 86_400 - offsetMin * 60;

/** A time in the phone's time zone (offsetMin: minutes east of UTC; no Intl, which Hermes may lack): its clock, its date, and how many days before now's day it is. */
export function localTime(unixS: number, nowS: number, offsetMin: number): { time: string; date: string; ago: number } {
  const local = (s: number) => new Date(s * 1000 + offsetMin * 60_000);
  const d = local(unixS);
  const now = local(nowS);
  const p = (n: number) => String(n).padStart(2, '0');
  const dayNumber = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) / 86_400_000;
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return {
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    date: d.getUTCFullYear() === now.getUTCFullYear() ? date : `${date} ${d.getUTCFullYear()}`,
    ago: dayNumber(now) - dayNumber(d),
  };
}

/** A time in full for a payment's page: "15 Oct 2026, 08:01:12", in the phone's time zone. */
export function fullTime(unixS: number, offsetMin: number): string {
  const d = new Date(unixS * 1000 + offsetMin * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * A time as Settings and its pages say it: "today at 11:24", "yesterday at
 * 22:52", "7 Oct at 22:52", and with the year when it isn't this one's ("7 Oct 2025 at 22:52"), on a 24-hour clock in
 * the phone's time zone.
 */
export function whenText(unixS: number, nowS: number, offsetMin: number): string {
  const { time, date, ago } = localTime(unixS, nowS, offsetMin);
  return `${ago === 0 ? 'today' : ago === 1 ? 'yesterday' : date} at ${time}`;
}

/** A date alone, "14 Nov", with the year when it isn't this one's ("14 Nov 2027"): the day the server is paid until. */
export const shortDate = (unixS: number, nowS: number, offsetMin: number): string => localTime(unixS, nowS, offsetMin).date;

/** A day as the history's headings say it: "Today" (and for a time yet to come), "Yesterday", then the date as shortDate. */
export function dayText(unixS: number, nowS: number, offsetMin: number): string {
  const { date, ago } = localTime(unixS, nowS, offsetMin);
  // An entry a moment ahead of the phone's clock (the server's is a little fast, across midnight) is today's, not a day of its own above Today.
  return ago <= 0 ? 'Today' : ago === 1 ? 'Yesterday' : date;
}
