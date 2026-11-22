package alerts

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/rates"
	"github.com/boltcard/karto/server/internal/store"
)

// t0 is 2026-10-17 12:00 UTC, the time of every test's transactions.
var t0 = time.Unix(1792238400, 0)

const blueID = "b1ee"

// fresh is a rate 1 minute old at t0: £250,000, €230,000, $270,000 and
// ¥45,000,000 a bitcoin.
func fresh() (rates.Prices, bool) {
	return rates.Prices{Time: t0.Unix() - 60, Per: map[string]int64{"GBP": 250_000, "EUR": 230_000, "USD": 270_000, "JPY": 45_000_000}}, true
}

func source(f *fakeStore, prices func() (rates.Prices, bool)) Source {
	return Source{Store: f, Prices: prices}
}

func gbpStore(t *testing.T) *fakeStore {
	f := newFakeStore(t)
	f.currency = "GBP"
	f.cards[blueID] = store.Card{ID: blueID, Name: "Blue"}
	return f
}

func build(t *testing.T, src Source, id int64, now time.Time) (map[string]any, Urgency, bool) {
	t.Helper()
	p, urg, ok, err := Build(context.Background(), src, id, now)
	if err != nil {
		t.Fatal(err)
	}
	return asMap(t, p), urg, ok
}

func asMap(t *testing.T, p Payload) map[string]any {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func want(t *testing.T, got map[string]any, js string) {
	t.Helper()
	var w map[string]any
	if err := json.Unmarshal([]byte(js), &w); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, w) {
		g, _ := json.Marshal(got)
		t.Fatalf("payload\n got %s\nwant %s", g, js)
	}
}

func TestBuildTopupCard(t *testing.T) {
	f := gbpStore(t)
	f.post(41, store.CardAccount(blueID), store.Line{Tx: store.Tx{Kind: store.KindTopup, AmountMsat: 123_000, CreatedAt: t0}})
	got, urg, ok := build(t, source(f, fresh), 41, t0.Add(4*time.Minute))
	if !ok || urg != UrgencyNormal {
		t.Fatalf("ok %v urgency %q", ok, urg)
	}
	want(t, got, `{"v":1,"kind":"received","account":"card:b1ee","name":"Blue","sat":123,"msat":123000,
		"fiat":{"currency":"GBP","minor":31,"priced":false},"reason":null,"count":0,"tx":41,"card":"b1ee","at":1792238400}`)
}

func TestBuildTopupPool(t *testing.T) {
	f := gbpStore(t)
	f.post(42, store.Pool, store.Line{Tx: store.Tx{Kind: store.KindTopup, AmountMsat: 123_000, FeeMsat: 2_000, CreatedAt: t0}})
	got, urg, ok := build(t, source(f, fresh), 42, t0)
	if !ok || urg != UrgencyNormal {
		t.Fatalf("ok %v urgency %q", ok, urg)
	}
	want(t, got, `{"v":1,"kind":"received","account":"pool","name":"","sat":123,"msat":123000,
		"fiat":{"currency":"GBP","minor":31,"priced":false},"reason":null,"count":0,"tx":42,"card":null,"at":1792238400}`)
}

func TestBuildTopupHosting(t *testing.T) {
	f := gbpStore(t)
	f.post(43, store.Hosting, store.Line{Tx: store.Tx{Kind: store.KindTopup, AmountMsat: 123_000, CreatedAt: t0}})
	got, urg, ok := build(t, source(f, fresh), 43, t0)
	if !ok || urg != UrgencyNormal {
		t.Fatalf("ok %v urgency %q", ok, urg)
	}
	want(t, got, `{"v":1,"kind":"received","account":"hosting","name":"","sat":123,"msat":123000,
		"fiat":{"currency":"GBP","minor":31,"priced":false},"reason":null,"count":0,"tx":43,"card":null,"at":1792238400}`)
}

