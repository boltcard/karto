// The press that leads to the hold screen. On an iPhone it
// is what lets that screen open Apple's sheet by itself. A link can open the screen too (karto://card?…), from
// another app or a web page, and a link is not a press: the screen then shows its button and waits for one.
//
// So each way into the hold screen from inside the app makes a token as it navigates and sends it as the screen's
// `press` parameter; the screen opens the sheet by itself only if its parameter is that token. The token is random
// and kept in memory, so a link cannot name it; a new press replaces it. It is read, never used up: a screen that
// mounts twice gets the same answer, and it stands only for the screen that was sent it.
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

let token: string | null = null;

/** A button that opens the hold screen was pressed: the token to send with the navigation, as `press`. */
export function holdPress(random: () => Uint8Array = () => randomBytes(16)): string {
  token = bytesToHex(random());
  return token;
}

/** Whether a hold screen's `press` parameter is the last press's token: a press in the app led to that screen. */
export function isHoldPress(press: unknown): boolean {
  return token !== null && typeof press === 'string' && press === token;
}
