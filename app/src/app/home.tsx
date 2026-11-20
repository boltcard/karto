// The wallet, once onboarding is done: banners for anything
// that needs the person, the notices, Pool and Hosting, Shop under them when there is one, and the cards as a stack, the first added at the back and the
// newest in front. ServerWatch does the work (useWatcher); Settings, behind ⚙, has the server page's other parts.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { RELEASES_PAGE } from '../appUpdate/appUpdate';
import { useAppUpdate } from '../appUpdate/useAppUpdate';
import type { WalletAccount } from '../cardd/client';
import { holdPress } from '../cards/holdPress';
import { cardsLine } from '../cards/labels';
import { availableMsat } from '../money/format';
import { shown, viewText } from '../money/view';
import { useReadCard, useWatcher } from '../services/server';
import { alertsClient, reopenAppDb, useRouteGuard, useServices } from '../services/services';
import { CANT_READ } from '../services/startRoute';
import { AlertsOffer } from '../ui/AlertsOffer';
import { useAmountView } from '../ui/amountView';
import { WalletNameAsk } from '../ui/WalletNameAsk';
import { Amount, RateAgeLine } from '../ui/money';
import { AMOUNT, TYPE, type Theme } from '../ui/theme';
import { Body, Button, Callout, ErrorText, Screen } from '../ui/ui';
import { useStyles } from '../ui/useTheme';
import { BannerView, CardFace, STACK_OVERLAP } from '../ui/wallet';
import { bannerInput } from '../wallet/bannerInput';
import { walletBanners, type Banner } from '../wallet/banners';
import { gaveUpNotice } from '../wallet/accountView';
import { payButton, removedNotice } from '../wallet/phoneCardView';
import { serverView } from '../wallet/serverView';
import { shopTile } from '../wallet/shop';
import { stackOrder, stripLabel, stripTag, type StackEntry } from '../wallet/stack';
import { askedThisRun, nameAskDue } from '../wallet/walletName';

const openAccount = (id: string) => router.push({ pathname: '/account', params: { id } });
const openHold = (op: 'finish-add' | 'wipe', id: string) => router.push({ pathname: '/card', params: { op, id, press: holdPress() } });

// A part-way card opens the hold-the-card screen at the tap sheet's own Finish setup or Finish wipe, for that card.
const openCard = (c: StackEntry) =>
  c.partWay ? openHold(c.partWay === 'add' ? 'finish-add' : 'wipe', c.id) : openAccount(c.id);

