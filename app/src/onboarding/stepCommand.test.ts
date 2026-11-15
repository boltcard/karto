import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { STEP_NOT_RUN, STEP_PREFIX, stepCommand } from './stepCommand';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const sum = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

// A step started so that a drop cannot hurt it.
describe('stepCommand', () => {
  it('is one fixed script, then this start\'s token, the sum of its input or a dash, and the step\'s own command as it was', () => {
    expect(stepCommand('sh card-app/install.sh system', { token: A })).toBe(`${STEP_PREFIX} ${A} - sh card-app/install.sh system`);
    expect(stepCommand("sh card-app/install.sh prepare 'vm-1001.lnvps.cloud'", { token: B, stdin: 'twelve words' }))
      .toBe(`${STEP_PREFIX} ${B} ${sum('twelve words')} sh card-app/install.sh prepare 'vm-1001.lnvps.cloud'`);
    // The script sits in single quotes, so it holds none; nothing of the input is in the command.
    expect(STEP_PREFIX).toMatch(/^sh -c '[^']+' step$/);
    expect(stepCommand('sh card-app/install.sh seed', { token: A, stdin: 'legal winner' })).not.toContain('legal');
  });

  it('takes only a token of 32 hex digits', () => {
    for (const token of ['', 'abc', `${'a'.repeat(31)}g`, `${A} x`, `${A}'`]) expect(() => stepCommand('sh x', { token })).toThrow('token');
  });

  // A shell cannot hold either faithfully, so the sum on the server would not be the sum of what was sent.
  it('refuses an input it cannot sum faithfully: one that ends in a newline or holds a zero byte', () => {
    expect(() => stepCommand('sh x', { token: A, stdin: 'words\n' })).toThrow('newline');
    expect(() => stepCommand('sh x', { token: A, stdin: 'wo\0rds' })).toThrow('zero byte');
    expect(stepCommand('sh x', { token: A, stdin: 'two\nlines' })).toContain(sum('two\nlines'));
    expect(stepCommand('sh x', { token: A, stdin: '' })).toContain(` ${sum('')} `);
  });

  it('keeps its own refusals apart from every code a step answers with', () => {
    expect(STEP_NOT_RUN).toEqual({ superseded: 70, noConnection: 71, input: 72, files: 73 });
  });
});

/** A "server": a home folder with card-app in it, and a step that logs its start and end, waits, and answers as told. */
function server() {
  const home = mkdtempSync(join(tmpdir(), 'cardapp-step-'));
  mkdirSync(join(home, 'card-app'));
  // step.sh NAME SECONDS CODE: its input goes to card-app/NAME.in.
  writeFileSync(
    join(home, 'card-app/step.sh'),
    'echo "start $1" >>card-app/log; cat >card-app/$1.in; sleep "$2"; echo "out of $1"; echo "err of $1" >&2; echo "end $1" >>card-app/log; exit "$3"\n',
  );
  chmodSync(join(home, 'card-app/step.sh'), 0o755);
  const log = () => (existsSync(join(home, 'card-app/log')) ? readFileSync(join(home, 'card-app/log'), 'utf8').trim().split('\n') : []);
  /** Starts a command as sshd does (a shell, pipes for the three streams). sent: what goes down its input, if not the command's own. */
  const start = (command: string, sent?: string) => {
    const child = spawn('sh', ['-c', command], { cwd: home });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(sent ?? '');
    const ended = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
    /** The connection goes: nobody reads what the command writes any more. */
    const drop = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    return { ended, drop };
  };
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!ok()) throw new Error(`waited 4 s: ${log().join(', ')}`);
  };
  const step = (name: string, seconds = 0, code = 0) => `sh card-app/step.sh ${name} ${seconds} ${code}`;
  return { home, log, start, until, step };
}

