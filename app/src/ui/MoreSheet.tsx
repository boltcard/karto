// A card's More, from ⋯ in its page's band:
// Limits and Change photo as rows, then the two red rows on their own, each saying first where the balance goes, so
// neither is one slip away: Wipe the card opens the hold-the-card screen for this card, which asks for the screen
// lock and refuses any other card; I no longer have this card gives it up without holding it, after a confirm and
// the screen lock.
import { router } from 'expo-router';
import { holdPress } from '../cards/holdPress';
import type { MoreRows } from '../wallet/accountView';
import { ListGroup, ListRow, Sheet, Small, Title } from './ui';

/** rows: wallet/accountView.ts moreRows; off: cardd can't be reached (Wipe works without it; Limits, Change photo and I no longer have this card don't); onLimits: open the Limits sheet. */
export function MoreSheet({ card, rows, off, onLimits, onGiveUp, onClose }: {
  card: { id: string; name: string }; rows: MoreRows; off: boolean; onLimits: () => void; onGiveUp: () => void; onClose: () => void;
}) {
  const photo = () => {
    onClose();
    router.push({ pathname: '/card-photo', params: { id: card.id } });
  };
  const wipe = () => {
    onClose();
    router.push({ pathname: '/card', params: { op: 'wipe', id: card.id, press: holdPress() } });
  };
  return (
    <Sheet visible onClose={onClose}>
      <Title>{card.name || 'Unnamed card'}</Title>
      <ListGroup>
        <ListRow icon="limits" name="Limits" line={rows.limits} onPress={onLimits} disabled={off} />
        <ListRow icon="photo" name="Change photo" line={rows.photo} onPress={photo} disabled={off} divider />
      </ListGroup>
      <ListGroup>
        <ListRow icon="wipe" name="Wipe the card" line={rows.wipe.line} onPress={wipe} disabled={rows.wipe.disabled} danger />
        {/* No card held: the server must answer, as a wipe's start needn't (giveUp.ts). */}
        <ListRow
          icon="lost"
          name="I no longer have this card"
          line={rows.giveUp.line}
          onPress={() => {
            onClose();
            onGiveUp();
          }}
          disabled={rows.giveUp.disabled || off}
          danger
          divider
        />
      </ListGroup>
      <Small>{rows.foot}</Small>
    </Sheet>
  );
}

/**
 * More for a phone that is a card: Limits, and for this phone's
 * own card Remove this phone's card in the place of Wipe, with the wipe's own line about the balance. No photo:
 * a phone has none. rows: wallet/phoneCardView.ts phoneMoreRows; onRemove asks for the screen lock, as a wipe does.
 */
export function PhoneMoreSheet({ card, rows, off, onLimits, onRemove, onClose }: {
  card: { name: string }; rows: { limits: string; remove: { line: string; disabled: boolean } | null; foot: string }; off: boolean;
  onLimits: () => void; onRemove: () => void; onClose: () => void;
}) {
  return (
    <Sheet visible onClose={onClose}>
      <Title>{card.name || 'Unnamed card'}</Title>
      <ListGroup>
        <ListRow icon="limits" name="Limits" line={rows.limits} onPress={onLimits} disabled={off} />
      </ListGroup>
      {rows.remove && (
        <ListGroup>
          <ListRow icon="wipe" name="Remove this phone's card" line={rows.remove.line} onPress={onRemove} disabled={rows.remove.disabled || off} danger />
        </ListGroup>
      )}
      <Small>{rows.foot}</Small>
    </Sheet>
  );
}
