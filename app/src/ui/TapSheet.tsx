// A card held to the phone on a screen that doesn't claim NFC itself, when it isn't one of the person's
// ready cards (those open their account page): what it is and what fits it.
// One shape for every card: its face or a blank card's outline, the title and
// one line, a warning in amber, the tap check, the one thing to do as a button, Wipe the card as a red row, the
// state and version small, Close.
import { router } from 'expo-router';
import type { WalletCard } from '../cardd/client';
import { holdPress } from '../cards/holdPress';
import type { TapCheck } from '../cards/check';
import { sheetLink } from '../cards/hold';
import type { Identity } from '../cards/identify';
import { ACTION_LABELS, sheetFor, tapCheckText, type SheetAction } from '../cards/labels';
import { confirmView, viewText } from '../money/view';
import { wipeLine } from '../wallet/accountView';
import { useAmountView } from './amountView';
import { CardOutline } from './cards';
import { Body, Button, Callout, ErrorText, ListGroup, ListRow, Sheet, Small, Title, WarnText } from './ui';
import { CardFace } from './wallet';

/**
 * colour: the card's colour in the wallet (wallet/colours.ts colourOf); balanceMsat: one of the person's cards' available
 * balance, drawn in the app's view, when the wallet lists it; card: the wallet's record of it, for the wipe row's line; photo: its photo (a data: URI).
 */
export function TapSheet({ identity, check, colour, balanceMsat, card, photo, onClose }: {
  identity: Identity; check: TapCheck | null; colour: string; balanceMsat?: number; card?: Pick<WalletCard, 'balanceMsat' | 'heldMsat'>; photo?: string; onClose: () => void;
}) {
  const look = useAmountView();
  const s = sheetFor(identity);
  // The wipe row's money: a wipe confirms money, so in sat while ***.
  const wipe = wipeLine(card, confirmView(look.view), look.rated);
  const go = (a: SheetAction | 'wipe') => {
    onClose();
    if (a === 'add') router.push('/card-add');
    else if (a === 'adopt') router.push({ pathname: '/card-add', params: { op: 'adopt' } });
    // For the card just held: a wipe refuses any other, and the others show its name (cards/hold.ts sheetLink).
    else router.push({ pathname: '/card', params: { ...sheetLink(a, identity.id), press: holdPress() } });
  };
  return (
    <Sheet visible solid onClose={onClose}>
      {s.face === 'card' && (
        <CardFace
          name={identity.known?.name || 'Unnamed card'}
          colour={colour}
          balance={balanceMsat === undefined ? undefined : viewText(balanceMsat, look.view, look.rated)}
          dim={identity.known?.state === 'frozen'}
          ring={identity.needsRepoint}
          tag={identity.needsRepoint ? 're-point' : undefined}
          photo={photo}
        />
      )}
      {s.face === 'outline' && <CardOutline name="" placeholder="Blank card" />}
      <Title>{s.title}</Title>
      {s.body && <Body>{s.body}</Body>}
      {s.warning && <Callout><WarnText>{s.warning}</WarnText></Callout>}
      {check && (check.ok ? <Body>{tapCheckText(check)}</Body> : <ErrorText>{tapCheckText(check)}</ErrorText>)}
      {s.main && <Button title={ACTION_LABELS[s.main]} onPress={() => go(s.main!)} />}
      {s.wipe && (
        <ListGroup>
          <ListRow icon="wipe" name="Wipe the card" line={wipe.line} onPress={() => go('wipe')} disabled={wipe.disabled} danger />
        </ListGroup>
      )}
      {s.foot && <Small>{s.foot}</Small>}
      <Button title="Close" kind="secondary" onPress={onClose} />
    </Sheet>
  );
}
