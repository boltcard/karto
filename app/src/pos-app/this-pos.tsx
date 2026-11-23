// This PoS: the phone's name in the shop, the shop's server, the sound switch, and Unpair this
// phone, which asks first (pairing again takes a new code from Karto Wallet); then the shop is asked to forget the
// phone, the phone forgets the shop, and Pair opens.
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { UpdateLine } from '../appUpdate/UpdateLine';
import { appVersion } from '../appUpdate/useAppUpdate';
import { usePos } from '../pos/app';
import { BUILD_LABEL } from '../pos/build';
import { unpair, unpairWords } from '../pos/pairing';
import { walletFact } from '../pos/names';
import { Fact, SwitchLine } from '../pos/parts';
import { Body, Button, Callout, ListGroup, ListRow, Panel, Screen, Small } from '../ui/ui';

export default function ThisPos() {
  const pos = usePos();
  const [asking, setAsking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  if (pos.paired === undefined || leaving) return <Screen title="This PoS" busy busyText={leaving ? unpairWords.busy : undefined} />;
  if (pos.paired === null) return <Redirect href="/pair" />;
  const leave = async () => {
    setLeaving(true);
    await unpair({ store: pos.store, forget: () => pos.ask((c) => c.forget()) });
    pos.setPaired(null);
    router.dismissTo('/pair');
  };
  return (
    <Screen title="This PoS" back>
      <Panel>
        <Fact label="Wallet" value={walletFact(pos.paired)} />
        <Fact label="This phone's name in the shop" value={pos.paired.name} />
        <Fact label="The shop's server" value={pos.paired.host} />
        <SwitchLine name="Sound when paid" value={pos.sound} onChange={pos.setSound} />
      </Panel>
      {asking ? (
        <Callout>
          <Body>{unpairWords.line}</Body>
          <Button title={unpairWords.unpair} kind="danger" onPress={() => void leave()} />
          <Button title={unpairWords.keep} kind="secondary" onPress={() => setAsking(false)} />
        </Callout>
      ) : (
        <ListGroup>
          <ListRow icon="cross" name={unpairWords.row} line={unpairWords.rowLine} danger acts onPress={() => setAsking(true)} />
        </ListGroup>
      )}
      <Small>{BUILD_LABEL(appVersion())}</Small>
      {/* A GitHub APK's and a .dev build's: asks GitHub for the latest release each time This PoS comes into view. */}
      <UpdateLine app="Karto PoS" />
    </Screen>
  );
}
