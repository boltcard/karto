// The first screen: what Karto Wallet is in a line, the three things
// about to happen, and the two ways in.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { routeContext, useRouteGuard, useServices } from '../services/services';
import { restoredNote } from '../services/startRoute';
import { NumberLead } from '../ui/setup';
import { Body, Button, ErrorText, GroupLabel, ListGroup, ListRow, Screen, Title } from '../ui/ui';
import { WelcomeCard } from '../ui/wallet';

export default function Welcome() {
  const allowed = useRouteGuard('/welcome');
  const sv = useServices();
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    routeContext(sv).then((ctx) => setNote(restoredNote(ctx)));
  }, [sv]);
  if (!allowed) return <Screen busy />;
  return (
    // The app's name in the band, and whose cards it is for.
    <Screen title="Karto Wallet" subtitle="for Bolt Card">
      <WelcomeCard />
      <Title>Your own server for your Bolt Cards, run from this phone.</Title>
      <Body muted>
        Karto Wallet rents a small server from LNVPS and installs a card server on it. The money on your cards sits in a Lightning wallet
        on that server.
      </Body>
      <GroupLabel>What happens next</GroupLabel>
      {/* What each step asks of the person: paper, sats, minutes. The rows open nothing. */}
      <ListGroup>
        <ListRow lead={<NumberLead n={1} />} name="Write down 12 words" line="Your recovery phrase: the only way back to the server and its money." />
        <ListRow lead={<NumberLead n={2} />} name="Pay for the server" line="Over Lightning, from a wallet you already have. You choose how many days." divider />
        <ListRow lead={<NumberLead n={3} />} name="Wait while it installs" line="Up to about an hour: LNVPS has to confirm the new server before your wallet seed goes to it. You can leave the app while it waits." divider />
      </ListGroup>
      {note && <ErrorText>{note}</ErrorText>}
      <Button title="Set up a new server" onPress={() => router.push('/phrase')} />
      <Button title="I already have a recovery phrase" kind="secondary" onPress={() => router.push('/restore')} />
    </Screen>
  );
}
