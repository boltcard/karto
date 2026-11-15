// The theme for the phone's light or dark setting. useColorScheme follows
// the phone and redraws while the app is open (app.json's userInterfaceStyle is automatic).
import { useColorScheme } from 'react-native';
import { stylesFor, themeFor, type Theme } from './theme';

export const useTheme = (): Theme => themeFor(useColorScheme());

/**
 * make's styles for the phone's setting, made once per scheme and kept (theme.ts stylesFor). make is a
 * module-level makeStyles function, never one made during a render.
 */
export function useStyles<T>(make: (t: Theme) => T): T {
  return stylesFor(make, useTheme());
}