func TestNamesCappedAt64Runes(t *testing.T) {
	long := strings.Repeat("é", 70)
	f := gbpStore(t)
	f.cards[blueID] = store.Card{ID: blueID, Name: long}
	f.post(41, store.CardAccount(blueID), store.Line{Tx: store.Tx{Kind: store.KindTopup, AmountMsat: 1_000, CreatedAt: t0}})
	f.post(44, store.Shop, store.Line{Tx: store.Tx{Kind: store.KindSale, AmountMsat: 1_000, CreatedAt: t0, Sale: &store.TxSale{Device: long}}})
	for _, id := range []int64{41, 44} {
		got, _, _ := build(t, source(f, fresh), id, t0)
		if n := []rune(got["name"].(string)); len(n) != 64 {
			t.Errorf("tx %d: name of %d runes, want 64", id, len(n))
		}
	}
	p := refusalPayload(taken{last: Refusal{CardID: blueID, Reason: RefusedOff, At: t0}, count: 1}, long)
	if n := []rune(p.Name); len(n) != 64 {
		t.Errorf("refusal: name of %d runes, want 64", len(n))
	}
}

func TestBuildSaleUsesItsPrice(t *testing.T) {
	f := gbpStore(t)
	sale := &store.TxSale{ID: "s1", Method: "card", Device: "Till 1", PriceMsat: 2_000_000, PriceCurrency: "GBP", PriceMinor: 500}
	f.post(44, store.Shop, store.Line{Tx: store.Tx{Kind: store.KindSale, AmountMsat: 2_000_000, CreatedAt: t0, Sale: sale}})
	// The rate says £5.00 too, but a dearer one shows the price is the sale's own.
	dear := func() (rates.Prices, bool) {
		return rates.Prices{Time: t0.Unix(), Per: map[string]int64{"GBP": 300_000}}, true
	}
	got, urg, ok := build(t, source(f, dear), 44, t0)
	if !ok || urg != UrgencyNormal {
		t.Fatalf("ok %v urgency %q", ok, urg)
	}
	want(t, got, `{"v":1,"kind":"received","account":"shop","name":"Till 1","sat":2000,"msat":2000000,
		"fiat":{"currency":"GBP","minor":500,"priced":true},"reason":null,"count":0,"tx":44,"card":null,"at":1792238400}`)

	// Its price stands with no rate and no currency at all.
	f.currency = ""
	got, _, _ = build(t, source(f, func() (rates.Prices, bool) { return rates.Prices{}, false }), 44, t0)
	if fiat, _ := got["fiat"].(map[string]any); fiat == nil || fiat["priced"] != true {
		t.Fatalf("fiat %v, want the sale's price", got["fiat"])
	}
}

func TestBuildSaleInSatUsesTheRate(t *testing.T) {
	f := gbpStore(t)
	f.post(45, store.Shop, store.Line{Tx: store.Tx{Kind: store.KindSale, AmountMsat: 2_000_000, CreatedAt: t0, Sale: &store.TxSale{ID: "s2", PriceMsat: 2_000_000}}})
	got, _, ok := build(t, source(f, fresh), 45, t0)
	if !ok {
		t.Fatal("not alerted")
	}
	want(t, got, `{"v":1,"kind":"received","account":"shop","name":"","sat":2000,"msat":2000000,
		"fiat":{"currency":"GBP","minor":500,"priced":false},"reason":null,"count":0,"tx":45,"card":null,"at":1792238400}`)
}

func TestBuildSpendSettled(t *testing.T) {
	f := gbpStore(t)
	f.post(46, store.CardAccount(blueID), store.Line{Tx: store.Tx{Kind: store.KindSpend, AmountMsat: -100_000, CreatedAt: t0}})
	got, urg, ok := build(t, source(f, fresh), 46, t0)
	if !ok || urg != UrgencyHigh {
		t.Fatalf("ok %v urgency %q", ok, urg)
	}
	want(t, got, `{"v":1,"kind":"spent","account":"card:b1ee","name":"Blue","sat":100,"msat":100000,
		"fiat":{"currency":"GBP","minor":25,"priced":false},"reason":null,"count":0,"tx":46,"card":"b1ee","at":1792238400}`)
}

