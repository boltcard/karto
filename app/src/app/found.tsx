// A wallet found on an iPhone: the app was deleted and
// installed again, and the Keychain kept the recovery phrase. The app says what it found and asks: carry on with
// that wallet (a restore with the words already here), or start a new one, which first removes the phrase, behind
// a warning. Both ask for the lock: carrying on pairs whoever holds the phone with the server and unpairs the
// person's other phones, as Pair this iPhone again does behind the same lock. Until the person has chosen, only
// this screen and Show recovery phrase open.
import { router } from 'expo-router';
import { useState } from 'react';
import { removalFailed } from '../onboarding/removeWallet';
import { usePhoneWallet } from '../services/server';
import { useRouteGuard } from '../services/services';
import { useLockedAct } from '../ui/lockedAct';
import { Body, Button, Callout, ErrorText, Screen, Title } from '../ui/ui';

/** The band, as Welcome's. */
const BAND = { title: 'Karto Wallet', subtitle: 'for Bolt Card' };

export default function Found() {
  const allowed = useRouteGuard('/found');
  const wallet = usePhoneWallet();
  const [page, setPage] = useState<'found' | 'new'>('found');
  const carry = useLockedAct({
    lock: { prompt: 'Carry on with this wallet', needs: 'carrying on with this wallet' },
    act: wallet.carryOn,
    failed: (e) => `Couldn't carry on with this wallet: ${e instanceof Error ? e.message : String(e)}`,
  });
  const remove = useLockedAct({
    lock: { prompt: 'Remove the recovery phrase', needs: 'removing the recovery phrase' },
    act: wallet.remove,
    failed: removalFailed,
  });

  if (!allowed || carry.busy || remove.busy) return <Screen {...BAND} busy />;
  if (page === 'new') {
    return (
      <Screen {...BAND} back={() => setPage('found')}>
        <Title>Start a new wallet</Title>
        <Callout>
          <Body>
            The recovery phrase on this iPhone will be removed. Without its 12 words on paper, the server, cards and money it belongs to can&apos;t be
            reached again.
          </Body>
        </Callout>
        <Button title="Show the words first" kind="secondary" onPress={() => router.push('/show-phrase')} />
        <Button title="Unlock to remove it" kind="danger" onPress={remove.press} />
        {remove.error && <ErrorText>{remove.error}</ErrorText>}
      </Screen>
    );
  }
  return (
    <Screen {...BAND}>
      <Title>This iPhone still has a wallet</Title>
      <Body>Karto Wallet was on this iPhone before, and its recovery phrase is still here.</Body>
      <Button title="Carry on with this wallet" onPress={carry.press} />
      <Body muted>Finds your server again and pairs this iPhone with it. Your other phones are unpaired; Karto PoS phones stay.</Body>
      {carry.error && <ErrorText>{carry.error}</ErrorText>}
      <Button title="Start a new wallet instead" kind="secondary" onPress={() => setPage('new')} />
    </Screen>
  );
}
