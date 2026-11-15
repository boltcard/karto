// Settings › Remove this wallet, on an iPhone only:
// deleting the app there removes neither the recovery phrase nor the phone's key, so this page does, with
// everything the app remembers, behind a warning and the lock. The server is not touched and is not told.
// removeWallet does the work and says where it stopped if it did.
import { router, Stack } from 'expo-router';
import { removalFailed } from '../onboarding/removeWallet';
import { usePhoneWallet } from '../services/server';
import { useRouteGuard } from '../services/services';
import { toStart, useLockedAct } from '../ui/lockedAct';
import { Body, Button, Callout, ErrorText, Screen, Title } from '../ui/ui';

const BAND = 'Remove this wallet';

export default function Remove() {
  const allowed = useRouteGuard('/remove');
  const wallet = usePhoneWallet();
  const remove = useLockedAct({ lock: { prompt: 'Remove this wallet', needs: 'removing this wallet' }, act: wallet.remove, failed: removalFailed });

  if (!allowed) return <Screen busy back />;
  // A removal that stopped may have taken what Settings and the wallet under this page showed: the arrow then goes
  // to where the app starts, which is the found-wallet screen once the app's memory is gone. The iPhone's swipe
  // from the edge would go to those pages instead, so it is off while a removal runs and once one has stopped.
  const swipe = <Stack.Screen options={{ gestureEnabled: !remove.busy && !remove.stopped }} />;
  if (remove.busy) {
    return (
      <>
        {swipe}
        <Screen title={BAND} busy />
      </>
    );
  }
  return (
    <Screen title={BAND} back={remove.stopped ? toStart : true}>
      {swipe}
      <Title>Remove this wallet from this iPhone</Title>
      <Body>
        This takes the recovery phrase, this phone&apos;s key and everything Karto Wallet remembers off this iPhone, with the backups kept on it.
      </Body>
      <Body>
        Your server is not touched. It keeps running, and keeps paying for itself from Hosting while there is money there; your cards keep working.
      </Body>
      <Callout>
        <Body>After this, the 12 words on your paper are the only way back to your server, cards and money. Check you have them first.</Body>
      </Callout>
      <Button title="Show recovery phrase" kind="secondary" onPress={() => router.push('/show-phrase')} />
      <Button title="Unlock to remove" kind="danger" onPress={remove.press} />
      {remove.error && <ErrorText>{remove.error}</ErrorText>}
    </Screen>
  );
}
