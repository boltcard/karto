// An account's page: the balance first, beside a
// small card for a card's page, which shows its photo large when tapped; the pill buttons; a card's limits as rows and its tap check; hosting's server
// panel; then the history by day. A card's More is ⋯ in the band; Top up, More, Limits and Renew now are sheets.
// It follows money as it arrives: its wallet and its
// history are each a read the server holds until there is something new, so the balance and the new row show as
// the books have them, and an open Top up sheet says Received. The wallet's read tells the watch whether cardd
// answered, for the wallet's banner and the money buttons.
// Shop's page is Pool's shape: Move and PoS phones, the line that says why some sales
// will read +0, and day headings that carry the day's sales.
// A card held to the phone opens its page with the tap check's result, shown until the person leaves the page
//.
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { revBehind, type SaleDay, type Tx, type Wallet, type WalletAccount, type WalletCard } from '../cardd/client';
import { feeCreditText, tapCheckText } from '../cards/labels';
import { HELD_IDLE_MS, heldLoop } from '../cards/poll';
import { availableMsat, heldLine, historyRows, moneyError } from '../money/format';
import { hostingSyncer } from '../money/hosting';
import { openedLine } from '../money/openedLine';
import { removePhoneCard } from '../phoneCard/setup';
import { useCardDeps, useServer, useTapCheck } from '../services/server';
import { phoneCardDeps, useRouteGuard, useServices } from '../services/services';
import { useAmountView } from '../ui/amountView';
import { HostingPanel, useHostingStatus } from '../ui/HostingPanel';
import { LimitsSheet } from '../ui/LimitsSheet';
import { screenLock } from '../ui/lock';
import { AccountHeader, HistoryList, PillButton, Pills, RateAgeLine, ReadBack } from '../ui/money';
import { MoreSheet, PhoneMoreSheet } from '../ui/MoreSheet';
import { RenewSheet } from '../ui/RenewSheet';
import { TopUpSheet } from '../ui/TopUpSheet';
import { BandMenu, Body, Button, ErrorText, goBack, GroupLabel, Panel, Screen } from '../ui/ui';
import { CardPhotoView, SmallCard } from '../ui/wallet';
import { accountButtons, accountId, fixedName, type AccountAction, type AccountKind } from '../wallet/account';
import { cardLimits, headerNote, hostingCard, moreRows } from '../wallet/accountView';
import { moneyOff } from '../wallet/banners';
import { colourOf } from '../wallet/colours';
import { historyAsk, walletAsk } from '../wallet/follow';
import { phoneCardError, phoneMoreRows } from '../wallet/phoneCardView';
import { capacityLine } from '../wallet/shop';
import { newestId, received, receivedWords } from '../wallet/topUp';

const PAGE = 50;
/** The days Shop's headings may carry sales for: as many as cardd counts in one answer. */
const SALE_DAYS = 90;

