// One root draws the app at a time: the newest. Back destroys Android's
// screen, and opening the app again at once makes a new one in the same JS run
// before the old one has stopped (about 0.3 s). Expo Router's routing queue is
// global, and any root's navigator takes what is queued: the old root's could
// take the new root's Redirect to the wallet, leaving the new screen blank. So
// an older root draws nothing once a newer one has mounted, and its navigator
// goes with it.

export class RootSlot {
  private latest = 0;
  private listeners = new Set<() => void>();

  /** A new root's number, as it first renders. */
  take(): number {
    return ++this.latest;
  }

  /** The root that may draw the app. */
  newest = (): number => this.latest;

  /** Once the newest root has mounted: the older ones are told to draw nothing. */
  mounted(): void {
    for (const l of [...this.listeners]) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
