// stepCommand against a real OpenSSH server: what a
// cut connection does to a step started plainly and to one started through the app's command. Run by
// deploy/test/ssh-drop-test.sh, which starts the server in a container and sets CARD_SSH_DROP_TEST to
// host:port:user:keyfile; without that these are skipped (the app's suite needs no Docker).
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer, type Socket } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { stepCommand } from './stepCommand';

const [host, port, user, key] = (process.env.CARD_SSH_DROP_TEST ?? '').split(':');
const token = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];

/** Runs a command on the server as the phone would: one connection, the command, its three streams. */
function ssh(command: string, o: { port?: string; input?: string } = {}) {
  const args = ['-i', key, '-p', o.port ?? port, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'BatchMode=yes', `${user}@${host}`, command];
  const child = spawn('ssh', args);
  children.push(child);
  let stdout = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d));
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(o.input ?? '');
  const ended = new Promise<{ code: number | null; stdout: string }>((resolve) => child.on('close', (code) => resolve({ code, stdout })));
  /** The client dies: the server sees the connection close at once. */
  const kill = () => void child.kill('SIGKILL');
  return { ended, kill };
}
const run = async (command: string) => (await ssh(command).ended).stdout.trim();

/** A step that writes as it goes for `seconds`, logging each second and its end under `name`. */
const step = (name: string, seconds: number) => `sh card-app/step.sh ${name} ${seconds}`;
const log = async (name: string) => (await run(`cat card-app/${name}.log 2>/dev/null`)).split('\n').filter(Boolean);
const wrapped = (name: string, seconds: number) => stepCommand(step(name, seconds), { token: token() });
const until = async (ok: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 100; i++) {
    if (await ok()) return;
    await sleep(200);
  }
  throw new Error(`waited 20 s for ${what}`);
};

/**
 * A way to the server that can go silent: everything is passed on until silence(), after which nothing is, in
 * either direction, and nothing is closed. What an iPhone's connection does when the app is paused.
 */
async function silentWay() {
  const pairs: [Socket, Socket][] = [];
  let silent = false;
  const server = createServer((from) => {
    const to = createConnection(Number(port), host);
    pairs.push([from, to]);
    from.on('data', (d) => void (silent || to.write(d)));
    to.on('data', (d) => void (silent || from.write(d)));
    for (const s of [from, to]) s.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  return {
    port: String(address.port),
    silence: () => void (silent = true),
    close: () => {
      for (const [a, b] of pairs) (a.destroy(), b.destroy());
      server.close();
    },
  };
}

describe.skipIf(!key)('a step and a connection that drops, on a real OpenSSH server', { timeout: 120_000 }, () => {
  afterAll(() => {
    for (const c of children) c.kill('SIGKILL');
  });

  it('has a step to run', async () => {
    const script = 'i=0; while [ $i -lt $2 ]; do sleep 1; i=$((i+1)); echo "$1 $i"; echo "$1 err $i" >&2; echo $i >>card-app/$1.log; done; echo end >>card-app/$1.log';
    await ssh('mkdir -p card-app && rm -f card-app/*.log card-app/step.* && cat >card-app/step.sh', { input: `${script}\n` }).ended;
    expect(await run('sh card-app/step.sh ready 1 2>/dev/null; cat card-app/ready.log')).toBe('ready 1\n1\nend');
  });

  // The fault a step command is there to prevent.
  it('kills a step started plainly, at its next write after the connection is cut', async () => {
    const plain = ssh(step('plain', 6));
    await until(async () => (await log('plain')).length >= 2, 'the plain step to start');
    plain.kill();
    await sleep(6_000);
    const seen = await log('plain');
    expect(seen).not.toContain('end');
    expect(seen.length).toBeLessThan(6);
  });

  // Its third row, with the app's own command.
  it('lets a step started through the command run to its end, and makes the next start wait for it', async () => {
    const first = ssh(wrapped('cut', 5));
    await until(async () => (await log('cut')).length >= 1, 'the step to start');
    first.kill();
    const again = await ssh(wrapped('again', 1)).ended;
    expect(again.code).toBe(0);
    expect(again.stdout).toBe('again 1\n');
    expect(await log('cut')).toEqual(['1', '2', '3', '4', '5', 'end']);
    // The second ran only once the first had ended: its one line came after.
    expect(Number(await run('stat -c %Y card-app/again.log'))).toBeGreaterThanOrEqual(Number(await run('stat -c %Y card-app/cut.log')));
  });

  it('runs the step for the first and the last of three starts, and never for one overtaken while it waited', async () => {
    const first = ssh(wrapped('one', 4));
    await until(async () => (await log('one')).length >= 1, 'the first to start');
    first.kill();
    const second = ssh(wrapped('two', 1));
    await sleep(800);
    second.kill();
    const third = await ssh(wrapped('three', 1)).ended;
    expect(third.code).toBe(0);
    await sleep(1_500);
    expect([await log('one'), await log('two'), await log('three')]).toEqual([['1', '2', '3', '4', 'end'], [], ['1', 'end']]);
  });

  // The iPhone's kind: nothing is closed, the connection just stops carrying anything.
  it('lets a step run to its end when its connection goes silent, and the next start run after it', async () => {
    const way = await silentWay();
    try {
      const quiet = ssh(wrapped('silent', 5), { port: way.port });
      await until(async () => (await log('silent')).length >= 1, 'the step to start');
      way.silence();
      const next = await ssh(wrapped('after', 1)).ended;
      expect(next.code).toBe(0);
      expect([await log('silent'), await log('after')]).toEqual([['1', '2', '3', '4', '5', 'end'], ['1', 'end']]);
      quiet.kill();
    } finally {
      way.close();
    }
  });
});
