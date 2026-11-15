// How the app starts a step of install.sh so that a connection that drops cannot hurt it.
// A step started plainly writes to the connection as it goes: cut
// the connection and the step is killed at its next write, the package manager part-way through an install; start
// it again and it may run beside one still going. Through this command a step always runs to its end, one at a
// time, and only for the start the app last made. The command is the app's own: install.sh does not change.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * The command's own refusals, which no step answers with (install.sh's codes are 0 to 11). Each means the step did
 * not run for this start: the app waits and starts it again, as after a drop.
 * superseded: a later start came while this one waited its turn. noConnection: the connection was gone when its
 * turn came. input: the step's input did not arrive whole. files: card-app could not be written to.
 */
export const STEP_NOT_RUN = { superseded: 70, noConnection: 71, input: 72, files: 73 } as const;

// $1 this start's token, $2 the SHA-256 of the input or "-", the rest the step's own command. In order:
// 1. say this is the latest start; 2. make the two output files, the login user's alone; 3. wait for the lock (on
// fd 8, which the step is started without, so nothing it starts can hold the lock); 4. still the latest, and the
// connection takes a line; 5. the input read into memory and summed, or none given; 6. the step, its output to the
// files; 7. the files sent back, still under the lock, and the step's own exit code.
// No single quote may appear in it: it is sent inside a pair. The line for step 3 cannot fail without the one before
// it having failed first (both make a file in card-app), so its exec has no code of its own.
const SCRIPT = [
  't=$1; s=$2; shift 2; d=card-app',
  `printf %s "$t" >$d/step.latest || exit ${STEP_NOT_RUN.files}`,
  `(umask 077; : >>$d/step.out; : >>$d/step.err) || exit ${STEP_NOT_RUN.files}`,
  `exec 8>$d/step.lock; flock 8 || exit ${STEP_NOT_RUN.files}`,
  `[ "$(cat $d/step.latest)" = "$t" ] || exit ${STEP_NOT_RUN.superseded}`,
  `echo >&2 || exit ${STEP_NOT_RUN.noConnection}`,
  'if [ "$s" = - ]; then',
  '  "$@" </dev/null >$d/step.out 2>$d/step.err 8>&-; c=$?',
  'else',
  `  in=$(cat); [ "$(printf %s "$in" | sha256sum | cut -c1-64)" = "$s" ] || exit ${STEP_NOT_RUN.input}`,
  '  printf %s "$in" | "$@" >$d/step.out 2>$d/step.err 8>&-; c=$?',
  'fi',
  'cat $d/step.out; cat $d/step.err >&2; exit $c',
].join('\n');

/** Everything of the command before this start's token: the fixed script, and the name it runs under. */
export const STEP_PREFIX = `sh -c '${SCRIPT}' step`;

/**
 * The command that runs `command` (one simple command: a program and its arguments, quoted as they are) as a step.
 * token: 32 hex digits, new for every start. stdin: what the step takes on its input, which must be sent with the
 * command exactly as given here; its sum goes in the command, never the input itself.
 */
export function stepCommand(command: string, o: { token: string; stdin?: string }): string {
  if (!/^[0-9a-f]{32}$/.test(o.token)) throw new Error('a step needs a token of 32 hex digits');
  if (o.stdin === undefined) return `${STEP_PREFIX} ${o.token} - ${command}`;
  // The shell on the server reads the input into a variable, which drops a zero byte and every newline at the end.
  if (o.stdin.endsWith('\n')) throw new Error("a step's input can't end in a newline: its sum on the server would not be this one");
  if (o.stdin.includes('\0')) throw new Error("a step's input can't hold a zero byte: its sum on the server would not be this one");
  return `${STEP_PREFIX} ${o.token} ${bytesToHex(sha256(utf8ToBytes(o.stdin)))} ${command}`;
}
