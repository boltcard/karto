// Karto PoS's root: what its screens share (pos/app.tsx), the stack of screens on the theme's background, the
// status bar's light icons over every screen's dark title band, and the two things that open over whatever is in
// front: Paid, for a sale that had ended and was paid after all, and Removed.
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useRef } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { holdTaps } from '../cards/nfcSlot';
import { PosProvider, usePos } from '../pos/app';
import { removedWords } from '../pos/pairing';
import { PaidPage } from '../pos/parts';
import { afterOverlay } from '../pos/sale';
import { Body, Button, Panel, Screen } from '../ui/ui';
import { useTheme } from '../ui/useTheme';

export default function Layout() {
  const t = useTheme();
  // The window under the screens shows during transitions and behind the keyboard: the background colour.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(t.bg).catch(() => undefined);
  }, [t.bg]);
  return (
    <PosProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }} />
      <Over />
      <StatusBar style="light" />
    </PosProvider>
  );
}

/** Removed, or Paid for a watched sale, in place of whatever is in front. */
function Over() {
  const pos = usePos();
  const t = useTheme();
  const showing = pos.removed ? 'removed' : pos.paid ? 'paid' : null;
  // Leaving Paid: a sale that is open underneath is shown again, untouched; with none, the till.
  const newSale = () => {
    pos.clearPaid();
    if (afterOverlay(pos.sale) === 'till') router.dismissTo('/till');
  };
  const leave = useRef(newSale);
  leave.current = newSale;
  // While one of the two shows, Back and the taps are its own. Its Back listener is added when it opens, so it is
  // the newest and the first Android asks: the screen underneath (a sale, say) must not take Back as its own and
  // cancel its sale. Back on Paid is New sale; on Removed it does nothing: Pair again is the way on. And a card
  // held now is closed unread: the sale screen underneath would charge it and say Paid where nobody could see.
  // (Neither rests on this order alone: the sale screen declines Back and cards by itself while it is covered.)
  useEffect(() => {
    if (showing === null) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showing === 'paid') leave.current();
      return true;
    });
    const release = holdTaps(pos.slot);
    return () => {
      sub.remove();
      release();
    };
  }, [showing, pos.slot]);
  if (showing === 'removed') {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: t.bg }]}>
        <Screen title="Karto PoS">
          <Panel tone="warn">
            <Body>{removedWords.line}</Body>
          </Panel>
          <Button
            title={removedWords.again}
            onPress={() => {
              void pos.pairAgain().then(() => router.replace('/pair'));
            }}
          />
        </Screen>
      </View>
    );
  }
  if (showing === 'paid' && pos.paid) {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: t.bg }]}>
        <Screen title="Sale">
          <PaidPage sale={pos.paid.sale} how={pos.paid.how} onNewSale={newSale} />
        </Screen>
      </View>
    );
  }
  return null;
}