export default function Home() {
  const allowed = useRouteGuard('/home');
  const { snap, watch } = useWatcher(allowed);
  // An iPhone reads a card only after a press.
  const read = useReadCard();
  const sv = useServices();
  const s = useStyles(makeStyles);
  const look = useAmountView();
  // A newer release on GitHub, for a wallet installed from there.
  const appUpdate = useAppUpdate();
  const [, tick] = useState(0);
  // Try again's reconnect and read, while on their way.
  const [retrying, setRetrying] = useState(false);
  // The wallet's two asks, one at a time: its name first.
  const [naming, setNaming] = useState(false);
  const [alerting, setAlerting] = useState(false);

  // Updating the server · m:ss counts up: drawn again each second while the update runs.
  const updating = !!snap.update?.running;
  useEffect(() => {
    if (!updating) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [updating]);

  // The saved state couldn't be read: the page says so rather than showing what it last had, and Try again gives
  // the database a new connection if its own no longer answers, then reads again.
  if (allowed && snap.cantRead) {
    const tryAgain = () => {
      setRetrying(true);
      void sv.store
        .reconnect(reopenAppDb)
        .catch(() => {})
        .then(() => watch.readAgain())
        .catch(() => {})
        .finally(() => setRetrying(false));
    };
    return (
      <Screen title="Wallet">
        <Body>{CANT_READ}</Body>
        <Button title={retrying ? 'Trying again…' : 'Try again'} onPress={tryAgain} disabled={retrying} />
      </Screen>
    );
  }
  const nowMs = Date.now();
  const view = serverView(snap, nowMs);
  if (!allowed || !view) return <Screen busy />;

  // Each banner opens where it is dealt with; the unreachable one also checks again at once, as Check again did.
  const openBanner = (b: Banner) => {
    if (b.checkAgain) void watch.checkAgain();
    const t = b.target;
    if (t?.kind === 'page') router.push(t.to);
    else if (t?.kind === 'pay-lnvps') router.push('/pay-lnvps');
    else if (t?.kind === 'hosting') openAccount('hosting');
    else if (t?.kind === 'nfc-settings') sv.nfc.openSettings();
    else if (t?.kind === 'github-releases') void Linking.openURL(RELEASES_PAGE).catch(() => {});
  };

  const banners = walletBanners({ ...bannerInput(snap, view, nowMs), appUpdate });
  // The red unreachable banner already says the server can't be reached: the cards' line doesn't say it again.
  const listLine = cardsLine(snap.cardsError, banners.some((b) => b.key === 'unreachable'));
  // The band: the wallet's title and, at its end, Settings.
  const gear = (
    <Pressable accessibilityRole="button" accessibilityLabel="Settings" hitSlop={12} onPress={() => router.push('/settings')} style={({ pressed }) => pressed && layout.pressed}>
      {/* U+FE0E: the gear as text, not Android's emoji. */}
      <Text style={s.gear}>{'⚙︎'}</Text>
    </Pressable>
  );
  const bannerViews = banners.map((b) => <BannerView key={b.key} banner={b} onPress={() => openBanner(b)} />);
  // A server that may not be the person's: none of its money, as the server page showed only the warning.
  if (view.keyNotice.kind === 'mismatch') {
    return (
      <Screen title="Wallet" right={gear}>
        {bannerViews}
      </Screen>
    );
  }

  const { wallet, cards } = snap;
  // From cardd's list, or the phone's cache while cardd can't be reached (name and state, no balance).
  // The phone as a card: its card in the sleeve, the button that
  // pays with it, and the notice of another phone's card that the wallet removed.
  const pc = snap.phoneCard;
  const stack = stackOrder(cards ?? [], wallet, snap.state!.host!.hostname, { ids: new Set(pc.ids), own: pc.own });
  const pay = payButton({
    supported: pc.supported,
    revoked: !!snap.backups?.revoked || snap.status?.kind === 'not_paired',
    removing: !!pc.record?.removing,
    nfc: snap.nfc,
    own: stack.find((c) => c.phone === 'own'),
  });
  const removed = removedNotice(pc.removed, pc.supported && !pc.record, look.view, look.rated);
  // The cards given up on their pages (account.tsx), until read.
  const gaveUp = gaveUpNotice(snap.gaveUp, look.view, look.rated);
  const shop = shopTile(wallet, snap.salesToday, snap.hadShop);
  return (
    // The wallet's name after Wallet, once it has one.
    <Screen title="Wallet" titleAfter={wallet?.name || undefined} right={gear}>
      {bannerViews}
      <RateAgeLine />
      {snap.notices.map((n) => (
        <Body key={n} muted>
          {n}
        </Body>
      ))}
      {removed && (
        <Callout>
          <Body>{removed.text}</Body>
          {removed.add && <Body>{removed.add}</Body>}
          <Button title="OK" kind="secondary" onPress={() => void watch.dismissRemovedPhoneCards().catch(() => {})} />
        </Callout>
      )}
      {gaveUp.length > 0 && (
        <Callout>
          {gaveUp.map((line, i) => (
            <Body key={i}>{line}</Body>
          ))}
          <Button title="OK" kind="secondary" onPress={() => watch.dismissGaveUp()} />
        </Callout>
      )}
      <View style={layout.tiles}>
        <Tile name="Pool" account={wallet?.pool} onPress={() => openAccount('pool')} />
        <Tile name="Hosting" account={wallet?.hosting} onPress={() => openAccount('hosting')} />
      </View>
      {shop && (
        <View style={layout.tiles}>
          <ShopTile tile={shop} disabled={!wallet?.shop} onPress={() => openAccount('shop')} />
        </View>
      )}
      {listLine && (listLine.muted ? <Body muted>{listLine.text}</Body> : <ErrorText>{listLine.text}</ErrorText>)}
      {cards === null && !snap.cardsError && <Body muted>Loading your cards…</Body>}
      {cards !== null && stack.length === 0 && <Button title="Add your first card" onPress={() => router.push('/card-add')} disabled={view.moneyOff} />}
      {stack.length > 0 && (
        <View>
          {stack.map((c, i) => {
            const tag = stripTag(c);
            return (
              <Pressable
                key={c.id}
                accessibilityRole="button"
                accessibilityLabel={stripLabel(c)}
                onPress={() => openCard(c)}
                // A card the wallet doesn't list (the server is down) has no page to open.
                disabled={!c.partWay && c.availableMsat === null}
                style={({ pressed }) => [i > 0 && layout.under, pressed && layout.pressed]}
              >
                <CardFace
                  name={c.name}
                  colour={c.colour}
                  balance={c.availableMsat === null ? undefined : viewText(c.availableMsat, look.view, look.rated)}
                  // The cards behind are strips; the newest, in front, stands whole in the sleeve.
                  stack={i === stack.length - 1 ? 'front' : 'behind'}
                  dim={c.state === 'frozen'}
                  ring={c.repoint || c.check}
                  tag={tag?.text}
                  tone={tag?.tone}
                  // A phone has no photo.
                  photo={c.phone ? undefined : snap.photos[c.id]}
                  phone={!!c.phone}
                />
              </Pressable>
            );
          })}
        </View>
      )}
      {pay && <Button title="Pay with this phone" onPress={() => router.push('/pay')} disabled={pay.off} />}
      {pay?.line && <Body muted>{pay.line}</Body>}
      {stack.length > 0 && <Button title="+ Add card" kind="secondary" onPress={() => router.push('/card-add')} disabled={view.moneyOff} />}
      {read ? (
        <>
          <Button title="Read a card" kind="secondary" onPress={read.press} disabled={!read.on} />
          <Body muted>See what a card is, or check one of yours.</Body>
        </>
      ) : (
        <Body muted>Hold any card to the back of the phone to see what it is.</Body>
      )}
      {/* The wallet's name, once per start while it has none, then the one offer of alerts: after
          setup, or once after the update that brought them. The offer waits for the wallet's answer, and for the name. */}
      <WalletNameAsk
        host={snap.state!.host!.hostname}
        wallet={snap.wallet}
        hold={alerting}
        onOpen={setNaming}
        save={(n) => alertsClient(sv, snap.state!.host!.hostname).setWalletName(n)}
      />
      <AlertsOffer
        host={snap.state!.host!.hostname}
        hold={naming || snap.wallet === null || nameAskDue(snap.wallet, snap.state!.host!.hostname, askedThisRun)}
        onOpen={setAlerting}
      />
    </Screen>
  );
}

/**
 * Pool or Hosting: its available balance as an Amount, the other figure under it ("…" until the wallet answers). The
 * tile opens the account's page; a tap on the figure moves every amount to the next view (rule 1). Its label says
 * the figure, so a screen reader hears it too.
 */
function Tile({ name, account, onPress }: { name: string; account: WalletAccount | undefined; onPress: () => void }) {
  const s = useStyles(makeStyles);
  const look = useAmountView();
  const msat = account ? availableMsat(account) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={msat === null ? name : `${name}, ${shown(msat, look.view, look.rated).spoken}`}
      onPress={onPress}
      disabled={!account}
      style={({ pressed }) => [s.tile, pressed && layout.pressed]}
    >
      <Text style={s.tileName}>{name}</Text>
      {msat === null ? <Text style={s.tileBalance}>…</Text> : <Amount msat={msat} size="mid" alt />}
    </Pressable>
  );
}

