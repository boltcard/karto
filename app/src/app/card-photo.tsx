// A card's photo: from More › Change
// photo, or as Add card's photo step (step=add, or adopt after adding a card back). Take photo opens our own card
// camera; its Use photo sends the thumbnail to cardd at once. What stands around the face in each
// state is cardphoto/screen.ts's photoView.
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, PermissionsAndroid, Platform, StyleSheet, Text, View } from 'react-native';
import { CardCamera } from '../cardphoto/CardCamera';
import { finishTo, photoStep, photoSwipe, photoView, removePhoto, saveError, savePhoto, validCardId, type PhotoButton } from '../cardphoto/screen';
import { askCamera } from '../cardphoto/take';
import { ADD_BAR } from '../cards/hold';
import { holdTaps } from '../cards/nfcSlot';
import { availableMsat } from '../money/format';
import { useCardDeps, useServer } from '../services/server';
import { useRouteGuard, useServices } from '../services/services';
import { viewText } from '../money/view';
import { useAmountView } from '../ui/amountView';
import { StepBar } from '../ui/money';
import { TYPE, type Theme } from '../ui/theme';
import { Body, Button, goBack, ListGroup, ListRow, Panel, Screen } from '../ui/ui';
import { useAndroidBack } from '../ui/useBack';
import { useStyles } from '../ui/useTheme';
import { CardFace } from '../ui/wallet';
import { colourOf } from '../wallet/colours';

export default function CardPhoto() {
  const allowed = useRouteGuard('/card-photo');
  const sv = useServices();
  const s = useStyles(makeStyles);
  const { snap, watch } = useServer();
  const look = useAmountView();
  const deps = useCardDeps();
  const params = useLocalSearchParams<{ id?: string; step?: string; name?: string }>();
  // Fixed when the screen opens, as the card flow's params are. name: the card flow's, as the list may not have it yet.
  const [{ id, step, name }] = useState(() => ({ id: params.id, step: photoStep(params.step), name: params.name ?? '' }));
  const fromAdd = step !== null;
  const [busy, setBusy] = useState<'asking' | 'saving' | 'removing' | null>(null);
  /** The card camera is open over the screen. */
  const [camera, setCamera] = useState(false);
  const closeCamera = useCallback(() => setCamera(false), []);
  /** A save that failed: its words, and the thumbnail Try again sends again. */
  const [failed, setFailed] = useState<{ text: string; jpeg?: string } | null>(null);
  /** The camera refused; false: only the phone's settings can allow it now. */
  const [noCamera, setNoCamera] = useState<{ canAskAgain: boolean } | null>(null);

  useEffect(() => {
    if (allowed && !validCardId(id)) router.dismissTo('/home');
  }, [allowed, id]);

  // As Add card's step, a card held to the phone is closed unread: the card just added is often still in the
  // hand, and read again it opened its account page over the step. From More the app's own handling keeps the taps.
  useFocusEffect(useCallback(() => (fromAdd ? holdTaps(sv.nfcSlot) : undefined), [fromAdd, sv]));

  const finish = () => (finishTo(fromAdd, router.canGoBack()) === 'wallet' ? router.dismissTo('/home') : router.back());
  // While it saves or removes, Back does nothing; in Add card's step it is the last button; from More it goes back.
  useAndroidBack(() => {
    if (camera) return false; // the camera has its own Back
    if (busy) return true;
    if (!fromAdd) return false;
    finish();
    return true;
  });

  if (!allowed || !deps || !validCardId(id)) return <Screen busy />;

  const row = snap.cards?.find((c) => c.id === id);
  const listed = snap.wallet?.cards.find((c) => c.id === id);
  const photo = snap.photos[id];
  /** The card's name: the card flow's in Add card's step (the list may not have it yet), the list's from More. */
  const cardName = (fromAdd ? name || row?.name || listed?.name : row?.name || listed?.name || name) || '';

  const save = async (jpeg: string) => {
    setBusy('saving');
    setFailed(null);
    try {
      await savePhoto(deps.cardd, watch, id, jpeg);
    } catch (e) {
      setFailed({ text: saveError(e), jpeg });
    } finally {
      setBusy(null);
    }
  };
  const take = async () => {
    setBusy('asking');
    setFailed(null);
    setNoCamera(null);
    try {
      const answer = await askCamera(sv.native, () => PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA));
      if (answer === 'granted') setCamera(true);
      else setNoCamera({ canAskAgain: answer === 'refused' });
    } catch (e) {
      setFailed({ text: saveError(e) });
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('removing');
    setFailed(null);
    try {
      await removePhoto(deps.cardd, watch, id);
    } catch (e) {
      setFailed({ text: saveError(e, 'remove') });
    } finally {
      setBusy(null);
    }
  };

  // The iPhone's swipe from the left edge: where the band has a working ←, and never with the camera up.
  const swipe = <Stack.Screen options={{ gestureEnabled: photoSwipe({ step, busy, camera }) }} />;
  if (camera)
    return (
      <>
        {swipe}
        <CardCamera
          name={cardName}
          onCancel={closeCamera}
          onUse={(jpeg) => {
            setCamera(false);
            void save(jpeg);
          }}
        />
      </>
    );
  const v = photoView({ step, hasPhoto: !!photo, busy, failed: failed && { text: failed.text, retry: !!failed.jpeg }, noCamera, ios: Platform.OS === 'ios' });
  const press: Record<PhotoButton['key'], () => void> = { take: () => void take(), retry: () => failed?.jpeg && void save(failed.jpeg), finish };
  return (
    <Screen title={v.band} back={v.back && (() => !v.off && goBack())}>
      {swipe}
      {v.bar && <StepBar names={ADD_BAR} at={2} />}
      <View>
        <CardFace
          name={cardName || 'Unnamed card'}
          colour={colourOf(snap.cards ?? [], id)}
          balance={listed ? viewText(availableMsat(listed), look.view, look.rated) : undefined}
          photo={photo}
        />
        {v.veil && (
          <View style={s.veil} accessibilityLiveRegion="polite">
            <Text style={s.veilText}>{v.veil}</Text>
          </View>
        )}
      </View>
      <Body muted>A photo of the card helps you tell your cards apart. Only your server keeps it, in its backups.</Body>
      {v.panels.map((text) => (
        <Panel key={text} tone="error">
          <Body>{text}</Body>
        </Panel>
      ))}
      {v.settings && <Button title="Open settings" kind="secondary" onPress={() => void Linking.openSettings()} />}
      {v.buttons.map((b) => (
        <Button key={b.key} title={b.title} kind={b.kind} onPress={press[b.key]} disabled={v.off} />
      ))}
      {v.remove && (
        <ListGroup>
          <ListRow icon="wipe" name="Remove photo" line="The card goes back to its colour." onPress={() => void remove()} disabled={v.off} danger acts />
        </ListGroup>
      )}
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    // Over the face while a photo is saved or removed: the page's veil, and the words on a small surface.
    veil: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 12, backgroundColor: t.veil, alignItems: 'center', justifyContent: 'center' },
    veilText: { ...TYPE.body, fontWeight: '600', color: t.text, backgroundColor: t.surface, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, overflow: 'hidden' },
  });
