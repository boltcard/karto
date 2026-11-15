// The checks of the native layer, run by `make phone-diag` (a build
// with EXPO_PUBLIC_DIAG_SSH set opens here instead of onboarding), the
// read-only card probe, run by `make phone-card-probe` (EXPO_PUBLIC_DIAG_CARD=1),
// the backup probe, run by `make phone-backup-probe` (EXPO_PUBLIC_DIAG_BACKUP=1),
// the channel-recovery check on the paired server, run by
// `make phone-recovery-check` (EXPO_PUBLIC_DIAG_RECOVERY=1; =result with RESULT=1, only the last check's result),
// the photo probe, run by `make phone-photo-probe` (EXPO_PUBLIC_DIAG_PHOTO=1),
// and the connection probe, run by `make phone-connection-probe` (EXPO_PUBLIC_DIAG_CONNECTION=1).
import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import CardNative from '../../modules/card-native';
import { Directory, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import { base64 } from '@scure/base';
import { ageDecrypt } from '../backup/age';
import { openSnapshot, phoneFiles } from '../backup/files';
import { openJobDb } from '../backup/jobDb';
import { probeBackup } from '../diagnostics/backupProbe';
import { probeCard } from '../diagnostics/cardProbe';
import { parseTarget, runChecks, type CheckResult } from '../diagnostics/checks';
import { probeConnection, type JobHandle } from '../diagnostics/connectionProbe';
import { probePhotos, type AppFile } from '../diagnostics/photoProbe';
import { PROBE_JPEG_BASE64 } from '../diagnostics/probePhoto';
import { checkRecovery, recoveryMode } from '../diagnostics/recoveryCheck';
import { bundleFromManifest, loadManifest } from '../deploy/bundle';
import { nativeSsh } from '../native/ssh';
import { connectToServer } from '../onboarding/machine';
import { cardDeps, reopenAppDb, useRouteGuard, useServices, type Services } from '../services/services';
import { TYPE, type Theme } from '../ui/theme';
import { Body, Button, Screen } from '../ui/ui';
import { useStyles } from '../ui/useTheme';

const CARD_PROBE = process.env.EXPO_PUBLIC_DIAG_CARD === '1';
const BACKUP_PROBE = process.env.EXPO_PUBLIC_DIAG_BACKUP === '1';
const RECOVERY_CHECK = recoveryMode(process.env.EXPO_PUBLIC_DIAG_RECOVERY);
const PHOTO_PROBE = process.env.EXPO_PUBLIC_DIAG_PHOTO === '1';
const CONNECTION_PROBE = process.env.EXPO_PUBLIC_DIAG_CONNECTION === '1';

/** A database of rows 1,000-byte rows with meta vm.id, serialised by expo-sqlite. */
async function makeDb(rows: number, vmId: string): Promise<Uint8Array> {
  const db = await SQLite.openDatabaseAsync(':memory:');
  try {
    await db.execAsync(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE filler (b BLOB);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${Math.floor(rows)})
      INSERT INTO filler SELECT randomblob(1000) FROM n;`);
    await db.runAsync(`INSERT INTO meta VALUES ('vm.id', ?)`, vmId);
    return await db.serializeAsync();
  } finally {
    await db.closeAsync();
  }
}

/** Logs in to the paired server as Update server does: the saved host and the phrase's SSH key. */
async function recoveryCheck(sv: Services): Promise<CheckResult[]> {
  const [phrase, state] = await Promise.all([sv.phrase.get(), sv.store.onboarding()]);
  if (!phrase || !state?.host) return [{ name: 'connect', ok: false, detail: 'this phone has no paired server' }];
  // 15 minutes or more: don't let the screen lock cut it short.
  activateKeepAwakeAsync('recovery-check').catch(() => {});
  try {
    return await checkRecovery(() => connectToServer(state, nativeSsh(sv.native), sv.keys(phrase)), { resultOnly: RECOVERY_CHECK === 'result' });
  } finally {
    deactivateKeepAwake('recovery-check').catch(() => {});
  }
}

/** Every file under a folder, for the photo probe: its path from label, its size, and whether it starts as a JPEG does. */
function listFiles(root: Directory, label: string): AppFile[] {
  const out: AppFile[] = [];
  const walk = (d: Directory, path: string) => {
    for (const e of d.list()) {
      if (e instanceof Directory) {
        walk(e, `${path}/${e.name}`);
        continue;
      }
      let head = new Uint8Array(0);
      try {
        const h = e.open();
        try {
          head = h.readBytes(3);
        } finally {
          h.close();
        }
      } catch {
        // unreadable (a database the app holds open): not a picture the camera left
      }
      out.push({ path: `${path}/${e.name}`, size: e.size ?? 0, jpeg: head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff });
    }
  };
  if (root.exists) walk(root, label);
  return out;
}

/** The photo probe on the paired server and the phone's own files and snapshots. */
async function photoProbe(sv: Services): Promise<CheckResult[]> {
  const [phrase, state] = await Promise.all([sv.phrase.get(), sv.store.onboarding()]);
  if (!phrase || !state?.host) return [{ name: 'server', ok: false, detail: 'this phone has no paired server' }];
  const { cardd } = cardDeps(sv, state, phrase);
  const files = phoneFiles();
  const identity = sv.keys(phrase).backupAgeIdentity;
  return probePhotos(base64.decode(PROBE_JPEG_BASE64), {
    appFiles: async () => [...listFiles(Paths.cache, 'cache'), ...listFiles(Paths.document, 'files')],
    thumbnail: async (jpeg, corners) => {
      if (!CardNative.cardThumbnail) throw new Error("this phone's module has no camera step");
      return CardNative.cardThumbnail(jpeg, corners);
    },
    cards: () => cardd.cards(),
    cardPhoto: (id) => cardd.cardPhoto(id),
    newestSnapshot: async () => {
      const k = (await files.list()).at(-1);
      return k ? { created: k.created, plain: ageDecrypt(await files.read(k.name), identity) } : null;
    },
    photoRows: async (plain) => {
      const db = await SQLite.deserializeDatabaseAsync(plain);
      try {
        return (await db.getAllAsync<{ card_id: string }>('SELECT card_id FROM card_photos')).map((r) => r.card_id);
      } finally {
        await db.closeAsync();
      }
    },
  });
}

/** deploy/test/phone-diag.sh and phone-card-probe.sh read these lines from logcat. */
function report(r: CheckResult[]) {
  for (const x of r) console.log('CARDAPP-DIAG', JSON.stringify(x));
  console.log('CARDAPP-DIAG-DONE', JSON.stringify({ pass: r.filter((x) => x.ok).length, fail: r.filter((x) => !x.ok).length }));
}

export default function Diagnostics() {
  const allowed = useRouteGuard('/diagnostics');
  const s = useStyles(makeStyles);
  const sv = useServices();
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    const r = BACKUP_PROBE
      ? await probeBackup({ makeDb, openDb: openSnapshot, rows: 4000, now: () => performance.now() })
      : RECOVERY_CHECK
      ? await recoveryCheck(sv)
      : PHOTO_PROBE
      ? await photoProbe(sv)
      : CONNECTION_PROBE
      ? await probeConnection(
          // expo-sqlite's type for NativeDatabase leaves out release(), which every Expo shared object has.
          {
            read: () => sv.store.onboarding(),
            openJob: async () => (await openJobDb()) as unknown as JobHandle,
            recover: {
              openShared: async () => (await SQLite.openDatabaseAsync('card-app.db')) as unknown as JobHandle,
              reconnect: () => sv.store.reconnect(reopenAppDb),
            },
          },
          5,
        )
      : await runChecks(CardNative, bundleFromManifest(await loadManifest(CardNative)), parseTarget(process.env.EXPO_PUBLIC_DIAG_SSH), CardNative);
    report(r);
    setResults(r);
    setRunning(false);
  };

  useEffect(() => {
    if (!allowed) return;
    if (!CARD_PROBE) {
      run();
      return;
    }
    let busy = false;
    // A screen claim on the shared slot: the provider's base claim keeps reader mode on after it lets go.
    return sv.nfcSlot.claim(async (tag) => {
      if (busy) return;
      busy = true;
      setRunning(true);
      const r = tag.transceive
        ? await probeCard(tag.transceive, tag.uid)
        : [{ name: 'tag', ok: false, detail: 'Android cannot talk ISO-DEP to this tag: it is not an NTAG 424 DNA' }];
      await tag.close();
      // Where cards are read in a session, the probe ends the one its button opened.
      const failed = r.find((x) => !x.ok);
      if (failed) sv.nfc.session?.fail(`${failed.name}: ${failed.detail}`);
      else sv.nfc.session?.done('Probe finished.');
      report(r);
      setResults(r);
      setRunning(false);
      busy = false;
    });
  }, [allowed]);

  if (!allowed) return <Screen busy />;
  return (
    <Screen title="Karto Wallet diagnostics">
      {CARD_PROBE && !running && !sv.nfc.session && <Body>Hold a blank NTAG 424 DNA card to the back of the phone.</Body>}
      {CARD_PROBE && !running && sv.nfc.session && (
        <Button
          title="Hold a card"
          onPress={() => void sv.nfc.session?.open('Hold a blank NTAG 424 DNA card against the top of the back of the phone.').catch(() => {})}
        />
      )}
      {CARD_PROBE && running && <Body muted>Reading the card. Keep holding it…</Body>}
      {RECOVERY_CHECK && running && (
        <Body muted>Checking that ACINQ gives the server’s channel back. This takes up to 20 minutes: keep the app open.</Body>
      )}
      {(results ?? []).map((r) => (
        <Text key={r.name} style={[s.result, r.ok ? s.ok : s.fail]}>
          {r.ok ? '✓' : '✗'} {r.name}: {r.detail}
        </Text>
      ))}
      {/* Another recovery check is another make phone-recovery-check, never a stray tap. */}
      {!CARD_PROBE && !RECOVERY_CHECK && <Button title={running ? 'Running…' : 'Run again'} onPress={run} disabled={running} />}
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    result: { ...TYPE.body },
    ok: { color: t.ok },
    fail: { color: t.error },
  });