/** Shop, across both columns: what is available ("…" while the wallet can't be read), and today's sales at its right; it opens Shop's page. */
function ShopTile({ tile, disabled, onPress }: { tile: { balanceMsat: number | null; line: string }; disabled: boolean; onPress: () => void }) {
  const s = useStyles(makeStyles);
  const look = useAmountView();
  const msat = tile.balanceMsat;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={msat === null ? 'Shop' : `Shop, ${shown(msat, look.view, look.rated).spoken}`}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [s.tile, layout.wide, pressed && layout.pressed]}
    >
      <View style={layout.wideText}>
        <Text style={s.tileName}>Shop</Text>
        {msat === null ? <Text style={s.tileBalance}>…</Text> : <Amount msat={msat} size="mid" alt />}
      </View>
      {tile.line !== '' && <Text style={s.tileName}>{tile.line}</Text>}
    </Pressable>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    gear: { ...TYPE.title, fontSize: 26, color: t.headerMuted },
    tile: { flex: 1, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 12, gap: 4 },
    tileName: { ...TYPE.body, color: t.muted },
    tileBalance: { ...TYPE.heading, fontSize: 20, color: t.text, ...AMOUNT },
  });

const layout = StyleSheet.create({
  pressed: { opacity: 0.7 },
  tiles: { flexDirection: 'row', gap: 12 },
  // The wide tile: its name over its balance at the left, today's sales at the right on the balance's line.
  wide: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  wideText: { gap: 4, flexShrink: 1 },
  // Each card after the first sits over the foot of the one behind it.
  under: { marginTop: -STACK_OVERLAP },
});
