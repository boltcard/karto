import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import {
  addDevice, finalSnapshot, FinalSnapshotRefused, install, InstallError, INSTALL_STEPS, isRetired, phoenixdState, RecoveryCheckRunning, recoveryCheckRunning,
  retireServer, savedSteps, SECRET_STEPS, uploadBundle, type InstallStep,
} from './install';
import { shellQuote, SshDropped, SshUploadRefused } from './ssh';
import { STEP_NOT_RUN, STEP_PREFIX, stepCommand } from './stepCommand';
import { FakeCardd } from '../testing/fakeCardd';
import { FakeSsh } from '../testing/fakeSsh';
import { vectors } from '../testing/vectors';

const bundle = [
  { path: 'install.sh', mode: 0o755, sha256: 'aa'.repeat(32), data: new Uint8Array([1]) },
  { path: 'bin/cardd', mode: 0o755, sha256: 'bb'.repeat(32), asset: 'deploy/bin/cardd', size: 11_088_034 },
];
const base = {
  bundle,
  host: 'vm-1001.lnvps.cloud',
  phoenixdSeed: 'prosper short ramp prepare exchange stove life snack client enough purpose fold',
  issuerKey: '866a12e42e31a09aa8ca4f25a02e999e',
  meta: { 'vm.id': '1001', 'vm.host': 'vm-1001.lnvps.cloud', 'vm.ipv4': '45.67.89.164', 'mailtm.address': "o'brien@uberip.com" },
};

const session = async (ssh: FakeSsh) =>
  ssh.connect({ host: 'h', port: 22, user: 'debian', hostKey: { keyType: 'ssh-ed25519', publicKey: 'AAAA' }, ed25519Seed: '00' });

