import { describe, expect, it } from 'vitest';
import { scanView } from './scanView';

describe('scanView', () => {
  it('waits while the camera is asked for, and shows the camera once it is allowed', () => {
    expect(scanView('asking', false)).toEqual({ kind: 'busy' });
    expect(scanView('granted', false)).toEqual({ kind: 'camera' });
    expect(scanView('granted', true)).toEqual({ kind: 'camera' });
  });

  it("says a refused camera in Android's words, with Open settings only once asking again cannot help", () => {
    const text = "The camera isn't allowed for this app. Paste the invoice or address instead, or allow the camera in Android's settings.";
    expect(scanView('refused', false)).toEqual({ kind: 'refused', text, settings: false });
    expect(scanView('refused_for_good', false)).toEqual({ kind: 'refused', text, settings: true });
  });

  it('names Settings on an iPhone, where every refusal is for good', () => {
    expect(scanView('refused_for_good', true)).toEqual({
      kind: 'refused', text: "The camera isn't allowed for this app. Paste the invoice or address instead, or allow the camera in Settings.", settings: true,
    });
  });
});
