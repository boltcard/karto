// The QR scanner (card-native's QrScannerView): a camera preview that sends
// the first QR code it reads as onCode. The screen asks for the camera
// permission first.
import { requireNativeView } from 'expo';
import type { ViewProps } from 'react-native';

export type QrScannerProps = ViewProps & {
  onCode: (e: { nativeEvent: { text: string } }) => void;
};

export const QrScanner = requireNativeView<QrScannerProps>('CardNative');
