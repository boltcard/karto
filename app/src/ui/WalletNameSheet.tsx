// The wallet's name, as a sheet: from Settings' Wallet name
// row, and over the wallet when it has none. Saves through the caller; stays open with the reason on a refusal.
import { useState } from 'react';
import { CarddError } from '../cardd/error';
import { moneyError } from '../money/format';
import { NAME_PAGE, walletNameProblem } from '../wallet/walletName';
import { Body, Button, ErrorText, Field, Sheet, Title } from './ui';

/** start: the field's first text. onSave: given the trimmed name; the sheet closes once it resolves. */
export function WalletNameSheet({ start, onSave, onClose }: { start: string; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = walletNameProblem(name);
  const save = async () => {
    if (busy || !problem.ok) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim());
      onClose();
    } catch (e) {
      setError(nameError(e));
      setBusy(false);
    }
  };
  return (
    <Sheet visible onClose={onClose}>
      <Title>{NAME_PAGE.title}</Title>
      <Body muted>{NAME_PAGE.body}</Body>
      <Field value={name} onChangeText={setName} editable={!busy} accessibilityLabel="Wallet name" />
      {problem.line !== '' && <ErrorText>{problem.line}</ErrorText>}
      <Button title={busy ? 'Saving…' : NAME_PAGE.save} onPress={() => void save()} disabled={busy || !problem.ok} />
      {error && <ErrorText>{error}</ErrorText>}
    </Sheet>
  );
}

/** A failed save's line: cardd's refusal of the name in the rule's words, anything else as the money screens say it. */
export const nameError = (e: unknown): string =>
  e instanceof CarddError && e.code === 'bad_name' ? "A name can't hold hidden characters." : moneyError(e);
