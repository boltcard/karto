// Karto PoS's scanner rendered: it asks for the camera
// through the module where the module can ask (an iPhone), and names the phone's own settings when refused.
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Scan from '../../pos-app/scan';

const { openSettings } = vi.hoisted(() => ({ openSettings: vi.fn(async () => undefined) }));
const camera: { answer: 'granted' | 'denied'; android: boolean; androidAnswer: string } = { answer: 'granted', android: false, androidAnswer: 'granted' };

vi.mock('../../pos/app', () => ({
  usePos: () => ({ native: camera.android ? {} : { cameraPermission: async () => camera.answer }, scanned: { current: null } }),
}));
vi.mock('react-native', async (original) => ({
  ...(await original<typeof import('react-native')>()),
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
  PermissionsAndroid: { PERMISSIONS: { CAMERA: 'android.permission.CAMERA' }, RESULTS: { GRANTED: 'granted' }, request: vi.fn(async () => camera.androidAnswer) },
  // react-native-web's Linking has no openSettings.
  Linking: { openSettings: openSettings },
}));
vi.mock('../../native/qrScanner', () => ({ QrScanner: () => <div>the camera</div> }));

describe("Karto PoS's scanner on an iPhone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    camera.answer = 'granted';
    camera.android = false;
  });

  it('opens the camera once the iPhone allows it', async () => {
    render(<Scan />);
    expect(await screen.findByText('the camera')).toBeTruthy();
  });

  it("names Settings when the iPhone refuses, and opens them", async () => {
    camera.answer = 'denied';
    render(<Scan />);
    expect(await screen.findByText("The camera isn't allowed for this app. Allow it in Settings to scan the code in Karto Wallet.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(openSettings).toHaveBeenCalled();
  });
});
