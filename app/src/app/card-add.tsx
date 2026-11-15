// Add card's first step: the name, on a card's outline as it
// is typed, and the row that hides the card's ID from readers (random UID, on unless switched off). Then the
// hold-the-card screen. Adding back a card the server doesn't know (op adopt) asks only the name.
// What it shows and passes on is cards/hold.ts's nameView.
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { holdPress } from '../cards/holdPress';
import { ADD_BAR, NAME_HINT, nameView } from '../cards/hold';
import { holdTaps } from '../cards/nfcSlot';
import { useServer } from '../services/server';
import { useRouteGuard, useServices } from '../services/services';
import { CardOutline, SwitchRow } from '../ui/cards';
import { StepBar } from '../ui/money';
import { Body, Button, Field, Label, ListGroup, ListRow, Screen, Title } from '../ui/ui';
import { asksWhatToAdd, WHAT_TO_ADD } from '../wallet/phoneCardView';

export default function CardAdd() {
  const allowed = useRouteGuard('/card-add');
  const sv = useServices();
  const adopt = useLocalSearchParams<{ op?: string }>().op === 'adopt';
  const { snap } = useServer();
  const [name, setName] = useState('');
  const [hide, setHide] = useState(true);
  /** The person chose a plastic card where the phone was offered too. */
  const [plastic, setPlastic] = useState(false);

  // A card held here is closed unread: the card about to be added, held a moment early, would raise its sheet
  // over the keyboard, and the sheet's Add card would push a second name screen.
  useFocusEffect(useCallback(() => holdTaps(sv.nfcSlot), [sv]));

  if (!allowed) return <Screen busy />;
  // Where this phone can be a card and is not one, Add card first asks what is being added.
  // An iPhone, and a phone that is a card already, go straight on.
  if (!adopt && !plastic && asksWhatToAdd({ supported: snap.phoneCard.supported, hasRecord: !!snap.phoneCard.record })) {
    return (
      <Screen title="Add a card" back>
        <Title>{WHAT_TO_ADD.lead}</Title>
        <ListGroup>
          <ListRow icon="pay" name={WHAT_TO_ADD.card.name} line={WHAT_TO_ADD.card.line} onPress={() => setPlastic(true)} />
          <ListRow icon="phone" name={WHAT_TO_ADD.phone.name} line={WHAT_TO_ADD.phone.line} onPress={() => router.replace('/phone-card')} divider />
        </ListGroup>
      </Screen>
    );
  }
  const v = nameView(adopt, name, hide);
  return (
    <Screen title={v.band} back>
      <StepBar names={ADD_BAR} at={0} />
      <CardOutline name={v.outline.name} placeholder={v.outline.placeholder} small />
      {v.intro && <Body>{v.intro}</Body>}
      <View style={layout.field}>
        <Label>Name</Label>
        <Field value={name} onChangeText={setName} placeholder={NAME_HINT} maxLength={40} autoFocus />
      </View>
      {v.note && <Body muted>{v.note}</Body>}
      {v.row && <SwitchRow icon="hide" name={v.row.name} line={v.row.line} value={hide} onChange={setHide} />}
      <Button title="Continue" disabled={!v.canContinue} onPress={() => router.replace({ pathname: '/card', params: { ...v.next, press: holdPress() } })} />
    </Screen>
  );
}

const layout = StyleSheet.create({
  field: { gap: 4 },
});
