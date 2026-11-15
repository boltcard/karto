// The PoS phones: the phones that take payments into Shop with
// Karto PoS, each opening a sheet to rename or remove it, and Add a PoS phone. After a restore the page asks the
// person to check the list, once for that restore. Its own 5-second read tells the watch whether cardd answered,
// as an account's page does.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { ShopPhones } from '../cardd/client';
import { poll } from '../cards/poll';
import { useCardDeps, useWatcher } from '../services/server';
import { useRouteGuard, useServices } from '../services/services';
import { PosPhoneSheet } from '../ui/PosPhoneSheet';
import { Body, Button, ErrorText, ListGroup, ListRow, Panel, Screen, Small } from '../ui/ui';
import { moneyOff } from '../wallet/banners';
import { phoneRows, posError, posGate, restoreNote, UPDATE_FIRST } from '../wallet/posPhones';
import { serverView } from '../wallet/serverView';

export default function PosPhones() {
  const allowed = useRouteGuard('/pos-phones');
  const deps = useCardDeps();
  const sv = useServices();
  // The watch runs under this page, as under Settings: it holds the server's state, which the gate below reads.
  const { snap, watch } = useWatcher(allowed);
  const [list, setList] = useState<ShopPhones | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The restore this phone last said it checked the list after; undefined until the phone's store answers. */
  const [checked, setChecked] = useState<number | null | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!deps) return;
    try {
      setList(await deps.cardd.shopPhones());
      setError(null);
      watch.reportRefresh({ ok: true });
    } catch (e) {
      watch.reportRefresh({ ok: false, error: e });
      setError(posError(e));
    }
  }, [deps, watch]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return poll(load, 5000, () => AppState.currentState === 'active');
    }, [load]),
  );
  useEffect(() => {
    sv.store.posRestoreChecked().then(setChecked, () => setChecked(null));
  }, [sv]);

  if (!allowed || !deps) return <Screen busy />;
  // A server that may not be the person's shows nothing of its shop, by the row or by a link; until the watch knows the server, the page waits.
  const gate = posGate(serverView(snap, Date.now()));
  if (gate === 'wait') return <Screen title="PoS phones" busy back />;
  if (gate !== 'open') {
    return (
      <Screen title="PoS phones" back>
        <ErrorText>{gate.stopped}</ErrorText>
      </Screen>
    );
  }
  // A server that hasn't had Update server has no shop.
  if (error === UPDATE_FIRST) {
    return (
      <Screen title="PoS phones" back>
        <Body>{UPDATE_FIRST}</Body>
        <Button title="Open Server" kind="secondary" onPress={() => router.push('/server')} />
      </Screen>
    );
  }
  if (!list) return <Screen title="PoS phones" back>{error ? <ErrorText>{error}</ErrorText> : <Body muted>Loading…</Body>}</Screen>;

  const off = moneyOff({ unreachable: snap.unreachable, updating: snap.update?.running ? snap.update : null });
  const rows = phoneRows(list.phones, Date.now() / 1000, -new Date().getTimezoneOffset());
  const sheet = rows.find((r) => r.keyId === open);
  const haveChecked = () => {
    const restored = list.restored;
    if (restored === undefined) return;
    setChecked(restored);
    void sv.store.savePosRestoreChecked(restored);
  };
  const add = <Button title="Add a PoS phone" onPress={() => router.push('/pos-add')} disabled={off} />;

  return (
    <Screen title="PoS phones" back>
      {error && <ErrorText>{error}</ErrorText>}
      {checked !== undefined && restoreNote(list, checked) && (
        <Panel tone="warn">
          <Body>
            This server was restored from a backup. Check this list: a PoS phone you removed after that backup was made is back. Sales taken after that backup are in
            Pool, not Shop, and aren&apos;t in the list of sales.
          </Body>
          <Button title="I've checked" kind="secondary" onPress={haveChecked} />
        </Panel>
      )}
      {rows.length === 0 ? (
        <>
          <Body>Karto PoS is a second app that takes payments on any Android phone: a Bolt Card held to it, or a QR code for a phone wallet.</Body>
          <Body muted>A PoS phone can take payments into Shop and see the sales it took. It can&apos;t move money, and it never sees your cards or your recovery phrase.</Body>
          {add}
        </>
      ) : (
        <>
          <ListGroup>
            {rows.map((r, i) => (
              <ListRow key={r.keyId} icon="phone" name={r.name} line={r.line} divider={i > 0} disabled={off} onPress={() => setOpen(r.keyId)} />
            ))}
          </ListGroup>
          {add}
          <Small>A PoS phone runs Karto PoS. It can take payments into Shop and see the sales it took, and nothing else.</Small>
        </>
      )}
      {sheet && (
        <PosPhoneSheet
          key={sheet.keyId}
          row={sheet}
          phones={list.phones}
          cardd={deps.cardd}
          off={off}
          onChanged={() => {
            setOpen(null);
            void load();
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </Screen>
  );
}
