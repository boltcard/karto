import { describe, expect, it } from 'vitest';
import { advance, initialState, type OnboardingState } from './machine';
import { updateServer } from './update';
import { InstallError, INSTALL_STEPS, type BundleFile } from './install';
import { bundleSha } from '../deploy/bundle';
import { HOST_KEY, world } from '../testing/world';
import { HostKeyMismatchError, SshDropped } from './ssh';

async function onboarded(t: ReturnType<typeof world>): Promise<OnboardingState> {
  let s = initialState('GBR');
  for (let i = 0; i < 50 && s.step !== 'done'; i++) {
    s = await advance(s, t.deps);
    if (s.waiting === 'payment') t.lnvps.pay(s.vmId!);
    if (s.waiting === 'boot') t.lnvps.boot(s.vmId!);
    if (s.waiting === 'host_keys') t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
    // LNVPS publishes the key the server presented on first use.
    if (s.waiting === 'host_key_confirm') t.lnvps.publishHostKeys(s.vmId!, [HOST_KEY]);
  }
  expect(s.step).toBe('done');
  return s;
}

const newer: BundleFile[] = [
  { path: 'install.sh', mode: 0o755, sha256: 'ac'.repeat(32), data: new Uint8Array([2]) },
  { path: 'bin/cardd', mode: 0o755, sha256: 'bd'.repeat(32), asset: 'deploy/bin/cardd', size: 3 },
];

describe('updateServer', () => {
  it('ends on an upload the server refuses with the file and the server\'s words, not as a drop', async () => {
    const t = world();
    const s = await onboarded(t);
    t.ssh.uploadRefusals = 1;
    const e = await updateServer(s, { ssh: t.deps.ssh, keys: t.keys, bundle: newer }, () => {}).catch((x) => x);
    expect(e).toBeInstanceOf(InstallError);
    expect(e).not.toBeInstanceOf(SshDropped);
    expect(e.message).toBe('The server refused the upload of install.sh: No space left on device');
  });

  it('re-runs every install step with the new bundle and records it', async () => {
    const t = world();
    const s = await onboarded(t);
    t.ssh.commands.length = 0;
    const steps: string[] = [];
    await updateServer(s, { ssh: t.deps.ssh, keys: t.keys, bundle: newer }, (x) => void steps.push(x));
    expect(steps).toEqual([...INSTALL_STEPS]);
    expect(t.cardd.meta.get('bundle.sha256')).toBe(bundleSha(newer));
    expect(t.ssh.files.get('card-app/bin/cardd')).toMatchObject({ asset: 'deploy/bin/cardd', size: 3 });
    // Same pinned host key and phrase key as onboarding; secrets on stdin only.
    expect(t.ssh.connects.at(-1)).toMatchObject({ host: '45.67.89.164', hostKey: { publicKey: HOST_KEY.public_key }, ed25519Seed: t.keys.sshEd25519Seed });
    expect(t.ssh.commands.find((c) => /install\.sh seed/.test(c.command))?.stdin).toBe(t.keys.phoenixdSeed);
  });

  it("reports the upload's progress", async () => {
    const t = world();
    const s = await onboarded(t);
    const seen: string[] = [];
    await updateServer(s, { ssh: t.deps.ssh, keys: t.keys, bundle: newer }, () => {}, (p) => void seen.push(`${p.path} ${p.sent}/${p.total}`));
    expect(seen).toEqual(['install.sh 0/1', 'install.sh 1/1', 'bin/cardd 0/3', 'bin/cardd 1/3', 'bin/cardd 3/3']);
  });

  it('refuses a server whose key LNVPS contradicted, without connecting', async () => {
    const t = world();
    const s = await onboarded(t);
    const connects = t.ssh.connects.length;
    await expect(updateServer({ ...s, hostKeyMismatch: 'LNVPS published SHA256:x' }, { ssh: t.deps.ssh, keys: t.keys, bundle: newer }, () => {}))
      .rejects.toBeInstanceOf(HostKeyMismatchError);
    expect(t.ssh.connects.length).toBe(connects);
  });

  it('passes install errors on, and still closes the connection', async () => {
    const t = world();
    const s = await onboarded(t);
    t.ssh.when(/install\.sh up/, { code: 1, stderr: 'dependency failed to start' }, 1);
    let closed = 0;
    const ssh: typeof t.deps.ssh = async (o) => {
      const session = await t.deps.ssh(o);
      return { ...session, close: async () => void closed++ };
    };
    await expect(updateServer(s, { ssh, keys: t.keys, bundle: newer }, () => {})).rejects.toBeInstanceOf(InstallError);
    expect(closed).toBe(1);
    expect(t.cardd.meta.get('bundle.sha256')).not.toBe(bundleSha(newer));
  });

  // An update that carries on after a drop keeps what it had finished.
  it('skips the steps it is told are done, and lets a drop through as a drop', async () => {
    const t = world();
    const s = await onboarded(t);
    t.ssh.commands.length = 0;
    const steps: string[] = [];
    await updateServer(s, { ssh: t.deps.ssh, keys: t.keys, bundle: newer }, (x) => void steps.push(x), undefined, ['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare']);
    expect(steps).toEqual(INSTALL_STEPS.slice(6));
    expect([t.ssh.files.size, t.ssh.ran(/install\.sh (first-boot|swap|docker|docker-setup|prepare)/), t.ssh.ran(/install\.sh up/)]).toEqual([2, 0, 1]);
    t.ssh.drop(/install\.sh up/);
    const e = await updateServer(s, { ssh: t.deps.ssh, keys: t.keys, bundle: newer }, () => {}).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(SshDropped);
  });
});
