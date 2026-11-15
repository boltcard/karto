// The scanner: the wallet's framed square over the camera, for the code Karto Wallet
// shows. A pairing code is handed to Pair in memory (pos.scanned), which is how Pair knows the person pointed
// this phone at it; anything else is "That isn't a Karto PoS code.", and the camera goes on looking.
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, PermissionsAndroid, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { askCamera, type CameraPermission } from '../native/camera';
import { QrScanner } from '../native/qrScanner';
import { usePos } from '../pos/app';
import { NOT_A_CODE, readLink } from '../pos/links';
import { PAIR_WORDS, scanRefusal } from '../pos/pairing';
import { ScanFrame } from '../ui/scanFrame';
import { FIXED, type Theme } from '../ui/theme';
import { Body, Button, ErrorText, goBack, Panel, Screen } from '../ui/ui';
import { useStyles } from '../ui/useTheme';

export default function Scan() {
  const pos = usePos();
  const s = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [camera, setCamera] = useState<'asking' | CameraPermission>('asking');
  const [wrong, setWrong] = useState(false);
  const done = useRef(false);

  // The iPhone's module asks for the camera itself; Android's PermissionsAndroid otherwise (cardphoto/take.ts).
  useEffect(() => {
    askCamera(pos.native, () => PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA)).then(setCamera, () => setCamera('refused'));
  }, [pos.native]);

  if (camera === 'asking') return <Screen busy />;
  if (camera !== 'granted') {
    const v = scanRefusal(camera, Platform.OS === 'ios');
    return (
      <Screen title="Scan the code" back>
        <Panel>
          <Body>{v.text}</Body>
        </Panel>
        {v.settings && <Button title="Open settings" kind="secondary" onPress={() => void Linking.openSettings()} />}
        <Button title="Back" onPress={goBack} />
      </Screen>
    );
  }
  return (
    <Screen title="Scan the code" back fill>
      <View style={layout.camera}>
        <QrScanner
          style={StyleSheet.absoluteFill}
          onCode={(e) => {
            if (done.current) return;
            const link = readLink(e.nativeEvent.text);
            if (link?.kind !== 'pair') return setWrong(true);
            done.current = true;
            pos.scanned.current = { host: link.host, code: link.code };
            router.replace('/pair');
          }}
        />
        <ScanFrame />
      </View>
      {/* Clear of the navigation bar, which the screen draws under. */}
      <View style={[s.bar, { paddingBottom: 20 + insets.bottom }]}>
        {wrong ? <ErrorText>{NOT_A_CODE}</ErrorText> : <Body>{PAIR_WORDS.scanFoot}</Body>}
        <Button title="Cancel" kind="secondary" onPress={goBack} />
      </View>
    </Screen>
  );
}

// The bar under the camera is the page's surface; behind the camera's picture, black in both modes.
const makeStyles = (t: Theme) =>
  StyleSheet.create({
    bar: { paddingHorizontal: 20, paddingTop: 16, gap: 12, backgroundColor: t.surface },
  });

const layout = StyleSheet.create({
  camera: { flex: 1, backgroundColor: FIXED.fade },
});
