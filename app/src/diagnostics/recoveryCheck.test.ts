import { describe, expect, it } from 'vitest';
import type { ExecResult, SshSession } from '../onboarding/ssh';
import { checkRecovery, RECOVERY_CHECK_COMMAND, RECOVERY_RESULT_COMMAND, recoveryMode, recoveryResult } from './recoveryCheck';

const ok = '{"ok":true,"before":{"balanceSat":50123,"channels":["Normal"]},"after":{"balanceSat":50123,"channels":["Normal"]},"seconds":312}';
const failed = '{"ok":false,"reason":"no Normal channel within 15 min (phoenixd: Offline, 0 sat): the original database is back","before":{"balanceSat":50123,"channels":["Normal"]},"seconds":958}';
const okAt = ok.replace('"seconds"', '"at":"20261007T000000Z","seconds"');
const exec = (code: number, stdout = '', stderr = ''): ExecResult => ({ code, stdout, stderr });

describe('recoveryResult', () => {
  // make phone-recovery-check: install.sh
  // recovery-check's one JSON line, on the phone's diagnostics screen and in logcat.
  it('passes when the channel came back with the same balance, saying how long it took', () => {
    const r = recoveryResult(exec(0, `${ok}\n`));
    expect(r).toEqual({ name: 'recovery-check', ok: true, detail: `the channel was Normal again after 312 s with 50123 sat (50123 before) ${ok}` });
  });

  it("fails with install.sh's reason when no channel came back (exit 9: the original database is back)", () => {
    const r = recoveryResult(exec(9, `${failed}\n`));
    expect(r.ok).toBe(false);
    expect(r.detail).toBe(`no Normal channel within 15 min (phoenixd: Offline, 0 sat): the original database is back ${failed}`);
  });

  it('fails when install.sh refused before touching anything (exit 10), with its message', () => {
    const r = recoveryResult(exec(10, '', 'install.sh recovery-check: no Normal channel to check (phoenixd: no channels, 0 sat)\n'));
    expect(r).toEqual({ name: 'recovery-check', ok: false, detail: 'refused: install.sh recovery-check: no Normal channel to check (phoenixd: no channels, 0 sat)' });
  });

  it('fails with the reason when it refused after looking again (exit 10 with JSON), or stopped on an error (exit 1)', () => {
    const late = '{"ok":false,"reason":"a payment started as the check began (cardd ledger holds): nothing was changed","before":{"balanceSat":50123,"channels":["Normal"],"channelIds":["c0ffee"]},"at":"20261007T000000Z","seconds":3}';
    expect(recoveryResult(exec(10, `${late}\n`))).toEqual({
      name: 'recovery-check', ok: false, detail: `refused: a payment started as the check began (cardd ledger holds): nothing was changed ${late}`,
    });
    const abort = '{"ok":false,"reason":"the check stopped on an error (exit 1): see recovery-check.log; no Normal channel within 15 min (phoenixd: Offline, 0 sat): the original database is back","before":{"balanceSat":50123,"channels":["Normal"]},"seconds":958}';
    expect(recoveryResult(exec(1, `${abort}\n`)).detail).toBe(
      `the check stopped on an error (exit 1): see recovery-check.log; no Normal channel within 15 min (phoenixd: Offline, 0 sat): the original database is back ${abort}`);
  });

  it('says a check is already running (exit 11), with its message', () => {
    const r = recoveryResult(exec(11, '', 'install.sh recovery-check: a check is running (from 20261007T000000Z, started): install.sh recovery-check result prints its result once it ends\n'));
    expect(r).toEqual({
      name: 'recovery-check', ok: false,
      detail: 'already running: install.sh recovery-check: a check is running (from 20261007T000000Z, started): install.sh recovery-check result prints its result once it ends',
    });
  });

  it("fails on any other exit, or an exit 0 whose last line isn't a passed check", () => {
    expect(recoveryResult(exec(2, '', 'usage: install.sh …\n')).detail).toBe('install.sh recovery-check exited 2: usage: install.sh …');
    expect(recoveryResult(exec(0, 'hello\n'))).toEqual({ name: 'recovery-check', ok: false, detail: 'install.sh recovery-check printed no result: hello' });
    expect(recoveryResult(exec(0, `${failed}\n`)).ok).toBe(false);
    expect(recoveryResult(exec(9, 'garbage\n')).detail).toBe('install.sh recovery-check exited 9: garbage');
  });
});

