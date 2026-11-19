// Runs deploy/install.sh on the VM, step by step (the
// contract is in deploy/README.md). Each finished step is reported through
// onStep so the caller can save it, and a resumed install skips it. wipe and
// restore belong to a rebuild: without one they do
// nothing and are reported done like the others. host-key is the app's own:
// the caller's check that LNVPS has confirmed the server's SSH key, before the
// first step that sends a secret; without a check it does nothing.
import { base64 } from '@scure/base';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { shellQuote, SshDropped, SshUploadRefused, type SshSession } from './ssh';
import { STEP_NOT_RUN, stepCommand } from './stepCommand';

export const DIR = 'card-app';
export const INSTALL_STEPS = ['upload', 'first-boot', 'swap', 'docker', 'docker-setup', 'prepare', 'host-key', 'wipe', 'seed', 'issuer-key', 'restore', 'up', 'meta'] as const;
export type InstallStep = (typeof INSTALL_STEPS)[number];

/**
 * The steps that send a secret to the server: phoenixd's seed, the issuer key, and a backup's whole ledger. They all
 * come after host-key, so none runs on a server whose SSH key LNVPS has not confirmed. So does the wipe, which sends
 * nothing but destroys what a VM rebuilt in place held: never on one LNVPS hasn't confirmed, and never before the wait.
 */
export const SECRET_STEPS: readonly InstallStep[] = ['seed', 'issuer-key', 'restore'];

/**
 * A saved list of finished steps as this app reads it: an app from before saved 'system', the one
 * step the four system steps replaced, so it reads as all four; an id this app doesn't know is dropped.
 */
export function savedSteps(saved: readonly string[]): InstallStep[] {
  const known = new Set<string>(INSTALL_STEPS);
  return saved.flatMap((x): InstallStep[] => (x === 'system' ? ['first-boot', 'swap', 'docker', 'docker-setup'] : known.has(x) ? [x as InstallStep] : []));
}

/**
 * The steps as the person sees them, in INSTALL_STEPS' order: the wipe, the wait for LNVPS to confirm the server's
 * key (hostKey) and the restore only where they do something.
 */
export const installStepsFor = (o: { wipe?: boolean; hostKey?: boolean; restore?: boolean }): readonly InstallStep[] =>
  INSTALL_STEPS.filter((x) => (x !== 'wipe' || !!o.wipe) && (x !== 'host-key' || !!o.hostKey) && (x !== 'restore' || !!o.restore));

/** A file of the deploy bundle, relative to ~/card-app on the VM: bytes, or an APK asset streamed natively. */
export type BundleFile = { path: string; mode: number; sha256: string } & (
  | { data: Uint8Array }
  | { asset: string; size: number }
);

/** newer_backup: the backup needs a newer cardd than this app carries. retired: up refused a server a rebuild replaced. */
export type InstallErrorKind = 'retry' | 'wrong_phrase' | 'revoked' | 'bug' | 'newer_backup' | 'retired';

export class InstallError extends Error {
  /** replacedBy: for 'retired', the VM that replaced this server, as its marker says. */
  constructor(readonly kind: InstallErrorKind, readonly step: InstallStep, message: string, readonly replacedBy?: number) {
    super(message);
  }
}

/**
 * install.sh exits 11 while install.sh recovery-check runs on that server (or up, retire or wipe holds its
 * lock): the check stops cardd and starts phoenixd again when it ends, so nothing goes on beside it. A wait, never a failure.
 */
export class RecoveryCheckRunning extends Error {}

/** Whether a recovery check runs on the server now. An install.sh from before recovery-check (exit 2) runs none. */
export async function recoveryCheckRunning(ssh: SshSession): Promise<boolean> {
  return (await ssh.exec(`sh ${DIR}/install.sh recovery-check result`)).code === 11;
}

/** What a rebuild restores: a decrypted backup (from: its name, recorded as meta restore.from), or nothing but the phrase. */
export type Restore = { kind: 'db'; db: Uint8Array; from?: string } | { kind: 'fresh' };

