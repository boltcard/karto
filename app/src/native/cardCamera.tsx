// The card camera (card-native's CardCameraView): the preview with the card-shaped frame and the found edges
// drawn natively; onFound when the card is found or lost, onError when the
// camera can't start; takePhoto() through a ref. The screen asks for the
// camera permission first.
import { requireNativeView } from 'expo';
import type { Ref } from 'react';
import type { ViewProps } from 'react-native';

/** Where the thumbnail's corners came from: found in the shot, the outline shown, or the frame. */
export type ShotSource = 'shot' | 'outline' | 'frame';

export type CardCameraHandle = {
  /** Rejects with code ERR_PHOTO_TOO_BIG, ERR_CAPTURE or ERR_CAMERA_CLOSED. */
  takePhoto(): Promise<{ jpeg: string; source: ShotSource }>;
};

export type CardCameraProps = ViewProps & {
  ref?: Ref<CardCameraHandle>;
  frameWidth: number;
  frameCentreY: number;
  onFound: (e: { nativeEvent: { found: boolean } }) => void;
  onError: (e: { nativeEvent: { message: string } }) => void;
};

export const CardCameraView = requireNativeView<CardCameraProps>('CardNative', 'CardCameraView');
