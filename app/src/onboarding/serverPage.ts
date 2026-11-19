// What the server page says about rebuilding: when it
// suggests Rebuild server, how a restore stands, the cards still pointing at
// the old server, and the old VM running again.
import { parseName } from '../backup/backups';
import type { CardInfo, RestoreInfo, Wallet } from '../cardd/client';
import { satText } from '../cards/labels';
import type { Vm } from '../lnvps/client';
import { whenText } from '../money/format';
import { oldVmsToWatch, type OnboardingState } from './machine';

/** How long cardd may fail to answer, while LNVPS answers, before the page suggests a rebuild. */
export const UNREACHABLE_SUGGEST_MS = 60 * 60 * 1000;

/**
 * The line above Rebuild server, or null: LNVPS reports the VM deleted or expired (gone: the
 * wallet's banner is red), or cardd has failed to answer for over an hour (the background job's
 * record) while LNVPS answers (amber). vm: LNVPS's answer for this server's VM ('unreachable'
 * when LNVPS didn't answer); carddAnswers: the page's own check just now.
 */
export function rebuildSuggestion(o: {
  vmId: number;
  vm: Vm | null | 'unreachable';
  lnvpsNowMs: number;
  unreachableSince: number | null;
  carddAnswers: boolean;
  nowMs: number;
}): { text: string; gone: boolean } | null {
  const { vm } = o;
  if (vm === 'unreachable') return null;
  if (!vm) return { text: `LNVPS no longer lists VM ${o.vmId}: your server is gone. Rebuild it from a backup.`, gone: true };
  if (vm.expires && Date.parse(vm.expires) <= o.lnvpsNowMs) {
    const deletes = vm.deleting_on ? `on ${vm.deleting_on.slice(0, 10)}` : 'soon';
    return { text: `VM ${o.vmId} has expired, and LNVPS deletes it ${deletes}. Pay LNVPS for it in time, or rebuild the server from a backup.`, gone: true };
  }
  if (!o.carddAnswers && o.unreachableSince !== null && o.nowMs - o.unreachableSince > UNREACHABLE_SUGGEST_MS) {
    return { text: "Your server hasn't answered for over an hour, though LNVPS does. If it doesn't come back, rebuild it from a backup.", gone: false };
  }
  return null;
}

/**
 * The restore's lines: where it came from, then reconcile's state (red for a shortfall and no channel).
 * While the channel is awaited and with no channel: what phoenixd reports (one not yet connected to ACINQ
 * doesn't answer); with no channel, notUp when the server would refuse the books for a channel that isn't
 * up yet (it sets them itself once it is).
 */
export type RestoreView = { from: string; line: string; red: boolean; setBooks: boolean; phoenixd?: string; notUp?: string };

export function restoreView(
  r: RestoreInfo | null,
  liquidity: Wallet['liquidity'] = null,
  nowS = Date.now() / 1000,
  offsetMin = -new Date(nowS * 1000).getTimezoneOffset(),
): RestoreView | null {
  if (!r) return null;
  // restore.from is the kept file's name without .age, "phrase" for the phrase alone.
  const created = parseName(`${r.from}.age`)?.created;
  const from =
    r.from === 'phrase'
      ? 'Started fresh from the recovery phrase'
      : created !== undefined
        ? `Restored from the backup of ${whenText(created, nowS, offsetMin)}`
        : 'Restored from a backup';
  const view = (line: string, red = false, setBooks = false) => ({ from, line, red, setBooks });
  switch (r.state) {
    case 'pending':
      return { ...view('Waiting for the channel to come back'), phoenixd: phoenixdNow(liquidity).phoenixd };
    case 'no_channel':
      return {
        ...view(
          'No channel came back from the Lightning provider (ACINQ) after the restore. The money may be on-chain in phoenixd\'s wallet, or was spent after the backup. ' +
            "Spending stays paused until the books are set to phoenixd's balance: the difference goes to pool.",
          true,
          true,
        ),
        ...phoenixdNow(liquidity),
      };
    case 'done': {
      const diff = r.reconciledMsat ?? 0;
      if (diff < 0) return view(`The server holds less than the backup said: ${satText(-diff)} short`, true);
      // Under a whole sat over is the balances matching: the app shows whole sats.
      return view(diff < 1000 ? 'The balances matched.' : `${satText(diff)} more than the backup, moved to Pool.`);
    }
  }
}

function phoenixdNow(l: Wallet['liquidity']): Pick<RestoreView, 'phoenixd' | 'notUp'> {
  const wallet = "The server's Lightning wallet (phoenixd)";
  if (!l) return { phoenixd: `${wallet} didn't answer just now.` };
  if (!l.channel) return { phoenixd: `${wallet} has no channel.` };
  if (l.usable) return { phoenixd: `${wallet} has its channel up again: the server sets the books itself within a minute.` };
  return { phoenixd: `${wallet} has a channel that isn't up yet.`, notUp: "The channel isn't up yet: wait for it." };
}

/**
 * Cards to re-point: not reset, their URL on another server (a cardd from before hosts says nothing). phones: the
 * ids of phones' cards, which are never among them: a phone makes its own links, and the wallet sets the server's
 * record of its card's host itself.
 */
export const cardsToRepoint = <C extends Pick<CardInfo, 'id' | 'state' | 'host'>>(cards: C[], host: string, phones?: ReadonlySet<string>) =>
  cards.filter((c) => c.state !== 'reset' && c.host !== undefined && c.host !== host && !phones?.has(c.id));

/**
 * Cards a restore left needing a check before they can pay (cardd's needsCheck), to hold to the phone: not reset,
 * not to be re-pointed (the re-point checks the card), and never a phone's, which the wallet checks itself
 * (phoneCard/keep.ts).
 */
export const cardsToCheck = <C extends Pick<CardInfo, 'id' | 'state' | 'host' | 'needsCheck'>>(cards: C[], host: string, phones?: ReadonlySet<string>) => {
  const repoint = new Set(cardsToRepoint(cards, host).map((c) => c.id));
  return cards.filter((c) => c.needsCheck && c.state !== 'reset' && !repoint.has(c.id) && !phones?.has(c.id));
};

/**
 * The red warning when LNVPS reports an old VM running that step 4 never retired over SSH, naming it
 * (the one Retire old server then retires). old: LNVPS's answers for the VMs oldVmsToWatch names.
 */
export function oldVmWarning(s: OnboardingState, old: (Vm | null | 'unreachable')[]): { vmId: number; text: string } | null {
  const watched = oldVmsToWatch(s);
  const vm = old.find((x): x is Vm => !!x && x !== 'unreachable' && x.status.state === 'running' && watched.includes(x.id));
  if (!vm) return null;
  const text = `LNVPS reports the old server (VM ${vm.id}) running, and it was never retired over SSH. Two Lightning wallets on one seed ` +
    'can close the channel: retire it now.';
  return { vmId: vm.id, text };
}
