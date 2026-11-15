// The phone diagnostics' channel-recovery check (make phone-recovery-check):
// over the paired server's SSH session, install.sh recovery-check sets phoenixd's database aside and waits
// for ACINQ to give the channel back, before any rebuild relies on that.
// make phone-recovery-check RESULT=1 only reads the last check's result.
import { DIR } from '../onboarding/install';
import type { ExecResult, SshSession } from '../onboarding/ssh';
import type { CheckResult } from './checks';

export const RECOVERY_CHECK_COMMAND = `sh ${DIR}/install.sh recovery-check`;
/** The last check's result once it has ended; exit 11 while it runs. */
export const RECOVERY_RESULT_COMMAND = `sh ${DIR}/install.sh recovery-check result`;

type Side = { balanceSat: number; channels: string[]; channelIds?: string[] };
type Outcome =
  | { ok: true; before: Side; after: Side; at?: string; seconds: number }
  | { ok: false; reason: string; before: Side; after?: Side; at?: string; seconds: number };

const lastLine = (s: string) => s.trim().split('\n').pop() ?? '';

function parse(line: string): Outcome | null {
  try {
    const o = JSON.parse(line) as Outcome;
    return typeof o === 'object' && o !== null && typeof o.ok === 'boolean' ? o : null;
  } catch {
    return null;
  }
}

/**
 * install.sh recovery-check's (or recovery-check result's) result: exit 0 passed, 9 the channel didn't come back
 * as it was, 10 refused (nothing changed), 11 a check is already running, 1 stopped on an error.
 */
export function recoveryResult(r: ExecResult): CheckResult {
  const name = 'recovery-check';
  const line = lastLine(r.stdout);
  const o = parse(line);
  if (r.code === 0 && o?.ok === true) {
    const detail = `the channel was Normal again after ${o.seconds} s with ${o.after.balanceSat} sat (${o.before.balanceSat} before) ${line}`;
    return { name, ok: true, detail };
  }
  if (r.code === 0) return { name, ok: false, detail: `install.sh recovery-check printed no result: ${line}` };
  const reason = o && !o.ok ? `${o.reason} ${line}` : null;
  if (r.code === 9 && reason) return { name, ok: false, detail: reason };
  const said = lastLine(r.stderr) || line;
  if (r.code === 10) return { name, ok: false, detail: `refused: ${reason ?? said}` };
  if (r.code === 11) return { name, ok: false, detail: `already running: ${said}` };
  if (r.code === 1 && reason) return { name, ok: false, detail: reason };
  return { name, ok: false, detail: `install.sh recovery-check exited ${r.code}: ${said}` };
}

/**
 * What a diagnostics build does (EXPO_PUBLIC_DIAG_RECOVERY): '1' runs a check, 'result' only reads the last
 * check's result (after the phone's session dropped, never a second check); anything else, neither.
 */
export function recoveryMode(env: string | undefined): 'check' | 'result' | null {
  return env === '1' ? 'check' : env === 'result' ? 'result' : null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** install.sh recovery-check's message while a check runs: "a check is running (from <at>, <phase>)". */
const RUNNING_FROM = /a check is running \(from (\d{8}T\d{6}Z),/;

/** How often, and how many times, to ask for the result of a check that was already running. */
const POLL_MS = 30_000;
const POLLS = 40;

/**
 * Logs in (connect), runs the check (up to MINUTES, 15, plus phoenixd's stop and start) and logs out. A check
 * already running (one whose SSH session dropped) is waited for, up to 20 minutes, and its result shown.
 * resultOnly: the last check's result, waited for in the same way, never a new check.
 */
export async function checkRecovery(
  connect: () => Promise<SshSession>,
  o: { sleep?: (ms: number) => Promise<void>; resultOnly?: boolean } = {},
): Promise<CheckResult[]> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let session: SshSession;
  try {
    session = await connect();
  } catch (e) {
    return [{ name: 'connect', ok: false, detail: message(e) }];
  }
  const out: CheckResult[] = [{ name: 'connect', ok: true, detail: 'logged in to the paired server' }];
  try {
    let r = await session.exec(o.resultOnly ? RECOVERY_RESULT_COMMAND : RECOVERY_CHECK_COMMAND);
    // Busy: a check runs (its start names it) or up, retire or wipe holds the lock, whose result would be an older check's.
    const at = r.code === 11 ? RUNNING_FROM.exec(r.stderr)?.[1] : undefined;
    if (r.code === 11 && !at) {
      out.push({ name: 'recovery-check', ok: false, detail: `no check is running, but ${lastLine(r.stderr)}: run it again once that ends` });
      return out;
    }
    for (let i = 0; r.code === 11 && i < POLLS; i++) {
      await sleep(POLL_MS);
      r = await session.exec(RECOVERY_RESULT_COMMAND);
    }
    const ended = at && r.code !== 11 ? parse(lastLine(r.stdout)) : null;
    if (ended && ended.at !== at) {
      out.push({ name: 'recovery-check', ok: false, detail: `the check from ${at} ended without a result of its own (the last is from ${ended.at ?? 'an older check'}): run it again` });
      return out;
    }
    out.push(recoveryResult(r));
  } catch (e) {
    out.push({ name: 'recovery-check', ok: false, detail: message(e) });
  } finally {
    await session.close().catch(() => {});
  }
  return out;
}
