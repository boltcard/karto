// The scanner's result, from the scan screen to Send out: in memory, never a
// route parameter (every screen can be opened by a karto:// link).
let scanned: string | null = null;

export const scanSlot = {
  put(text: string) {
    scanned = text;
  },
  /** The scanned text, once. */
  take(): string | null {
    const t = scanned;
    scanned = null;
    return t;
  },
};
