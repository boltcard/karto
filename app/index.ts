// Polyfills first: noble and BIP-39 need crypto.getRandomValues at import time.
import './src/native/polyfills';
// One project, two apps (variant.js). The build's setting reaches the bundle as EXPO_PUBLIC_APP_VARIANT, which is
// a constant by the time Metro collects what to bundle: the other app's start-up, and everything only it reaches,
// is left out (deploy/test/bundle-markers.sh checks each APK). So these are requires inside the branch, not imports.
if (process.env.EXPO_PUBLIC_APP_VARIANT === 'pos') require('./src/pos/start');
else require('./src/services/start');
// Then Expo Router, which registers the app; its screens are the router's root: src/app/, or src/pos-app/.
require('expo-router/entry');
