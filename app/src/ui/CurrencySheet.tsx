// Settings' Currency list: None and the seven, the server's one
// ticked. A choice is sent to the server (PUT /api/v1/currency): every phone of it then shows and takes amounts in
// it, its PoS phones too. Closes once the server has it; says why when it refuses.
import { useState } from 'react';
import type { CurrencyCode } from '../money/fiat';
import { moneyError } from '../money/format';
import { CURRENCY_CHOICES } from '../wallet/currencySetting';
import { Body, ErrorText, ListGroup, ListRow, Sheet, Title } from './ui';

export function CurrencySheet({ current, onChoose, onClose }: {
  current: CurrencyCode | 'none' | null; onChoose: (code: CurrencyCode | 'none') => Promise<void>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (code: CurrencyCode | 'none') => {
    if (busy) return;
    if (code === current) return onClose();
    setBusy(true);
    setError(null);
    try {
      await onChoose(code);
      onClose();
    } catch (e) {
      setError(moneyError(e));
      setBusy(false);
    }
  };
  return (
    <Sheet visible onClose={onClose}>
      <Title>Currency</Title>
      <Body muted>Amounts are shown and typed in it, on this phone and on your PoS phones.</Body>
      <ListGroup>
        {CURRENCY_CHOICES.map((c, i) => (
          <ListRow key={c.value} name={c.name} selected={c.value === current} disabled={busy} divider={i > 0} onPress={() => void choose(c.value)} />
        ))}
      </ListGroup>
      {error && <ErrorText>{error}</ErrorText>}
    </Sheet>
  );
}
