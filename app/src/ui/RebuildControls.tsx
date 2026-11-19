// What the person chooses and confirms during a rebuild,
// under the step that waits for it: on Rebuild server, and in
// onboarding for a new phone. A choice is a row chosen and then one button; it goes through the runner,
// which saves it and carries on at once. Also the choice of server for a phrase with more than one.
import { useEffect, useRef, useState } from 'react';
import type { Kept } from '../backup/backups';
import { importExported } from '../backup/files';
import { OLD_VM_SSH_WAIT_MS, oldServerAnswers, overrideFor, overrideOffered, overridePrompt, type ChosenBackup, type OnboardingState } from '../onboarding/machine';
import { elapsed } from '../onboarding/progress';
import {
  backupButton, backupRows, backupSelection, importedChoice, inPlaceChoices, vmButton, vmRows, vmSelection, whereButton, whereRows, withBackup, withConfirm, withoutBackup, withTarget,
  type BackupOpened, type InPlaceChoice,
} from '../onboarding/rebuild';
import type { OnboardingRunner } from '../onboarding/runner';
import { OldServerPayPanel } from './PayPanel';
import { Body, Button, Callout, ErrorText, ListGroup, ListRow } from './ui';

/** The phone's clock for the rows' times: now (unix seconds) and the minutes east of UTC. */
const clock = () => [Date.now() / 1000, -new Date().getTimezoneOffset()] as const;

type Act = (f: (s: OnboardingState) => OnboardingState) => Promise<void>;

export function RebuildControls({ s, runner }: { s: OnboardingState; runner: OnboardingRunner }) {
  // An error stops the runner: a new choice starts it again.
  const act: Act = async (f) => {
    await runner.update(f);
    void runner.start();
  };
  const oldId = s.rebuild?.oldVm?.id;
  if (s.step === 'order' && s.waiting === 'choose_vm') return <ChooseVm s={s} act={act} />;
  if (!s.rebuild) return null;
  // A choice refused (a backup the phrase can't open, a VM not paid) is chosen again.
  const choosing = (w: OnboardingState['waiting']) => s.waiting === w || s.error?.kind === 'retry';
  if (s.step === 'backup' && choosing('choose_backup')) return <ChooseBackup s={s} runner={runner} act={act} />;
  if (s.waiting === 'confirm_older') {
    return (
      <>
        <ErrorText>{s.notice}</ErrorText>
        <Button title="Restore it all the same" onPress={() => act((x) => withConfirm(x, { older: true }))} />
        <Button title="Choose another backup" kind="secondary" onPress={() => act(withoutBackup)} />
      </>
    );
  }
  if (s.step === 'where' && choosing('choose_where')) return <ChooseWhere s={s} runner={runner} act={act} />;
  if (s.waiting === 'confirm_retire') {
    return (
      <>
        <Body>
          The old server (VM {oldId}) is retired before the new one gets the wallet seed, so two Lightning wallets never run on one seed: a final snapshot, then its
          services removed and a marker that stops them starting again. If it doesn&apos;t answer, LNVPS starts it first.
        </Body>
        <Button title={`Retire VM ${oldId}`} onPress={() => act((x) => withConfirm(x, { retire: true }))} />
      </>
    );
  }
  if (s.waiting === 'confirm_reinstall') {
    return (
      <>
        <ErrorText>{s.notice}</ErrorText>
        <Button title={`Re-install VM ${oldId}`} kind="secondary" onPress={() => act((x) => withConfirm(x, { reinstall: true }))} />
      </>
    );
  }
  if (s.waiting === 'confirm_expired') {
    return (
      <>
        <Callout>
          <Body>
            VM {oldId} has expired. LNVPS keeps it stopped for a while before deleting it, but it still holds the Lightning wallet&apos;s
            seed, and a payment from anyone starts it again beside the new server. Paying it a day from another wallet lets the app start it,
            take its final snapshot and retire it properly.
          </Body>
        </Callout>
        <Button title="Pay 1 day to retire it properly" onPress={() => act((x) => withConfirm(x, { payOld: true }))} />
        <Button title="Skip: don't pay it" kind="secondary" onPress={() => act((x) => withConfirm(x, { expired: true }))} />
      </>
    );
  }
  if (s.waiting === 'old_payment') return <OldServerPayPanel s={s} serverTime={() => runner.deps.lnvps.serverTime()} />;
  if (overrideOffered(s)) {
    // LNVPS can't say what the old server does, retiring it over SSH keeps failing, or its final snapshot can't be had.
    // Taken only for what it was confirmed for: a pass that meets the other case drops it.
    const prompt = overridePrompt(s);
    const override = overrideFor(s);
    return (
      <>
        <ErrorText>{prompt.text}</ErrorText>
        <Button title={prompt.title} kind="secondary" onPress={() => act((x) => withConfirm(x, { override }))} />
      </>
    );
  }
  if (s.waiting === 'old_vm_starting') return <OldVmStarting since={s.rebuild.reachingSince} />;
  return null;
}