describe('checkRecovery', () => {
  it('runs install.sh recovery-check over SSH and closes the session', async () => {
    const ran: string[] = [];
    let closed = false;
    const session = {
      exec: async (cmd: string) => (ran.push(cmd), exec(0, ok)),
      close: async () => void (closed = true),
    } as unknown as SshSession;
    const r = await checkRecovery(async () => session);
    expect(ran).toEqual([RECOVERY_CHECK_COMMAND]);
    expect(RECOVERY_CHECK_COMMAND).toBe('sh card-app/install.sh recovery-check');
    expect(r.map((x) => [x.name, x.ok])).toEqual([['connect', true], ['recovery-check', true]]);
    expect(closed).toBe(true);
  });

  it("waits for a check that is already running (a dropped session's) and shows its result", async () => {
    const ran: string[] = [];
    const answers = [
      exec(11, '', 'install.sh recovery-check: a check is running (from 20261007T000000Z, started): …\n'),
      exec(11, '', 'install.sh recovery-check: a check is running (from 20261007T000000Z, normal): …\n'),
      exec(0, `${okAt}\n`),
    ];
    const session = {
      exec: async (cmd: string) => (ran.push(cmd), answers.shift()!),
      close: async () => {},
    } as unknown as SshSession;
    const slept: number[] = [];
    const r = await checkRecovery(async () => session, { sleep: async (ms) => void slept.push(ms) });
    expect(RECOVERY_RESULT_COMMAND).toBe('sh card-app/install.sh recovery-check result');
    expect(ran).toEqual([RECOVERY_CHECK_COMMAND, RECOVERY_RESULT_COMMAND, RECOVERY_RESULT_COMMAND]);
    expect(slept).toEqual([30_000, 30_000]);
    expect(r[1]).toMatchObject({ name: 'recovery-check', ok: true });
  });

  // The lock is also held while up, retire or wipe runs: the result then is an older check's.
  it('polls only for a check that runs, and never shows an older check\'s result as its own', async () => {
    const busy = (answers: ExecResult[]) => {
      const ran: string[] = [];
      const session = { exec: async (cmd: string) => (ran.push(cmd), answers.shift()!), close: async () => {} } as unknown as SshSession;
      return { ran, connect: async () => session };
    };
    const other = busy([exec(11, '', 'install.sh recovery-check: another install.sh step (up, retire or wipe) is running\n')]);
    const r = await checkRecovery(other.connect, { sleep: async () => {} });
    expect(other.ran).toEqual([RECOVERY_CHECK_COMMAND]);
    expect(r[1]).toEqual({
      name: 'recovery-check', ok: false,
      detail: 'no check is running, but install.sh recovery-check: another install.sh step (up, retire or wipe) is running: run it again once that ends',
    });
    const older = busy([
      exec(11, '', 'install.sh recovery-check: a check is running (from 20261007T000000Z, started): …\n'),
      exec(0, `${ok.replace('"seconds"', '"at":"20261006T120000Z","seconds"')}\n`),
    ]);
    const r2 = await checkRecovery(older.connect, { sleep: async () => {} });
    expect(r2[1]).toEqual({
      name: 'recovery-check', ok: false,
      detail: 'the check from 20261007T000000Z ended without a result of its own (the last is from 20261006T120000Z): run it again',
    });
  });

  it('gives up waiting after 20 minutes, saying it is still running', async () => {
    let n = 0;
    const session = {
      exec: async () => (n++, exec(11, '', 'install.sh recovery-check: a check is running (from 20261007T000000Z, started): …\n')),
      close: async () => {},
    } as unknown as SshSession;
    const r = await checkRecovery(async () => session, { sleep: async () => {} });
    expect(n).toBe(1 + 40);
    expect(r[1]).toEqual({ name: 'recovery-check', ok: false, detail: 'already running: install.sh recovery-check: a check is running (from 20261007T000000Z, started): …' });
  });

  // make phone-recovery-check RESULT=1, after the phone's session dropped: never a second check, with cardd stopped again.
  it('only reads the last result in result mode, waiting for a check that still runs', async () => {
    const ran: string[] = [];
    const answers = [exec(11, '', 'install.sh recovery-check: a check is running (from 20261007T000000Z, normal): …\n'), exec(0, `${okAt}\n`)];
    const session = { exec: async (cmd: string) => (ran.push(cmd), answers.shift()!), close: async () => {} } as unknown as SshSession;
    const r = await checkRecovery(async () => session, { sleep: async () => {}, resultOnly: true });
    expect(ran).toEqual([RECOVERY_RESULT_COMMAND, RECOVERY_RESULT_COMMAND]);
    expect(r[1]).toMatchObject({ name: 'recovery-check', ok: true });
    const ended = { exec: async (cmd: string) => (ran.push(cmd), exec(0, `${okAt}\n`)), close: async () => {} } as unknown as SshSession;
    ran.length = 0;
    expect((await checkRecovery(async () => ended, { resultOnly: true }))[1]).toMatchObject({ ok: true });
    expect(ran).toEqual([RECOVERY_RESULT_COMMAND]);
  });

  it('reads the mode from the build: a check, its result only, or neither', () => {
    expect(recoveryMode('1')).toBe('check');
    expect(recoveryMode('result')).toBe('result');
    expect(recoveryMode(undefined)).toBeNull();
    expect(recoveryMode('')).toBeNull();
  });

  it("reports a connection that fails, and a dropped session's error", async () => {
    const r = await checkRecovery(async () => { throw new Error('the server refused the key for debian'); });
    expect(r).toEqual([{ name: 'connect', ok: false, detail: 'the server refused the key for debian' }]);
    const dropped = { exec: async () => { throw new Error('Broken transport'); }, close: async () => {} } as unknown as SshSession;
    const r2 = await checkRecovery(async () => dropped);
    expect(r2[1]).toEqual({ name: 'recovery-check', ok: false, detail: 'Broken transport' });
  });
});
