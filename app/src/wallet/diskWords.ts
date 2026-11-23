// The server's disk nearly full, in the wallet's words: the banner and the Server page's card (cardd measures and
// decides the level: server/internal/disk). phoenixd keeps a record of every invoice it has made and can't delete
// them; Rebuild server leaves them behind (deploy/install.sh wipe). The card offers it only when cardd says a
// rebuild would free enough, or can't tell.
import type { DiskAnswer } from '../cardd/client';

/**
 * Bytes as the phones show them, decimal: GB with one decimal once that rounds to 1.0 GB (from 950,000,000 bytes),
 * else whole MB, each to the nearest. Integer arithmetic, as Android's words (AlertWords.kt) and cardd's alert vectors.
 */
export function bytesText(n: number): string {
  const tenths = Math.floor((n + 50_000_000) / 100_000_000);
  return tenths >= 10 ? `${Math.floor(tenths / 10)}.${tenths % 10} GB` : `${Math.floor((n + 500_000) / 1_000_000)} MB`;
}

/** The wallet's banner: amber when nearly full, red when almost full, none with room or no reading. */
export function diskBanner(d: DiskAnswer | undefined): { tone: 'amber' | 'red'; text: string } | null {
  if (!d?.level) return null;
  const left = bytesText(d.freeBytes);
  return d.level === 'critical'
    ? { tone: 'red', text: `Your server's disk is almost full: ${left} left` }
    : { tone: 'amber', text: `Your server's disk is nearly full: ${left} left` };
}

/** The Server page's card: what is happening and what to do; rebuild: whether it offers Rebuild server. */
export function diskCard(d: DiskAnswer | undefined): { title: string; text: string; rebuild: boolean } | null {
  if (!d?.level) return null;
  const critical = d.level === 'critical';
  const left = `${bytesText(d.freeBytes)} of ${bytesText(d.totalBytes)} is left`;
  if (d.rebuildHelps === undefined) {
    return {
      title: critical ? 'The disk is almost full: rebuild now' : 'The disk is nearly full',
      text: `${left}. Rebuilding the server usually frees the most room: phoenixd, the Lightning wallet on it, keeps a record of every invoice it has made.`,
      rebuild: true,
    };
  }
  if (!d.rebuildHelps) {
    return {
      title: critical ? 'The disk is almost full' : 'The disk is nearly full',
      text:
        `${left}, and a rebuild would free only ${bytesText(d.freeableBytes ?? 0)}: something other than Karto's own data is filling the disk. ` +
        'Ask for help on GitHub: github.com/boltcard/karto/issues.',
      rebuild: false,
    };
  }
  return {
    title: critical ? 'The disk is almost full: rebuild now' : 'The disk is nearly full',
    text:
      `${left}. phoenixd, the Lightning wallet on your server, keeps a record of every invoice it has made and has no way to delete them. ` +
      'Rebuild server sets the server up again, in place on this VM while it is paid or on a new one (paid for), and leaves those records behind: your cards, money and notes come with you. ' +
      'Each card then needs a tap.',
    rebuild: true,
  };
}
