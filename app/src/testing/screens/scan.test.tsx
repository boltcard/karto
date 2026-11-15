// The Scan QR screen rendered: its hand-off to Send out, and its words when the camera is refused.
// The camera's preview is card-native's view, which only a phone has: here it is a button that "reads" a code.
import { fireEvent, render, screen } from '@testing-library/react';
import { router } from 'expo-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Scan from '../../app/scan';
import { scanSlot } from '../../money/scanSlot';

// The iPhone's module answers for the camera itself (cameraPermission); Android's is asked through
// PermissionsAndroid, which react-native-web lacks: it stands in here, answering as Android does.
const camera: { answer: 'granted' | 'denied'; android: boolean; androidAnswer: string } = { answer: 'granted', android: false, androidAnswer: 'granted' };

vi.mock('../../services/services', () => ({
  useRouteGuard: () => true,
  useServices: () => ({ native: camera.android ? {} : { cameraPermission: async () => camera.answer } }),
}));
vi.mock('react-native', async (original) => ({
  ...(await original<typeof import('react-native')>()),
  PermissionsAndroid: { PERMISSIONS: { CAMERA: 'android.permission.CAMERA' }, request: vi.fn(async () => camera.androidAnswer) },
}));
vi.mock('../../native/qrScanner', () => ({
  QrScanner: ({ onCode }: { onCode: (e: { nativeEvent: { text: string } }) => void }) => (
    <button onClick={() => onCode({ nativeEvent: { text: 'lnbc1example' } })}>a code in view</button>
  ),
}));

describe('Scan QR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    camera.answer = 'granted';
    camera.android = false;
    camera.androidAnswer = 'granted';
    scanSlot.take();
  });

  it('puts the first code read in the slot for Send out, and goes back to it; a second read is ignored', async () => {
    render(<Scan />);
    fireEvent.click(await screen.findByText('a code in view'));
    fireEvent.click(screen.getByText('a code in view'));
    expect(scanSlot.take()).toBe('lnbc1example');
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('Cancel goes back, with nothing for Send out', async () => {
    render(<Scan />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(scanSlot.take()).toBeNull();
  });

  it("on Android, a refusal that can be asked again says so, with Back and no Open settings", async () => {
    camera.android = true;
    camera.androidAnswer = 'denied';
    render(<Scan />);
    expect(await screen.findByText(/The camera isn't allowed for this app. .* in Android's settings\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull();
    // The page's Back, under the words (the header's arrow is called Back too).
    fireEvent.click(screen.getAllByRole('button', { name: 'Back' }).at(-1)!);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("on Android, a refusal for good offers Open settings", async () => {
    camera.android = true;
    camera.androidAnswer = 'never_ask_again';
    render(<Scan />);
    expect(await screen.findByText(/The camera isn't allowed for this app/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy();
  });

  it("says the camera is not allowed, and offers Open settings, when the module answers for it (the iPhone's way: iOS asks only once)", async () => {
    camera.answer = 'denied';
    render(<Scan />);
    expect(await screen.findByText(/The camera isn't allowed for this app/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy();
  });
});
