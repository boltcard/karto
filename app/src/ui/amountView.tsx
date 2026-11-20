// The wallet's one view of every amount, held for the whole
// app: the unit amounts are shown in and whether they are hidden (Settings' Show amounts in and Hide amounts, the
// Wallet page's eye), the unit amounts are typed in, and the server's currency with its rate from the last wallet
// answer. An amount is text: nothing changes the view but those rows and the eye. The phone keeps the first three
// (AppStore kv); the rate rides on GET /api/v1/wallet. AmountViewWith takes its store, wallet answer and server as
// props: the app's provider (amountViewProvider.tsx) passes the real ones, a screen test its own (testing/viewKv.ts).
// Outside either, useAmountView() answers a still default: sat, shown, no rate, setters that change nothing.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { rated as ratedOf, type CurrencyCode, type Fiat, type Rated } from '../money/fiat';
import type { Unit, View } from '../money/view';
import type { AppStore } from '../store/store';
import { regionCurrency } from '../wallet/currencySetting';

/** Where the phone keeps the view: AppStore's six calls. */
export type ViewKv = Pick<AppStore, 'amountUnit' | 'setAmountUnit' | 'amountsHidden' | 'setAmountsHidden' | 'typingUnit' | 'setTypingUnit'>;
/** The server as the view needs it: its host, and its call to set the currency. */
export type ViewServer = { host: string; setCurrency(code: CurrencyCode | 'none'): Promise<Fiat> };

/**
 * view: the view as drawn now: *** while hidden, else the unit, £ drawn as sat while there is no rate. unit: the unit
 * kept (£ stays £ while its rate is still coming); hidden: whether amounts are hidden; setUnit, setHidden: Settings'
 * rows and the eye. rated: the currency with its rate, or null (no £ anywhere); fiat: what the server last said of
 * its currency, null before it said (or an older cardd, without currencies); typingUnit: what a field types in, sat
 * whenever there is no rate; chooseCurrency: Settings' list, applied at once from cardd's answer. The rate's age line
 * is ui/money.tsx RateAgeLine's.
 */
export type AmountViewState = {
  view: View; unit: Unit; hidden: boolean; setUnit(unit: Unit): void; setHidden(on: boolean): void; rated: Rated | null; fiat: Fiat | null;
  typingUnit: 'fiat' | 'sat'; setTypingUnit(unit: 'fiat' | 'sat'): void; chooseCurrency(code: CurrencyCode | 'none'): Promise<void>;
};

const STILL: AmountViewState = {
  view: 'sat', unit: 'sat', hidden: false, setUnit: () => {}, setHidden: () => {}, rated: null, fiat: null,
  typingUnit: 'sat', setTypingUnit: () => {}, chooseCurrency: () => Promise.reject(new Error('there is no server to set the currency on')),
};

const Ctx = createContext<AmountViewState>(STILL);

export const useAmountView = (): AmountViewState => useContext(Ctx);

/**
 * kv: where the view is kept (null: nowhere). answer: the last wallet answer; null while there is none, when the rate
 * it last had is kept (an old rate is still used). server: null until the watch holds the server's client.
 * region: the phone's region currency code, read when a server that never had a currency is given it.
 */
export function AmountViewWith({ kv, answer, server, region, children }: {
  kv: ViewKv | null; answer: { fiat?: Fiat } | null; server: ViewServer | null; region?: () => string | null | undefined; children: ReactNode;
}) {
  const [unit, setUnitNow] = useState<Unit>('sat');
  const [hidden, setHiddenNow] = useState(false);
  const [typing, setTyping] = useState<'fiat' | 'sat'>('fiat');
  // A change made before the kept values were read is not undone by them; each value on its own, so the eye pressed
  // early still lets the kept unit load.
  const touched = useRef({ unit: false, hidden: false, typing: false });
  useEffect(() => {
    if (!kv) return;
    let live = true;
    Promise.all([kv.amountUnit().catch(() => 'sat' as const), kv.amountsHidden().catch(() => false), kv.typingUnit().catch(() => 'fiat' as const)]).then(([u, h, t]) => {
      if (!live) return;
      if (!touched.current.unit) setUnitNow(u);
      if (!touched.current.hidden) setHiddenNow(h);
      if (!touched.current.typing) setTyping(t);
    });
    return () => {
      live = false;
    };
  }, [kv]);

  // What Settings' list set, until the next wallet answer says it (the currency's change answers a held read at once).
  const [pushed, setPushed] = useState<{ fiat: Fiat; over: { fiat?: Fiat } | null } | null>(null);
  const last = useRef<Fiat | null>(null);
  const answerNow = useRef(answer);
  const fiat = pushed && pushed.over === answer ? pushed.fiat : answer ? (answer.fiat ?? null) : last.current;
  useEffect(() => {
    last.current = fiat;
    answerNow.current = answer;
  }, [fiat, answer]);
  const rated = useMemo(() => ratedOf(fiat), [fiat]);
  const view: View = hidden ? 'hidden' : unit === 'fiat' && !rated ? 'sat' : unit;

  const setUnit = useCallback(
    (u: Unit) => {
      touched.current.unit = true;
      setUnitNow(u);
      kv?.setAmountUnit(u).catch(() => {});
    },
    [kv],
  );
  const setHidden = useCallback(
    (on: boolean) => {
      touched.current.hidden = true;
      setHiddenNow(on);
      kv?.setAmountsHidden(on).catch(() => {});
    },
    [kv],
  );
  // The currency becoming none moves a £ unit to sat. No rate yet moves nothing: £ is drawn as sat until one comes.
  const none = fiat?.currency === 'none';
  useEffect(() => {
    if (none && unit === 'fiat') setUnit('sat');
  }, [none, unit, setUnit]);

  const setTypingUnit = useCallback(
    (unit: 'fiat' | 'sat') => {
      touched.current.typing = true;
      setTyping(unit);
      kv?.setTypingUnit(unit).catch(() => {});
    },
    [kv],
  );
  // cardd's answer to a change of currency, shown until a wallet answer says it (unless the latest already does).
  const adopt = useCallback((f: Fiat) => {
    if (answerNow.current?.fiat?.currency !== f.currency) setPushed({ fiat: f, over: answerNow.current });
  }, []);
  const chooseCurrency = useCallback(
    async (code: CurrencyCode | 'none') => {
      if (!server) throw new Error('there is no server to set the currency on');
      chosen.current = true;
      try {
        adopt(await server.setCurrency(code));
      } catch (e) {
        chosen.current = false;
        throw e;
      }
    },
    [server, adopt],
  );

  // A server that has never had a currency is given this phone's region's, once, with nothing to tap. A
  // failure is tried again at the next wallet answer that still says never set.
  const regionSent = useRef<string | null>(null);
  // Never once the person has chosen a currency in this run: a stale wallet answer saying null must not replace it.
  const chosen = useRef(false);
  const unset = fiat?.currency === null && !chosen.current;
  // Re-runs on every new answer on purpose: the retry after a failed send depends on it.
  useEffect(() => {
    if (!unset || !server || !region || regionSent.current === server.host) return;
    regionSent.current = server.host;
    server.setCurrency(regionCurrency(region())).then(adopt, () => {
      regionSent.current = null;
    });
  }, [unset, server, region, answer, adopt]);

  const value = useMemo<AmountViewState>(
    () => ({
      view, unit, hidden, setUnit, setHidden, rated, fiat,
      typingUnit: rated ? typing : 'sat', setTypingUnit, chooseCurrency,
    }),
    [view, unit, hidden, setUnit, setHidden, rated, fiat, typing, setTypingUnit, chooseCurrency],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
