// The version stamped into cardd (deploy/server-version.sh, used by `make cardd-linux`). It was the repository's
// latest commit, so every commit made a different cardd, a different bundle hash, and "This app carries a newer
// version of the server" after every build of the app, though the server hadn't changed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '..', '..', '..', 'deploy', 'server-version.sh');
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A throwaway repository: write(path, text), commit() giving the new commit's short hash, and the script's answer. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'server-version-'));
  made.push(dir);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim();
  git('init', '-q');
  return {
    dir,
    write: (path: string, text: string) => {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    },
    commit: (message: string) => {
      git('add', '-A');
      git('commit', '-q', '-m', message);
      return git('rev-parse', '--short', 'HEAD');
    },
    version: () => execFileSync('sh', [SCRIPT, dir], { env, encoding: 'utf8' }).trim(),
  };
}

describe('deploy/server-version.sh', () => {
  it("is the last commit that changed the server's code, whatever was committed elsewhere since", () => {
    const r = repo();
    r.write('server/cmd/cardd/main.go', 'package main\n');
    const server = r.commit('the server');
    expect(r.version()).toBe(server);
    r.write('app/src/app/welcome.tsx', '// a screen\n');
    r.write('deploy/install.sh', '# the installer has its own hash in the bundle\n');
    r.write('docs/spec.md', 'words\n');
    const later = r.commit('the app, the installer and the docs');
    expect(later).not.toBe(server);
    expect(r.version()).toBe(server);
    r.write('server/internal/ledger/ledger.go', 'package ledger\n');
    expect(r.version()).not.toBe(server); // uncommitted: below
    const changed = r.commit('the server again');
    expect(r.version()).toBe(changed);
  });

  it("says -dirty only for uncommitted changes to the server's code, a new file among them", () => {
    const r = repo();
    r.write('server/main.go', 'package main\n');
    const server = r.commit('the server');
    r.write('app/x.ts', 'export {};\n');
    expect(r.version()).toBe(server); // an untracked file elsewhere
    r.commit('the app');
    r.write('app/x.ts', 'export const x = 1;\n');
    expect(r.version()).toBe(server); // a change elsewhere
    r.write('server/main.go', 'package main\n\nfunc main() {}\n');
    expect(r.version()).toBe(`${server}-dirty`);
    r.commit('the server');
    r.write('server/new.go', 'package main\n');
    expect(r.version()).toMatch(/^[0-9a-f]{7,}-dirty$/);
  });

  it('says unknown outside a repository, or in one with no server yet, rather than failing the build', () => {
    const r = repo();
    expect(r.version()).toBe('unknown');
    r.write('app/x.ts', 'export {};\n');
    r.commit('the app alone');
    expect(r.version()).toBe('unknown');
    const bare = mkdtempSync(join(tmpdir(), 'server-version-none-'));
    made.push(bare);
    expect(execFileSync('sh', [SCRIPT, bare], { encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } }).trim()).toBe('unknown');
  });
});
