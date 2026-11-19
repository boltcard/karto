// Karto Wallet's start-up, before the router (index.ts).
// The background jobs must be defined as the bundle loads: the backups', and the watch over a setup's wait for LNVPS.
import '../backup/task';
import '../onboarding/keyWatchTask';
// Only the newest root draws the app, while Android's old screen stops (rootSlot.ts).
// Not in a dev build, where LogBox's own root would be wrapped too and take the app's place.
import { AppRegistry } from 'react-native';
import { OneRoot } from './oneRoot';

if (!__DEV__) AppRegistry.setWrapperComponentProvider(() => OneRoot);