export type InstallOptions = {
  bundle: BundleFile[];
  host: string;
  phoenixdSeed: string;
  issuerKey: string;
  meta: Record<string, string>;
  done: readonly InstallStep[];
  onStep: (step: InstallStep) => Promise<void>;
  /** Told just before a step runs (not one already done): the step's time starts then. */
  onStart?: (step: InstallStep) => Promise<void> | void;
  /** Bytes of each bundle file sent so far: from 0 to its full size. */
  onUpload?: (p: UploadProgress) => void;
  /** In place: first delete everything the old server had but phoenixd's seed and the issuer key. */
  wipe?: boolean;
  /** What to restore, or how to have it when the step runs (a backup decrypted only then, never before it is needed). */
  restore?: Restore | (() => Promise<Restore>);
  /** This phone's public key (lower-case hex), which the restore re-activates; required with restore. */
  device?: string;
  /**
   * Runs at the step host-key, before the first step that sends a secret (SECRET_STEPS): throwing stops the install
   * there. Onboarding's check that LNVPS has confirmed the server's SSH key; Update server has none.
   */
  confirmHostKey?: () => Promise<void>;
  /** Runs before each step that sends a secret (SECRET_STEPS) still to run: throwing stops the install there (a rebuild's retire). */
  beforeSecret?: () => Promise<void>;
  /** Runs just before up starts anything; throwing stops the install there (a rebuild's last look at the old VM). */
  beforeUp?: () => Promise<void>;
  /** A new token for each start of a step (stepCommand.ts): 32 hex digits, random unless a test says. */
  token?: () => string;
};

const NOT_RUN: readonly number[] = Object.values(STEP_NOT_RUN);

export type UploadProgress = { path: string; sent: number; total: number };

const newToken = () => bytesToHex(randomBytes(16));

/**
 * One command of install.sh through the step command, so a connection that drops cannot kill it part-way or let
 * two run at once. The step command's own refusals mean
 * the command did not run: a drop.
 */
async function runStep(ssh: SshSession, what: string, command: string, token: string, stdin?: string) {
  const r = await ssh.exec(stepCommand(command, { token, stdin }), stdin);
  if (NOT_RUN.includes(r.code)) throw new SshDropped('command', `install.sh ${what} was not run for this start (exit ${r.code})`);
  return r;
}

