// The till: a figure, a pad of
// twelve keys and Charge. With the shop's currency and its rate the pad types a price in it from its last digit, and a sat
// key types this sale in sats; the next sale starts in the currency again. Charge makes the sale's id and asks the
// shop's server for the price or the sats already in memory: nothing on the way to the sale screen waits on the rate.
// The rate is read as the till shows, every 5 minutes while it is in front, and as the app comes back to
// the front. pos/keypad.ts decides every key and every word.
import { randomUUID } from 'expo-crypto';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';
import { CarddError, isNoRate, isWrongCurrency } from '../cardd/error';
import { rated } from '../money/fiat';
import { usePos } from '../pos/app';
import { chargeAnswered, chargePressed } from '../pos/chargeTiming';
import { chargeLabel, chargeOf, figureText, retarget, startTyped, tillNote, typeKey, type Typed } from '../pos/keypad';
import { tillLine } from '../pos/names';
import { Figure, Keypad } from '../pos/parts';
import { Icon } from '../ui/icons';
import { Body, Button, ErrorText, Row, Screen, Small } from '../ui/ui';
import { useTheme } from '../ui/useTheme';

/** How often the till reads the shop's currency and rate while it is in front. */
const FIAT_EVERY_MS = 5 * 60_000;

export default function Till() {
  const pos = usePos();
  const t = useTheme();
  const { readFiat, readMe } = pos;
  const r = useMemo(() => rated(pos.fiat), [pos.fiat]);
  const [typed, setTyped] = useState<Typed>(() => startTyped(r));
  // The sat key was pressed for this sale: a rate that arrives meanwhile doesn't take the pad back to the currency.
  const [satKey, setSatKey] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowS, setNowS] = useState(() => Date.now() / 1000);
  // A sale was opened from here: the amount is cleared, and the pad back in the currency, when the till shows again.
  const sold = useRef(false);

  // The pad follows the rate: one that comes before anything is typed takes it to the currency (pos/keypad.ts retarget).
  useEffect(() => setTyped((now) => retarget(now, r, satKey)), [r, satKey]);

  useFocusEffect(
    useCallback(() => {
      if (sold.current) {
        sold.current = false;
        setSatKey(false);
        setTyped(startTyped(r));
        setError(null);
      }
    }, [r]),
  );

  // The shop's currency and rate: read as the till shows, every 5 minutes while it is in front, and as the app comes
  // back to the front. Never on Charge.
  useFocusEffect(
    useCallback(() => {
      const read = () => {
        setNowS(Date.now() / 1000);
        void readFiat();
        // Who this till is, and whose: a renamed wallet or till shows within 5 minutes, at once on coming back.
        void readMe();
      };
      read();
      const timer = setInterval(() => {
        if (AppState.currentState === 'active') read();
      }, FIAT_EVERY_MS);
      const sub = AppState.addEventListener('change', (s) => {
        if (s === 'active') read();
      });
      return () => {
        clearInterval(timer);
        sub.remove();
      };
    }, [readFiat, readMe]),
  );

  if (pos.paired === undefined) return <Screen busy />;
  if (pos.paired === null) return <Redirect href="/pair" />;

  const charge = async () => {
    setAsking(true);
    setError(null);
    try {
      // The price (or the sats) is in memory: nothing here waits on the rate.
      chargePressed(typed.unit === 'sat' ? 'sat' : 'fiat');
      const sale = await pos.ask((c) => c.newSale(randomUUID(), chargeOf(typed)));
      chargeAnswered(sale.id);
      pos.setSale(sale);
      sold.current = true;
      router.push('/sale');
    } catch (e) {
      // A refusal in the shop's own words (wrong_currency, no_rate, over the cap); no answer in the till's.
      setError(e instanceof CarddError ? e.message : "Can't reach the shop's server.");
      // The shop's currency or rate isn't what the till holds: read it again now, after the refusal (never before a
      // Charge), so the keypad is in the shop's currency for the next try (Review Focus 1).
      if (isWrongCurrency(e) || isNoRate(e)) void readFiat();
    } finally {
      setAsking(false);
    }
  };
  // The sat key: this sale in sats; pressed again (it then names the currency), back to the currency.
  const switchUnit = () => {
    const toSat = typed.unit !== 'sat';
    setSatKey(toSat);
    setTyped(toSat ? { unit: 'sat', sat: 0 } : startTyped(r));
    setError(null);
  };
  const button = chargeLabel(typed);
  const f = figureText(typed, r);
  const note = tillNote(pos.fiat, nowS);
  const sales = (
    <Pressable accessibilityRole="button" accessibilityLabel="Sales" hitSlop={12} onPress={() => router.push('/sales')} style={({ pressed }) => pressed && layout.dim}>
      <Icon name="list" colour={t.headerText} size={24} />
    </Pressable>
  );
  return (
    <Screen title="Karto PoS" right={sales}>
      <Figure figure={f.figure} unit={f.unit} label={f.label} under={f.under} />
      {note && <Small>{note}</Small>}
      <Keypad disabled={asking} onKey={(k) => setTyped((now) => typeKey(now, k, r))} />
      <Row>
        {r && <Button title={typed.unit === 'sat' ? r.currency : 'sat'} kind="secondary" onPress={switchUnit} disabled={asking} />}
        <View style={layout.grow}>
          <Button title={asking ? 'Making the sale…' : button.title} onPress={() => void charge()} disabled={button.off || asking} />
        </View>
      </Row>
      {/* After a no_rate refusal the till's own note says the same sentence: said once. */}
      {error && error !== note && <ErrorText>{error}</ErrorText>}
      <Small>{tillLine(pos.paired)}</Small>
      {/* Space under the name, so the pad doesn't sit on the screen's foot on a short phone. */}
      <Body muted> </Body>
    </Screen>
  );
}

const layout = StyleSheet.create({
  dim: { opacity: 0.5 },
  grow: { flex: 1 },
});
