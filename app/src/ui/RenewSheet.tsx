// Hosting's Renew now, in a sheet from its pill:
// the days, the price and the fee to expect, then the renewal behind the screen
// lock, once per request id. While it renews the sheet can't be closed, so its result is seen.
import { useState } from 'react';
import type { HostingStatus, SendAnswer } from '../cardd/client';
import type { CardDeps } from '../cards/deps';
import { confirmPayment } from '../money/confirm';
import { moneyError } from '../money/format';
import { daysText, hostingSyncer, RENEW_PRESETS, renewDays, renewedText, renewProblem, renewSat } from '../money/hosting';
import { requestId, runRequest } from '../money/requests';
import { feeEstimateSat, WATCH_SEND_MS } from '../money/send';
import { aboutText, confirmView, viewText } from '../money/view';
import { syncHostingIfDue, useServices } from '../services/services';
import { useAmountView } from './amountView';
import { screenLock } from './lock';
import { Amount } from './money';
import { Body, Button, ErrorText, Field, Panel, Row, Sheet, Title } from './ui';

// A failed renewal writes no history line: it shows only as the held amount coming back.
const UNKNOWN = "Not known yet. In Hosting, a “Renewed the VM” line in its history means it went; the held amount coming back with no line means it didn't.";
const FAILED = 'The renewal payment failed: nothing left Hosting.';

type State = { at: 'ready' } | { at: 'renewing'; text: string } | { at: 'done'; ok: boolean; text: string };


const capitalised = (text: string) => text[0].toUpperCase() + text.slice(1);

/**
 * status: cardd's hosting status (the price of a day), and load, which reads it again; availableMsat: hosting's
 * available balance; onChanged: load the account again (after a renewal); off: cardd can't be reached.
 */
export function RenewSheet({ deps, status, load, availableMsat, onChanged, off, onClose }: {
  deps: CardDeps; status: HostingStatus | null; load: () => Promise<void>; availableMsat: number; onChanged: () => void; off: boolean; onClose: () => void;
}) {
  const sv = useServices();
  const [typed, setTyped] = useState('');
  const [state, setState] = useState<State>({ at: 'ready' });
  // Renew shows its amounts in the app's view, in sat while ***: the price is confirmed here.
  const look = useAmountView();
  const cv = confirmView(look.view);

  const days = renewDays(typed);
  const sat = days && status?.synced ? renewSat(days, status.msatPerDay) : null;
  const problem = sat ? renewProblem(availableMsat, sat, cv, look.rated) : null;

  const sent = (a: SendAnswer, d: number, feeMsat: number): State => ({ at: 'done', ok: true, text: renewedText(a.amountMsat, d, feeMsat, cv, look.rated) });
  const renew = async () => {
    if (!days || !sat || problem) return;
    const before = hostingSyncer.lnvpsExpires;
    const why = await screenLock(`Renew for ${daysText(days)}: ${sat} sat`, 'renewing');
    if (why) return setState({ at: 'done', ok: false, text: why });
    setState({ at: 'renewing', text: 'Renewing… keep this screen open.' });
    const out = await runRequest({ cardd: deps.cardd, store: deps.cache }, { kind: 'renew', id: requestId(), days, started: Date.now() }).catch(
      (e) => ({ at: 'failed' as const, e }),
    );
    if (out.at === 'failed') return setState({ at: 'done', ok: false, text: moneyError(out.e) });
    if (out.at === 'refused') return setState({ at: 'done', ok: false, text: moneyError(out.error) });
    if (out.at !== 'answered') return setState({ at: 'done', ok: false, text: UNKNOWN });
    const a = out.answer as SendAnswer;
    let next: State;
    if (a.status === 'sent') next = sent(a, days, a.feeMsat ?? 0);
    else if (a.status === 'failed') next = { at: 'done', ok: false, text: FAILED };
    else {
      setState({ at: 'renewing', text: 'Still on its way…' });
      const w = await confirmPayment(deps.cardd, 'hosting', a.paymentHash, { timeoutMs: WATCH_SEND_MS });
      next = w.kind === 'paid' ? sent(a, days, w.feeMsat) : w.kind === 'failed' ? { at: 'done', ok: false, text: FAILED } : { at: 'done', ok: false, text: UNKNOWN };
    }
    setState(next);
    onChanged();
    await load();
    // LNVPS's own expiry, read every 10 s until it moves (up to 3 minutes): LNVPS may be slow to apply it.
    void hostingSyncer.afterPayment(
      async () => {
        const expires = await syncHostingIfDue(sv, { force: true });
        await load();
        return expires;
      },
      { before },
    );
  };

  return (
    <Sheet visible locked={state.at === 'renewing'} onClose={onClose}>
      <Title>Renew now</Title>
      {state.at === 'ready' && (
        <>
          <Row>
            {RENEW_PRESETS.map((d) => (
              <Button key={d} title={daysText(d)} kind={days === d ? 'primary' : 'secondary'} onPress={() => setTyped(String(d))} />
            ))}
          </Row>
          <Field value={typed} onChangeText={setTyped} placeholder="Days (1 to 365)" keyboardType="number-pad" />
          {typed.trim() !== '' && !days && <Body muted>Renew for 1 to 365 days.</Body>}
          {sat !== null && days !== null && (
            <Panel>
              {/* The price large, the other figure under it. */}
              <Amount msat={sat * 1000} size="large" alt force={cv} />
              <Body>{`for ${daysText(days)}`}</Body>
              <Body muted>{`${capitalised(aboutText(feeEstimateSat(sat * 1000) * 1000, cv, look.rated))} in routing fees. From Hosting's ${viewText(availableMsat, cv, look.rated)}.`}</Body>
            </Panel>
          )}
          {problem && <Body muted>{problem}</Body>}
          <Button title={days ? `Renew for ${daysText(days)}` : 'Renew'} disabled={!sat || problem !== null || off} onPress={renew} />
        </>
      )}
      {state.at === 'renewing' && <Body>{state.text}</Body>}
      {state.at === 'done' && (
        <>
          {state.ok ? <Body>{state.text}</Body> : <ErrorText>{state.text}</ErrorText>}
          <Button title="OK" kind="secondary" onPress={() => setState({ at: 'ready' })} />
        </>
      )}
    </Sheet>
  );
}
