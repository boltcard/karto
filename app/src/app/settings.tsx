// Settings, from the wallet's ⚙: rows, each with how its part stands in one
// line, opening the Server and Backups pages, the phrase and Rebuild server, and on an iPhone Remove this wallet.
// settingsRows says what each row shows; ServerWatch does the work (useWatcher).
import { router } from 'expo-router';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { alertsRow } from '../alerts/alertsView';
import { useAlerts } from '../alerts/useAlerts';
import { buildLabel } from '../deploy/bundle';
import { useCardDeps, useWatcher } from '../services/server';
import { alertsClient, useRouteGuard, useServices } from '../services/services';
import { useAmountView } from '../ui/amountView';
import { SwitchRow } from '../ui/cards';
import { CurrencySheet } from '../ui/CurrencySheet';
import { UnitSheet } from '../ui/UnitSheet';
import { WalletNameSheet } from '../ui/WalletNameSheet';
import type { IconName } from '../ui/icons';
import { ListGroup, ListRow, Screen, Small } from '../ui/ui';
import { currencyRow, unitRow } from '../wallet/currencySetting';
import { serverView } from '../wallet/serverView';
import { settingsRows, type SettingsRow } from '../wallet/settingsRows';
import { walletNameRow } from '../wallet/walletName';

const ICONS: Record<SettingsRow['key'], IconName> = {
  server: 'server', backups: 'backup', phone: 'phone', alerts: 'bell', phrase: 'key', pos: 'sale', rebuild: 'rebuild', remove: 'wipe',
};
/**
 * The groups, top to bottom: the server and this phone (with its alerts), the point of sale, and
 * Rebuild server, alone or over Remove this wallet.
 */
const GROUPS: SettingsRow['key'][][] = [['server', 'backups', 'phone', 'alerts', 'phrase'], ['pos'], ['rebuild', 'remove']];

export default function Settings() {
  const allowed = useRouteGuard('/settings');
  const { snap } = useWatcher(allowed);
  const sv = useServices();
  const deps = useCardDeps();
  // How alerts stand, on a phone that has them: read again each time Settings is shown.
  const host = deps?.host;
  const alerts = useAlerts(sv.native, useMemo(() => (host ? alertsClient(sv, host) : null), [sv, host]));
  const [, tick] = useState(0);
  const amounts = useAmountView();
  const [choosing, setChoosing] = useState(false);
  const [unitList, setUnitList] = useState(false);
  // The wallet's name: its sheet, and a name just saved, shown until the wallet's answer says it.
  const [naming, setNaming] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const serverName = snap.wallet?.name;
  useEffect(() => setSavedName(null), [serverName]);

  // The Server row's Updating · m:ss, ticking while the update runs.
  const updating = !!snap.update?.running;
  useEffect(() => {
    if (!updating) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [updating]);

  const nowMs = Date.now();
  const view = serverView(snap, nowMs);
  if (!allowed || !view) return <Screen busy back />;

  const open = (r: SettingsRow) => {
    if (r.opens === 'nfc-settings') sv.nfc.openSettings();
    else if (r.opens === '/rebuild') {
      // Rebuild server replaces the wallet: coming back to it would show the old server. The stack is cut back to
      // the wallet first, so the rebuild's Done or Cancel leaves one wallet.
      router.dismissTo('/home');
      router.replace('/rebuild');
    } else if (r.opens) router.push(r.opens);
  };
  const row = (r: SettingsRow, i: number) => (
    <ListRow
      key={r.key}
      icon={ICONS[r.key]}
      name={r.name}
      line={r.line}
      tone={r.tone}
      tag={r.tag}
      danger={r.key === 'rebuild' || r.key === 'remove'}
      disabled={r.disabled}
      divider={i > 0}
      onPress={r.opens ? () => open(r) : undefined}
    />
  );
  const rows = settingsRows(snap, view, nowMs, undefined, {
    outlivesApp: sv.phrase.outlivesApp,
    alerts: alerts.supported ? alertsRow(alerts.view, alerts.server, alerts.error) : undefined,
  });
  // The server's one currency, then this phone's Show amounts in and Hide amounts, under the server's group.
  const currency = currencyRow(snap.wallet, amounts.fiat);
  const name = walletNameRow(snap.wallet, savedName);
  const amountsGroup = (
    <>
      <ListGroup>
        <ListRow icon="phone" name="Wallet name" line={name.line} disabled={name.off} onPress={() => setNaming(true)} />
        <ListRow icon="currency" name="Currency" line={currency.line} disabled={currency.off} divider onPress={() => setChoosing(true)} />
        <ListRow icon="currency" name="Show amounts in" line={unitRow(amounts.unit, amounts.fiat)} divider onPress={() => setUnitList(true)} />
      </ListGroup>
      <SwitchRow icon="hide" name="Hide amounts" line="Shows *** in place of every amount" value={amounts.hidden} onChange={amounts.setHidden} />
    </>
  );
  return (
    <Screen title="Settings" back>
      {/* A group with no row (Point of sale, on a server that may not be the person's) isn't drawn. */}
      {GROUPS.map((keys) => rows.filter((r) => keys.includes(r.key))).map(
        (group, i) =>
          group.length > 0 && (
            <Fragment key={group[0].key}>
              <ListGroup>{group.map(row)}</ListGroup>
              {i === 0 && amountsGroup}
            </Fragment>
          ),
      )}
      {/* Every build calls itself 1.0.0: this tells the person which one is installed. */}
      <Small>{buildLabel(sv.build)}</Small>
      {naming && deps && (
        <WalletNameSheet
          start={savedName ?? snap.wallet?.name ?? ''}
          onSave={async (n) => setSavedName(await deps.cardd.setWalletName(n))}
          onClose={() => setNaming(false)}
        />
      )}
      {unitList && <UnitSheet unit={amounts.unit} fiat={amounts.fiat} onChoose={amounts.setUnit} onClose={() => setUnitList(false)} />}
      {choosing && <CurrencySheet current={amounts.fiat?.currency ?? null} onChoose={amounts.chooseCurrency} onClose={() => setChoosing(false)} />}
    </Screen>
  );
}
