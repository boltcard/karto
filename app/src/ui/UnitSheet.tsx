// Settings' Show amounts in list: the server's currency, sat and
// msat, the kept one ticked. A choice is this phone's alone (amounts are hidden apart from it, by Hide amounts and
// the Wallet page's eye) and closes the list.
import type { Fiat } from '../money/fiat';
import type { Unit } from '../money/view';
import { unitChoices } from '../wallet/currencySetting';
import { Body, ListGroup, ListRow, Sheet, Title } from './ui';

export function UnitSheet({ unit, fiat, onChoose, onClose }: { unit: Unit; fiat: Fiat | null; onChoose: (unit: Unit) => void; onClose: () => void }) {
  return (
    <Sheet visible onClose={onClose}>
      <Title>Show amounts in</Title>
      <Body muted>On this phone. Hide amounts, or the eye on the Wallet page, shows *** in place of each.</Body>
      <ListGroup>
        {unitChoices(fiat).map((c, i) => (
          <ListRow
            key={c.value}
            name={c.name}
            line={c.off ? 'Choose a currency first' : undefined}
            selected={c.value === unit}
            disabled={c.off}
            divider={i > 0}
            onPress={() => {
              onChoose(c.value);
              onClose();
            }}
          />
        ))}
      </ListGroup>
    </Sheet>
  );
}
