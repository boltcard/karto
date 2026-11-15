// What the background backup job writes to the phone's log when it ends: one line, so that a run
// can see the job ran and how it ended. A failure gives its code and whether the phone had no key, never its
// words: an error's message may name a file, a host or what the phone's key store said.
import { NoDeviceKeyError } from '../native/deviceKey';

export type JobEnd = { ended: 'idle' } | { ended: 'done'; kind: string } | { ended: 'failed'; error: unknown };

const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;

export function jobLine(end: JobEnd): string {
  if (end.ended === 'idle') return JSON.stringify({ ended: 'idle' });
  if (end.ended === 'done') return JSON.stringify({ ended: 'done', kind: end.kind });
  const code = (end.error as { code?: unknown } | null)?.code;
  return JSON.stringify({ ended: 'failed', noKey: end.error instanceof NoDeviceKeyError, ...(typeof code === 'string' && CODE.test(code) ? { code } : {}) });
}