// FakeSsh reads a step's command out of the one it is sent in
// (commands), keeps what was sent (sent) and checks the input's sum as the real command does.
describe('install, every step started so that a drop cannot hurt it', () => {
  const run = async (o: Partial<Parameters<typeof install>[1]> = {}, ssh = new FakeSsh()) => {
    await install(await session(ssh), { ...base, done: [], onStep: async () => {}, ...o });
    return ssh;
  };

  it('sends each script step through the step command, with a token of its own and the sum of its input', async () => {
    let n = 0;
    const ssh = await run({ token: () => String(++n).padStart(32, '0') });
    const steps = ssh.sent.filter((c) => c.command.startsWith(STEP_PREFIX));
    expect(steps.map((c) => c.command)).toEqual([
      stepCommand('sh card-app/install.sh first-boot', { token: '1'.padStart(32, '0') }),
      stepCommand('sh card-app/install.sh swap', { token: '2'.padStart(32, '0') }),
      stepCommand('sh card-app/install.sh docker', { token: '3'.padStart(32, '0') }),
      stepCommand('sh card-app/install.sh docker-setup', { token: '4'.padStart(32, '0') }),
      stepCommand("sh card-app/install.sh prepare 'vm-1001.lnvps.cloud'", { token: '5'.padStart(32, '0') }),
      stepCommand('sh card-app/install.sh seed', { token: '6'.padStart(32, '0'), stdin: base.phoenixdSeed }),
      stepCommand('sh card-app/install.sh issuer-key', { token: '7'.padStart(32, '0'), stdin: base.issuerKey }),
      stepCommand('sh card-app/install.sh up', { token: '8'.padStart(32, '0') }),
      ...Object.entries(base.meta).map(([k, v], i) => stepCommand(`sh card-app/cardd-ctl meta set ${shellQuote(k)} ${shellQuote(v)}`, { token: String(9 + i).padStart(32, '0') })),
    ]);
    expect(steps.map((c) => c.stdin)).toEqual([undefined, undefined, undefined, undefined, undefined, base.phoenixdSeed, base.issuerKey, undefined, undefined, undefined, undefined, undefined]);
    // The upload's two commands are not steps of the script.
    expect(ssh.sent.filter((c) => !c.command.startsWith(STEP_PREFIX)).map((c) => c.command)).toEqual([
      'mkdir -p card-app/bin', 'cd card-app && sha256sum -c - 2>/dev/null', "cd card-app && chmod 755 'install.sh' 'bin/cardd'", 'cd card-app && sha256sum --quiet -c -',
    ]);
    const all = ssh.sent.map((c) => c.command).join(' ');
    expect([all.includes(base.issuerKey), all.includes('prosper')]).toEqual([false, false]);
  });

  it('makes a new random token for every start when none is given', async () => {
    const ssh = await run();
    const tokens = ssh.steps.map((s) => s.token);
    expect(tokens.every((t) => /^[0-9a-f]{32}$/.test(t))).toBe(true);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('sends a restore\'s database with its sum too', async () => {
    const db = new Uint8Array([83, 81, 76, 105, 116, 101]);
    const ssh = await run({ restore: { kind: 'db', db }, device: 'ab'.repeat(33) });
    const restore = ssh.steps.find((s) => / restore /.test(s.command))!;
    expect(restore.sum).toMatch(/^[0-9a-f]{64}$/);
    expect(ssh.commands.find((c) => / restore /.test(c.command))!.stdin).toBe(base64.encode(db));
  });

  it('runs the four system commands in order, telling each step as it starts', async () => {
    const started: InstallStep[] = [];
    const ssh = await run({ onStart: (step) => void started.push(step) });
    const steps = ssh.commands.map((c) => /install\.sh (first-boot|swap|docker-setup|docker|system)\b/.exec(c.command)?.[1]).filter(Boolean);
    expect(steps).toEqual(['first-boot', 'swap', 'docker', 'docker-setup']);
    expect(started).toEqual([...INSTALL_STEPS]);
  });

  it('reads a saved list from before the system step was split in four (savedSteps)', () => {
    expect(savedSteps(['upload', 'system', 'prepare'])).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare']);
    expect(savedSteps(['upload', 'nonsense'])).toEqual(['upload']);
    expect(savedSteps(['upload', 'swap'])).toEqual(['upload', 'swap']);
  });

  it.each(Object.entries(STEP_NOT_RUN))('treats the command\'s own refusal "%s" as a drop: the step did not run, and is started again', async (_name, code) => {
    const ssh = new FakeSsh().when(/install\.sh prepare/, { code }, 1);
    const done: InstallStep[] = [];
    const opts = { ...base, done, onStep: async (s: InstallStep) => void done.push(s) };
    const e = await install(await session(ssh), opts).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(SshDropped);
    expect((e as SshDropped).during).toBe('command');
    expect(done).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup']);
    await install(await session(ssh), opts);
    expect(done).toEqual([...INSTALL_STEPS]);
  });

  it('still reads a step\'s own failure as the step\'s', async () => {
    const ssh = new FakeSsh().when(/install\.sh seed/, { code: 3, stderr: '\ninstall.sh seed: phoenixd already has a different seed; refusing to replace it' });
    await expect(run({}, ssh)).rejects.toMatchObject({ kind: 'wrong_phrase', step: 'seed' });
  });

  // The command writes one empty line to the connection before the step runs (its look at whether the connection
  // is there), so a step's own stderr is never empty as the app receives it: its words may be on stdout alone.
  it('says why a step failed when its reason came on stdout', async () => {
    const ssh = new FakeSsh().when(/install\.sh up/, { code: 1, stdout: 'Container card-app-cardd-1  Error\ndependency failed to start: container card-app-cardd-1 is unhealthy\n', stderr: '\n' });
    await expect(run({}, ssh)).rejects.toThrow('install.sh up failed (exit 1): Container card-app-cardd-1  Error dependency failed to start: container card-app-cardd-1 is unhealthy');
    const both = new FakeSsh().when(/install\.sh up/, { code: 1, stdout: 'on stdout', stderr: '\non stderr\n' });
    await expect(run({}, both)).rejects.toThrow('install.sh up failed (exit 1): on stderr');
  });

  it('refuses, before anything is sent, an input the server could not sum', async () => {
    const ssh = new FakeSsh();
    await expect(run({ issuerKey: `${base.issuerKey}\n` }, ssh)).rejects.toThrow('newline');
    expect(ssh.ran(/issuer-key/)).toBe(0);
  });
});

describe('install', () => {
  it('uploads the bundle and runs every step in order, secrets on stdin only', async () => {
    const ssh = new FakeSsh();
    const done: InstallStep[] = [];
    await install(await session(ssh), { ...base, done: [], onStep: async (s) => void done.push(s) });
    expect(done).toEqual([...INSTALL_STEPS]);
    expect([...ssh.files.keys()]).toEqual(['card-app/install.sh', 'card-app/bin/cardd']);
    // The binary streams from the APK's assets; small files go as bytes.
    expect(ssh.files.get('card-app/bin/cardd')).toEqual({ asset: 'deploy/bin/cardd', size: 11_088_034, mode: 0o755 });
    expect(ssh.commands.map((c) => c.command)).toEqual([
      'mkdir -p card-app/bin',
      'cd card-app && sha256sum -c - 2>/dev/null',
      "cd card-app && chmod 755 'install.sh' 'bin/cardd'",
      'cd card-app && sha256sum --quiet -c -',
      'sh card-app/install.sh first-boot',
      'sh card-app/install.sh swap',
      'sh card-app/install.sh docker',
      'sh card-app/install.sh docker-setup',
      "sh card-app/install.sh prepare 'vm-1001.lnvps.cloud'",
      'sh card-app/install.sh seed',
      'sh card-app/install.sh issuer-key',
      'sh card-app/install.sh up',
      "sh card-app/cardd-ctl meta set 'vm.id' '1001'",
      "sh card-app/cardd-ctl meta set 'vm.host' 'vm-1001.lnvps.cloud'",
      "sh card-app/cardd-ctl meta set 'vm.ipv4' '45.67.89.164'",
      `sh card-app/cardd-ctl meta set 'mailtm.address' 'o'\\''brien@uberip.com'`,
    ]);
    expect(ssh.commands[3].stdin).toBe(`${'aa'.repeat(32)}  install.sh\n${'bb'.repeat(32)}  bin/cardd\n`);
    expect(ssh.commands[9].stdin).toBe(base.phoenixdSeed);
    expect(ssh.commands[10].stdin).toBe(base.issuerKey);
    expect(ssh.commands.map((c) => c.command).join(' ')).not.toContain(base.issuerKey);
    expect(ssh.commands.map((c) => c.command).join(' ')).not.toContain('prosper');
  });

  it('resumes after a failure without repeating finished steps', async () => {
    const ssh = new FakeSsh().when(/install\.sh up/, { code: 1, stderr: 'cardd-1 is unhealthy' }, 1);
    const done: InstallStep[] = [];
    const opts = { ...base, done, onStep: async (s: InstallStep) => void done.push(s) };
    const err = await install(await session(ssh), opts).catch((e) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect(err.kind).toBe('retry');
    expect(err.message).toContain('cardd-1 is unhealthy');
    expect(done).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'host-key', 'seed', 'issuer-key', 'restore']);
    await install(await session(ssh), opts);
    expect(ssh.ran(/install\.sh (first-boot|swap|docker|docker-setup)$/)).toBe(4);
    expect(ssh.ran(/install\.sh up/)).toBe(2);
    expect(done).toEqual([...INSTALL_STEPS]);
  });

  // The caller's check that LNVPS confirmed the server's key runs before any step that sends a secret, and stops them all.
  it('runs host-key\'s check after the steps that carry no secret and before every one that does', async () => {
    const ssh = new FakeSsh();
    const done: InstallStep[] = [];
    const unconfirmed = new Error('not confirmed yet');
    let ranBefore: string[] = [];
    const confirmHostKey = async () => {
      ranBefore = ssh.commands.map((c) => c.command);
      throw unconfirmed;
    };
    const err = await install(await session(ssh), { ...base, done, onStep: async (s) => void done.push(s), confirmHostKey }).catch((e) => e);
    expect(err).toBe(unconfirmed);
    expect(done).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe']);
    expect(ranBefore.some((c) => /install\.sh prepare /.test(c))).toBe(true);
    expect(ssh.ran(/install\.sh (seed|issuer-key|restore|restore-fresh)( |$)/)).toBe(0);
    expect(ssh.commands.some((c) => c.stdin === base.phoenixdSeed || c.stdin === base.issuerKey)).toBe(false);
    expect(SECRET_STEPS.every((x) => INSTALL_STEPS.indexOf(x) > INSTALL_STEPS.indexOf('host-key'))).toBe(true);
    // Confirmed, the install carries on from host-key.
    await install(await session(ssh), { ...base, done, onStep: async (s) => void done.push(s), confirmHostKey: async () => {} });
    expect(done).toEqual([...INSTALL_STEPS]);
  });

  it('reports a different existing seed or issuer key as a wrong phrase', async () => {
    for (const step of ['seed', 'issuer-key']) {
      const ssh = new FakeSsh().when(new RegExp(`install\\.sh ${step}$`), { code: 3, stderr: 'refusing to replace' });
      const err = await install(await session(ssh), { ...base, done: [], onStep: async () => {} }).catch((e) => e);
      expect(err.kind).toBe('wrong_phrase');
      expect(err.step).toBe(step);
    }
  });

  it('does not trust an upload whose checksums do not match', async () => {
    const ssh = new FakeSsh().when(/sha256sum --quiet/, { code: 1, stdout: 'bin/cardd: FAILED' }, 1);
    const done: InstallStep[] = [];
    const opts = { ...base, done, onStep: async (s: InstallStep) => void done.push(s) };
    const err = await install(await session(ssh), opts).catch((e) => e);
    expect(err).toMatchObject({ kind: 'retry', step: 'upload' });
    expect(err.message).toContain('bin/cardd: FAILED');
    expect(done).toEqual([]);
    expect(ssh.ran(/^sh card-app\/install\.sh/)).toBe(0);
    await install(await session(ssh), opts);
    expect(done).toEqual([...INSTALL_STEPS]);
  });

  it('reports up without a seed as a bug, not a retry', async () => {
    const ssh = new FakeSsh().when(/install\.sh up/, { code: 4 });
    const err = await install(await session(ssh), { ...base, done: [], onStep: async () => {} }).catch((e) => e);
    expect(err.kind).toBe('bug');
  });
});

// A rebuild: the old data wiped first in place, the backup restored before up.
describe('install for a rebuild', () => {
  const device = vectors.deviceAuth.publicKey;
  const from = '00112233445566778899aabbccddeeff-7-1790000000';
  /** Every byte value, many times over: base64 on stdin must bring each back exactly. */
  const db = Uint8Array.from({ length: 256 * 41 + 7 }, (_, i) => i % 256);
  const served = () => {
    const ssh = new FakeSsh();
    const cardd = new FakeCardd(() => Date.UTC(2026, 9, 6, 17, 40, 12)).serve(ssh);
    return { ssh, cardd };
  };

  it('wipes after prepare, restores the database byte for byte after the issuer key, and checks just before up', async () => {
    const { ssh, cardd } = served();
    cardd.retired = { at: '2026-10-06T12:00:00Z', replacedBy: 1001 }; // a test VM retired this one; going back to it
    cardd.database = true;
    const done: InstallStep[] = [];
    const seen: string[] = [];
    await install(await session(ssh), {
      ...base, wipe: true, restore: { kind: 'db', db, from }, device, done: [],
      onStep: async (x) => void done.push(x),
      beforeUp: async () => void seen.push(`beforeUp after ${ssh.commands.at(-1)!.command}`),
    });
    expect(done).toEqual(['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'wipe', 'host-key', 'seed', 'issuer-key', 'restore', 'up', 'meta']);
    expect(done).toEqual([...INSTALL_STEPS]);
    expect(ssh.commands.map((c) => c.command).slice(4, 14)).toEqual([
      'sh card-app/install.sh first-boot',
      'sh card-app/install.sh swap',
      'sh card-app/install.sh docker',
      'sh card-app/install.sh docker-setup',
      "sh card-app/install.sh prepare 'vm-1001.lnvps.cloud'",
      'sh card-app/install.sh wipe',
      'sh card-app/install.sh seed',
      'sh card-app/install.sh issuer-key',
      `sh card-app/install.sh restore '${device}' '1001' 'vm-1001.lnvps.cloud' '45.67.89.164' '${from}'`,
      'sh card-app/install.sh up',
    ]);
    expect(seen).toEqual([`beforeUp after sh card-app/install.sh restore '${device}' '1001' 'vm-1001.lnvps.cloud' '45.67.89.164' '${from}'`]);
    // The database goes on stdin as text, never in the command.
    expect(ssh.commands[12].stdin).toBe(base64.encode(db));
    expect(cardd.restored).toEqual({ kind: 'db', db, device, from });
    expect(cardd.retired).toBeNull();
    expect(cardd.meta.get('restore.from')).toBe(from);
    // The new VM from the restore on, before up: cardd's first snapshot names it.
    expect([cardd.meta.get('vm.id'), cardd.meta.get('vm.host'), cardd.meta.get('vm.ipv4')]).toEqual(['1001', 'vm-1001.lnvps.cloud', '45.67.89.164']);
  });

  it('starts from an empty database for the phrase alone', async () => {
    const { ssh, cardd } = served();
    const done: InstallStep[] = [];
    await install(await session(ssh), { ...base, restore: { kind: 'fresh' }, device, done: [], onStep: async (x) => void done.push(x) });
    expect(done).toEqual([...INSTALL_STEPS]);
    const fresh = ssh.commands.find((c) => /restore/.test(c.command))!;
    expect(fresh).toEqual({ command: `sh card-app/install.sh restore-fresh '${device}' '1001' 'vm-1001.lnvps.cloud' '45.67.89.164'`, stdin: undefined });
    expect(ssh.ran(/install\.sh wipe/)).toBe(0);
    expect(cardd.restored).toEqual({ kind: 'fresh', device });
    expect(cardd.meta.get('restore.from')).toBe('phrase');
  });

  // Each step is saved once done; a cut before restore's was saved runs it again, which cardd answers "already restored".
  it('restores again harmlessly after a cut, and never after up', async () => {
    const { ssh, cardd } = served();
    ssh.when(/install\.sh up/, { code: 1, stderr: 'cardd-1 is unhealthy' }, 1);
    const done: InstallStep[] = [];
    const opts = { ...base, restore: { kind: 'db' as const, db, from }, device, done, onStep: async (x: InstallStep) => void done.push(x) };
    await expect(install(await session(ssh), opts)).rejects.toMatchObject({ kind: 'retry', step: 'up' });
    expect(done.at(-1)).toBe('restore');
    await install(await session(ssh), { ...opts, done: done.filter((x) => x !== 'restore') });
    expect(ssh.ran(/install\.sh restore /)).toBe(2);
    expect(cardd.restored).toEqual({ kind: 'db', db, device, from });
    await install(await session(ssh), opts);
    expect(ssh.ran(/install\.sh restore /)).toBe(2);
  });

  it("names a backup from a newer cardd as the person's to fix, and a database already there as a bug", async () => {
    const newer = new FakeSsh().when(/install\.sh restore /, {
      code: 6, stderr: "cardd: this backup is from a newer cardd: update the app first (its schema is 5, this cardd's 4)\n",
    });
    const e6 = await install(await session(newer), { ...base, restore: { kind: 'db', db }, device, done: [], onStep: async () => {} }).catch((e) => e);
    expect(e6).toMatchObject({ kind: 'newer_backup', step: 'restore' });
    expect(e6.message).toContain('update the app first');
    expect(e6.message).toContain("its schema is 5, this cardd's 4");
    for (const restore of [{ kind: 'db' as const, db }, { kind: 'fresh' as const }]) {
      const { ssh, cardd } = served();
      cardd.database = true; // cardd made one: up ran without a restore
      const e7 = await install(await session(ssh), { ...base, restore, device, done: [], onStep: async () => {} }).catch((e) => e);
      expect(e7).toBeInstanceOf(InstallError);
      expect(e7).toMatchObject({ kind: 'bug', step: 'restore' });
      expect(e7.message).toContain('a database is already there');
      expect(ssh.ran(/install\.sh up/)).toBe(0);
    }
  });

  it('refuses to restore without this phone\'s key, before running anything for it', async () => {
    for (const bad of [undefined, '', vectors.deviceAuth.publicKey.toUpperCase()]) {
      const { ssh } = served();
      const e = await install(await session(ssh), { ...base, restore: { kind: 'fresh' }, device: bad, done: [], onStep: async () => {} }).catch((x) => x);
      expect(e).toMatchObject({ kind: 'bug', step: 'restore' });
      expect(ssh.ran(/restore/)).toBe(0);
    }
  });

  it('refuses to restore without the new VM in meta, before running anything for it', async () => {
    for (const key of ['vm.id', 'vm.host', 'vm.ipv4'] as const) {
      const { ssh } = served();
      const meta: Record<string, string> = { ...base.meta };
      delete meta[key];
      const e = await install(await session(ssh), { ...base, meta, restore: { kind: 'fresh' }, device, done: [], onStep: async () => {} }).catch((x) => x);
      expect(e).toMatchObject({ kind: 'bug', step: 'restore' });
      expect(ssh.ran(/restore/)).toBe(0);
    }
  });

  it('refuses to start a retired server, naming the VM that replaced it', async () => {
    const { ssh, cardd } = served();
    cardd.retired = { at: '2026-10-06T17:40:12Z', replacedBy: 1004 };
    let checked = 0;
    const e = await install(await session(ssh), { ...base, done: [], onStep: async () => {}, beforeUp: async () => void checked++ }).catch((x) => x);
    expect(e).toBeInstanceOf(InstallError);
    expect(e).toMatchObject({ kind: 'retired', step: 'up', replacedBy: 1004 });
    expect(e.message).toContain('VM 1004');
    expect(checked).toBe(1);
    expect(cardd.database).toBe(false);
  });

  it('stops at wipe or up while a recovery check runs on the server (exit 11), as RecoveryCheckRunning', async () => {
    for (const step of ['wipe', 'up'] as const) {
      const { ssh } = served();
      ssh.when(new RegExp(`install\\.sh ${step}$`), { code: 11, stderr: `install.sh ${step}: a recovery check is running (…)\n` });
      const e = await install(await session(ssh), { ...base, wipe: true, done: [], onStep: async () => {} }).catch((x) => x);
      expect(e).toBeInstanceOf(RecoveryCheckRunning);
      expect(e.message).toBe(`install.sh ${step}: a recovery check is running (…)`);
    }
  });

  it('runs no check before up when up is already done', async () => {
    const { ssh } = served();
    let checked = 0;
    const done = INSTALL_STEPS.filter((x) => x !== 'meta');
    await install(await session(ssh), { ...base, done, onStep: async () => {}, beforeUp: async () => void checked++ });
    expect(checked).toBe(0);
  });

  it('stops before up when the check before it throws', async () => {
    const { ssh } = served();
    const done: InstallStep[] = [];
    const e = await install(await session(ssh), {
      ...base, done, onStep: async (x) => void done.push(x), beforeUp: async () => { throw new Error('the old server is running again'); },
    }).catch((x) => x);
    expect(e.message).toBe('the old server is running again');
    expect(done.at(-1)).toBe('restore');
    expect(ssh.ran(/install\.sh up/)).toBe(0);
  });
});

// The old server's side of a rebuild.
describe('retiring the old server', () => {
  const served = () => {
    const ssh = new FakeSsh();
    const cardd = new FakeCardd(() => Date.UTC(2026, 9, 6, 17, 40, 12, 345)).serve(ssh);
    return { ssh, cardd };
  };

  it('takes a final snapshot, retires the server for the new VM, and reads the marker back', async () => {
    const { ssh, cardd } = served();
    await expect(finalSnapshot(await session(ssh))).rejects.toThrow('no snapshot');
    cardd.addSnapshot(new Uint8Array([1, 2, 3]), 1_790_000_000);
    expect(await finalSnapshot(await session(ssh))).toEqual({ version: 1, created: 1_790_000_000 });
    expect(ssh.commands.at(-1)!.command).toBe('sh card-app/install.sh final-snapshot');
    expect(await isRetired(await session(ssh))).toBeNull();
    await retireServer(await session(ssh), 1004);
    expect(ssh.commands.at(-1)!.command).toBe("sh card-app/install.sh retire '1004'");
    expect(await isRetired(await session(ssh))).toEqual({ at: '2026-10-06T17:40:12Z', replacedBy: 1004 });
    expect(ssh.commands.at(-1)!.command).toBe('sh card-app/install.sh retired');
    // Its containers are gone: no snapshot can be taken, and up refuses.
    await expect(finalSnapshot(await session(ssh))).rejects.toThrow('final-snapshot');
    expect((await (await session(ssh)).exec('sh card-app/install.sh up')).code).toBe(8);
  });

  it('reads a marker after compose\'s notices, and passes other failures on', async () => {
    const ssh = new FakeSsh().when(/install\.sh retired$/, { stdout: 'Container card-app-phoenixd-run-1 Creating\n2026-10-06T17:40:12Z 1004\n' });
    expect(await isRetired(await session(ssh))).toEqual({ at: '2026-10-06T17:40:12Z', replacedBy: 1004 });
    ssh.when(/install\.sh retired$/, { code: 125, stderr: 'docker: error during connect' });
    await expect(isRetired(await session(ssh))).rejects.toThrow('error during connect');
    ssh.when(/install\.sh retired$/, { stdout: 'something else\n' });
    await expect(isRetired(await session(ssh))).rejects.toThrow('something else');
    ssh.when(/install\.sh retire '/, { code: 1, stderr: 'compose down failed' });
    await expect(retireServer(await session(ssh), 1004)).rejects.toThrow('compose down failed');
    ssh.when(/install\.sh final-snapshot$/, { stdout: 'Container card-app-cardd-1 Running\n{"version":9,"created":1790000500}\n' });
    expect(await finalSnapshot(await session(ssh))).toEqual({ version: 9, created: 1_790_000_500 });
  });

  // Retiring stops the stack and then writes the marker: cut between the two it would leave a stopped server no
  // pass takes for retired, and no cardd to make the final snapshot the next pass asks for first.
  it('retires through the step command, so a cut connection cannot stop it part-way', async () => {
    const ssh = new FakeSsh();
    await retireServer(await session(ssh), 1004, () => 'ab'.repeat(16));
    expect(ssh.steps).toEqual([{ token: 'ab'.repeat(16), sum: '-', command: "sh card-app/install.sh retire '1004'" }]);
    await retireServer(await session(ssh), 1004);
    expect(ssh.steps[1].token).toMatch(/^[0-9a-f]{32}$/);
    expect(ssh.steps[1].token).not.toBe(ssh.steps[0].token);
  });

  it('takes a retire the step command did not run for a drop, and says a failed retire\'s words from either output', async () => {
    for (const code of Object.values(STEP_NOT_RUN)) {
      const ssh = new FakeSsh().when(/install\.sh retire '/, { code });
      const e = await retireServer(await session(ssh), 1004).catch((x) => x);
      expect(e).toBeInstanceOf(SshDropped);
      expect(e).toMatchObject({ during: 'command', message: `install.sh retire was not run for this start (exit ${code})` });
    }
    const ssh = new FakeSsh().when(/install\.sh retire '/, { code: 1, stdout: 'compose down failed\n' });
    await expect(retireServer(await session(ssh), 1004)).rejects.toThrow('install.sh retire failed (exit 1): compose down failed');
    ssh.when(/install\.sh retire '/, { code: 11, stdout: 'install.sh retire: a recovery check is running\n' });
    const e = await retireServer(await session(ssh), 1004).catch((x) => x);
    expect(e).toBeInstanceOf(RecoveryCheckRunning);
    expect(e.message).toBe('install.sh retire: a recovery check is running');
  });

  // install.sh recovery-check stops cardd and starts phoenixd again when it ends: nothing else runs beside it.
  it('tells a recovery check running on the server (exit 11) from any other failure', async () => {
    const running = { code: 11, stderr: 'install.sh retire: a recovery check is running (install.sh recovery-check result prints its result once it ends)\n' };
    const ssh = new FakeSsh().when(/install\.sh retire '/, running);
    const e = await retireServer(await session(ssh), 1004).catch((x) => x);
    expect(e).toBeInstanceOf(RecoveryCheckRunning);
    expect(e.message).toContain('a recovery check is running');
    expect(await recoveryCheckRunning(await session(ssh))).toBe(false);
    expect(ssh.commands.at(-1)!.command).toBe('sh card-app/install.sh recovery-check result');
    ssh.when(/install\.sh recovery-check result$/, { code: 11, stderr: 'install.sh recovery-check: a check is running (from 20261007T000000Z, started): …\n' });
    expect(await recoveryCheckRunning(await session(ssh))).toBe(true);
    // An install.sh from before recovery-check: no check can run there.
    ssh.when(/install\.sh recovery-check result$/, { code: 2, stderr: 'usage: install.sh system|prepare HOST|…\n' });
    expect(await recoveryCheckRunning(await session(ssh))).toBe(false);
  });

  // The look before up at the phrase's other VMs: one phoenixd per seed.
  it('tells a server that can run phoenixd on the seed from one retired or holding no seed', async () => {
    const { ssh, cardd } = served();
    expect(await phoenixdState(await session(ssh))).toBe('live');
    expect(ssh.commands.at(-1)!.command).toBe('sh card-app/install.sh retired');
    await retireServer(await session(ssh), 1004);
    expect(await phoenixdState(await session(ssh))).toBe('retired');
    cardd.seeded = false; // re-installed through LNVPS, say
    expect(await phoenixdState(await session(ssh))).toBe('empty');
    await expect(isRetired(await session(ssh))).rejects.toThrow('install.sh retired failed (exit 9)'); // a seed is expected there
  });

  it('throws rather than guess when it can\'t tell', async () => {
    const ssh = new FakeSsh().when(/install\.sh retired$/, { code: 125, stderr: 'docker: error during connect' });
    await expect(phoenixdState(await session(ssh))).rejects.toThrow('error during connect');
    ssh.when(/install\.sh retired$/, { code: 2, stderr: 'usage: install.sh system|prepare HOST|seed|issuer-key|up' }); // an old install.sh
    await expect(phoenixdState(await session(ssh))).rejects.toThrow('usage');
    ssh.when(/install\.sh retired$/, { stdout: 'something else\n' });
    await expect(phoenixdState(await session(ssh))).rejects.toThrow('something else');
  });

  // Step 4 tries a final snapshot again unless cardd says no second try can make one.
  it.each([
    ['no backup key', 'cardd: no snapshot: no backup key yet (meta backup.recipient): Update server writes it', true],
    ['a backup key that isn\'t an age one', 'cardd: no snapshot: the backup key "x" isn\'t an age recipient', true],
    ['none made, and no problem to report', 'cardd: no snapshot\n', true],
    ['a cardd older than backup now', 'cardd: unknown command "backup"\n', true],
    ['a snapshot that failed this time', 'cardd: no snapshot: the last snapshot failed: disk I/O error', false],
    ['Docker restarting cardd', 'Error response from daemon: container cardd is restarting', false],
  ])('says whether a final snapshot can never be made: %s', async (_, stderr, refused) => {
    const ssh = new FakeSsh().when(/install\.sh final-snapshot$/, { code: 1, stderr });
    const e = await finalSnapshot(await session(ssh)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e instanceof FinalSnapshotRefused).toBe(refused);
    expect((e as Error).message).toContain('install.sh final-snapshot failed (exit 1)');
  });
});

// An upload tried again sends only what did not arrive whole.
describe('uploadBundle, tried again', () => {
  const files = [
    { path: 'install.sh', mode: 0o755, sha256: 'aa'.repeat(32), data: new Uint8Array([1]) },
    { path: 'compose.yaml', mode: 0o644, sha256: 'cc'.repeat(32), data: new Uint8Array([2]) },
    { path: 'bin/cardd', mode: 0o755, sha256: 'bb'.repeat(32), asset: 'deploy/bin/cardd', size: 11_088_034 },
  ];
  const LIST = `${'aa'.repeat(32)}  install.sh\n${'cc'.repeat(32)}  compose.yaml\n${'bb'.repeat(32)}  bin/cardd\n`;
  /** A server that has these files whole, as sha256sum -c says it: a line for each, and exit 1 unless all are. */
  const serverWith = (whole: string[]) =>
    new FakeSsh().when(/sha256sum -c - 2>/, { code: 1, stdout: files.map((f) => `${f.path}: ${whole.includes(f.path) ? 'OK' : 'FAILED'}`).join('\n') });

  it('asks the server which files it has whole, and sends only the others', async () => {
    const ssh = serverWith(['install.sh', 'compose.yaml']);
    const seen: string[] = [];
    await uploadBundle(await session(ssh), files, (p) => void seen.push(p.path));
    expect([...ssh.files.keys()]).toEqual(['card-app/bin/cardd']);
    expect(ssh.commands.map((c) => c.command)).toEqual([
      'mkdir -p card-app/bin',
      'cd card-app && sha256sum -c - 2>/dev/null',
      "cd card-app && chmod 755 'install.sh' 'bin/cardd' && chmod 644 'compose.yaml'",
      'cd card-app && sha256sum --quiet -c -',
    ]);
    expect([ssh.commands[1].stdin, ssh.commands[3].stdin]).toEqual([LIST, LIST]);
    // Only what is sent is reported: the screen names no file that did not move.
    expect([...new Set(seen)]).toEqual(['bin/cardd']);
  });

  it('sends every file to a server that has none, or whose answer is not the list it asked for', async () => {
    for (const ssh of [new FakeSsh(), new FakeSsh().when(/sha256sum -c - 2>/, { code: 127, stdout: '', stderr: 'sh: sha256sum: not found' }), serverWith([])]) {
      await uploadBundle(await session(ssh), files);
      expect([...ssh.files.keys()]).toEqual(['card-app/install.sh', 'card-app/compose.yaml', 'card-app/bin/cardd']);
    }
  });

  it('sends nothing to a server that has them all, sets their modes again, and still checks them', async () => {
    const ssh = serverWith(['install.sh', 'compose.yaml', 'bin/cardd']);
    await uploadBundle(await session(ssh), files);
    expect(ssh.files.size).toBe(0);
    expect(ssh.ran(/chmod 755 'install.sh' 'bin\/cardd' && chmod 644 'compose.yaml'/)).toBe(1);
    expect(ssh.ran(/sha256sum --quiet/)).toBe(1);
  });

  it('counts only a line that says OK for a file of the bundle', async () => {
    const ssh = new FakeSsh().when(/sha256sum -c - 2>/, { code: 1, stdout: 'install.sh: FAILED open or read\ncompose.yaml: FAILED\nbin/cardd: OK\nother: OK\nOK' });
    await uploadBundle(await session(ssh), files);
    expect([...ssh.files.keys()]).toEqual(['card-app/install.sh', 'card-app/compose.yaml']);
  });

  it('says which file the server refused and why, as the upload step\'s own failure, and sends the rest on the next try', async () => {
    const ssh = serverWith(['install.sh']);
    ssh.uploadRefusals = 1;
    const e = await uploadBundle(await session(ssh), files).catch((x) => x);
    expect(e).toBeInstanceOf(InstallError);
    expect(e).not.toBeInstanceOf(SshUploadRefused);
    expect(e).toMatchObject({ kind: 'retry', step: 'upload', message: 'The server refused the upload of compose.yaml: No space left on device' });
    // Nothing more was asked of the server after the refusal.
    expect(ssh.commands.at(-1)!.command).toMatch(/sha256sum -c - 2>/);
    expect([...ssh.files.keys()]).toEqual([]);
    await uploadBundle(await session(ssh), files);
    expect([...ssh.files.keys()]).toEqual(['card-app/compose.yaml', 'card-app/bin/cardd']);
  });

  it('makes every directory of the bundle before sending (ntfy/server.yml beside bin/cardd)', async () => {
    const ssh = new FakeSsh();
    const ntfy = { path: 'ntfy/server.yml', mode: 0o644, sha256: 'dd'.repeat(32), data: new Uint8Array([3]) };
    await uploadBundle(await session(ssh), [...files, ntfy]);
    expect(ssh.commands[0].command).toBe('mkdir -p card-app/bin card-app/ntfy');
    expect(ssh.files.has('card-app/ntfy/server.yml')).toBe(true);
  });

  it('still refuses a file the last check finds wrong, whatever the first look said', async () => {
    const ssh = serverWith(['install.sh', 'compose.yaml', 'bin/cardd']).when(/sha256sum --quiet/, { code: 1, stdout: 'bin/cardd: FAILED' });
    await expect(uploadBundle(await session(ssh), files)).rejects.toMatchObject({ kind: 'retry', step: 'upload' });
  });
});

// The upload is the slow step on a weak network (11 MB of cardd): the screen shows its progress.
describe('install upload progress', () => {
  it('reports each file as it uploads, up to its full size', async () => {
    const ssh = new FakeSsh();
    const seen: { path: string; sent: number; total: number }[] = [];
    await install(await session(ssh), { ...base, done: [], onStep: async () => {}, onUpload: (p) => void seen.push(p) });
    expect(seen.filter((p) => p.path === 'install.sh').at(-1)).toEqual({ path: 'install.sh', sent: 1, total: 1 });
    const cardd = seen.filter((p) => p.path === 'bin/cardd');
    expect(cardd[0]).toEqual({ path: 'bin/cardd', sent: 0, total: 11_088_034 });
    expect(cardd.at(-1)).toEqual({ path: 'bin/cardd', sent: 11_088_034, total: 11_088_034 });
    expect(cardd.length).toBeGreaterThan(2);
  });
});

describe('addDevice', () => {
  it('returns the key id cardd prints', async () => {
    const ssh = new FakeSsh().when(/device add/, { stdout: 'b18b86ce1389e46d\n' });
    expect(await addDevice(await session(ssh), '04ab', 'Pixel 8')).toBe('b18b86ce1389e46d');
    expect(ssh.commands[0].command).toBe("sh card-app/cardd-ctl device add -pubkey '04ab' -name 'Pixel 8'");
  });
});

describe('shellQuote', () => {
  it('quotes so the shell sees exactly one argument', () => {
    expect(shellQuote('plain')).toBe(`'plain'`);
    expect(shellQuote(`a'b`)).toBe(`'a'\\''b'`);
    expect(shellQuote('$(rm -rf /); `x`')).toBe(`'$(rm -rf /); \`x\`'`);
  });
  it('round-trips through a real /bin/sh', () => {
    for (const s of [`o'brien`, '$HOME', 'a b\tc', '"; echo pwned', `''`, '*', 'é ✓']) {
      expect(execFileSync('sh', ['-c', `printf %s ${shellQuote(s)}`], { encoding: 'utf8' })).toBe(s);
    }
  });
});
