// Name this wallet, the page at the end of setup, over the wallet:
// its name, which Karto PoS phones show beside their own, prefilled with the phone's model. Save names it; leaving
// without saving is allowed (the wallet asks again on a later start). Either way the wallet isn't asked again in this
// run. With alerts=1 the Alerts step follows, counted as the one offer here, as it opens, and in this page's place,
// so Back from it is the wallet (app/alerts.tsx toWallet); else the wallet.
import * as Device from 'expo-device';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { offerShown } from '../alerts/offer';
import { deviceName } from '../native/deviceName';
import { useCardDeps } from '../services/server';
import { useRouteGuard, useServices, walletStore } from '../services/services';
import { useAndroidBack } from '../ui/useBack';
import { Body, Button, ErrorText, Field, Screen } from '../ui/ui';
import { nameError } from '../ui/WalletNameSheet';
import { askedThisRun, NAME_PAGE, namePrefill, walletNameProblem } from '../wallet/walletName';

export default function WalletName() {
  const allowed = useRouteGuard('/wallet-name');
  const sv = useServices();
  const deps = useCardDeps();
  const { alerts } = useLocalSearchParams<{ setup?: string; alerts?: string }>();
  const [name, setName] = useState(() => namePrefill(deviceName(Device.modelName)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Leaving has begun: a second press, or Back during the save, does nothing.
  const going = useRef(false);
  const problem = walletNameProblem(name);
  // Shown is asked, however the page is left: Home doesn't ask again in this run.
  const host = deps?.host;
  useEffect(() => {
    if (host) askedThisRun.add(host);
  }, [host]);

  const leave = async () => {
    if (alerts === '1') {
      // Not counted (the phone's store failed): no step, and the wallet's own sheet asks later.
      const counted = await offerShown({ store: walletStore(sv) }).then(() => true, () => false);
      if (counted) return router.replace({ pathname: '/alerts', params: { setup: '1' } });
    }
    if (router.canGoBack()) router.back();
    else router.replace('/home');
  };
  const leaveOnce = () => {
    if (going.current) return;
    going.current = true;
    void leave();
  };
  const save = async () => {
    if (going.current || !deps || !problem.ok) return;
    going.current = true;
    setBusy(true);
    setError(null);
    try {
      await deps.cardd.setWalletName(name.trim());
    } catch (e) {
      setError(nameError(e));
      setBusy(false);
      going.current = false;
      return;
    }
    await leave();
  };
  useAndroidBack(() => {
    leaveOnce();
    return true;
  });

  if (!allowed || !deps) return <Screen busy />;
  return (
    <Screen title={NAME_PAGE.title} back={leaveOnce}>
      {/* No swipe back on an iPhone: it would leave without the Alerts step that follows (the arrow and Android's Back go through leave). */}
      <Stack.Screen options={{ gestureEnabled: false }} />
      <Body>{NAME_PAGE.body}</Body>
      <Field value={name} onChangeText={setName} editable={!busy} accessibilityLabel="Wallet name" />
      {problem.line !== '' && <ErrorText>{problem.line}</ErrorText>}
      <Button title={busy ? 'Saving…' : NAME_PAGE.save} onPress={() => void save()} disabled={busy || !problem.ok} />
      {error && <ErrorText>{error}</ErrorText>}
    </Screen>
  );
}