export default function Account() {
  const allowed = useRouteGuard('/account');
  const sv = useServices();
  const deps = useCardDeps();
  const { snap, watch } = useServer();
  const params = useLocalSearchParams<{ id?: string }>();
  const [id] = useState(() => accountId(params.id));
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [txs, setTxs] = useState<Tx[]>([]);
  /** The history has answered: until then the list shown is no history at all. */
  const [loaded, setLoaded] = useState(false);
  // What the page shows, as an ask under way sees it now: a render's own values are a moment old to it.
  const shown = useRef<{ wallet: Wallet | null; txs: Tx[]; loaded: boolean }>({ wallet: null, txs: [], loaded: false });
  /** The two held loops while the page is in front, for a load of the page's own to kick: there is something to ask past. */
  const loops = useRef<{ wallet: { kick(): void }; history: { kick(): void } } | null>(null);
  const front = useRef(false);
  /** The open Top up sheet's baseline: the history's newest id and the wallet's rev as they were when it opened (id null until the history has answered). */
  // channel: whether the server had a Lightning channel when the Top up sheet opened (null: not known), for the Received words.
  const [base, setBase] = useState<{ id: number | null; rev: string | undefined; channel: boolean | null } | null>(null);
  const showWallet = useCallback(
    (w: Wallet) => {
      shown.current.wallet = w;
      setWallet(w);
      // The watch takes it too, so the rate every screen converts at stays fresh while this page is in front.
      if (deps) watch.seenWallet(deps, w);
    },
    [deps, watch],
  );
  const showTxs = useCallback((next: Tx[]) => {
    shown.current = { ...shown.current, txs: next, loaded: true };
    setTxs(next);
    setLoaded(true);
  }, []);
  const [saleDays, setSaleDays] = useState<SaleDay[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'top-up' | 'more' | 'limits' | 'renew' | 'photo' | null>(null);
  const tapCheck = useTapCheck(id);
  const hosting = useHostingStatus(deps, id === 'hosting');
  const look = useAmountView();

  // Each answer, or the failure to get one, tells the watch whether cardd can be reached (the wallet's refresh is stopped here).
  const loadWallet = useCallback(async () => {
    if (!deps) return;
    try {
      const w = await deps.cardd.wallet();
      // Not one behind the wallet shown: a held read brought a newer one while this was on its way.
      if (!revBehind(w.rev, shown.current.wallet?.rev)) showWallet(w);
      watch.reportRefresh({ ok: true });
      loops.current?.wallet.kick();
    } catch (error) {
      watch.reportRefresh({ ok: false, error });
      throw error;
    }
  }, [deps, watch, showWallet]);
  // The newest page; older ones are loaded by "Load more" and kept until the
  // screen opens again or an action changes the history.
  const loadHistory = useCallback(async () => {
    if (!deps || !id) return;
    // After a note's save on its way from the payment page just left: read before it, the row would show the old note.
    await openedLine.settled();
    // Shop's sales by day, for its headings, read once with the first page: without them (the read failed), and for a
    // day older than the newest SALE_DAYS that Load more reaches, the headings are plain.
    const [page, days] = await Promise.all([
      deps.cardd.history(id, { limit: PAGE }),
      id === 'shop' ? deps.cardd.salesDays(-new Date().getTimezoneOffset(), SALE_DAYS).catch(() => []) : [],
    ]);
    showTxs(page);
    setSaleDays(days);
    setMore(page.length === PAGE);
    loops.current?.history.kick();
  }, [deps, id, showTxs]);
  const reload = useCallback(() => {
    if (!id) return;
    Promise.all([loadWallet(), loadHistory()]).then(() => setError(null), (e) => setError(moneyError(e)));
  }, [id, loadWallet, loadHistory]);

  // While the screen shows: the wallet and the history, each read at once and then held by the server until there
  // is something new (a server from before: the wallet every 5 seconds, as it was, and the history with it).
  useFocusEffect(
    useCallback(() => {
      front.current = true;
      reload();
      if (!deps || !id) return () => void (front.current = false);
      const active = () => AppState.currentState === 'active';
      // Each starts when the page's own load has answered and kicks it, or 5 seconds on.
      const wallets = heldLoop({
        ask: walletAsk({ cardd: deps.cardd, shown: () => shown.current.wallet, show: showWallet, report: (r) => watch.reportRefresh(r), live: () => front.current && active() }),
        active,
        startIn: HELD_IDLE_MS,
      });
      const histories = heldLoop({
        ask: historyAsk({
          cardd: deps.cardd,
          id,
          page: PAGE,
          shown: () => shown.current,
          show: (next, o) => {
            showTxs(next);
            if (o.startedOver) setMore(true);
            // Shop's day headings count the day's sales: read again when one came.
            if (o.sale && id === 'shop') void deps.cardd.salesDays(-new Date().getTimezoneOffset(), SALE_DAYS).then(setSaleDays, () => {});
          },
        }),
        active,
        startIn: HELD_IDLE_MS,
      });
      loops.current = { wallet: wallets, history: histories };
      // Back in front (the person paid from another app on this phone and came back): both ask at once, not at
      // their next look 5 seconds on.
      const sub = AppState.addEventListener('change', (s) => {
        if (s !== 'active') return;
        wallets.kick();
        histories.kick();
      });
      return () => {
        front.current = false;
        loops.current = null;
        sub.remove();
        wallets.stop();
        histories.stop();
      };
    }, [reload, deps, id, watch, showWallet, showTxs]),
  );

  // The Top up sheet. Opened before the history has answered, it compares against the first answer
  // that comes: nothing in that answer counts as received.
  useEffect(() => {
    if (sheet === 'top-up' && base && base.id === null && loaded) setBase({ ...base, id: newestId(txs) });
  }, [sheet, base, loaded, txs]);
  // A card that can no longer receive while its sheet is open (a wipe begun on another phone) closes the sheet:
  // money sent to its address after that goes to Pool.
  const listed = wallet?.cards.find((c) => c.id === id);
  const cantReceive = id !== '' && fixedName(id) === null && wallet !== null && !(listed && (listed.state === 'active' || listed.state === 'frozen'));
  useEffect(() => {
    if (sheet === 'top-up' && cantReceive) setSheet(null);
  }, [sheet, cantReceive]);

  const loadMore = async () => {
    if (!deps || txs.length === 0) return;
    try {
      const before = txs[txs.length - 1].id;
      const page = await deps.cardd.history(id, { before, limit: PAGE });
      // The list started over while this was read (a whole page of newer rows came): the page no longer joins it.
      if (shown.current.txs.at(-1)?.id !== before) return;
      // Under what is shown now: a newer row may have been put on top meanwhile.
      showTxs([...shown.current.txs, ...page]);
      setMore(page.length === PAGE);
    } catch (e) {
      setError(moneyError(e));
    }
  };

  if (!allowed || !deps) return <Screen busy />;
  const isCard = id !== '' && fixedName(id) === null;
  const card: WalletCard | undefined = wallet?.cards.find((c) => c.id === id);
  // The band's name and the small card before the wallet answers: the phone's cache of the cards, which the wallet's stack draws too.
  const named = card ?? snap.cards?.find((c) => c.id === id);
  const acct: WalletAccount | undefined = card ?? (id === 'pool' ? wallet?.pool : id === 'hosting' ? wallet?.hosting : id === 'shop' ? wallet?.shop : undefined);
  // A link's id that is no account: none at all, a card the wallet, once it answered, doesn't list (a wiped one), or Shop on a server from before it.
  const missing = id === '' || (wallet !== null && !acct);
  // The watch's flag: cardd can't be reached and no Update server is running.
  const off = moneyOff({ unreachable: snap.unreachable, updating: snap.update?.running ? snap.update : null });
  const name = fixedName(id) ?? (named?.name || 'Unnamed card');
  const nowS = Date.now() / 1000;
  // The top-up an open Top up sheet says Received for: one newer than the history was when it opened.
  const got = sheet === 'top-up' && base ? received(txs, base.id) : null;

  if (missing) {
    return (
      <Screen back>
        <Body>There is no such account.</Body>
      </Screen>
    );
  }

  const act = (fn: () => Promise<unknown>) => () => {
    fn().then(reload, (e) => setError(moneyError(e)));
  };
  // A phone that is a card: this phone's own pays from here too.
  const phone = id === snap.phoneCard.own ? 'own' : snap.phoneCard.ids.includes(id) ? 'other' : null;
  // Remove this phone's card: behind the screen lock, as a wipe is; nothing is held to the phone.
  const removePhone = async () => {
    setSheet(null);
    const refused = await screenLock("Remove this phone's card", "removing this phone's card");
    if (refused !== null) return setError(refused);
    try {
      await removePhoneCard(phoneCardDeps(sv, deps));
    } catch (e) {
      // A removal that stopped is finished by the wallet once it can be: the list says how it stands.
      setError(phoneCardError(e));
      return void watch.reloadCards().catch(() => {});
    }
    await watch.reloadCards().catch(() => {});
    goBack();
  };
  const press = (a: AccountAction) => {
    if (a === 'top-up') {
      setBase({ id: shown.current.loaded ? newestId(shown.current.txs) : null, rev: shown.current.wallet?.rev, channel: shown.current.wallet?.liquidity?.channel ?? null });
      setSheet(a);
    } else if (a === 'renew') setSheet(a);
    else if (a === 'pay') router.push('/pay');
    else if (a === 'move') router.push({ pathname: '/move', params: { from: id } });
    else if (a === 'send') router.push('/send');
    else if (a === 'pay-lnvps') router.push('/pay-lnvps');
    else if (a === 'pos-phones') router.push('/pos-phones');
    else if (card) act(() => (a === 'freeze' ? deps.cardd.freezeCard(card.id) : deps.cardd.unfreezeCard(card.id)))();
  };
  const kind: AccountKind = card ? { kind: 'card', state: card.state, ownPhone: phone === 'own', nfcOff: snap.nfc === 'off' } : id === 'pool' ? { kind: 'pool' } : id === 'shop' ? { kind: 'shop' } : { kind: 'hosting' };
  const capacity = id === 'shop' ? capacityLine(wallet?.liquidity ?? null, look.view, look.rated) : '';
  const feeCredit = feeCreditText(wallet?.liquidity?.feeCreditSat ?? 0, look.view, look.rated);
  // A phone has no photo.
  const photo = phone ? undefined : snap.photos[id];

  return (
    // The account's name in the band: the card's (from the cache until the wallet answers), Pool, Hosting or Shop.
    <Screen title={name} back right={card ? <BandMenu onPress={() => setSheet('more')} /> : undefined}>
      {error && <ErrorText>{error}</ErrorText>}
      <RateAgeLine />
      <AccountHeader
        card={
          isCard ? (
            <SmallCard
              name={name}
              colour={colourOf(snap.cards ?? [], id)}
              photo={photo}
              dim={named?.state === 'frozen'}
              onPress={photo ? () => setSheet('photo') : undefined}
            />
          ) : undefined
        }
        msat={acct ? availableMsat(acct) : null}
        note={card ? headerNote(card.state, phone) : null}
        held={acct ? heldLine(acct.heldMsat, look.view, look.rated) : ''}
      />
      {id === 'pool' && feeCredit !== '' && <Body muted>{feeCredit}</Body>}
      {acct && (
        <Pills>
          {accountButtons(kind, off).map((b) => (
            <PillButton key={b.action} icon={b.icon} label={b.label} disabled={b.off} main={b.main} onPress={() => press(b.action)} />
          ))}
        </Pills>
      )}
      {capacity !== '' && (
        <Panel tone="warn">
          <Body>{capacity}</Body>
        </Panel>
      )}
      {card && <ReadBack rows={cardLimits(card, look.view, look.rated)} />}
      {card?.state === 'frozen' && <Body>Frozen: can&apos;t pay; still takes top-ups.</Body>}
      {card && tapCheck && (tapCheck.ok ? <Body>{tapCheckText(tapCheck)}</Body> : <ErrorText>{tapCheckText(tapCheck)}</ErrorText>)}
      {id === 'hosting' && <HostingPanel card={hostingCard(hosting.status, hostingSyncer.lnvpsExpires, nowS)} />}

      <GroupLabel>History</GroupLabel>
      {txs.length === 0 ? (
        <Body muted>Nothing yet.</Body>
      ) : (
        <HistoryList
          days={historyRows(txs, nowS, -new Date().getTimezoneOffset(), { cards: wallet?.cards ?? snap.cards ?? [], days: saleDays, view: look.view, rated: look.rated })}
          // A line's own page: the line goes with it, so the page draws it before its details come.
          onOpen={(txId) => {
            const tx = txs.find((x) => x.id === txId);
            if (!tx || !id) return;
            openedLine.put(id, tx);
            router.push({ pathname: '/payment', params: { account: id, tx: String(txId) } });
          }}
        />
      )}
      {more && <Button title="Load more" kind="secondary" onPress={loadMore} />}

      {sheet === 'top-up' && acct && (
        <TopUpSheet
          name={name}
          address={acct.address}
          liquidity={wallet!.liquidity}
          received={got && receivedWords(got, { name, nowS, offsetMin: -new Date().getTimezoneOffset(), availableMsat: wallet?.rev && wallet.rev !== base?.rev ? availableMsat(acct) : null, channelBefore: base?.channel ?? null, view: look.view, rated: look.rated })}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'photo' && photo && <CardPhotoView photo={photo} onClose={() => setSheet(null)} />}
      {sheet === 'more' && card && !phone && (
        <MoreSheet card={card} rows={moreRows(card, !!photo, look.view, look.rated)} off={off} onLimits={() => setSheet('limits')} onClose={() => setSheet(null)} />
      )}
      {sheet === 'more' && card && phone && (
        <PhoneMoreSheet
          card={card}
          rows={phoneMoreRows(card, phone === 'own', look.view, look.rated)}
          off={off}
          onLimits={() => setSheet('limits')}
          onRemove={() => void removePhone()}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'limits' && card && (
        <LimitsSheet
          card={card}
          cardd={deps.cardd}
          off={off}
          onSaved={() => {
            setSheet(null);
            reload();
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'renew' && acct && (
        <RenewSheet deps={deps} status={hosting.status} load={hosting.load} availableMsat={availableMsat(acct)} onChanged={reload} off={off} onClose={() => setSheet(null)} />
      )}
    </Screen>
  );
}
