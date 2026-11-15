// Setting this phone up as a card: one page, from Add card's
// "This phone". What it means, said once; the name, the phone's own to begin with; Set up. Nothing is held to the
// phone and the lock is not asked: the card is empty until money is moved onto it. Its words are
// wallet/phoneCardView.ts's; the work is phoneCard/setup.ts's, finished by the wallet itself if it is cut off.
import * as Device from 'expo-device';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { CardInfo } from '../cardd/client';
import { holdTaps } from '../cards/nfcSlot';
import { deviceName } from '../native/deviceName';
import { setUpPhoneCard } from '../phoneCard/setup';
import { useCardDeps, useServer } from '../services/server';
import { phoneCardDeps, useRouteGuard, useServices } from '../services/services';
import { ResultPage } from '../ui/result';
import { Body, Button, ErrorText, Field, goBack, Label, Screen } from '../ui/ui';
import { canSetUp, phoneCardError, SET_UP, setUpDone } from '../wallet/phoneCardView';

export default function PhoneCard() {
  const allowed = useRouteGuard('/phone-card');
  const sv = useServices();
  const deps = useCardDeps();
  const { snap, watch } = useServer();
  const [name, setName] = useState(() => deviceName(Device.modelName));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CardInfo | null>(null);

  // A card held here is closed unread: its sheet would open over the keyboard.
  useFocusEffect(useCallback(() => holdTaps(sv.nfcSlot), [sv]));

  if (!allowed || !deps) return <Screen busy />;

  if (done) {
    const w = setUpDone(done.name || name);
    return (
      <Screen title={SET_UP.title}>
        <ResultPage view={{ tone: 'ok', mark: 'check', title: w.title, line: w.line }} onDone={() => router.replace({ pathname: '/move', params: { to: done.id } })} done={w.move} />
        <Button title="Done" kind="secondary" onPress={goBack} />
      </Screen>
    );
  }

  // A link to this page on a phone that can't be a card, or is one already, opens it with nothing to set up.
  if (!snap.phoneCard.supported || snap.phoneCard.record) {
    return (
      <Screen title={SET_UP.title} back>
        <Body>{snap.phoneCard.record ? 'This phone is already a card.' : "This phone can't be a card."}</Body>
      </Screen>
    );
  }

  const setUp = async () => {
    setBusy(true);
    setError(null);
    try {
      const card = await setUpPhoneCard(phoneCardDeps(sv, deps), name.trim());
      await watch.reloadCards().catch(() => {});
      setDone(card);
    } catch (e) {
      setError(phoneCardError(e));
      // What a set-up left part-way, the wallet finishes once it has the server's list again.
      void watch.reloadCards().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={SET_UP.title} back>
      {SET_UP.lines.map((line) => (
        <Body key={line}>{line}</Body>
      ))}
      <View style={layout.field}>
        <Label>Name</Label>
        <Field value={name} onChangeText={setName} maxLength={40} editable={!busy} />
      </View>
      {error && <ErrorText>{error}</ErrorText>}
      <Button title={SET_UP.button} disabled={!canSetUp(name, busy)} onPress={() => void setUp()} />
    </Screen>
  );
}

const layout = StyleSheet.create({
  field: { gap: 4 },
});
