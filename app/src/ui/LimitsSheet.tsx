// A card's limits, edited in a sheet from More:
// per payment and per 24 hours, in whole sats or, with the server's currency and a rate, in it:
// cardd then keeps them in the currency and converts them at each tap.
// The sheet says the card's limits in their own unit and opens in it when it is the server's; a card limited in a
// currency that is no longer the server's is said in it, and changed in sat or the server's currency.
// What is typed keeps its unit: the fields empty themselves when the rate goes under them, as Send out's do.
// Raising either limit asks for the screen lock first: a higher limit lets the card spend more at a till. Lowering
// them asks for none.
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { CarddClient, LimitsRequest, WalletCard } from '../cardd/client';
import { currencyOf, fiatInput, isCode, minorInputText, symbol } from '../money/fiat';
import { convertTyped, limitsNow, limitsProblem, limitsRaise, limitsText, moneyError, satInput, thousands } from '../money/format';
import { viewText } from '../money/view';
import { useAmountView } from './amountView';
import { screenLock } from './lock';
import { UnitChip } from './money';
import { Body, Button, ErrorText, Field, Label, Row, Sheet, Title } from './ui';

/** off: cardd can't be reached; onSaved: the limits were set (close, and load the page again). */
export function LimitsSheet({ card, cardd, off, onSaved, onClose }: {
  card: Pick<WalletCard, 'id' | 'perTapSat' | 'dailySat' | 'spent24hMsat' | 'limits'>; cardd: Pick<CarddClient, 'setLimits'>; off: boolean; onSaved: () => void; onClose: () => void;
}) {
  const look = useAmountView();
  const { rated } = look;
  const own = card.limits;
  const [unit, setUnit] = useState<'fiat' | 'sat'>(() => (rated && own?.currency === rated.currency ? 'fiat' : 'sat'));
  // The rate the fields are typed at: none while they are in sat.
  const r = unit === 'fiat' ? rated : null;
  const [perTap, setPerTap] = useState(() => (r && own ? minorInputText(own.perTapMinor, own.currency) : String(card.perTapSat)));
  const [daily, setDaily] = useState(() => (r && own ? minorInputText(own.dailyMinor, own.currency) : String(card.dailySat)));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Still the server's currency while cardd has no rate for a moment; changed in it only with one.
  const code = look.fiat?.currency;
  const now = limitsNow(card, code && isCode(code) ? code : null, rated?.currency ?? null);
  const unitWord = r ? symbol(r.currency).trim() : 'sat';
  const keyboard = r && currencyOf(r.currency).decimals > 0 ? 'decimal-pad' : 'number-pad';
  // cardd's own words when it is asked for limits in a currency it has no rate for.
  const noRate = code && isCode(code) && !rated ? `No ${symbol(code).trim()} rate yet: set the limits in sat.` : null;

  // The unit what is in the fields was typed in, or the chip turned it into: a currency, or sat. When it changes
  // under them (the rate goes, or the server's currency changes), they are emptied rather than read in the new unit:
  // "20" typed in £ would be saved as 20 sat. The sheet stays in sat when a rate comes back, so sats typed meanwhile
  // aren't saved as £.
  const typedIn = r ? r.currency : 'sat';
  const fieldsUnit = useRef(typedIn);
  useEffect(() => {
    if (fieldsUnit.current === typedIn) return;
    fieldsUnit.current = typedIn;
    if (!rated) setUnit('sat');
    setPerTap('');
    setDaily('');
  }, [typedIn, rated]);

  const flip = () => {
    if (!rated) return;
    const to = unit === 'fiat' ? 'sat' : 'fiat';
    // The chip's own change: what is typed is turned into the new unit, not emptied.
    fieldsUnit.current = to === 'fiat' ? rated.currency : 'sat';
    setUnit(to);
    setPerTap(convertTyped(perTap, to, rated));
    setDaily(convertTyped(daily, to, rated));
    setError(null);
  };

  const save = async () => {
    let limits: LimitsRequest;
    if (r) {
      const perTapMinor = fiatInput(perTap, r.currency) ?? 0;
      const dailyMinor = fiatInput(daily, r.currency) ?? 0;
      const problem = limitsProblem(perTapMinor, dailyMinor, r);
      if (problem) return setError(problem);
      limits = { currency: r.currency, perTapMinor, dailyMinor };
    } else {
      const perTapSat = (satInput(perTap) ?? 0) / 1000;
      const dailySat = (satInput(daily) ?? 0) / 1000;
      const problem = limitsProblem(perTapSat, dailySat);
      if (problem) return setError(problem);
      limits = { perTapSat, dailySat };
    }
    setSaving(true);
    setError(null);
    try {
      if (limitsRaise(card, limits, rated)) {
        const why = await screenLock(`Raise limits to ${limitsText(limits)}`, "raising a card's limits");
        if (why) {
          setError(why);
          return setSaving(false);
        }
      }
      await cardd.setLimits(card.id, limits);
      onSaved();
    } catch (e) {
      setError(moneyError(e));
      setSaving(false);
    }
  };

  return (
    <Sheet visible onClose={onClose}>
      <Title>Limits</Title>
      <Body muted>{now.line}</Body>
      {now.note && <Body muted>{now.note}</Body>}
      {noRate && <Body muted>{noRate}</Body>}
      {rated && (
        <View style={layout.chip}>
          <UnitChip unit={unit} currency={rated.currency} onPress={flip} />
        </View>
      )}
      <Label>{`Per payment (${unitWord})`}</Label>
      <Field value={perTap} onChangeText={setPerTap} keyboardType={keyboard} />
      <Label>{`Per 24 hours (${unitWord})`}</Label>
      <Field value={daily} onChangeText={setDaily} keyboardType={keyboard} />
      <Body muted>{`${viewText(card.spent24hMsat, look.view, rated)} spent in the last 24 hours.`}</Body>
      {error && <ErrorText>{error}</ErrorText>}
      <Row>
        <Button title="Cancel" kind="secondary" onPress={onClose} />
        <Button title="Save limits" onPress={save} disabled={off || saving} />
      </Row>
    </Sheet>
  );
}

const layout = StyleSheet.create({
  // The chip at its own width, at the start of the line.
  chip: { flexDirection: 'row' },
});
