// An account's Top up: its QR at once, its
// address, Copy address and Share, the first top-up's warning while phoenixd has no channel, and the fee credit,
// if any. When a top-up lands while it is open it says Received in place of all that,
// and Done closes it onto the page, where the row is.
import * as Clipboard from 'expo-clipboard';
import { Share } from 'react-native';
import type { Wallet } from '../cardd/client';
import { feeCreditText, lnurlFor } from '../cards/labels';
import { topUpWarning } from '../money/format';
import { useAmountView } from './amountView';
import { ResultPage } from './result';
import { Body, Button, Panel, QrTile, Row, Sheet, Title } from './ui';

/**
 * name: the account's ("Daily card", "Pool"); address: its Lightning address; liquidity: the wallet's, for the
 * warning and the fee credit; received: the words for a top-up that landed since the sheet opened (wallet/topUp.ts
 * receivedWords), or none.
 */
export function TopUpSheet({ name, address, liquidity, received, onClose }: {
  name: string; address: string; liquidity: Wallet['liquidity']; received?: { title: string; line: string; label: string } | null; onClose: () => void;
}) {
  // Every hook before the Received page's return: a top-up landing while the sheet is open must not change their order.
  const look = useAmountView();
  if (received) {
    return (
      <Sheet visible onClose={onClose}>
        <Title>Top up {name}</Title>
        <ResultPage view={{ tone: 'ok', mark: 'check', title: received.title, line: received.line }} label={received.label} onDone={onClose} />
      </Sheet>
    );
  }
  const warning = topUpWarning(liquidity, look.view, look.rated);
  const feeCredit = feeCreditText(liquidity?.feeCreditSat ?? 0, look.view, look.rated);
  return (
    <Sheet visible onClose={onClose}>
      <Title>Top up {name}</Title>
      {warning !== '' && (
        <Panel tone="warn">
          <Body>{warning}</Body>
        </Panel>
      )}
      <QrTile value={lnurlFor(address)} label="QR code for this address" />
      <Body selectable>{address}</Body>
      <Row>
        <Button title="Copy address" kind="secondary" onPress={() => Clipboard.setStringAsync(address)} />
        <Button title="Share" kind="secondary" onPress={() => void Share.share({ message: address }).catch(() => {})} />
      </Row>
      {feeCredit !== '' && <Body muted>{feeCredit}</Body>}
      <Body muted>Any Lightning wallet can pay this. It stays the same, so it can be saved.</Body>
    </Sheet>
  );
}
