// The sale: the amount, the invoice as a code for a phone wallet, and a card held
// to the back of the phone. This is the one screen that reads cards. It reads the sale each second, stays awake,
// and shows what pos/sale.ts saleStep makes of each event: waiting, card read, refused, paid, ran out. On an iPhone
// a card is read only under Apple's sheet: the code shows first, and
// Pay by card, where Android's hold row is, opens the sheet; pos/sheet.ts says what it is told.
import { randomUUID } from 'expo-crypto';
import { useKeepAwake } from 'expo-keep-awake';
import { Redirect, router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { CarddError, isRevoked } from '../cardd/error';
import { usePos } from '../pos/app';
import { chargeCard, refusalText } from '../pos/charge';
import { saleDrawn } from '../pos/chargeTiming';
import type { PosSale } from '../pos/client';
import { claimSale, readTap } from '../pos/nfc';
import { DotLine, PaidPage, SaleAmount } from '../pos/parts';
import { leftOpen, ranOutView, readsAgainAtOnce, readsNow, SALE_WAIT_S, saleFigure, saleQr, saleStart, saleStep, takesCard, waitingLine, type SaleEvent, type SaleState } from '../pos/sale';
import { cardButton, saleSheet, saleSheetEnd, type SaleSheetEvent } from '../pos/sheet';
import { Icon } from '../ui/icons';
import { ResultPage } from '../ui/result';
import { TYPE, type Theme } from '../ui/theme';
import { Body, Button, ErrorText, Panel, QrTile, Screen, WarnText } from '../ui/ui';
import { useAndroidBack } from '../ui/useBack';
import { useStyles, useTheme } from '../ui/useTheme';

export default function Sale() {
  const pos = usePos();
  if (!pos.sale) return <Redirect href="/till" />;
  // One screen per sale: a new sale for the same amount starts it afresh. No swipe back on an iPhone: a sale is
  // left by its own ways out (the band's arrow is Back), so it is cancelled or watched as on Android.
  return (
    <>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <OneSale key={pos.sale.id} first={pos.sale} />
    </>
  );
}

function OneSale({ first }: { first: PosSale }) {
  useKeepAwake();
  const pos = usePos();
  const t = useTheme();
  const s = useStyles(makeStyles);
  const [state, setState] = useState<SaleState>(() => saleStart(first));
  const [nowS, setNowS] = useState(() => Date.now() / 1000);
  const [again, setAgain] = useState<{ asking: boolean; error: string | null }>({ asking: false, error: null });
  // The state as it stands now, for answers that come later than the render that asked.
  const current = useRef(state);
  const reading = useRef(false);
  const cardBusy = useRef(false);
  const gone = useRef(false);
  // Paid for an earlier sale, or Removed, is over this screen: Back and a held card are that page's, not this sale's.
  const covered = useRef(false);
  covered.current = pos.paid !== null || pos.removed;
  // The shop this sale was made at: a sale handed over to be watched carries it, and is never asked of another.
  const shop = useRef(pos.paired?.host ?? '');
  // Apple's sheet, on an iPhone; null on Android, where the claim below reads any card held to the phone. sheet:
  // its state as last seen, for Pay by card's on and off, set after each call on it and at each end iOS reports.
  const session = pos.nfc.session;
  const [sheet, setSheet] = useState(() => session?.state() ?? null);
  /** Tells the sheet an event, if there is one: a call on a sheet that isn't open does nothing (native/nfc.ts). */
  const tell = useCallback(
    (e: SaleSheetEvent) => {
      if (!session) return;
      const c = saleSheet(e);
      if (c.call === 'close') session.close();
      else if (c.call !== 'open') session[c.call](c.line);
      setSheet(session.state());
    },
    [session],
  );

  // Charge to this screen's first frame, for adb logcat.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const line = saleDrawn(first.id);
      if (line) console.log(line);
    });
    return () => cancelAnimationFrame(frame);
  }, [first.id]);

  const send = useCallback(
    (e: SaleEvent) => {
      if (gone.current) return;
      const before = current.current;
      const out = saleStep(before, e);
      current.current = out.state;
      setState(out.state);
      // The sheet hears how the sale ended before the screen goes (leaving then closes it, which is then a no-op).
      const end = saleSheetEnd(before, out.state, e);
      if (end) tell(end);
      const sale = out.state.sale;
      for (const effect of out.effects) {
        // Neither is waited for: the sale's own state says what became of it.
        // With the card's return link, when its server gave one.
        if (effect === 'tell-card') {
          const link = e.kind === 'card' && e.outcome.kind === 'accepted' ? e.outcome.returnLink : undefined;
          void pos.ask((c) => c.cardRead(sale.id, link)).catch(() => undefined);
        }
        else if (effect === 'cancel') void pos.ask((c) => c.cancel(sale.id)).catch(() => undefined);
        else if (effect === 'buzz-refused') pos.buzzRefused();
        else if (effect === 'paid') pos.celebrate();
        else pos.watch({ id: sale.id, expires: sale.expires, why: effect === 'watch-cancelled' ? 'cancelled' : effect === 'watch-ran-out' ? 'ran-out' : 'stopped', host: shop.current });
      }
      if (out.leave) {
        gone.current = true;
        pos.setSale(null);
        router.dismissTo('/till');
      }
    },
    [pos, tell],
  );

  // The sheet's ends, as iOS reports them: Pay by card comes back on. Only an error of iOS's own says anything;
  // Cancel, the 60 seconds and the app leaving the front just bring the button back (as the wallet's hold screen).
  useEffect(() => {
    if (!session) return;
    return session.onEnd((e) => {
      setSheet(session.state());
      if (e.why === 'error' && current.current.at === 'waiting') send({ kind: 'sheet-error', text: e.error });
    });
  }, [session, send]);

  // Paid for an earlier sale, or Removed, over this screen: the sheet is closed. And when the screen goes.
  const isCovered = pos.paid !== null || pos.removed;
  useEffect(() => {
    if (isCovered) tell({ on: 'ended', to: 'leave' });
  }, [isCovered, tell]);
  useEffect(() => () => session?.close(), [session]);

  /** Pay by card: opens the sheet with the amount, unless one is up or still going. A refusal goes in the note. */
  const payByCard = () => {
    if (!session || session.state() !== 'none') return;
    // A new try: the last card's or sheet's note is cleared, as a card held to the phone clears it.
    send({ kind: 'card-held' });
    const f = saleFigure(current.current.sale);
    const c = saleSheet({ on: 'press', amount: `${f.figure} ${f.unit}` });
    if (c.call !== 'open') return;
    session
      .open(c.line)
      .catch((err: unknown) => send({ kind: 'sheet-error', text: err instanceof Error ? err.message : String(err) }))
      .finally(() => setSheet(session.state()));
    setSheet(session.state());
  };

  // Taken away by anything but its own ways out (the Paid page of an earlier sale and its New sale): a sale that
  // can still be paid goes on being read, so its payment opens Paid over whatever is in front.
  const watch = useRef(pos.watch);
  watch.current = pos.watch;
  useEffect(
    () => () => {
      if (gone.current) return;
      gone.current = true;
      const left = leftOpen(current.current, shop.current);
      if (left) watch.current(left);
    },
    [],
  );

  // Each second: the clock for the countdown and Card read's 30 seconds, and a read of the sale unless one is under
  // way. The shop holds a read's answer until the sale is paid (SALE_WAIT_S) and the next read starts as that one
  // ends, so Paid shows the moment the payment arrives; a shop that doesn't hold is read once a second.
  useEffect(() => {
    let live = true;
    const read = () => {
      // Under Apple's sheet the app may be 'inactive', and a payment by the code must still show (pos/sale.ts readsNow).
      if (!live || reading.current || current.current.at === 'paid' || !readsNow(AppState.currentState, (session?.state() ?? 'none') !== 'none')) return;
      reading.current = true;
      const started = Date.now();
      pos
        .ask((c) => c.sale(first.id, SALE_WAIT_S))
        .then(
          (sale) => send({ kind: 'read', sale }),
          // A removed phone gets the removed panel (pos.ask); anything else is no answer: it keeps asking.
          (e) => void (isRevoked(e) || send({ kind: 'offline' })),
        )
        .finally(() => {
          reading.current = false;
          if (readsAgainAtOnce(started, Date.now())) read();
        });
    };
    const timer = setInterval(() => {
      const nowMs = Date.now();
      setNowS(nowMs / 1000);
      send({ kind: 'tick', nowMs });
      read();
    }, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pos, first.id, send, session]);

  // The one place a card is read: its link, then its own server is asked to pay the sale's invoice. The claim is
  // made on both phones alike; on an iPhone a card arrives only inside the sheet,
  // which is told each step: a link read ends it with the tick (charging needs no card), and a card that can't pay
  // or was lifted too soon is asked for again in the sheet, with no note under it to go stale.
  useFocusEffect(
    useCallback(
      () =>
        claimSale(pos.slot, (tag) => {
          const now = current.current;
          if (!takesCard(now, cardBusy.current, covered.current)) return void tag.close();
          cardBusy.current = true;
          const sale = now.sale;
          send({ kind: 'card-held' });
          if (session) tell({ on: 'card' });
          void (async () => {
            const tap = await readTap(tag);
            if (session) {
              tell({ on: 'read', tap: tap.kind });
              if (tap.kind !== 'link') return;
            }
            const outcome = tap.kind === 'link' ? await chargeCard(pos.cardFetch, tap.link, sale.invoice!, sale.amountMsat) : tap;
            send({ kind: 'card', saleId: sale.id, outcome, nowMs: Date.now() });
          })().finally(() => (cardBusy.current = false));
        }),
      [pos, send, session, tell],
    ),
  );

  const back = () => send({ kind: 'back' });
  useAndroidBack(() => {
    // Under a page that is over this screen, Back is left to that page, whichever of the two Android asks first.
    if (covered.current) return false;
    back();
    return true;
  });

  const sale = state.sale;
  // Pay by card on an iPhone while the sale waits; null on Android, which shows its hold row.
  const card = cardButton(state, sheet);
  if (state.at === 'paid') {
    return (
      <Screen title="Sale">
        <PaidPage sale={sale} how={state.how} onNewSale={back} />
      </Screen>
    );
  }
  if (state.at === 'ran-out') {
    const v = ranOutView(sale, state.cancelled);
    const chargeAgain = async () => {
      setAgain({ asking: true, error: null });
      try {
        const next = await pos.ask((c) => c.newSale(randomUUID(), v.charge));
        // The sale that ran out is still watched, and this screen starts again for the new one.
        pos.watch({ id: sale.id, expires: sale.expires, why: state.cancelled ? 'cancelled' : 'ran-out', host: shop.current });
        gone.current = true;
        pos.setSale(next);
      } catch (e) {
        // A refusal in the shop's words: a price rung again after the shop's currency changed is wrong_currency.
        setAgain({ asking: false, error: e instanceof CarddError ? e.message : "Can't reach the shop's server." });
      }
    };
    return (
      <Screen title="Sale">
        <View accessible accessibilityLiveRegion="polite" style={layout.block}>
          {v.lines.map((line) => (
            <Body key={line}>{line}</Body>
          ))}
        </View>
        <SaleAmount sale={sale} />
        {again.error && <ErrorText>{again.error}</ErrorText>}
        <Button title={again.asking ? 'Making the sale…' : v.again} onPress={() => void chargeAgain()} disabled={again.asking} />
        <Button title="New sale" kind="secondary" onPress={back} />
      </Screen>
    );
  }
  if (state.at === 'card-read') {
    return (
      <Screen title="Sale">
        <SaleAmount sale={sale} />
        <ResultPage view={{ tone: 'warn', mark: 'clock', title: 'Card read', line: 'The card can be taken away. Waiting for its server to pay…' }} />
        {state.canLeave && (
          <>
            <Button title="Stop waiting" kind="secondary" onPress={() => send({ kind: 'stop-waiting' })} />
            <Button title="Back to the sale" kind="secondary" onPress={() => send({ kind: 'back-to-sale' })} />
          </>
        )}
      </Screen>
    );
  }
  if (state.at === 'refused') {
    return (
      <Screen title="Sale" back={back}>
        <SaleAmount sale={sale} />
        <View accessible accessibilityLiveRegion="assertive">
          <Panel tone="error" title="The card's server refused.">
            <Body>{refusalText(state)}</Body>
          </Panel>
        </View>
        <Body muted>Nothing was paid. The sale is still open: try another card, or show the code.</Body>
        <Button title="Back to the sale" onPress={() => send({ kind: 'back-to-sale' })} />
        <Button title="Cancel sale" kind="secondary" onPress={() => send({ kind: 'cancel' })} />
      </Screen>
    );
  }
  return (
    <Screen title="Sale" back={back}>
      <SaleAmount sale={sale} />
      {sale.invoice && <QrTile value={saleQr(sale.invoice)} label="QR code for this sale" size={204} />}
      <Body muted>Scan with a Lightning wallet</Body>
      <View style={layout.or}>
        <View style={s.rule} />
        <Text style={s.orText}>or</Text>
        <View style={s.rule} />
      </View>
      {card ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Pay by card"
          accessibilityState={{ disabled: !card.on }}
          disabled={!card.on}
          onPress={payByCard}
          style={({ pressed }) => [s.cardRow, (pressed || !card.on) && layout.dim]}
        >
          <Icon name="phone" colour={t.muted} size={28} />
          <Text style={s.cardText}>Pay by card</Text>
        </Pressable>
      ) : (
        <View style={s.cardRow}>
          <Icon name="phone" colour={t.muted} size={28} />
          <Text style={s.cardText}>Hold a Bolt Card to the back of this phone</Text>
        </View>
      )}
      {state.note !== '' && <WarnText>{state.note}</WarnText>}
      <DotLine>{waitingLine(sale, nowS, state.online)}</DotLine>
      <Button title="Cancel sale" kind="secondary" onPress={() => send({ kind: 'cancel' })} />
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    rule: { flex: 1, height: 1, backgroundColor: t.line },
    orText: { ...TYPE.small, color: t.muted },
    cardRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 14 },
    cardText: { ...TYPE.body, fontWeight: '600', color: t.text, flex: 1 },
  });

const layout = StyleSheet.create({
  or: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  block: { gap: 4 },
  dim: { opacity: 0.5 },
});
