// This PoS: the phone's name in the shop, the shop's server, the sound switch, and Unpair this
// phone, which acts at once: the shop is asked to forget the phone, the phone forgets the shop, and Pair opens.
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { usePos } from '../pos/app';
import { BUILD_LABEL } from '../pos/build';
import { unpair } from '../pos/pairing';
import { walletFact } from '../pos/names';
import { Fact, SwitchLine } from '../pos/parts';
import { ListGroup, ListRow, Panel, Screen, Small } from '../ui/ui';

export default function ThisPos() {
  const pos = usePos();
  const [leaving, setLeaving] = useState(false);
  if (pos.paired === undefined || leaving) return <Screen title="This PoS" busy busyText={leaving ? 'Unpairing…' : undefined} />;
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
      <ListGroup>
        <ListRow icon="cross" name="Unpair this phone" line="It stops taking payments. The shop's sales stay." danger acts onPress={() => void leave()} />
      </ListGroup>
      <Small>{BUILD_LABEL()}</Small>
    </Screen>
  );
}
