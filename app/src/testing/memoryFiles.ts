// BackupFiles in memory (tests only), as src/backup/files.ts keeps them on the phone.
import { parseName, type BackupFiles, type CheckResult, type Kept } from '../backup/backups';

export function memoryFiles(): BackupFiles {
  const files = new Map<string, Uint8Array>();
  const marks = new Map<string, CheckResult>();
  return {
    list: async () =>
      [...files.entries()]
        .map(([name, b]) => ({ name, ...parseName(name)!, size: b.length, checked: marks.get(name) }) as Kept)
        .sort((a, b) => a.created - b.created || a.version - b.version),
    write: async (name, bytes) => {
      files.set(name, bytes.slice());
      marks.delete(name);
    },
    read: async (name) => {
      const b = files.get(name);
      if (!b) throw new Error(`no ${name}`);
      return b.slice();
    },
    remove: async (name) => {
      files.delete(name);
      marks.delete(name);
    },
    mark: async (name, result) => void marks.set(name, result),
  };
}
