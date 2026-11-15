// The phone as a card, from the card-native module (CardNativeModule.kt, PhoneCardService.kt, PhoneCardTag.kt):
// the service is given the taps to hand out and named the one
// Android gives a reader's commands to while the app is in front. Android only: the iPhone's module has none of
// these calls, and there the phone is never a card.

/** A tap was handed to a reader: how many since the service was armed, and how many it has left. */
export type PhoneCardReadEvent = { given: number; left: number };

export type PhoneCardNativeApi = {
  /** Host card emulation and NFC on this phone, in a build that declares the service (Karto Wallet's). */
  phoneCardSupported(): Promise<boolean>;
  /**
   * Takes the taps (each one's NDEF file, in hex), replacing any it has, and names the service as preferred for
   * the activity in front. Rejects with code ERR_PHONE_CARD_REFUSED, nothing kept, unless the activity is in front
   * and Android answers yes to the preference.
   */
  phoneCardArm(files: string[]): Promise<void>;
  /** Appends taps while armed. */
  phoneCardAdd(files: string[]): Promise<void>;
  /** Empties the service, gives up the preference, and answers how many taps were handed to a reader since phoneCardArm. */
  phoneCardDisarm(): Promise<number>;
  addListener(event: 'phoneCardRead', listener: (e: PhoneCardReadEvent) => void): { remove(): void };
  /** The module disarmed by itself, in the activity's pause, because the app left the front. */
  addListener(event: 'phoneCardEnded', listener: (e: { given: number }) => void): { remove(): void };
};

/** Android would not make this phone a card just now, or this phone can't be one. */
export class PhoneCardRefused extends Error {
  constructor(message = "This phone can't be a card.") {
    super(message);
    this.name = 'PhoneCardRefused';
  }
}

export type PhoneCard = {
  supported(): Promise<boolean>;
  /** Throws PhoneCardRefused when Android refuses. */
  arm(files: string[]): Promise<void>;
  add(files: string[]): Promise<void>;
  disarm(): Promise<number>;
  onRead(fn: (e: PhoneCardReadEvent) => void): { remove(): void };
  onEnded(fn: (given: number) => void): { remove(): void };
};

const NOT_LISTENING = { remove: () => {} };

/** native: the card-native module, which lacks the calls on an iPhone. */
export function nativePhoneCard(native: Partial<PhoneCardNativeApi>): PhoneCard {
  const { phoneCardSupported, phoneCardArm, phoneCardAdd, phoneCardDisarm, addListener } = native;
  if (!phoneCardSupported || !phoneCardArm || !phoneCardAdd || !phoneCardDisarm || !addListener) {
    return {
      supported: async () => false,
      arm: async () => {
        throw new PhoneCardRefused();
      },
      add: async () => {},
      disarm: async () => 0,
      onRead: () => NOT_LISTENING,
      onEnded: () => NOT_LISTENING,
    };
  }
  // Called on the module, as its other calls are: an Expo module's functions are its own.
  const api = native as PhoneCardNativeApi;
  return {
    supported: () => api.phoneCardSupported(),
    async arm(files) {
      try {
        await api.phoneCardArm(files);
      } catch (e) {
        if ((e as { code?: string }).code === 'ERR_PHONE_CARD_REFUSED') throw new PhoneCardRefused((e as Error).message);
        throw e;
      }
    },
    add: (files) => api.phoneCardAdd(files),
    disarm: () => api.phoneCardDisarm(),
    onRead: (fn) => api.addListener('phoneCardRead', fn),
    onEnded: (fn) => api.addListener('phoneCardEnded', (e) => fn(e.given)),
  };
}
