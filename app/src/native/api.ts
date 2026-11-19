/** Sent while sshUploadBytes/sshUploadAsset runs: bytes of remotePath sent so far, up to its size. */
export type SshUploadProgressEvent = { id: number; remotePath: string; sent: number };

// The functions the card-native module exposes (CardNativeModule.kt). Kept
// as a plain type so the wrappers can be tested with a fake.
export type CardNativeApi = {
  /** Makes the device key if there is none; returns its public key (uncompressed hex). */
  deviceKeyCreate(): Promise<string>;
  /** Rejects with code ERR_NO_DEVICE_KEY if there is no key (e.g. after a restore from backup). */
  devicePublicKey(): Promise<string>;
  deviceKeyIsStrongBox(): Promise<boolean>;
  /** Another app on this phone against this app's signer: 'absent' when none of that package is installed or visible. */
  signedLikeThisApp(packageName: string): Promise<'same' | 'other' | 'absent'>;
  /**
   * Deletes the device key; done when there was none. The iPhone's module only: its Keychain keeps the key when the
   * app is deleted, where Android's goes with the app.
   */
  deviceKeyDelete?(): Promise<void>;
  deviceSign(message: string): Promise<string>;
  sshConnect(host: string, port: number, user: string, hostKeyType: string, hostKeyBlob: string, seedHex: string): Promise<number>;
  sshExec(id: number, command: string, stdin: string | null): Promise<{ code: number; stdout: string; stderr: string }>;
  sshUploadBytes(id: number, remotePath: string, base64: string, mode: number): Promise<void>;
  sshUploadAsset(id: number, remotePath: string, asset: string, size: number, mode: number): Promise<void>;
  sshClose(id: number): Promise<void>;
  /** A text file from the APK's assets (the server bundle's manifest.json). */
  readAssetText(path: string): Promise<string>;
  /** The server's ssh-ed25519 host key, read without logging in. */
  sshScanHostKey(host: string, port: number): Promise<{ keyType: string; publicKey: string }>;
  addListener(event: 'sshUploadProgress', listener: (e: SshUploadProgressEvent) => void): { remove(): void };
  /**
   * The card's 428×270 JPEG (base64) from a JPEG, corners as fractions of it, x and y of each from the top left
   * clockwise (the photo probe's). Android's module only: the probe is not run on an iPhone.
   */
  cardThumbnail?(jpeg: string, corners: number[]): Promise<string>;
  /**
   * Asks for the camera. The iPhone's module only: iOS asks the person once, and a camera refused before can only
   * be allowed in Settings. On Android React Native asks (cardphoto/take.ts askCamera).
   */
  cameraPermission?(): Promise<'granted' | 'refused_for_good'>;
};

/** The distributor's endpoint for this phone's alerts and its Web Push keys (RFC 8291; base64url, unpadded), as cardd takes them. */
export type PushEndpoint = { endpoint: string; p256dh: string; auth: string };
/**
 * Why a registration gave no endpoint: temporary (a fallback distributor's, never handed to cardd: the endpoint kept
 * stays), no-keys, unregistered (the distributor dropped it, or was removed), or the connector's network,
 * action-required, vapid-required or internal-error.
 */
export type PushFailedEvent = { reason: 'temporary' | 'no-keys' | 'unregistered' | 'network' | 'action-required' | 'vapid-required' | 'internal-error' };

/**
 * Alerts with the app closed: Android's module only,
 * through UnifiedPush's connector (CardNativeModule.kt, AlertService.kt).
 */
export type AlertsNativeApi = {
  /** The distributors installed, by package: this app's own on the Play build when Play Services answer. */
  pushDistributors(): string[];
  /** The distributor chosen, null for none. */
  pushDistributor(): string | null;
  /**
   * The Play build's embedded FCM distributor (this app's own package) when pushDistributors lists it, else null.
   * Any other distributor listed, such as ntfy, is chosen before it.
   */
  pushEmbeddedDistributor(): string | null;
  /**
   * Chooses the distributor (null: the one chosen before; rejects ERR_NO_DISTRIBUTOR without one) and registers with
   * the server's VAPID public key (rejects ERR_BAD_VAPID for one not uncompressed and base64url). fresh: drops the
   * registration first, so a new token and keys go to ntfy's current default server. The endpoint comes as onPushEndpoint.
   */
  pushRegister(vapidPublicKey: string, distributor: string | null, fresh: boolean): Promise<void>;
  /** Drops the registration and the endpoint kept. */
  pushUnregister(): Promise<void>;
  /** The last endpoint the distributor gave, kept for an app opened after one came while it was closed. */
  pushEndpoint(): PushEndpoint | null;
  /** Whether notifications may show: Android 13's permission granted, and not blocked in Android's settings. */
  notificationsAllowed(): boolean;
  /** Asks Android 13's permission when it isn't granted; true when notifications may show. */
  requestNotifications(): Promise<boolean>;
  /** Whether Doze leaves the app's connection alone (ntfy's: io.heckel.ntfy). */
  ignoringBatteryOptimizations(packageName: string): boolean;
  /** Opens ntfy, or its store page when it isn't installed. */
  openNtfySettings(): void;
  addListener(event: 'onPushEndpoint', listener: (e: PushEndpoint) => void): { remove(): void };
  addListener(event: 'onPushFailed', listener: (e: PushFailedEvent) => void): { remove(): void };
};

/** The setup's own notices: Android's module only (CardNativeModule.kt, AlertNotifier.kt). */
export type SetupNoticeNativeApi = {
  /** Posts a notification on the "Server setup" channel under tag (a later one replaces it); a tap opens the wallet. */
  postSetupNotice(tag: string, title: string, text: string): void;
  /** As AlertsNativeApi's. */
  notificationsAllowed(): boolean;
  /** As AlertsNativeApi's. */
  requestNotifications(): Promise<boolean>;
};
