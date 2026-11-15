// Scan QR's states, apart from React so they are tested: what
// the screen shows for each answer to asking for the camera.
import { settingsPlace, type CameraPermission } from '../cardphoto/take';

/** busy: the camera is being asked for. camera: the scanner. refused: the words, and whether Open settings stands under them. */
export type ScanView = { kind: 'busy' } | { kind: 'camera' } | { kind: 'refused'; text: string; settings: boolean };

/**
 * camera: the answer, 'asking' until there is one. ios: the phone is an iPhone. Open settings is offered once
 * asking again cannot help: on an iPhone that is every refusal, since iOS asks only once.
 */
export function scanView(camera: 'asking' | CameraPermission, ios: boolean): ScanView {
  if (camera === 'asking') return { kind: 'busy' };
  if (camera === 'granted') return { kind: 'camera' };
  return {
    kind: 'refused',
    text: `The camera isn't allowed for this app. Paste the invoice or address instead, or allow the camera in ${settingsPlace(ios)}.`,
    settings: camera === 'refused_for_good',
  };
}