func TestBuildQuietKinds(t *testing.T) {
	f := gbpStore(t)
	kinds := []store.Kind{store.KindSend, store.KindMove, store.KindWipe, store.KindFeeAdjust, store.KindAdjust, store.KindRenew}
	for i, k := range kinds {
		id := int64(100 + i)
		f.post(id, store.CardAccount(blueID), store.Line{Tx: store.Tx{Kind: k, AmountMsat: -1_000, CreatedAt: t0}})
		if _, _, ok := build(t, source(f, fresh), id, t0); ok {
			t.Errorf("%s alerted", k)
		}
	}
	// A transaction with no leg to show (store.ErrNotFound) is quiet, not an error.
	if _, _, ok := build(t, source(f, fresh), 999, t0); ok {
		t.Error("an unknown transaction alerted")
	}
}

func TestBuildStale(t *testing.T) {
	f := gbpStore(t)
	f.post(47, store.CardAccount(blueID), store.Line{Tx: store.Tx{Kind: store.KindSpend, AmountMsat: -100_000, CreatedAt: t0}})
	if _, _, ok := build(t, source(f, fresh), 47, t0.Add(6*time.Minute)); ok {
		t.Fatal("a spend 6 minutes old alerted")
	}
	if _, _, ok := build(t, source(f, fresh), 47, t0.Add(5*time.Minute)); !ok {
		t.Fatal("a spend 5 minutes old didn't alert")
	}
}

func TestBuildOldRateNoFiat(t *testing.T) {
	f := gbpStore(t)
	f.post(48, store.CardAccount(blueID), store.Line{Tx: store.Tx{Kind: store.KindTopup, AmountMsat: 123_000, CreatedAt: t0}})
	old := func() (rates.Prices, bool) {
		return rates.Prices{Time: t0.Unix() - 20*60, Per: map[string]int64{"GBP": 250_000}}, true
	}
	none := func() (rates.Prices, bool) { return rates.Prices{}, false }
	for name, prices := range map[string]func() (rates.Prices, bool){"20 minutes old": old, "none": none} {
		got, _, ok := build(t, source(f, prices), 48, t0)
		if !ok {
			t.Fatalf("%s: not alerted", name)
		}
		if got["fiat"] != nil {
			t.Errorf("rate %s: fiat %v, want none", name, got["fiat"])
		}
		if got["sat"] != 123.0 {
			t.Errorf("rate %s: sat %v", name, got["sat"])
		}
	}
	// Just under 15 minutes is still fresh.
	recent := func() (rates.Prices, bool) {
		return rates.Prices{Time: t0.Unix() - 15*60 + 1, Per: map[string]int64{"GBP": 250_000}}, true
	}
	if got, _, _ := build(t, source(f, recent), 48, t0); got["fiat"] == nil {
		t.Error("a rate 14:59 old gave no fiat")
	}
}

func TestBuildNoCurrencyNoFiat(t *testing.T) {
	f := gbpStore(t)
	f.currency = ""
	f.post(49, store.CardAccount(blueID), store.Line{Tx: store.Tx{Kind: store.KindTopup, AmountMsat: 123_000, CreatedAt: t0}})
	got, _, ok := build(t, source(f, fresh), 49, t0)
	if !ok || got["fiat"] != nil {
		t.Fatalf("ok %v fiat %v, want an alert with none", ok, got["fiat"])
	}
}

func TestBuildUnderAMinorUnitNoFiat(t *testing.T) {
	f := gbpStore(t)
	f.post(50, store.Pool, store.Line{Tx: store.Tx{Kind: store.KindTopup, AmountMsat: 1_000, CreatedAt: t0}})
	if got, _, _ := build(t, source(f, fresh), 50, t0); got["fiat"] != nil {
		t.Fatalf("1 sat gave fiat %v, want none (it rounds to £0.00)", got["fiat"])
	}
}

