import { describe, expect, it } from 'vitest';
import { lockKind, lockMissing, lockName, lockNotConfirmed } from './lockName';

// An iPhone never says "screen lock".
describe('the lock\'s name', () => {
  it('is the screen lock on Android, whatever is set up', () => {
    expect(lockKind({ ios: false, biometric: true, face: true })).toBe('screen-lock');
    expect(lockKind({ ios: false, biometric: false, face: false })).toBe('screen-lock');
    expect(lockName('screen-lock')).toBe('your screen lock');
  });
  it('is the iPhone\'s own, from what is set up on it', () => {
    expect(lockName(lockKind({ ios: true, biometric: true, face: true }))).toBe('Face ID or your passcode');
    expect(lockName(lockKind({ ios: true, biometric: true, face: false }))).toBe('Touch ID or your passcode');
    // Face ID on the phone but not set up: the passcode is what will be asked for.
    expect(lockName(lockKind({ ios: true, biometric: false, face: true }))).toBe('your passcode');
  });
  it('asks for a lock to be set in the phone\'s own words', () => {
    expect(lockMissing('screen-lock', 'wiping a card')).toBe('Set a screen lock on this phone first: wiping a card needs it.');
    expect(lockMissing('passcode', 'wiping a card')).toBe('Set a passcode on this phone first: wiping a card needs it.');
  });
  it('says what was not confirmed', () => {
    expect(lockNotConfirmed('screen-lock')).toBe('The screen lock was not confirmed.');
    expect(lockNotConfirmed('face')).toBe('Face ID or your passcode was not confirmed.');
    expect(lockNotConfirmed('touch')).toBe('Touch ID or your passcode was not confirmed.');
    expect(lockNotConfirmed('passcode')).toBe('Your passcode was not confirmed.');
  });
});
