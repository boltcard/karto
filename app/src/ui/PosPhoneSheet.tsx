// A PoS phone's sheet, from the PoS phones page: Rename, with the
// name's rules and cardd's refusal, and Remove, which acts at once with no second question: pairing again undoes it.
import { useState } from 'react';
import type { CarddClient, PosPhone } from '../cardd/client';
import { nameProblem, posError, type PhoneRow } from '../wallet/posPhones';
import { Body, Button, ErrorText, Field, Label, ListGroup, ListRow, Sheet, Title } from './ui';

/** phones: the list, for the name's rules. off: cardd can't be reached. onChanged: renamed or removed (close, and read the list again). */
export function PosPhoneSheet({ row, phones, cardd, off, onChanged, onClose }: {
  row: PhoneRow; phones: PosPhone[]; cardd: Pick<CarddClient, 'renameShopPhone' | 'removeShopPhone'>; off: boolean; onChanged: () => void; onClose: () => void;
}) {
  const [name, setName] = useState(row.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const problem = nameProblem(name, phones, row.keyId);

  const run = (what: 'save' | 'remove', fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    fn().then(onChanged, (e) => {
      setError(posError(e));
      setBusy(null);
    });
  };

  return (
    <Sheet visible onClose={onClose}>
      <Title>{row.name}</Title>
      <Label>Rename</Label>
      <Field value={name} onChangeText={setName} editable={!busy} />
      {problem.line !== '' && <ErrorText>{problem.line}</ErrorText>}
      <Button
        title={busy === 'save' ? 'Saving…' : 'Save'}
        kind="secondary"
        onPress={() => run('save', () => cardd.renameShopPhone(row.keyId, name.trim()))}
        disabled={off || busy !== null || !problem.ok || name.trim() === row.name}
      />
      <ListGroup>
        <ListRow
          icon="cross"
          name={busy === 'remove' ? 'Removing…' : 'Remove this PoS phone'}
          line="It stops taking payments at once. Its sales stay in Shop."
          danger
          acts
          disabled={off || busy !== null}
          onPress={() => run('remove', () => cardd.removeShopPhone(row.keyId))}
        />
      </ListGroup>
      {error && <ErrorText>{error}</ErrorText>}
      <Body muted>{row.foot}</Body>
    </Sheet>
  );
}