// vector is one case of testvectors/alerts.json: a scenario, the payload
// cardd makes of it, and the words the phones must make of that payload.
type vector struct {
	name        string
	acct        store.Account
	line        *store.Line // a committed transaction, for Build
	refusal     *Refusal    // a refused tap: the notification's last, its count, tag and update
	count       int
	tag         string
	update      bool
	test        bool
	hosting     *hostingCase // hosting's low-funding alert
	capped      bool         // the unpaid cap turned payers away
	card        string       // the card's name
	currency    string       // the server's currency, "" for none
	title, text string
}

// win is the tag of a card's refusal window begun at t0; hour the tag of
// the summary of its hour begun then.
var (
	win  = windowTag(blueID, t0)
	hour = hourTag(blueID, t0.Add(time.Hour))
)

// hostingCase is hosting's available balance and the whole days it pays for.
type hostingCase struct {
	availableMsat int64
	days          int
}

var vectors = []vector{
	{name: "topup-card", acct: store.CardAccount(blueID), card: "Blue", currency: "GBP",
		line:  &store.Line{Tx: store.Tx{ID: 41, Kind: store.KindTopup, AmountMsat: 123_000, CreatedAt: t0}},
		title: "Blue card", text: "123 sat received (£0.31)"},
	{name: "topup-pool", acct: store.Pool, currency: "GBP",
		line:  &store.Line{Tx: store.Tx{ID: 42, Kind: store.KindTopup, AmountMsat: 123_000, FeeMsat: 2_000, CreatedAt: t0}},
		title: "Karto", text: "123 sat received (£0.31)"},
	{name: "topup-card-unnamed-no-currency", acct: store.CardAccount(blueID), card: "",
		line:  &store.Line{Tx: store.Tx{ID: 43, Kind: store.KindTopup, AmountMsat: 1_234_567_000, CreatedAt: t0}},
		title: "Card", text: "1,234,567 sat received"},
	{name: "topup-card-yen", acct: store.CardAccount(blueID), card: "Blue", currency: "JPY",
		line:  &store.Line{Tx: store.Tx{ID: 44, Kind: store.KindTopup, AmountMsat: 123_000, CreatedAt: t0}},
		title: "Blue card", text: "123 sat received (¥55)"},
	{name: "sale-priced", acct: store.Shop, currency: "GBP",
		line: &store.Line{Tx: store.Tx{ID: 45, Kind: store.KindSale, AmountMsat: 2_000_000, CreatedAt: t0,
			Sale: &store.TxSale{ID: "s1", Method: "card", Device: "Till 1", PriceMsat: 2_000_000, PriceCurrency: "GBP", PriceMinor: 500}}},
		title: "Shop · Till 1", text: "2,000 sat received (priced £5.00)"},
	{name: "sale-in-sat-no-till", acct: store.Shop, currency: "GBP",
		line: &store.Line{Tx: store.Tx{ID: 46, Kind: store.KindSale, AmountMsat: 2_000_000, CreatedAt: t0,
			Sale: &store.TxSale{ID: "s2", Method: "qr", PriceMsat: 2_000_000}}},
		title: "Shop", text: "2,000 sat received (£5.00)"},
	{name: "spend", acct: store.CardAccount(blueID), card: "Blue", currency: "GBP",
		line:  &store.Line{Tx: store.Tx{ID: 47, Kind: store.KindSpend, AmountMsat: -104_196, FeeMsat: 4_196, CreatedAt: t0}},
		title: "Blue card", text: "100 sat spent (£0.25)"}, // the payment without its routing fee
	{name: "topup-hosting", acct: store.Hosting, currency: "GBP",
		line:  &store.Line{Tx: store.Tx{ID: 49, Kind: store.KindTopup, AmountMsat: 123_000, CreatedAt: t0}},
		title: "Hosting", text: "123 sat received (£0.31)"},
	{name: "topup-pool-euro", acct: store.Pool, currency: "EUR",
		line:  &store.Line{Tx: store.Tx{ID: 50, Kind: store.KindTopup, AmountMsat: 123_000, CreatedAt: t0}},
		title: "Karto", text: "123 sat received (€0.28)"},
	{name: "spend-dollar", acct: store.CardAccount(blueID), card: "Blue", currency: "USD",
		line:  &store.Line{Tx: store.Tx{ID: 51, Kind: store.KindSpend, AmountMsat: -100_000, CreatedAt: t0}},
		title: "Blue card", text: "100 sat spent ($0.27)"},
	{name: "sale-priced-no-currency", acct: store.Shop,
		line: &store.Line{Tx: store.Tx{ID: 52, Kind: store.KindSale, AmountMsat: 2_000_000, CreatedAt: t0,
			Sale: &store.TxSale{ID: "s3", Method: "card", Device: "Till 1", PriceMsat: 2_000_000, PriceCurrency: "GBP", PriceMinor: 500}}},
		title: "Shop · Till 1", text: "2,000 sat received (priced £5.00)"},
	{name: "spend-no-currency", acct: store.CardAccount(blueID), card: "Blue",
		line:  &store.Line{Tx: store.Tx{ID: 48, Kind: store.KindSpend, AmountMsat: -100_000, CreatedAt: t0}},
		title: "Blue card", text: "100 sat spent"},
	{name: "refused-daily", card: "Blue", count: 1, tag: win, refusal: &Refusal{CardID: blueID, Reason: RefusedDaily, AmountMsat: 5_000_000, At: t0},
		title: "Blue card", text: "A 5,000 sat spend was refused: over its daily limit"},
	{name: "refused-per-tap", card: "Blue", count: 1, tag: win, refusal: &Refusal{CardID: blueID, Reason: RefusedPerTap, AmountMsat: 5_000_000, At: t0},
		title: "Blue card", text: "A 5,000 sat spend was refused: over its per-payment limit"},
	{name: "refused-funds", card: "Blue", count: 1, tag: win, refusal: &Refusal{CardID: blueID, Reason: RefusedFunds, AmountMsat: 5_000_000, At: t0},
		title: "Blue card", text: "A 5,000 sat spend was refused: not enough money on the card"},
	{name: "refused-invoice", card: "Blue", count: 1, tag: win, refusal: &Refusal{CardID: blueID, Reason: RefusedInvoice, AmountMsat: 5_000_000, At: t0},
		title: "Blue card", text: "A 5,000 sat spend was refused: the terminal's invoice can't be paid"},
	{name: "refused-paused", card: "Blue", count: 1, tag: win, refusal: &Refusal{CardID: blueID, Reason: RefusedPaused, At: t0},
		title: "Blue card", text: "A tap was refused: spending is paused"},
	{name: "refused-daily-no-amount", card: "Blue", count: 1, tag: win, refusal: &Refusal{CardID: blueID, Reason: RefusedDaily, At: t0},
		title: "Blue card", text: "A tap was refused: over its daily limit"},
	{name: "refused-repeated", card: "Blue", count: 1, tag: win, refusal: &Refusal{CardID: blueID, Reason: RefusedRepeated, At: t0},
		title: "Blue card", text: "A repeated tap was refused"},
	{name: "refused-off", card: "Blue", count: 1, tag: win, refusal: &Refusal{CardID: blueID, Reason: RefusedOff, At: t0},
		title: "Blue card", text: "The card is off: a tap was refused"},
	{name: "refused-folded", card: "Blue", count: 3, tag: win, update: true, refusal: &Refusal{CardID: blueID, Reason: RefusedFunds, AmountMsat: 7_000_000, At: t0.Add(20 * time.Second)},
		title: "Blue card", text: "3 spends refused"},
	{name: "refused-folded-taps", card: "Blue", count: 2, tag: win, update: true, refusal: &Refusal{CardID: blueID, Reason: RefusedPaused, At: t0.Add(5 * time.Second)},
		title: "Blue card", text: "2 taps refused"},
	{name: "refused-hour-summary", card: "Blue", count: 4, tag: hour, refusal: &Refusal{CardID: blueID, Reason: RefusedDaily, AmountMsat: 5_000_000, At: t0.Add(50 * time.Minute)},
		title: "Blue card", text: "4 spends refused"},
	{name: "test", test: true, title: "Karto", text: "Alerts work"},
	{name: "hosting-low-5", hosting: &hostingCase{1_100_000, 5}, title: "Hosting", text: "Covers about 5 days: top it up or move from Pool"},
	{name: "hosting-low-1", hosting: &hostingCase{300_000, 1}, title: "Hosting", text: "Covers about 1 day: top it up or move from Pool"},
	{name: "hosting-low-0", hosting: &hostingCase{50_000, 0}, title: "Hosting", text: "Covers about 0 days: top it up or move from Pool"},
	{name: "invoices-capped", capped: true, title: "Karto", text: "Some payments in were turned away: too many unpaid invoices just now"},
}

