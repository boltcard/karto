// The card-native Expo module (android/src/main/java/tech/whitewolf/karto/cardnative).
import { requireNativeModule } from 'expo';
import type { AlertsNativeApi, CardNativeApi } from '../../src/native/api';
import type { CardNfcApi } from '../../src/native/nfc';
import type { PhoneCardNativeApi } from '../../src/native/phoneCard';

// The phone's card calls (src/native/phoneCard.ts) and the alerts' (src/native/api.ts) are Android's module's alone.
export default requireNativeModule<CardNativeApi & CardNfcApi & Partial<PhoneCardNativeApi> & Partial<AlertsNativeApi>>('CardNative');
