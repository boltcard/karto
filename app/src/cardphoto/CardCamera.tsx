// The card camera: full screen
// over the photo screen, the preview with the card-shaped frame, the hint,
// Cancel and the shutter; after the shutter, the check view with Use photo
// and Retake. Its choices are camera.ts's.
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { holdTaps } from '../cards/nfcSlot';
import { CardCameraView, type CardCameraHandle } from '../native/cardCamera';
import { useServices } from '../services/services';
import { TYPE } from '../ui/theme';
import { backDoes, checkLine, hint, LOOKING, oneShot, shoot, photoColours, type CameraState } from './camera';
import { FRAME_CENTRE_Y, FRAME_WIDTH, PHOTO_HEIGHT, PHOTO_WIDTH } from './take';

const GREEN = '#3fb950';
const USE_PHOTO = photoColours();

/** name: the card's, for the hint ("Hold Kids inside the frame"). */
export function CardCamera({ name, onUse, onCancel }: { name?: string; onUse: (jpeg: string) => void; onCancel: () => void }) {
  const sv = useServices();
  const camera = useRef<CardCameraHandle>(null);
  const [state, setState] = useState<CameraState>(LOOKING);
  const [found, setFound] = useState(false);
  /** Bumped by Try again: a new native view starts the camera again. */
  const [attempt, setAttempt] = useState(0);

  // A card that close to the phone is read: every tap is closed unread while the camera is open.
  useEffect(() => holdTaps(sv.nfcSlot), [sv]);

  const stateRef = useRef(state);
  stateRef.current = state;
  const retake = () => {
    setFound(false);
    setState(LOOKING);
  };
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const does = backDoes(stateRef.current);
      if (does === 'retake') retake();
      if (does === 'cancel') onCancel();
      return true;
    });
    return () => sub.remove();
  }, [onCancel]);

  const [press] = useState(() =>
    oneShot(async () => {
      const view = camera.current;
      if (!view) return;
      setState({ kind: 'taking' });
      setState(await shoot(() => view.takePhoto()));
    }),
  );

  if (state.kind === 'check')
    return (
      <SafeAreaView style={styles.full}>
        <StatusBar style="light" />
        <View style={styles.check}>
          <Text style={styles.title}>Check the photo</Text>
          <Text style={styles.detail}>{checkLine(state.source)}</Text>
          <Image source={{ uri: `data:image/jpeg;base64,${state.jpeg}` }} style={styles.thumb} accessibilityLabel="The card's photo" />
          <View style={styles.buttons}>
            <Pressable style={[styles.button, styles.primary]} onPress={() => onUse(state.jpeg)} accessibilityRole="button">
              <Text style={styles.primaryText}>Use photo</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.secondary]} onPress={retake} accessibilityRole="button">
              <Text style={styles.secondaryText}>Retake</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    );

  const words = hint(state, found, name);
  return (
    <SafeAreaView style={styles.full}>
      <StatusBar style="light" />
      {state.kind !== 'broken' && (
        <CardCameraView
          key={attempt}
          ref={camera}
          style={StyleSheet.absoluteFill}
          frameWidth={FRAME_WIDTH}
          frameCentreY={FRAME_CENTRE_Y}
          onFound={(e) => setFound(e.nativeEvent.found)}
          onError={(e) => setState({ kind: 'broken', reason: e.nativeEvent.message })}
        />
      )}
      <View style={styles.hint} pointerEvents="none">
        <Text style={styles.title}>{words.title}</Text>
        {!!words.detail && <Text style={styles.detail}>{words.detail}</Text>}
      </View>
      <View style={styles.bar}>
        <Pressable style={styles.cancel} onPress={onCancel} accessibilityRole="button">
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        {state.kind === 'broken' ? (
          <Pressable
            style={[styles.button, styles.secondary]}
            onPress={() => {
              setAttempt((n) => n + 1);
              retake();
            }}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryText}>Try again</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.shutter, found && { borderColor: GREEN }, state.kind === 'taking' && styles.off]}
            onPress={() => void press()}
            disabled={state.kind === 'taking'}
            accessibilityRole="button"
            accessibilityLabel="Take the photo"
          >
            <View style={styles.shutterDot} />
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1, backgroundColor: '#000' },
  hint: { position: 'absolute', left: 16, right: 16, top: 56, alignItems: 'center', gap: 4 },
  title: { ...TYPE.heading, fontSize: 17, color: '#fff', textAlign: 'center' },
  detail: { ...TYPE.body, fontSize: 14, lineHeight: 20, color: 'rgba(255,255,255,0.75)', textAlign: 'center' },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 40, alignItems: 'center', justifyContent: 'center' },
  cancel: { position: 'absolute', left: 24, padding: 8 },
  cancelText: { ...TYPE.button, fontWeight: '400', color: '#fff' },
  shutter: { width: 72, height: 72, borderRadius: 36, borderWidth: 5, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  shutterDot: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#fff' },
  off: { opacity: 0.4 },
  check: { flex: 1, paddingHorizontal: 14, paddingTop: 48, paddingBottom: 32, gap: 14 },
  thumb: { width: '100%', aspectRatio: PHOTO_WIDTH / PHOTO_HEIGHT, borderRadius: 9, marginTop: 'auto' },
  buttons: { marginTop: 'auto', gap: 10 },
  button: { borderRadius: 8, paddingVertical: 13, paddingHorizontal: 20, alignItems: 'center' },
  primary: { backgroundColor: USE_PHOTO.fill },
  primaryText: { ...TYPE.button, color: USE_PHOTO.text },
  secondary: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)' },
  secondaryText: { ...TYPE.button, color: '#fff' },
});