/** Step 1 lists this many backups until the person asks for all. */
const SHOWN = 5;

/**
 * Step 1: the backups on this phone as rows (newest first), the phrase alone as the last row when it is offered,
 * and an exported file. The newest backup that can be chosen is ticked until another row is tapped.
 */
function ChooseBackup({ s, runner, act }: { s: OnboardingState; runner: OnboardingRunner; act: Act }) {
  const d = runner.deps;
  const [rows, setRows] = useState<{ kept: Kept; summary: BackupOpened }[] | null>(null);
  const [all, setAll] = useState(false);
  // Phrase only is refused while the old server answers and the phone holds a backup (step 1's own rule).
  const [phraseOnly, setPhraseOnly] = useState<'checking' | 'offered' | 'refused'>('checking');
  /** The row the person tapped (its key); null until they tap one. */
  const [tapped, setTapped] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Read once: the runner hands over a new state at every poll, which mustn't list and open everything again.
  const rebuild = useRef(s.rebuild!);

  useEffect(() => {
    let stopped = false;
    (async () => {
      const kept = await d.backups.list();
      const shown = kept.filter((k) => k.checked !== 'unreadable').reverse();
      setRows(shown.map((k) => ({ kept: k, summary: undefined })));
      const answers = kept.length > 0 && (await oldServerAnswers(rebuild.current, d).catch(() => false));
      if (!stopped) setPhraseOnly(answers ? 'refused' : 'offered');
    })().catch((e) => !stopped && setMessage(e instanceof Error ? e.message : String(e)));
    return () => {
      stopped = true;
    };
  }, [d]);

  // Opening one takes seconds on the phone: the ones shown, one at a time, newest first.
  const visible = rows && (all ? rows : rows.slice(0, SHOWN));
  const next = visible?.find((r) => r.summary === undefined);
  useEffect(() => {
    if (!next) return;
    let stopped = false;
    d.backups.inspect(next.kept.name).catch(() => 'failed' as const).then((x) => {
      if (!stopped) setRows((rs) => rs && rs.map((r) => (r.kept.name === next.kept.name ? { ...r, summary: x } : r)));
    });
    return () => {
      stopped = true;
    };
  }, [d, next]);

  const choose = (b: ChosenBackup) => act((x) => withBackup(x, b));
  const pick = async () => {
    setMessage(null);
    try {
      const name = await importExported(d.keys.backupAgeIdentity);
      if (!name) return;
      const chosen = await importedChoice(name, d.backups);
      if (!chosen) return setMessage("This file can't be opened with your recovery phrase.");
      await choose(chosen);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const [nowS, offsetMin] = clock();
  const list = backupRows(visible ?? [], phraseOnly === 'offered', nowS, offsetMin);
  const chosen = backupSelection(list, tapped);
  return (
    <>
      {rows === null && <Body muted>Looking at the backups on this phone…</Body>}
      {rows?.length === 0 && <Body muted>This phone keeps no backup.</Body>}
      {list.length > 0 && (
        <ListGroup>
          {list.map((r, i) =>
            r.choice ? (
              <ListRow key={r.key} name={r.name} line={r.line} selected={r.key === chosen?.key} onPress={() => setTapped(r.key)} divider={i > 0} />
            ) : (
              // One that can't be chosen: greyed, opens nothing, and its line says why.
              <ListRow key={r.key} name={r.name} line={r.line} disabled divider={i > 0} />
            ),
          )}
        </ListGroup>
      )}
      {chosen?.choice?.kind === 'phrase_only' && (
        <Body muted>
          The server starts with no cards and all of its Lightning balance in Pool: the split between the cards is lost, and each card is
          added back by tapping it.
        </Body>
      )}
      <Button title={backupButton(chosen, nowS, offsetMin)} onPress={() => chosen?.choice && choose(chosen.choice)} disabled={!chosen?.choice} />
      {rows && !all && rows.length > SHOWN && <Button title={`Show all ${rows.length} backups`} kind="secondary" onPress={() => setAll(true)} />}
      <Button title="Choose an exported backup…" kind="secondary" onPress={pick} />
      {phraseOnly === 'refused' && (
        <Body muted>No backup isn&apos;t offered: the old server still answers, so step 4 takes a final snapshot from it, newer than any choice here.</Body>
      )}
      {message && <ErrorText>{message}</ErrorText>}
    </>
  );
}

/**
 * Step 2: a new server, or in place on a paid VM of this phrase. Nothing is ticked at first: one choice costs money
 * and the other wipes a server. In place, the button is the wipe's confirmation, under its warning.
 */
function ChooseWhere({ s, runner, act }: { s: OnboardingState; runner: OnboardingRunner; act: Act }) {
  const lnvps = runner.deps.lnvps;
  const [vms, setVms] = useState<InPlaceChoice[] | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    lnvps
      .listVms()
      .then((all) => setVms(inPlaceChoices(all, { sshKeyId: s.sshKeyId, retiredVms: s.retiredVms }, lnvps.serverTime())))
      .catch((e) => setMessage(`LNVPS couldn't list your servers: ${e instanceof Error ? e.message : String(e)}`));
  }, [lnvps, s.sshKeyId, s.retiredVms]);
  // Until LNVPS has answered (or failed to), nothing is offered: a new server alone would hide a paid one to rebuild in place on.
  if (vms === null && message === null) return <Body muted>Asking LNVPS for your servers…</Body>;
  const rows = whereRows(vms ?? [], ...clock());
  const target = rows.find((r) => r.key === key)?.target ?? null;
  return (
    <>
      <ListGroup>
        {rows.map((r, i) => (
          <ListRow key={r.key} name={r.name} line={r.line} selected={r.key === key} onPress={() => setKey(r.key)} divider={i > 0} />
        ))}
      </ListGroup>
      {target?.kind === 'in_place' && (
        <ErrorText>
          VM {target.vmId}&apos;s server data is wiped: its database, the backups on it, and its Lightning wallet&apos;s data except the seed.
        </ErrorText>
      )}
      <Button title={whereButton(target)} onPress={() => target && act((x) => withTarget(x, target))} disabled={!target} />
      {message && <ErrorText>{message}</ErrorText>}
    </>
  );
}

