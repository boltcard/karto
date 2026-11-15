// Copies the server bundle (deploy/ plus the linux cardd binary) into
// app/deploy-assets/deploy/, which the withDeployAssets plugin adds to the
// APK's assets, and writes app/deploy-assets/manifest.json (path, mode, size,
// sha256) for src/deploy/bundle.ts, and app/deploy-assets/build.json (the
// app's commit and build time). Run via `make app-deploy-assets`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'app', 'deploy-assets');
// Everything install.sh and cardd-ctl need on the VM (deploy/README.md).
export const FILES = [
  ['compose.yaml', 0o644],
  ['Caddyfile', 0o644],
  ['ntfy/server.yml', 0o644],
  ['Dockerfile.cardd', 0o644],
  ['README.md', 0o644],
  ['install.sh', 0o755],
  ['cardd-ctl', 0o755],
  ['bin/cardd', 0o755],
];

rmSync(out, { recursive: true, force: true });
const manifest = FILES.map(([path, mode]) => {
  const src = join(root, 'deploy', path);
  const data = readFileSync(src);
  mkdirSync(dirname(join(out, 'deploy', path)), { recursive: true });
  cpSync(src, join(out, 'deploy', path));
  return { path, mode, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
});
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(manifest.map((f) => `${f.sha256.slice(0, 12)} ${String(f.size).padStart(9)} ${f.path}`).join('\n'));

// The app's own build, for the server page. Not in manifest.json: it would change bundleSha on every build.
// Built from a copy without .git (or no git at all), the label says "unknown" rather than the build failing.
let commit = 'unknown';
try {
  commit = execFileSync('git', ['describe', '--always', '--dirty'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || commit;
} catch {
  // keep "unknown"
}
writeFileSync(join(out, 'build.json'), JSON.stringify({ commit, builtAt: Math.floor(Date.now() / 1000) }) + '\n');
console.log(`build ${commit}`);
