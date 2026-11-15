// The QR scanner: the camera under the band,
// a framed square in its middle with the picture around it dimmed, and a bar at the foot with Cancel; the first
// code read goes back to Send out through scanSlot (or to the wallet, when a link opened the scanner first). What
// it shows for each answer about the camera is money/scanView.ts's. On an iPhone the swipe from the left edge is
// Cancel.
import { useEffect, useRef, useState } from 'react';
import { Linking, PermissionsAndroid, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { askCamera, type CameraPermission } from '../cardphoto/take';
import { scanSlot } from '../money/scanSlot';
import { scanView } from '../money/scanView';
import { QrScanner } from '../native/qrScanner';
import { useRouteGuard, useServices } from '../services/services';
import { FIXED, type Theme } from '../ui/theme';
import { Body, Button, goBack, Panel, Screen } from '../ui/ui';
import { ScanFrame } from '../ui/scanFrame';
import { useStyles } from '../ui/useTheme';

export default function Scan() {
  const allowed = useRouteGuard('/scan');
  const sv = useServices();
  const s = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [camera, setCamera] = useState<'asking' | CameraPermission>('asking');
  const done = useRef(false);

  useEffect(() => {
    askCamera(sv.native, () => PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA)).then(setCamera, () => setCamera('refused'));
  }, [sv]);

  const v = scanView(camera, Platform.OS === 'ios');
  if (!allowed || v.kind === 'busy') return <Screen busy />;
  if (v.kind === 'refused')
    return (
      <Screen title="Scan a QR code" back>
        <Panel>
          <Body>{v.text}</Body>
        </Panel>
        {v.settings && <Button title="Open settings" kind="secondary" onPress={() => void Linking.openSettings()} />}
        <Button title="Back" onPress={goBack} />
      </Screen>
    );
  return (
    <Screen title="Scan a QR code" back fill>
      <View style={layout.camera}>
        <QrScanner
          style={StyleSheet.absoluteFill}
          onCode={(e) => {
            if (done.current) return;
            done.current = true;
            scanSlot.put(e.nativeEvent.text);
            goBack();
          }}
        />
        <ScanFrame />
      </View>
      {/* Clear of the navigation bar, which the screen draws under. */}
      <View style={[s.bar, { paddingBottom: 20 + insets.bottom }]}>
        <Body>Point at a Lightning invoice or address.</Body>
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
