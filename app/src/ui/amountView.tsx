// The wallet's one view of every amount, held for the whole
// app: the view a tap on any amount moves on, Show msat amounts, the unit amounts are typed in, and the server's
// currency with its rate from the last wallet answer. The phone keeps the first three (AppStore kv); the rate rides on
// GET /api/v1/wallet. AmountViewWith takes its store, wallet answer and server as props: the app's provider
// (amountViewProvider.tsx) passes the real ones, a screen test its own (testing/viewKv.ts). Outside either,
// useAmountView() answers a still default: sat, no rate, a tap changes nothing.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { rated as ratedOf, type CurrencyCode, type Fiat, type Rated } from '../money/fiat';
import { nextView, settleView, type View } from '../money/view';
import type { AppStore } from '../store/store';
import { regionCurrency } from '../wallet/currencySetting';

/** Where the phone keeps the view: AppStore's six calls. */
export type ViewKv = Pick<AppStore, 'amountView' | 'setAmountView' | 'showMsat' | 'setShowMsat' | 'typingUnit' | 'setTypingUnit'>;
/** The server as the view needs it: its host, and its call to set the currency. */
export type ViewServer = { host: string; setCurrency(code: CurrencyCode | 'none'): Promise<Fiat> };

/**
 * view: the view as drawn now (the kept one, settled against what is allowed); rated: the currency with its rate, or
 * null (no £ anywhere); fiat: what the server last said of its currency, null before it said (or an older cardd,
 * without currencies); next: a tap on an amount; typingUnit: what a field types in, sat whenever there is no rate;
 * chooseCurrency: Settings' list, applied at once from cardd's answer. The rate's age line is ui/money.tsx RateAgeLine's.
 */
export type AmountViewState = {
  view: View; rated: Rated | null; fiat: Fiat | null; showMsat: boolean; next(): void; setShowMsat(on: boolean): void;
  typingUnit: 'fiat' | 'sat'; setTypingUnit(unit: 'fiat' | 'sat'): void; chooseCurrency(code: CurrencyCode | 'none'): Promise<void>;
};

const STILL: AmountViewState = {
  view: 'sat', rated: null, fiat: null, showMsat: false, next: () => {}, setShowMsat: () => {},
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
  const [stored, setStored] = useState<View>('sat');
  const [msat, setMsat] = useState(false);
  const [typing, setTyping] = useState<'fiat' | 'sat'>('fiat');
  // A change made before the kept values were read is not undone by them.
  const touched = useRef(false);
  useEffect(() => {
    if (!kv) return;
    let live = true;
    Promise.all([kv.amountView().catch(() => 'sat' as const), kv.showMsat().catch(() => false), kv.typingUnit().catch(() => 'fiat' as const)]).then(([v, m, u]) => {
      if (!live || touched.current) return;
      setStored(v);
      setMsat(m);
      setTyping(u);
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
  const canFiat = rated !== null;
  const view = settleView(stored, { fiat: canFiat, msat });

  const keep = useCallback(
    (v: View) => {
      touched.current = true;
      setStored(v);
      kv?.setAmountView(v).catch(() => {});
    },
    [kv],
  );
  // The currency becoming none moves a £ view to sat. No rate yet moves nothing: £ is drawn as sat until one comes.
  const none = fiat?.currency === 'none';
  useEffect(() => {
    if (none && stored === 'fiat') keep('sat');
  }, [none, stored, keep]);

  const next = useCallback(() => keep(nextView(view, { fiat: canFiat, msat })), [keep, view, canFiat, msat]);
  const setShowMsat = useCallback(
    (on: boolean) => {
      touched.current = true;
      setMsat(on);
      kv?.setShowMsat(on).catch(() => {});
      if (!on && stored === 'msat') keep('sat');
    },
    [kv, stored, keep],
  );
  const setTypingUnit = useCallback(
    (unit: 'fiat' | 'sat') => {
      touched.current = true;
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
      view, rated, fiat, showMsat: msat, next, setShowMsat,
      typingUnit: rated ? typing : 'sat', setTypingUnit, chooseCurrency,
    }),
    [view, rated, fiat, msat, next, setShowMsat, typing, setTypingUnit, chooseCurrency],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