describe.skipIf(process.platform !== 'linux')('stepCommand, run by a real shell', () => {
  it('brings back what the step wrote and the code it ended with', async () => {
    const s = server();
    const r = await s.start(stepCommand(s.step('one', 0, 7), { token: A })).ended;
    expect([r.code, r.stdout, r.stderr.trim()]).toEqual([7, 'out of one\n', 'err of one']);
    expect((await s.start(stepCommand(s.step('two', 0, 11), { token: B })).ended).code).toBe(11);
    expect((await s.start(stepCommand(s.step('three'), { token: C })).ended).code).toBe(0);
  });

  it('keeps the step\'s output in two files only the login user can read', async () => {
    const s = server();
    await s.start(stepCommand(s.step('one'), { token: A })).ended;
    for (const f of ['step.out', 'step.err']) expect(statSync(join(s.home, 'card-app', f)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(s.home, 'card-app/step.out'), 'utf8')).toBe('out of one\n');
  });

  it('hands the step its input whole, byte for byte', async () => {
    const s = server();
    const input = `${'QUJD+/09'.repeat(40_000)}\ntwo lines, the second not ended`;
    const command = stepCommand(s.step('db'), { token: A, stdin: input });
    expect((await s.start(command, input).ended).code).toBe(0);
    expect(readFileSync(join(s.home, 'card-app/db.in'), 'utf8')).toBe(input);
  });

  it('starts no step for an input cut short or altered on its way', async () => {
    const s = server();
    const input = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const command = (token: string) => stepCommand(s.step('seed'), { token, stdin: input });
    expect((await s.start(command(A), input.slice(0, 30)).ended).code).toBe(STEP_NOT_RUN.input);
    expect((await s.start(command(B), input.replace('yellow', 'winner')).ended).code).toBe(STEP_NOT_RUN.input);
    expect((await s.start(command(C), '').ended).code).toBe(STEP_NOT_RUN.input);
    expect(s.log()).toEqual([]);
  });

  it('gives a step that takes no input an empty one, whatever the connection sends', async () => {
    const s = server();
    await s.start(stepCommand(s.step('quiet'), { token: A }), 'not for this step').ended;
    expect(readFileSync(join(s.home, 'card-app/quiet.in'), 'utf8')).toBe('');
  });

  it('runs two starts one after the other, and each reads its own output', async () => {
    const s = server();
    const first = s.start(stepCommand(s.step('first', 0.4), { token: A }));
    await s.until(() => s.log().includes('start first'));
    const second = s.start(stepCommand(s.step('second', 0.1, 7), { token: B }));
    const [a, b] = await Promise.all([first.ended, second.ended]);
    expect(s.log()).toEqual(['start first', 'end first', 'start second', 'end second']);
    expect([a.code, a.stdout, a.stderr.trim()]).toEqual([0, 'out of first\n', 'err of first']);
    expect([b.code, b.stdout, b.stderr.trim()]).toEqual([7, 'out of second\n', 'err of second']);
  });

  // The first table's third row: a step whose connection goes is not killed, and the next start waits for it.
  it('lets a step whose connection went run to its end, and the next start wait for it', async () => {
    const s = server();
    const cut = s.start(stepCommand(s.step('cut', 0.4), { token: A }));
    await s.until(() => s.log().includes('start cut'));
    cut.drop();
    const again = await s.start(stepCommand(s.step('again'), { token: B })).ended;
    expect(s.log()).toEqual(['start cut', 'end cut', 'start again', 'end again']);
    expect(again.code).toBe(0);
  });

  // A phone locked and unlocked leaves starts waiting their turn: only the last runs the step.
  it('runs nothing for a start that a later one has overtaken while it waited', async () => {
    const s = server();
    const first = s.start(stepCommand(s.step('first', 0.4), { token: A }));
    await s.until(() => s.log().includes('start first'));
    first.drop();
    const second = s.start(stepCommand(s.step('second'), { token: B }));
    await new Promise((r) => setTimeout(r, 100));
    second.drop();
    const third = s.start(stepCommand(s.step('third'), { token: C }));
    const [b, c] = await Promise.all([second.ended, third.ended]);
    expect(s.log()).toEqual(['start first', 'end first', 'start third', 'end third']);
    expect([b.code, c.code, c.stdout]).toEqual([STEP_NOT_RUN.superseded, 0, 'out of third\n']);
  });

  it('runs nothing for a start whose connection is known to be gone when its turn comes', async () => {
    const s = server();
    const first = s.start(stepCommand(s.step('first', 0.4), { token: A }));
    await s.until(() => s.log().includes('start first'));
    const waiting = s.start(stepCommand(s.step('waiting'), { token: B }));
    await new Promise((r) => setTimeout(r, 100));
    waiting.drop();
    await Promise.all([first.ended, waiting.ended]);
    expect(s.log()).toEqual(['start first', 'end first']);
  });
});
