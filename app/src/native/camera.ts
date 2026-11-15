// Asking for the camera, on either phone, for both apps' scanners and the card's photo.
// Here in the native layer so Karto PoS's scanner can use it too;
// cardphoto/take.ts passes it on to the wallet's screens.
import type { CardNativeApi } from './api';

export type CameraPermission = 'granted' | 'refused' | 'refused_for_good';

/** PermissionsAndroid.request's answer: never_ask_again means only Android's settings can allow the camera now. */
export const cameraPermission = (answer: string): CameraPermission =>
  answer === 'granted' ? 'granted' : answer === 'never_ask_again' ? 'refused_for_good' : 'refused';

/**
 * Asks for the camera, on either phone. Where the module can ask, it does: the iPhone's, where iOS asks the person
 * once and React Native's PermissionsAndroid would answer "denied" without asking. Otherwise android asks
 * (PermissionsAndroid.request for the camera). Anything a module says but 'granted' is a refusal only Settings can undo.
 */
export async function askCamera(native: Pick<CardNativeApi, 'cameraPermission'>, android: () => Promise<string>): Promise<CameraPermission> {
  if (native.cameraPermission) return (await native.cameraPermission()) === 'granted' ? 'granted' : 'refused_for_good';
  return cameraPermission(await android());
}

/** Where a phone's owner allows the camera, as the screens name it. */
export const settingsPlace = (ios: boolean): string => (ios ? 'Settings' : "Android's settings");
