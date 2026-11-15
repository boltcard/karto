// Opens the right screen: welcome, country, onboarding or home, or the question a wallet found on an iPhone asks.
// If the phone can't be read it says so, with Try again, and opens none.
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { reopenAppDb, routeContext, useServices } from '../services/services';
import { startFrom } from '../services/startRoute';
import { Body, Button, Screen } from '../ui/ui';

/** A failed read, for adb logcat; no secrets. */
const logRead = (e: unknown) => console.log('CARDAPP-START', JSON.stringify({ read: e instanceof Error ? e.message : String(e) }));

export default function Index() {
  const sv = useServices();
  const [start, setStart] = useState<Awaited<ReturnType<typeof startFrom>> | null>(null);
  // Bumped by Try again, which reads the phone afresh.
  const [reading, setReading] = useState(0);
  useEffect(() => {
    let gone = false;
    startFrom(() => routeContext(sv), logRead).then((s) => !gone && setStart(s));
    return () => {
      gone = true;
    };
  }, [sv, reading]);
  // A database connection that no longer answers is replaced first, so Try again can work without the app
  // being stopped; a phone not yet unlocked is only read again.
  const tryAgain = () => {
    setStart(null);
    void sv.store
      .reconnect(reopenAppDb)
      .catch(logRead)
      .finally(() => setReading((n) => n + 1));
  };
  if (!start) return <Screen busy />;
  if ('route' in start) return <Redirect href={start.route} />;
  return (
    <Screen>
      <Body>{start.cantRead}</Body>
      <Button title="Try again" onPress={tryAgain} />
    </Screen>
  );
}