func (v vector) payload(t *testing.T) map[string]any {
	t.Helper()
	switch {
	case v.test:
		return asMap(t, testPayload(t0))
	case v.hosting != nil:
		return asMap(t, HostingLow(v.hosting.availableMsat, v.hosting.days, t0))
	case v.capped:
		return asMap(t, InvoicesCapped(t0))
	case v.refusal != nil:
		return asMap(t, refusalPayload(taken{last: *v.refusal, count: v.count, tag: v.tag, update: v.update}, v.card))
	}
	f := newFakeStore(t)
	f.currency = v.currency
	f.cards[blueID] = store.Card{ID: blueID, Name: v.card}
	f.post(v.line.ID, v.acct, *v.line)
	got, _, ok := build(t, source(f, fresh), v.line.ID, t0)
	if !ok {
		t.Fatalf("%s: Build made no alert", v.name)
	}
	return got
}

func alertVectorPath() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "testvectors", "alerts.json")
}

type vectorFile struct {
	Cases []vectorCase `json:"cases"`
}

type vectorCase struct {
	Name    string         `json:"name"`
	Payload map[string]any `json:"payload"`
	Title   string         `json:"title"`
	Text    string         `json:"text"`
	Link    string         `json:"link"` // what a tap opens, "" for the app as it is
}

