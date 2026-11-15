import { describe, expect, it } from 'vitest';
import { NoDeviceKeyError } from '../native/deviceKey';
import { jobLine } from './jobLog';

describe('jobLine', () => {
  it('says a job with nothing to do was idle', () => {
    expect(jobLine({ ended: 'idle' })).toBe('{"ended":"idle"}');
  });

  it("says how a job that ran ended, by its result's kind alone", () => {
    expect(jobLine({ ended: 'done', kind: 'fetched' })).toBe('{"ended":"done","kind":"fetched"}');
    expect(jobLine({ ended: 'done', kind: 'unreachable' })).toBe('{"ended":"done","kind":"unreachable"}');
  });

  it("gives a failure's code and whether the phone had no key, and never its words", () => {
    const locked = Object.assign(new Error('DeviceKeyException: the key could not be read: -25308 (at CardNative/DeviceKey.swift:55)'), { code: 'ERR_DEVICE_KEY' });
    expect(jobLine({ ended: 'failed', error: locked })).toBe('{"ended":"failed","noKey":false,"code":"ERR_DEVICE_KEY"}');
    expect(jobLine({ ended: 'failed', error: new NoDeviceKeyError('this phone has no key') })).toBe('{"ended":"failed","noKey":true}');
    expect(jobLine({ ended: 'failed', error: new Error('unable to open database file /var/mobile/x/card-app.db') })).toBe('{"ended":"failed","noKey":false}');
  });

  it('leaves out a code that is not a plain code, and takes anything thrown', () => {
    expect(jobLine({ ended: 'failed', error: Object.assign(new Error('x'), { code: 'abandon ability able about' }) })).toBe('{"ended":"failed","noKey":false}');
    expect(jobLine({ ended: 'failed', error: Object.assign(new Error('x'), { code: 14 }) })).toBe('{"ended":"failed","noKey":false}');
    expect(jobLine({ ended: 'failed', error: 'a string' })).toBe('{"ended":"failed","noKey":false}');
    expect(jobLine({ ended: 'failed', error: null })).toBe('{"ended":"failed","noKey":false}');
  });
});
