import { describe, expect, it } from 'vitest';
import { IOS_AUDIO_MODE, refusedBuzz } from './feel';

// The till's buzzes and chime on an iPhone.
describe('refusedBuzz', () => {
  it("keeps Android's two short buzzes", () => {
    expect(refusedBuzz(false)).toEqual([0, 80, 90, 80]);
  });

  it("gives an iPhone two of its fixed buzzes, 600 ms apart (its pattern's numbers are only the gaps)", () => {
    expect(refusedBuzz(true)).toEqual([0, 600]);
  });
});

describe('IOS_AUDIO_MODE', () => {
  it('plays the Paid chime with the silent switch on, alongside other apps', () => {
    expect(IOS_AUDIO_MODE).toEqual({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' });
  });
});
