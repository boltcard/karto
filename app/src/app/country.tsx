// Step 2: the country, defaulting from the phone's
// region, as rows with each country's VAT at the end.
import { getLocales } from 'expo-localization';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { countryRows, defaultCountry } from '../onboarding/countries';
import { continueLabel, expectedVat, vatLabel } from '../onboarding/vat';
import { chooseCountry } from '../onboarding/runner';
import { useRouteGuard, useServices } from '../services/services';
import { SearchField } from '../ui/setup';
import { Body, Button, ListGroup, ListRow, Screen, Small } from '../ui/ui';

export default function Country() {
  const allowed = useRouteGuard('/country');
  const sv = useServices();
  // null until the saved country has been read: the list starts with the chosen one, so it is drawn once that is known.
  const [chosen, setChosen] = useState<string | undefined | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sv.store
      .onboarding()
      .catch(() => null)
      .then((o) => setChosen(o?.country ?? defaultCountry(getLocales()[0]?.regionCode)));
  }, [sv]);
  const { rows, more } = useMemo(() => countryRows(query, chosen ?? undefined), [query, chosen]);

  if (!allowed || chosen === null) return <Screen busy />;
  const go = async () => {
    setBusy(true);
    await chooseCountry(sv.onboarding, sv.store, chosen!);
    router.replace('/onboarding');
  };
  return (
    <Screen title="Your country">
      <Body>LNVPS, the company that rents you the server, charges VAT by country.</Body>
      <Body muted>It can&apos;t be changed later.</Body>
      <SearchField placeholder="Search" accessibilityLabel="Search for a country" value={query} onChangeText={setQuery} autoCorrect={false} />
      {rows.length > 0 ? (
        <ListGroup>
          {rows.map((c, i) => {
            const vat = expectedVat(c.alpha3);
            return <ListRow key={c.alpha3} name={c.name} end={vatLabel(vat)} endWarn={vat > 0} selected={c.chosen} onPress={() => setChosen(c.alpha3)} divider={i > 0} />;
          })}
        </ListGroup>
      ) : (
        <Body muted>No country matches.</Body>
      )}
      {more && <Small>Search for any other country.</Small>}
      <Button title={continueLabel(chosen)} onPress={go} disabled={!chosen || busy} />
    </Screen>
  );
}
