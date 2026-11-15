// What onboarding needs from SSH. A native module implements it (on
// Android, Kotlin around sshj); tests use FakeSsh.

/** The VM's host key exactly as LNVPS publishes it (host_ssh_keys). */
export type PinnedHostKey = { keyType: string; publicKey: string };

export type ExecResult = { code: number; stdout: string; stderr: string };

export interface SshSession {
  /** Runs a command; stdin, if given, is written and then closed. */
  exec(command: string, stdin?: string): Promise<ExecResult>;
  /** Writes a file (path relative to the login user's home). */
  upload(remotePath: string, data: Uint8Array, mode: number): Promise<void>;
  /** Streams a file bundled in the APK's assets (the cardd binary) without it passing through JS; onProgress gets the bytes sent so far. */
  uploadAsset(remotePath: string, asset: string, size: number, mode: number, onProgress?: (sent: number) => void): Promise<void>;
  close(): Promise<void>;
}

export type SshConnectOptions = {
  host: string;
  port: number;
  user: string;
  /** The only host key accepted (never trust on first use). Only its key type is offered to the server. */
  hostKey: PinnedHostKey;
  /** The phrase-derived Ed25519 seed (keys.sshEd25519Seed). */
  ed25519Seed: string;
};

export type SshConnect = (opts: SshConnectOptions) => Promise<SshSession>;

/** The server's ssh-ed25519 host key, read without logging in (trust on first use). */
export type SshScan = (host: string, port: number) => Promise<PinnedHostKey>;

/** Thrown by an SshConnect when the server's key is not the pinned one. */
export class HostKeyMismatchError extends Error {}

/** Thrown by an SshConnect when the server refuses the phrase's SSH key. */
export class SshAuthError extends Error {}

/**
 * Thrown by an SshConnect, and by a session's exec and uploads, when the connection failed: none could be made, or
 * it went away under a command or an upload. Not the
 * server's answer: a command that ran and failed resolves with its exit code. during: which of the three failed.
 * The message is the phone's own words for the failure, unchanged.
 */
export class SshDropped extends Error {
  constructor(
    readonly during: 'connect' | 'command' | 'upload',
    message: string,
  ) {
    super(message);
    this.name = 'SshDropped';
  }
}

/**
 * Thrown by a session's uploads when the server itself refused the file: its disk is full, or the folder cannot be
 * written. The connection was there to bring the refusal
 * back, so this is no drop and nothing is waited out. The message is the server's own words.
 */
export class SshUploadRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshUploadRefused';
  }
}

/** Quotes one argument for a POSIX shell. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
