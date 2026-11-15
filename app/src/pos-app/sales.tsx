// Sales: today's count and total, then this till's paid sales by day, 50 at a time and
// more as the list is scrolled; pulling down reads again. Prices only: a till never sees Shop's balance. A sale rung
// up in the shop's currency shows its price with its sats under it; one typed in sats its value now.
// pos/salesView.ts has the words.
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { isRevoked } from '../cardd/error';
import { usePos } from '../pos/app';
import { rated } from '../money/fiat';
import type { PosDay, PosSale } from '../pos/client';
import { salesDays, salesHead, type SaleRow } from '../pos/salesView';
import { Icon } from '../ui/icons';
import { AMOUNT, TYPE, type Theme } from '../ui/theme';
import { ErrorText, ListGroup, ListRow, Screen } from '../ui/ui';
import { useStyles, useTheme } from '../ui/useTheme';

const PAGE = 50;
/** The days whose headings may carry a count: as many as the shop counts in one answer. */
const DAYS = 90;

type Item = { kind: 'day'; day: string } | { kind: 'sale'; row: SaleRow };

export default function Sales() {
  const pos = usePos();
  // The calls alone: the rest of what the screens share changes with every sale, and the lists aren't read again for that.
  const ask = pos.ask;
  const t = useTheme();
  const s = useStyles(makeStyles);
  const [sales, setSales] = useState<PosSale[]>([]);
  const [days, setDays] = useState<PosDay[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const offsetMin = -new Date().getTimezoneOffset();

  const failed = (e: unknown) => void (isRevoked(e) || setError("Can't reach the shop's server."));
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [page, counted] = await Promise.all([ask((c) => c.sales({ limit: PAGE })), ask((c) => c.days(-new Date().getTimezoneOffset(), DAYS))]);
      setSales(page);
      setDays(counted);
      setMore(page.length === PAGE);
      setError(null);
    } catch (e) {
      failed(e);
    } finally {
      setLoading(false);
    }
  }, [ask]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const loadMore = async () => {
    const last = sales.at(-1)?.txId;
    if (!more || busy.current || !last) return;
    busy.current = true;
    try {
      const page = await ask((c) => c.sales({ before: last, limit: PAGE }));
      setSales((had) => [...had, ...page]);
      setMore(page.length === PAGE);
    } catch (e) {
      failed(e);
    } finally {
      busy.current = false;
    }
  };

  // A link can open this screen on a phone that isn't paired.
  if (pos.paired === null) return <Redirect href="/pair" />;
  const nowS = Date.now() / 1000;
  const head = salesHead(days, nowS, offsetMin, sales);
  const items: Item[] = salesDays(sales, days, nowS, offsetMin, rated(pos.fiat)).flatMap((d) => [{ kind: 'day', day: d.day } as Item, ...d.rows.map((row) => ({ kind: 'sale', row }) as Item)]);
  return (
    <Screen title="Sales" back fill>
      <FlatList
        data={items}
        keyExtractor={(item, i) => (item.kind === 'day' ? `day-${i}-${item.day}` : item.row.id)}
        contentContainerStyle={layout.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={t.muted} />}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View style={layout.head}>
            {error && <ErrorText>{error}</ErrorText>}
            <View style={s.today} accessible accessibilityLabel={[head.title, head.total].filter(Boolean).join(', ')}>
              <Text style={s.todayTitle}>{head.title}</Text>
              {head.total !== '' && <Text style={s.todayTotal}>{head.total}</Text>}
            </View>
          </View>
        }
        renderItem={({ item }) =>
          item.kind === 'day' ? (
            <Text style={s.day} accessibilityRole="header">
              {item.day}
            </Text>
          ) : (
            <View accessible accessibilityRole="text" accessibilityLabel={item.row.label} style={s.entry}>
              <View style={s.entryIcon}>
                <Icon name="sale" colour={t.muted} size={18} />
              </View>
              <View style={layout.entryBody}>
                <View style={layout.nameRow}>
                  <Text style={s.entryName}>{item.row.name}</Text>
                  {/* Refunded from Karto Wallet: the tag, and the amount struck through. */}
                  {item.row.refunded && <Text style={s.tag}>Refunded</Text>}
                </View>
                <Text style={s.entryLine}>{item.row.line}</Text>
              </View>
              <View style={layout.entryEnd}>
                <Text style={[s.amount, item.row.refunded && s.struck]}>{item.row.amount}</Text>
                {item.row.under !== null && <Text style={s.under}>{item.row.under}</Text>}
              </View>
            </View>
          )
        }
        ListFooterComponent={
          <View style={layout.foot}>
            <ListGroup>
              <ListRow icon="phone" name="This PoS" onPress={() => router.push('/this-pos')} />
            </ListGroup>
          </View>
        }
      />
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    today: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 14 },
    todayTitle: { ...TYPE.body, fontWeight: '600', color: t.text, flexShrink: 1 },
    todayTotal: { ...TYPE.title, fontSize: 20, lineHeight: 26, color: t.text, ...AMOUNT },
    day: { ...TYPE.small, fontSize: 12, lineHeight: 16, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase', color: t.muted, paddingTop: 14, paddingBottom: 4 },
    entry: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, minHeight: 52, borderTopWidth: 1, borderTopColor: t.line },
    entryIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: t.surface, alignItems: 'center', justifyContent: 'center' },
    entryName: { ...TYPE.body, fontWeight: '600', color: t.text },
    tag: { ...TYPE.small, fontSize: 12, lineHeight: 16, fontWeight: '600', color: t.muted, borderWidth: 1, borderColor: t.line, borderRadius: 999, paddingHorizontal: 8 },
    struck: { textDecorationLine: 'line-through', color: t.muted },
    entryLine: { ...TYPE.small, color: t.muted },
    amount: { ...TYPE.body, fontWeight: '600', color: t.ok, textAlign: 'right', ...AMOUNT },
    under: { ...TYPE.small, color: t.muted, textAlign: 'right', ...AMOUNT },
  });

const layout = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32 },
  head: { gap: 10 },
  entryBody: { flex: 1, gap: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  entryEnd: { alignItems: 'flex-end' },
  foot: { paddingTop: 20 },
});
