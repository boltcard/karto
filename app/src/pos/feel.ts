// How the till feels on each phone: the
// refused buzz and the Paid chime's audio mode.
//
// React Native's Vibration (https://reactnative.dev/docs/vibration): "On iOS, the vibration duration is fixed at
// roughly 400 milliseconds" and "the numbers in the pattern array represent the separation time"; on Android the
// odd indices are buzzes and the even ones gaps. So Android's two 80 ms buzzes would be one long buzz on an iPhone.
//
// expo-audio 57 (https://docs.expo.dev/versions/v57.0.0/sdk/audio/): setAudioModeAsync's playsInSilentMode
// "determines if audio playback is allowed when the device is in silent mode" (a till that goes quiet on silent
// is a fault), and interruptionMode 'mixWithOthers' plays alongside other apps' audio instead of stopping it.
import type { AudioMode } from 'expo-audio';

/** A card's server refused: two short buzzes on Android; on an iPhone two of its fixed buzzes, 600 ms apart. */
export const refusedBuzz = (ios: boolean): number[] => (ios ? [0, 600] : [0, 80, 90, 80]);

/** Set once on an iPhone, as the till starts. */
export const IOS_AUDIO_MODE: Partial<AudioMode> = { playsInSilentMode: true, interruptionMode: 'mixWithOthers' };