/** A new phone's phrase with more than one paid server: which to set up. Nothing is ticked at first. */
function ChooseVm({ s, act }: { s: OnboardingState; act: Act }) {
  const [id, setId] = useState<number | null>(null);
  const rows = vmRows(s.vmChoices ?? [], ...clock());
  // The choices can change under the screen (one expired meanwhile): a server no longer offered isn't chosen.
  const chosen = vmSelection(rows, id);
  return (
    <>
      <ListGroup>
        {rows.map((r, i) => (
          <ListRow key={r.key} name={r.name} line={r.line} selected={r.id === chosen} onPress={() => setId(r.id)} divider={i > 0} />
        ))}
      </ListGroup>
      <Button title={vmButton(chosen)} onPress={() => chosen !== null && act((x) => ({ ...x, chosenVmId: chosen }))} disabled={chosen === null} />
    </>
  );
}

/** Step 4 waits for the old server's SSH after LNVPS started it, before the last resort. */
function OldVmStarting({ since }: { since?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (since === undefined) return null;
  return (
    <Body muted>
      Waited {elapsed(since, now)} of {OLD_VM_SSH_WAIT_MS / 60_000} minutes. If it still doesn&apos;t answer, the last resort is re-installing it
      through LNVPS.
    </Body>
  );
}
