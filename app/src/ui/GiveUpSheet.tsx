// "I no longer have this card": the confirm before the screen lock. It can't be undone, so it says what moves and
// what a card found later takes; the page closes it before asking for the lock (account.tsx).
import { Body, Button, Sheet, Title } from './ui';

/** line: giveUpLine's (the money that moves, and that taps are refused). */
export function GiveUpSheet({ name, line, onConfirm, onClose }: { name: string; line: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet visible onClose={onClose}>
      <Title>{`I no longer have ${name}`}</Title>
      <Body>{`It can't be undone. ${line} If the card turns up, hold it to the phone to finish wiping it, then add it again.`}</Body>
      <Button title="Remove the card" kind="danger" onPress={onConfirm} />
      <Button title="Cancel" kind="secondary" onPress={onClose} />
    </Sheet>
  );
}
