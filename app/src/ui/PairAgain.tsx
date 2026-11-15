// Pair this iPhone again, on the Server and Backups
// pages of a phone whose phrase outlives the app and whose server no longer knows it: behind the lock, the phone
// gets a new key and the app starts a restore with the words it has. wallet/pairAgain.ts says when and with what words.
import { usePhoneWallet } from '../services/server';
import { PAIR_AGAIN } from '../wallet/pairAgain';
import { useLockedAct } from './lockedAct';
import { Body, Button, ErrorText } from './ui';

export function PairAgain() {
  const wallet = usePhoneWallet();
  const pair = useLockedAct({
    lock: { prompt: PAIR_AGAIN.lockTitle, needs: 'pairing this iPhone again' },
    act: wallet.carryOn,
    failed: (e) => `Couldn't pair this iPhone again: ${e instanceof Error ? e.message : String(e)}`,
  });
  return (
    <>
      <Button title={PAIR_AGAIN.button} onPress={pair.press} disabled={pair.busy} />
      <Body muted>{PAIR_AGAIN.line}</Body>
      {pair.error && <ErrorText>{pair.error}</ErrorText>}
    </>
  );
}
