// An SshConnect that records what onboarding does on the VM and answers
// commands from a small script.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { ExecResult, PinnedHostKey, SshConnect, SshConnectOptions, SshScan, SshSession } from '../onboarding/ssh';
import { HostKeyMismatchError, SshAuthError, SshDropped, SshUploadRefused } from '../onboarding/ssh';
import { STEP_NOT_RUN, STEP_PREFIX } from '../onboarding/stepCommand';

/** A function result that returns undefined passes the command on to the next rule. */
type Rule = { match: RegExp; result: Partial<ExecResult> | ((cmd: string, stdin?: string) => Partial<ExecResult> | undefined); times?: number };

export class FakeSsh {
  connects: SshConnectOptions[] = [];
  /** What ran: a step's own command, read out of the step command it was sent in (stepCommand.ts), and every other command as sent. */
  commands: { command: string; stdin?: string }[] = [];
  /** Every command exactly as it was sent. */
  sent: { command: string; stdin?: string }[] = [];
  /** The step commands among them: this start's token, the sum sent for the input ("-" for none), and the step's own command. */
  steps: { token: string; sum: string; command: string }[] = [];
  files = new Map<string, { data: Uint8Array; mode: number } | { asset: string; size: number; mode: number }>();
  /** The key the "server" presents; connect fails unless it is the pinned one. */
  serverKey?: PinnedHostKey;
  /** The only Ed25519 seed the "server" lets in, if set (authorized_keys). */
  authorizedSeed?: string;
  /** The key a scan sees when no serverKey is set (world sets LNVPS's HOST_KEY). */
  scanKey?: PinnedHostKey;
  /** Make scanHostKey fail, as a server whose sshd is not up yet does. */
  scanFails = false;
  scans = 0;
  /** Make close() fail, as a dropped connection can. */
  closeFails = false;
  /** Make connect fail, as a server that is off, or whose sshd doesn't answer, does. */
  unreachable = false;
  /** Make the next so many connects fail, then answer again. */
  connectDrops = 0;
  /** Make the next so many uploads fail part-way. */
  uploadDrops = 0;
  /** Make the server refuse the next so many uploads, as the SSH layer reports it (SshUploadRefused): its disk is full. */
  uploadRefusals = 0;
  private rules: Rule[] = [];
  private cuts: { match: RegExp; times: number; after: boolean; skip: number }[] = [];

  /**
   * The connection goes under the next `times` commands matching `match`, as the SSH layer reports it (SshDropped).
   * after: the server ran the command to its end first (its rule answered, whatever that changed), and only the
   * answer was lost. skip: so many matching commands go through first.
   */
  drop(match: RegExp, times = 1, o: { after?: boolean; skip?: number } = {}): this {
    this.cuts.push({ match, times, after: !!o.after, skip: o.skip ?? 0 });
    return this;
  }

  /** Answer commands matching `match` with `result` (`times` times, then fall through). */
  when(match: RegExp, result: Rule['result'], times?: number): this {
    this.rules.unshift({ match, result, times });
    return this;
  }

  scanHostKey: SshScan = async (host, port) => {
    this.scans++;
    if (this.scanFails) throw new Error(`connect to ${host}:${port} timed out`);
    const key = this.serverKey ?? this.scanKey;
    if (!key) throw new Error('FakeSsh: no host key to scan');
    return key;
  };

  connect: SshConnect = async (opts) => {
    this.connects.push(opts);
    // As the SSH layer says it (native/ssh.ts): a connect that fails for anything but the two refusals below is a drop.
    if (this.unreachable || this.connectDrops-- > 0) throw new SshDropped('connect', `connect to ${opts.host}:${opts.port} timed out`);
    if (this.serverKey && (this.serverKey.keyType !== opts.hostKey.keyType || this.serverKey.publicKey !== opts.hostKey.publicKey)) {
      throw new HostKeyMismatchError('host key does not match the pinned key');
    }
    if (this.authorizedSeed !== undefined && this.authorizedSeed !== opts.ed25519Seed) {
      throw new SshAuthError('Exhausted available authentication methods');
    }
    const session: SshSession = {
      exec: async (sentCommand, stdin) => {
        this.sent.push({ command: sentCommand, stdin });
        let command = sentCommand;
        if (sentCommand.startsWith(`${STEP_PREFIX} `)) {
          const [token, sum, ...words] = sentCommand.slice(STEP_PREFIX.length + 1).split(' ');
          command = words.join(' ');
          this.steps.push({ token, sum, command });
          // As the real command: a step with no input reads none, and an input that is not the one summed starts no step.
          if (sum !== '-' && bytesToHex(sha256(utf8ToBytes(stdin ?? ''))) !== sum) return { code: STEP_NOT_RUN.input, stdout: '', stderr: '' };
        }
        let cut = this.cuts.find((c) => c.times > 0 && c.match.test(command));
        if (cut && cut.skip > 0) {
          cut.skip--;
          cut = undefined;
        }
        if (cut) cut.times--;
        if (cut && !cut.after) throw new SshDropped('command', 'Broken pipe');
        this.commands.push({ command, stdin });
        const answer = (): ExecResult => {
          for (const rule of this.rules) {
            if (!rule.match.test(command) || (rule.times !== undefined && rule.times <= 0)) continue;
            const out = typeof rule.result === 'function' ? rule.result(command, stdin) : rule.result;
            if (!out) continue;
            if (rule.times !== undefined) rule.times--;
            return { code: 0, stdout: '', stderr: '', ...out };
          }
          return { code: 0, stdout: '', stderr: '' };
        };
        const r = answer();
        if (cut) throw new SshDropped('command', 'Broken pipe');
        // As the real step command: one empty line to the connection before the step, so a step's stderr never comes back empty.
        return sentCommand === command ? r : { ...r, stderr: `\n${r.stderr}` };
      },
      upload: async (path, data, mode) => {
        if (this.uploadRefusals-- > 0) throw new SshUploadRefused('No space left on device');
        if (this.uploadDrops-- > 0) throw new SshDropped('upload', 'Broken pipe');
        this.files.set(path, { data, mode });
      },
      uploadAsset: async (path, asset, size, mode, onProgress) => {
        onProgress?.(Math.floor(size / 2));
        if (this.uploadRefusals-- > 0) throw new SshUploadRefused('No space left on device');
        if (this.uploadDrops-- > 0) throw new SshDropped('upload', 'Broken pipe');
        this.files.set(path, { asset, size, mode });
      },
      close: async () => {
        if (this.closeFails) throw new Error('connection reset while closing');
      },
    };
    return session;
  };

  ran(pattern: RegExp): number {
    return this.commands.filter((c) => pattern.test(c.command)).length;
  }
}