export async function install(ssh: SshSession, o: InstallOptions): Promise<void> {
  const token = o.token ?? newToken;
  const run = async (step: InstallStep, command: string, stdin?: string) => {
    const r = await runStep(ssh, step, command, token(), stdin);
    if (r.code === 0) return r;
    // stderr trimmed first: the step command's own empty line is always there, and the step's words may be on stdout alone.
    const detail = (r.stderr.trim() || r.stdout).trim().split('\n').slice(-3).join(' ');
    if ((step === 'seed' || step === 'issuer-key') && r.code === 3) {
      throw new InstallError('wrong_phrase', step,
        'This server already has a different key. Was it set up with another recovery phrase?');
    }
    if ((step === 'wipe' || step === 'up') && r.code === 11) throw new RecoveryCheckRunning(detail);
    if (step === 'up' && r.code === 4) throw new InstallError('bug', step, 'install.sh up ran before the seed was written');
    if (step === 'up' && r.code === 8) {
      const vm = /replaced by VM (\d+)/.exec(r.stderr)?.[1];
      throw new InstallError('retired', step,
        `This server was retired when a rebuild replaced it${vm ? ` with VM ${vm}` : ''}: it must not start again.`, vm ? Number(vm) : undefined);
    }
    if (step === 'restore' && r.code === 6) {
      const schemas = /\(its schema is \d+, this cardd's \d+\)/.exec(r.stderr)?.[0] ?? '';
      throw new InstallError('newer_backup', step,
        `This backup was made by a newer version of the server than this app carries: update the app first ${schemas}`.trim());
    }
    if (step === 'restore' && r.code === 7) throw new InstallError('bug', step, `install.sh restore found a database it didn't restore: ${detail}`);
    throw new InstallError('retry', step, `install.sh ${step} failed (exit ${r.code}): ${detail}`);
  };
  const sh = (args: string) => `sh ${DIR}/install.sh ${args}`;
  const restore = async (r: Restore) => {
    // cardd checks the key itself; this catches a caller that forgot it before anything runs.
    if (!o.device || !/^[0-9a-f]+$/.test(o.device)) throw new InstallError('bug', 'restore', "a restore needs this phone's public key in lower-case hex");
    // The new VM goes in with the database, so cardd's first snapshot names it.
    const vm = (['vm.id', 'vm.host', 'vm.ipv4'] as const).map((k) => o.meta[k]);
    if (vm.some((v) => !v)) throw new InstallError('bug', 'restore', "a restore needs the new VM's vm.id, vm.host and vm.ipv4 in meta");
    const args = [shellQuote(o.device), ...vm.map(shellQuote)].join(' ');
    if (r.kind === 'fresh') return run('restore', sh(`restore-fresh ${args}`));
    // The SSH module's stdin is text: base64, which install.sh decodes.
    return run('restore', sh(`restore ${args}${r.from ? ` ${shellQuote(r.from)}` : ''}`), base64.encode(r.db));
  };

  const steps: Record<InstallStep, () => Promise<unknown>> = {
    upload: () => uploadBundle(ssh, o.bundle, o.onUpload),
    'first-boot': () => run('first-boot', sh('first-boot')),
    swap: () => run('swap', sh('swap')),
    docker: () => run('docker', sh('docker')),
    'docker-setup': () => run('docker-setup', sh('docker-setup')),
    prepare: () => run('prepare', sh(`prepare ${shellQuote(o.host)}`)),
    wipe: async () => {
      if (o.wipe) await run('wipe', sh('wipe'));
    },
    'host-key': async () => {
      await o.confirmHostKey?.();
    },
    seed: () => run('seed', sh('seed'), o.phoenixdSeed),
    'issuer-key': () => run('issuer-key', sh('issuer-key'), o.issuerKey),
    restore: async () => {
      if (o.restore) await restore(typeof o.restore === 'function' ? await o.restore() : o.restore);
    },
    up: async () => {
      await o.beforeUp?.();
      return run('up', sh('up'));
    },
    meta: async () => {
      for (const [k, v] of Object.entries(o.meta)) {
        await run('meta', `sh ${DIR}/cardd-ctl meta set ${shellQuote(k)} ${shellQuote(v)}`);
      }
    },
  };

  for (const step of INSTALL_STEPS) {
    if (o.done.includes(step)) continue;
    if (SECRET_STEPS.includes(step)) await o.beforeSecret?.();
    await o.onStart?.(step);
    await steps[step]();
    await o.onStep(step);
  }
}

/**
 * Uploads the bundle to ~/card-app and checks every file's sha256 there. Tried again after a connection dropped,
 * it sends only what did not arrive whole: the server is
 * first asked which files it has, by the same sums. A file cut part-way fails its sum and is sent from its start.
 * Every file's mode is set again, since a file can arrive whole and the connection go before its mode is set.
 */
export async function uploadBundle(ssh: SshSession, bundle: BundleFile[], onUpload?: (p: UploadProgress) => void): Promise<void> {
  // The bundle's directories (bin/, ntfy/), made before anything is sent; its paths are the build's own.
  const dirs = [...new Set(bundle.filter((f) => f.path.includes('/')).map((f) => `${DIR}/${f.path.slice(0, f.path.lastIndexOf('/'))}`))];
  const mkdir = await ssh.exec(`mkdir -p ${dirs.length ? dirs.join(' ') : DIR}`);
  if (mkdir.code !== 0) throw new InstallError('retry', 'upload', `mkdir failed: ${mkdir.stderr.trim()}`);
  const sums = bundle.map((f) => `${f.sha256}  ${f.path}\n`).join('');
  // "<path>: OK" for each file that is there whole; its exit code only says whether all are. A server that
  // answers anything else has none, as far as this goes: everything is sent, and the check at the end decides.
  const look = await ssh.exec(`cd ${DIR} && sha256sum -c - 2>/dev/null`, sums);
  const whole = new Set(look.stdout.split('\n').map((l) => /^(.+): OK$/.exec(l)?.[1]));
  for (const f of bundle) {
    if (whole.has(f.path)) continue;
    const total = 'asset' in f ? f.size : f.data.length;
    const report = (sent: number) => onUpload?.({ path: f.path, sent, total });
    report(0);
    try {
      if ('asset' in f) await ssh.uploadAsset(`${DIR}/${f.path}`, f.asset, f.size, f.mode, report);
      else await ssh.upload(`${DIR}/${f.path}`, f.data, f.mode);
    } catch (e) {
      // The server's answer, not a drop: shown as this step's failure, with the file and the server's words.
      if (e instanceof SshUploadRefused) throw new InstallError('retry', 'upload', `The server refused the upload of ${f.path}: ${e.message}`);
      throw e;
    }
    report(total);
  }
  const modes = [...new Set(bundle.map((f) => f.mode))];
  const chmod = modes.map((m) => `chmod ${m.toString(8)} ${bundle.filter((f) => f.mode === m).map((f) => shellQuote(f.path)).join(' ')}`).join(' && ');
  const moded = await ssh.exec(`cd ${DIR} && ${chmod}`);
  if (moded.code !== 0) throw new InstallError('retry', 'upload', `chmod failed: ${moded.stderr.trim()}`);
  // A truncated or corrupted upload must not be installed.
  const check = await ssh.exec(`cd ${DIR} && sha256sum --quiet -c -`, sums);
  if (check.code !== 0) {
    throw new InstallError('retry', 'upload', `uploaded files don't match the app's copy: ${(check.stdout + check.stderr).trim()}`);
  }
}

/** Registers the phone's device key with cardd. Returns the key id. */
/**
 * Revokes every paired phone but keepKeyId (a restore
 * onto a new phone). cardd refuses a keep id it doesn't know as active, so this
 * phone can't lock itself out.
 */
export async function revokeOthers(ssh: SshSession, keepKeyId: string): Promise<void> {
  const r = await ssh.exec(`sh ${DIR}/cardd-ctl device revoke-others -keep ${shellQuote(keepKeyId)}`);
  const detail = (r.stderr || r.stdout).trim();
  if (r.code !== 0) throw new InstallError('retry', 'meta', `cardd device revoke-others failed (exit ${r.code}): ${detail}`);
}

export async function addDevice(ssh: SshSession, publicKeyHex: string, name: string): Promise<string> {
  const r = await ssh.exec(`sh ${DIR}/cardd-ctl device add -pubkey ${shellQuote(publicKeyHex)} -name ${shellQuote(name)}`);
  const detail = (r.stderr || r.stdout).trim();
  // cardd exits 5 for a key that was revoked: it stays revoked, so retrying can't help.
  if (r.code === 5) throw new InstallError('revoked', 'meta', detail);
  if (r.code !== 0) throw new InstallError('retry', 'meta', `cardd device add failed (exit ${r.code}): ${detail}`);
  // The key id is cardd's last line; docker compose may print notices before it.
  return r.stdout.trim().split('\n').at(-1)!.trim();
}

/** The last line of a command's output: docker compose may print notices before it. */
const lastLine = (out: string) => out.trim().split('\n').at(-1)!.trim();

// stderr trimmed first: through the step command its own empty line is always there.
const failed = (what: string, r: { code: number; stdout: string; stderr: string }) =>
  new Error(`install.sh ${what} failed (exit ${r.code}): ${(r.stderr.trim() || r.stdout).trim().split('\n').slice(-3).join(' ')}`);

/**
 * A final snapshot cardd can't make however often it is asked: no backup key set (or not an age one), none
 * made and no problem to report (cardd's bare "no snapshot"), or a cardd too old to know `backup now`.
 */
export class FinalSnapshotRefused extends Error {}

/** A snapshot of the server being replaced, taken now; created is unix seconds. */
export async function finalSnapshot(ssh: SshSession): Promise<{ version: number; created: number }> {
  const r = await ssh.exec(`sh ${DIR}/install.sh final-snapshot`);
  if (r.code !== 0 && /no backup key|isn't an age recipient|unknown command "backup"|no snapshot$/m.test(`${r.stderr}\n${r.stdout}`.trim())) {
    throw new FinalSnapshotRefused(failed('final-snapshot', r).message);
  }
  if (r.code !== 0) throw failed('final-snapshot', r);
  const s = JSON.parse(lastLine(r.stdout)) as { version: number; created: number };
  return { version: s.version, created: s.created };
}

/**
 * Stops the server for good and marks it replaced by newVmId, so its phoenixd never runs beside the new one.
 * Through the step command: cut between the stop and the marker, it would leave a stopped server that is not
 * retired, and no cardd for the final snapshot the next pass asks for first.
 */
export async function retireServer(ssh: SshSession, newVmId: number, token: () => string = newToken): Promise<void> {
  const r = await runStep(ssh, 'retire', `sh ${DIR}/install.sh retire ${shellQuote(String(newVmId))}`, token());
  if (r.code === 11) throw new RecoveryCheckRunning((r.stderr.trim() || r.stdout).trim());
  if (r.code !== 0) throw failed('retire', r);
}

/** install.sh retired's marker: "<UTC time> <new VM id>". */
const MARKER = /^(\S+) (\d+)$/;

/**
 * Whether this server can run phoenixd on the phrase's seed: 'retired' (its marker), 'empty' (no seed at all:
 * never installed, or re-installed through LNVPS), or 'live'. Throws when it can't tell. Needs the app's install.sh.
 */
export async function phoenixdState(ssh: SshSession): Promise<'retired' | 'empty' | 'live'> {
  const r = await ssh.exec(`sh ${DIR}/install.sh retired`);
  if (r.code === 9) return 'empty';
  if (r.code === 1) return 'live';
  if (r.code !== 0) throw failed('retired', r);
  if (!MARKER.test(lastLine(r.stdout))) throw new Error(`install.sh retired printed no marker: ${r.stdout.trim()}`);
  return 'retired';
}

/** The server's retired marker (its UTC time and the VM that replaced it), or null if it was never retired. */
export async function isRetired(ssh: SshSession): Promise<{ at: string; replacedBy: number } | null> {
  const r = await ssh.exec(`sh ${DIR}/install.sh retired`);
  if (r.code === 1) return null;
  if (r.code !== 0) throw failed('retired', r);
  const m = MARKER.exec(lastLine(r.stdout));
  if (!m) throw new Error(`install.sh retired printed no marker: ${r.stdout.trim()}`);
  return { at: m[1], replacedBy: Number(m[2]) };
}
