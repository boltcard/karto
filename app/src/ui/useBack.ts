// Android's Back for a screen with steps of its own (Send out and Move).
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { BackHandler } from 'react-native';

/**
 * While the screen is in front, Android's Back calls onBack: true when the screen dealt with it (a step back),
 * false to let it close the screen as usual.
 */
export function useAndroidBack(onBack: () => boolean) {
  const latest = useRef(onBack);
  latest.current = onBack;
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => latest.current());
      return () => sub.remove();
    }, []),
  );
}