// phoneLink is the link the phones put on an alert, written
// here from the payload so each phone's own code is checked against it: a
// refusal opens the card's page, a payment its page, each naming the account
// as the app's pages do (pool, hosting, shop, or a card's bare id).
func phoneLink(p map[string]any) string {
	kind, _ := p["kind"].(string)
	if kind == "hosting" {
		return "karto://account?id=hosting"
	}
	if kind == "refused" {
		if card, ok := p["card"].(string); ok && card != "" {
			return "karto://account?id=" + url.QueryEscape(card)
		}
		return ""
	}
	acct, _ := p["account"].(string)
	acct = strings.TrimPrefix(acct, "card:")
	tx, ok := p["tx"].(float64)
	if !ok || acct == "" {
		return ""
	}
	return fmt.Sprintf("karto://payment?account=%s&tx=%d", url.QueryEscape(acct), int64(tx))
}

// testvectors/alerts.json is what cardd sends for each scenario and the words
// the phones must compose from it. CARDD_WRITE_ALERT_VECTORS=1
// writes it from the table above; every run checks it still matches.
func TestPayloadsMatchVectors(t *testing.T) {
	var made vectorFile
	for _, v := range vectors {
		p := v.payload(t)
		made.Cases = append(made.Cases, vectorCase{v.name, p, v.title, v.text, phoneLink(p)})
	}
	if os.Getenv("CARDD_WRITE_ALERT_VECTORS") == "1" {
		raw, err := json.MarshalIndent(made, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(alertVectorPath(), append(raw, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(alertVectorPath())
	if err != nil {
		t.Fatal(err)
	}
	var file vectorFile
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) != len(made.Cases) {
		t.Fatalf("testvectors/alerts.json has %d cases, the table %d: write it with CARDD_WRITE_ALERT_VECTORS=1", len(file.Cases), len(made.Cases))
	}
	for i, c := range file.Cases {
		m := made.Cases[i]
		if !reflect.DeepEqual(c, m) {
			g, _ := json.Marshal(m)
			f, _ := json.Marshal(c)
			t.Errorf("case %d (%s):\n file %s\nmade %s", i, c.Name, f, g)
		}
	}
}
