import { describe, expect, it, vi } from 'vitest';
import { RootSlot } from './rootSlot';

describe('RootSlot', () => {
  it('lets the one root draw the app', () => {
    const slot = new RootSlot();
    const first = slot.take();
    expect(slot.newest()).toBe(first);
  });

  // Back, then the app opened again at once: Android's new screen mounts before the old one has stopped.
  it('hands the app to a newer root, and tells the older roots once it has mounted', () => {
    const slot = new RootSlot();
    const old = slot.take();
    const told = vi.fn();
    slot.subscribe(told);
    const next = slot.take();
    expect(next).not.toBe(old);
    expect(slot.newest()).toBe(next);
    expect(told).not.toHaveBeenCalled();
    slot.mounted();
    expect(told).toHaveBeenCalledTimes(1);
  });

  it('stops telling a root that has gone', () => {
    const slot = new RootSlot();
    const told = vi.fn();
    const off = slot.subscribe(told);
    off();
    slot.take();
    slot.mounted();
    expect(told).not.toHaveBeenCalled();
  });
});
