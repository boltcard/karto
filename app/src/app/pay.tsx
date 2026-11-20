// Pay with this phone: the phone is a card only while this
// screen shows. It asks for the screen lock, makes the phone a card for a minute, says when a till has read it and
// what was paid. The moments and what moves between them are phoneCard/pay.ts's; the words are
// wallet/phoneCardView.ts's; this draws them, ticks the seconds, and stops the card when the screen is left.
import { useKeepAwake } from 'expo-keep-awake';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState, StyleSheet, Vibration, View } from 'react-native';
import { availableMsat } from '../money/format';
import { Pay, type PayView } from '../phoneCard/pay';
import { useCardDeps, useServer } from '../services/server';
import { useRouteGuard, useServices } from '../services/services';
import { useAmountView } from '../ui/amountView';
import { PayPicture } from '../ui/cards';
import { screenLock } from '../ui/lock';
import { ReadBack } from '../ui/money';
import { ResultPage } from '../ui/result';
import { Body, Button, Callout, ErrorText, goBack, Screen, Small, Title } from '../ui/ui';
import { cantWords, overWords, paidWords, readWords, readyWords } from '../wallet/phoneCardView';

const TITLE = 'Pay';

export default function PayScreen() {
  const allowed = useRouteGuard('/pay');
  const sv = useServices();
  const deps = useCardDeps();
  const { snap, watch } = useServer();
  // The pay screen confirms money: its amounts in the app's view, in the chosen unit while *** (rule 5).
  const look = useAmountView();
  const cv = look.unit;
  const [view, setView] = useState<PayView>({ at: 'opening' });
  const [error, setError] = useState<string | null>(null);
  /** Pay again: the screen starts over, the lock asked afresh. */
  const [round, setRound] = useState(0);
  const pay = useRef<Pay | null>(null);
  useKeepAwake(); // the minute is the person's to hold the phone to the till in

  // This phone's card as the Wallet page has it: its name and state from the list, its money from the wallet.
  const own = snap.cards?.find((c) => c.id === snap.phoneCard.own);
  const money = snap.wallet?.cards.find((c) => c.id === snap.phoneCard.own);
  const state = useRef(own?.state ?? 'active');
  state.current = own?.state ?? 'active';

  useFocusEffect(
    useCallback(() => {
      if (!allowed || !deps) return;
      setView({ at: 'opening' });
      setError(null);
      const p = new Pay(
        {
          issuer: deps.issuer,
          host: deps.host,
          // Each call gives up after the few seconds a held card's calls do: the wait the screen asks the server
          // to hold its answer for (ASK_WAIT_S) is under that.
          cardd: deps.held,
          record: sv.phoneCardRecord,
          card: sv.phoneCard,
          slot: sv.nfcSlot,
          lock: () => screenLock('Pay with this phone', 'paying with this phone'),
          now: Date.now,
          wait: (ms) => new Promise((done) => setTimeout(done, ms)),
          onArmed: (armed) => void (sv.phoneCardArmed.on = armed),
          buzz: () => Vibration.vibrate(200),
        },
        setView,
      );
      pay.current = p;
      p.open({ state: state.current }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
      const timer = setInterval(() => {
        if (AppState.currentState === 'active') p.tick().catch(() => {});
      }, 1000);
      return () => {
        clearInterval(timer);
        // The counter moved and money may have: the Wallet page reads both again.
        void p.stop().then(() => watch.reloadCards(), () => {}).catch(() => {});
      };
    }, [allowed, deps, sv, watch, round]),
  );

  if (!allowed || !deps) return <Screen busy />;
  const name = own?.name || 'This phone';
  const stop = () => void pay.current?.stop();

  if (error) {
    return (
      <Screen title={TITLE} back>
        <ErrorText>{error}</ErrorText>
        <Button title="Back" kind="secondary" onPress={goBack} />
      </Screen>
    );
  }
  switch (view.at) {
    case 'opening':
      return <Screen title={TITLE} busy />;
    case 'back':
      return (
        <Screen title={TITLE} back>
          <Body>{view.text}</Body>
          <Button title="Back" kind="secondary" onPress={goBack} />
        </Screen>
      );
    case 'cant': {
      const w = cantWords(view.why, name);
      return (
        <Screen title={TITLE} back>
          <Callout>
            <Title>{w.title}</Title>
            <Body>{w.line}</Body>
          </Callout>
          {w.openCard && own && <Button title="Open the card" onPress={() => router.replace({ pathname: '/account', params: { id: own.id } })} />}
          <Button title="Back" kind="secondary" onPress={goBack} />
        </Screen>
      );
    }
    case 'ready': {
      const w = readyWords(view, { name, availableMsat: money ? availableMsat(money) : null, perTapSat: money?.perTapSat ?? null, limits: money?.limits }, cv, look.rated);
      return (
        <Screen title={TITLE} back>
          <PayPicture />
          {/* The large line is announced once; the count under it changes each second and is not. */}
          <View style={layout.centre}>
            <View accessible accessibilityLiveRegion="polite">
              <Title>{w.lead}</Title>
            </View>
            <Body muted>{w.wait}</Body>
          </View>
          {w.amount !== null && <ReadBack rows={[[w.label, w.amount]]} />}
          {w.warning !== null && (
            <Callout>
              <Body>{w.warning}</Body>
            </Callout>
          )}
          {w.small !== null && <Small>{w.small}</Small>}
          <Button title="Stop" kind="secondary" onPress={stop} />
        </Screen>
      );
    }
    case 'read': {
      const w = readWords(view);
      return (
        <Screen title={TITLE} back>
          <ResultPage view={{ tone: 'warn', mark: 'clock', title: w.title, line: w.lines.join('\n') }} />
          <Button title="Stop" kind="secondary" onPress={stop} />
        </Screen>
      );
    }
    case 'paid': {
      const w = paidWords(view, name, cv, look.rated);
      return (
        <Screen title={TITLE}>
          <ResultPage view={{ tone: 'ok', mark: 'check', title: `${w.title} ${w.amount}`, line: w.lines.join('\n') }} onDone={goBack} />
        </Screen>
      );
    }
    case 'over': {
      const w = overWords(view);
      return (
        <Screen title={TITLE} back>
          <ResultPage view={{ tone: 'warn', mark: 'dots', title: w.title, line: w.lines.join('\n') }} />
          <Button title="Pay again" onPress={() => setRound((n) => n + 1)} />
          <Button title="Done" kind="secondary" onPress={goBack} />
          <Small>Pay again asks for your screen lock.</Small>
        </Screen>
      );
    }
  }
}

const layout = StyleSheet.create({
  centre: { alignItems: 'center', gap: 4 },
});
