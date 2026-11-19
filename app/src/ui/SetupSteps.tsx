// The setup's steps, one at a time (onboarding, and Rebuild
// server): where it stands, a heading, one line with a spinner while Karto works, the step's own content (Pay's
// panel, the install's list, a rebuild's choice or confirmation), the buttons that can fix an error, and what is
// done folded into a line at the foot. onboarding/progress.ts decides every word.
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import type { UploadProgress } from '../onboarding/install';
import type { OnboardingState } from '../onboarding/machine';
import { doneSteps, doneSummary, errorActions, installFoot, installRows, setupProgress, statusLine, stepHeading, uploadLine, working } from '../onboarding/progress';
import type { OnboardingRunner } from '../onboarding/runner';
import { PayPanel } from './PayPanel';
import { RebuildControls } from './RebuildControls';
import { KeyWaitNotify } from './KeyWaitNotify';
import { DoneFold, Progress, StatusLine } from './setup';
import { Body, Button, ErrorText, Panel, Small, Step, Title } from './ui';

/** upload: the install's upload as it goes (useOnboardingRunner). children: the screen's own buttons, over the Done line (Cancel rebuild). */
export function SetupSteps({ s, runner, upload, children }: { s: OnboardingState; runner: OnboardingRunner; upload: UploadProgress | null; children?: ReactNode }) {
  // The install's minutes, a recovery check's and the Done line's times move with the clock: each second during the
  // install, for its steps' times, every ten seconds otherwise.
  const [now, setNow] = useState(Date.now());
  const installing = s.step === 'install';
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), installing ? 1000 : 10_000);
    return () => clearInterval(t);
  }, [installing]);
  // The Done line starts folded, and folds again when the step changes.
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [s.step]);

  const progress = setupProgress(s);
  const line = statusLine(s, now);
  // These waits show the notice in red, beside what confirms it.
  const noticeBelow = s.waiting === 'confirm_older' || s.waiting === 'confirm_reinstall';
  const actions = errorActions(s);
  const summary = doneSummary(s);
  return (
    <>
      <Progress text={`Step ${progress.n} of ${progress.of}`} n={progress.n} of={progress.of} label={progress.label} />
      <Title>{stepHeading(s)}</Title>
      {s.notice && !noticeBelow && <Body>{s.notice}</Body>}
      {line !== null && (s.error ? <ErrorText>{line}</ErrorText> : <StatusLine text={line} spinning={working(s)} />)}
      {s.step === 'pay' && !s.error && <PayPanel s={s} runner={runner} serverTime={() => runner.deps.lnvps.serverTime()} />}
      {s.step === 'install' && <InstallList s={s} upload={upload} now={now} />}
      {s.waiting === 'host_key_confirm' && !s.error && <KeyWaitNotify />}
      <RebuildControls s={s} runner={runner} />
      {actions.retry && <Button title="Try again" onPress={() => runner.retry()} />}
      {actions.chooseCountry && <Button title="Choose another country" onPress={() => router.replace('/country')} />}
      {actions.final && <Body muted>Trying again won&apos;t fix this.</Body>}
      {children}
      {summary && <DoneFold summary={summary} rows={doneSteps(s, now / 1000, -new Date(now).getTimezoneOffset())} open={open} onToggle={() => setOpen(!open)} />}
    </>
  );
}

/**
 * The install's own steps, as Update server lists its own, each with its time and the upload's megabytes
 * under its step while it runs; under the list, the minutes so far and what to do meanwhile.
 */
function InstallList({ s, upload, now }: { s: OnboardingState; upload: UploadProgress | null; now: number }) {
  return (
    <>
      <Panel>
        {installRows(s, now).map((r) => (
          <Step key={r.step} label={r.label} status={r.status} time={r.time} spoken={r.spoken}>
            {r.step === 'upload' && r.status === 'current' && !s.error && <Body muted>{upload ? uploadLine(upload) : 'Connecting to the server…'}</Body>}
          </Step>
        ))}
      </Panel>
      <Small>{installFoot(s, now)}</Small>
    </>
  );
}
