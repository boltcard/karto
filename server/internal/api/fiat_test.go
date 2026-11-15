package api

import (
	"context"
	"maps"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/rates"
	"github.com/boltcard/karto/server/internal/store"
)

// mempoolPrices is mempool.space's answer of 2026-10-15.
var mempoolPrices = rates.Prices{Time: 1792037404, Per: map[string]int64{
	"USD": 80854, "EUR": 72070, "GBP": 61352, "CAD": 114850, "CHF": 67032, "AUD": 116376, "JPY": 12780023}}

// rate gives the server p as cardd's last rate, as cardd serve wires it:
// to the API (the phones' fiat, a sale's conversion) and to the store
// (limits in a currency).
func (w *moneyWorld) rate(p rates.Prices) {
	w.money.Prices = func() (rates.Prices, bool) { return p, true }
	w.st.Rate = func() (rates.Prices, bool) { return p, true }
}

// noRate takes the rate away: cardd has fetched none since it started.
func (w *moneyWorld) noRate() {
	w.money.Prices = nil
	w.st.Rate = nil
}

// repriced is p a minute later, with one currency's price changed.
func repriced(p rates.Prices, currency string, price int64) rates.Prices {
	per := maps.Clone(p.Per)
	per[currency] = price
	return rates.Prices{Time: p.Time + 60, Per: per}
}

// fiatOf is an answer's fiat object.
func fiatOf(out map[string]any) map[string]any {
	f, _ := out["fiat"].(map[string]any)
	return f
}

// The server's currency and what both apps read of it: null
// until the wallet sets one; then "none" or a code; a code's price and time
// only with a rate. Setting it is the wallet's alone.
func TestTheServersCurrency(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	if status, out := w.do("GET", "/api/v1/wallet", nil); status != 200 || !hasKey(out, "fiat") || !reflect.DeepEqual(fiatOf(out), map[string]any{"currency": nil}) {
		t.Fatalf("never set: %d %v", status, out["fiat"])
	}
	if status, out := till.do("GET", "/api/v1/pos/fiat", nil); status != 200 || !reflect.DeepEqual(fiatOf(out), map[string]any{"currency": nil}) {
		t.Fatalf("a till, never set: %d %v", status, out)
	}
	// No rate yet: a currency with no price.
	if status, out := w.do("PUT", "/api/v1/currency", map[string]string{"currency": "GBP"}); status != 200 || !reflect.DeepEqual(fiatOf(out), map[string]any{"currency": "GBP"}) {
		t.Fatalf("GBP with no rate: %d %v", status, out)
	}
	w.rate(mempoolPrices)
	want := map[string]any{"currency": "GBP", "price": 61352.0, "time": 1792037404.0}
	for _, c := range []*client{w.client, till} {
		if status, out := c.do("GET", "/api/v1/pos/fiat", nil); status != 200 || !reflect.DeepEqual(fiatOf(out), want) {
			t.Fatalf("pos/fiat: %d %v", status, out)
		}
	}
	if _, out := w.do("GET", "/api/v1/wallet", nil); !reflect.DeepEqual(fiatOf(out), want) {
		t.Fatalf("the wallet's fiat: %v", out["fiat"])
	}
	if status, out := w.do("PUT", "/api/v1/currency", map[string]string{"currency": "EUR"}); status != 200 || fiatOf(out)["price"] != 72070.0 {
		t.Fatalf("EUR: %d %v", status, out)
	}
	// None: no price, whatever the rate.
	if status, out := w.do("PUT", "/api/v1/currency", map[string]string{"currency": "none"}); status != 200 || !reflect.DeepEqual(fiatOf(out), map[string]any{"currency": "none"}) {
		t.Fatalf("none: %d %v", status, out)
	}
	for _, bad := range []string{"", "gbp", "XYZ", "BTC"} {
		if status, out := w.do("PUT", "/api/v1/currency", map[string]string{"currency": bad}); status != 400 || out["error"] != "malformed" {
			t.Fatalf("%q: %d %v", bad, status, out)
		}
	}
	// A PoS phone can't set it: deviceauth holds it to /api/v1/pos/.
	if status, out := till.do("PUT", "/api/v1/currency", map[string]string{"currency": "GBP"}); status != 403 || out["error"] != "not_allowed" {
		t.Fatalf("a till setting the currency: %d %v", status, out)
	}
	if code, _, _ := w.st.Currency(context.Background()); code != "none" {
		t.Fatalf("the currency is %q after the refusals, want none", code)
	}
}

// Changing the currency answers a held Wallet read at once: it
// moves the bell's rev, which is what releases one, so every wallet phone
// shows the new currency without waiting out its read.
func TestACurrencyChangeAnswersAHeldWalletRead(t *testing.T) {
	w := moneySetup(t)
	w.money.Bell, w.money.HeldRecheck = NewBell(), 20*time.Second
	w.st.Changed = w.money.Bell.Changed
	w.rate(mempoolPrices)
	_, first := w.do("GET", "/api/v1/wallet", nil)
	rev, _ := first["rev"].(string)
	if rev == "" {
		t.Fatalf("no rev: %v", first)
	}
	type answer struct {
		status int
		out    map[string]any
		after  time.Duration
	}
	got := make(chan answer, 1)
	go func() {
		start := time.Now()
		status, out, _ := w.doWith(http.DefaultClient, "GET", "/api/v1/wallet?since="+rev+"&wait=10", nil)
		got <- answer{status, out, time.Since(start)}
	}()
	select {
	case a := <-got:
		t.Fatalf("answered with nothing new after %v: %v", a.after, a.out)
	case <-time.After(300 * time.Millisecond):
	}
	if status, out := w.do("PUT", "/api/v1/currency", map[string]string{"currency": "GBP"}); status != 200 {
		t.Fatalf("set: %d %v", status, out)
	}
	select {
	case a := <-got:
		if a.status != 200 || a.out["rev"] == rev || a.after > 2*time.Second || fiatOf(a.out)["currency"] != "GBP" || fiatOf(a.out)["price"] != 61352.0 {
			t.Fatalf("the held read: %d after %v, rev %v, fiat %v", a.status, a.after, a.out["rev"], a.out["fiat"])
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the held read was still held 5 s after the currency changed")
	}
}

// sellAt asks for a sale rung up in a currency.
func sellAt(c *client, id, currency string, minor any) (int, map[string]any) {
	return c.do("POST", "/api/v1/pos/sales", map[string]any{"id": id, "price": map[string]any{"currency": currency, "minor": minor}})
}

// A sale rung up in the server's currency: cardd converts it at
// its last rate, half up, into the sale's sats, and the sale keeps its
// price. The same request again, after the rate moved and even the
// currency, is the first sale with its first sats.
func TestASaleInACurrency(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	w.rate(mempoolPrices)
	if status, _ := w.do("PUT", "/api/v1/currency", map[string]string{"currency": "GBP"}); status != 200 {
		t.Fatal("currency")
	}
	id := uuid()
	status, out := sellAt(till, id, "GBP", 250)
	s := theSale(out)
	wantPrice := map[string]any{"currency": "GBP", "minor": 250.0}
	if status != 201 || s["amountMsat"] != 4_075_000.0 || !reflect.DeepEqual(s["price"], wantPrice) {
		t.Fatalf("£2.50: %d %v", status, out)
	}
	invoice := s["invoice"].(string)
	info, ok := w.f.InvoiceInfo(invoice)
	if !ok || info.AmountMsat != 4_075_000 || info.ExternalID != "sale:"+id {
		t.Fatalf("phoenixd's invoice: %+v %v", info, ok)
	}
	for _, c := range []*client{till, w.client} {
		if status, out := c.do("GET", "/api/v1/pos/sales/"+id, nil); status != 200 || !reflect.DeepEqual(theSale(out)["price"], wantPrice) {
			t.Fatalf("read back: %d %v", status, out)
		}
	}
	// The rate moves, then the currency: the retry still finds its sale.
	w.rate(repriced(mempoolPrices, "GBP", 70_000))
	w.do("PUT", "/api/v1/currency", map[string]string{"currency": "EUR"})
	status, out = sellAt(till, id, "GBP", 250)
	if status != 200 || theSale(out)["amountMsat"] != 4_075_000.0 || theSale(out)["invoice"] != invoice || w.f.InvoiceCount() != 1 {
		t.Fatalf("again after the rate moved: %d %v, %d invoices", status, out, w.f.InvoiceCount())
	}
	if status, out := sellAt(till, id, "GBP", 251); status != 409 || out["error"] != "sale_exists" {
		t.Fatalf("the id at another price: %d %v", status, out)
	}
	if status, out := sell(till, id, 4075); status != 409 || out["error"] != "sale_exists" {
		t.Fatalf("the id typed in sat: %d %v", status, out)
	}
	// A new sale at the new rate: £2.50 is 3,571 sat at £70,000.
	w.do("PUT", "/api/v1/currency", map[string]string{"currency": "GBP"})
	if status, out := sellAt(till, uuid(), "GBP", 250); status != 201 || theSale(out)["amountMsat"] != 3_571_000.0 {
		t.Fatalf("at the new rate: %d %v", status, out)
	}
	// Paid: the wallet's history and the till's list name the price; a sale typed in sat has none.
	if done, err := w.st.CreditSale(context.Background(), id, 4_075_000, info.PaymentHash, "received"); err != nil || !done {
		t.Fatalf("credit: %v %v", done, err)
	}
	w.soldAndPaid(till, 1000, 1000)
	_, out = w.do("GET", "/api/v1/accounts/shop/history", nil)
	txs := out["transactions"].([]any)
	newest, older := txs[0].(map[string]any)["sale"].(map[string]any), txs[1].(map[string]any)["sale"].(map[string]any)
	if hasKey(newest, "price") || newest["priceMsat"] != 1_000_000.0 {
		t.Fatalf("the sat sale in the history: %v", newest)
	}
	if !reflect.DeepEqual(older["price"], wantPrice) || older["priceMsat"] != 4_075_000.0 {
		t.Fatalf("the priced sale in the history: %v", older)
	}
	_, out = till.do("GET", "/api/v1/pos/sales", nil)
	list := out["sales"].([]any)
	if len(list) != 2 || hasKey(list[0].(map[string]any), "price") || !reflect.DeepEqual(list[1].(map[string]any)["price"], wantPrice) {
		t.Fatalf("the till's list: %v", list)
	}
	// A day's total stays in msat: the sales' sats.
	_, out = till.do("GET", "/api/v1/pos/sales/days?offset=840", nil)
	if d := out["days"].([]any)[0].(map[string]any); d["totalMsat"] != 5_075_000.0 {
		t.Fatalf("the day: %v", d)
	}
}

// A priced sale's sats at the edges: half a sat rounds up; under
// 1 sat or over 2,000,000 is refused, the cap named in the currency; minor
// units are 1 to 10^10, checked before any arithmetic; yen have none.
func TestAPricedSalesEdges(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	w.do("PUT", "/api/v1/currency", map[string]string{"currency": "GBP"})
	w.rate(mempoolPrices)
	// The cap: £1,227.04 is exactly 2,000,000 sat at £61,352; a penny more is over.
	if status, out := sellAt(till, uuid(), "GBP", 122_704); status != 201 || theSale(out)["amountMsat"] != 2_000_000_000.0 {
		t.Fatalf("at the cap: %d %v", status, out)
	}
	if status, out := sellAt(till, uuid(), "GBP", 122_705); status != 400 || out["error"] != "malformed" ||
		out["message"] != "Over the 2,000,000 sat a sale can be (£1,227.04)." {
		t.Fatalf("over the cap: %d %v", status, out)
	}
	// Half a sat: at £2,000,000 a bitcoin a penny is 0.5 sat, so 1; three pence, 1.5, are 2.
	w.rate(repriced(mempoolPrices, "GBP", 2_000_000))
	for minor, msat := range map[int64]float64{1: 1000, 3: 2000} {
		if status, out := sellAt(till, uuid(), "GBP", minor); status != 201 || theSale(out)["amountMsat"] != msat {
			t.Fatalf("%dp: %d %v", minor, status, out)
		}
	}
	// At £4,000,000 a penny is a quarter of a sat: under the 1 sat a sale must be.
	w.rate(repriced(mempoolPrices, "GBP", 4_000_000))
	if status, out := sellAt(till, uuid(), "GBP", 1); status != 400 || out["error"] != "malformed" ||
		out["message"] != "A sale is at least 1 sat: £0.01 is under it at today's rate." {
		t.Fatalf("under 1 sat: %d %v", status, out)
	}
	// Yen.
	w.do("PUT", "/api/v1/currency", map[string]string{"currency": "JPY"})
	w.rate(mempoolPrices)
	if status, out := sellAt(till, uuid(), "JPY", 480); status != 201 || theSale(out)["amountMsat"] != 3_756_000.0 {
		t.Fatalf("¥480: %d %v", status, out)
	}
	if status, out := sellAt(till, uuid(), "JPY", 255_601); status != 400 || out["message"] != "Over the 2,000,000 sat a sale can be (¥255,600)." {
		t.Fatalf("over the cap in yen: %d %v", status, out)
	}
	made := w.f.InvoiceCount()
	for i, body := range []map[string]any{
		{"id": uuid(), "price": map[string]any{"currency": "JPY", "minor": 0}},
		{"id": uuid(), "price": map[string]any{"currency": "JPY", "minor": -5}},
		{"id": uuid(), "price": map[string]any{"currency": "JPY", "minor": 10_000_000_001}},
		{"id": uuid(), "price": map[string]any{"currency": "JPY", "minor": 1.5}},
		{"id": uuid(), "price": map[string]any{"currency": "jpy", "minor": 480}},
		{"id": uuid(), "price": map[string]any{"currency": "XYZ", "minor": 480}},
		{"id": uuid(), "price": map[string]any{"currency": "JPY"}},
		{"id": uuid(), "price": map[string]any{"currency": "JPY", "minor": 480, "rate": 1}},
		{"id": uuid(), "amountSat": 3756, "price": map[string]any{"currency": "JPY", "minor": 480}},
		{"id": "not-a-uuid", "price": map[string]any{"currency": "JPY", "minor": 480}},
	} {
		if status, out := till.do("POST", "/api/v1/pos/sales", body); status != 400 || out["error"] != "malformed" {
			t.Fatalf("body %d %v: %d %v", i, body, status, out)
		}
	}
	if w.f.InvoiceCount() != made {
		t.Fatalf("%d invoices for refused sales", w.f.InvoiceCount()-made)
	}
}

// A price in a currency that isn't the server's is refused, and one cardd
// has no rate for, in the words the till shows; a sale in sat is
// made all the same.
func TestAPriceTheServerCantConvert(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	w.rate(mempoolPrices)
	wrong := func(when string) {
		t.Helper()
		if status, out := sellAt(till, uuid(), "GBP", 250); status != 409 || out["error"] != "wrong_currency" ||
			out["message"] != "The shop's currency changed: start the sale again." {
			t.Fatalf("%s: %d %v", when, status, out)
		}
	}
	wrong("no currency set")
	w.do("PUT", "/api/v1/currency", map[string]string{"currency": "none"})
	wrong("currency none")
	w.do("PUT", "/api/v1/currency", map[string]string{"currency": "EUR"})
	wrong("the server's in EUR")
	w.noRate()
	if status, out := sellAt(till, uuid(), "EUR", 250); status != 409 || out["error"] != "no_rate" || out["message"] != "No € rate yet: type the price in sat." {
		t.Fatalf("no rate: %d %v", status, out)
	}
	if w.f.InvoiceCount() != 0 {
		t.Fatalf("%d invoices for refused sales", w.f.InvoiceCount())
	}
	status, out := sell(till, uuid(), 2500)
	if status != 201 || hasKey(theSale(out), "price") {
		t.Fatalf("a sale in sat: %d %v", status, out)
	}
}

// Limits in a currency through the API: PATCH takes either
// form, not both; a card's JSON, wherever it is, carries its limits in
// their currency, and perTapSat/dailySat as a tap would take them at the
// last rate (0 with none), so every reader of the sat figures stays true.
func TestLimitsInACurrencyThroughTheAPI(t *testing.T) {
	w := moneySetup(t)
	path := "/api/v1/cards/" + cardID + "/limits"
	gbp := map[string]any{"currency": "GBP", "perTapMinor": 500, "dailyMinor": 2000}
	if status, out := w.do("PATCH", path, gbp); status != 409 || out["error"] != "no_rate" || out["message"] != "No £ rate yet: set the limits in sat." {
		t.Fatalf("no rate: %d %v", status, out)
	}
	w.rate(mempoolPrices)
	w.do("PUT", "/api/v1/currency", map[string]string{"currency": "GBP"})
	wantLimits := map[string]any{"currency": "GBP", "perTapMinor": 500.0, "dailyMinor": 2000.0}
	status, out := w.do("PATCH", path, gbp)
	if status != 200 || !reflect.DeepEqual(out["limits"], wantLimits) || out["perTapSat"] != 8150.0 || out["dailySat"] != 32599.0 {
		t.Fatalf("£5 and £20: %d %v", status, out)
	}
	walletCard := func() map[string]any {
		t.Helper()
		_, out := w.do("GET", "/api/v1/wallet", nil)
		return out["cards"].([]any)[0].(map[string]any)
	}
	if c := walletCard(); !reflect.DeepEqual(c["limits"], wantLimits) || c["perTapSat"] != 8150.0 || c["dailySat"] != 32599.0 {
		t.Fatalf("the wallet's card: %v", c)
	}
	_, out = w.do("GET", "/api/v1/cards", nil)
	if c := out["cards"].([]any)[0].(map[string]any); !reflect.DeepEqual(c["limits"], wantLimits) || c["perTapSat"] != 8150.0 {
		t.Fatalf("the card list: %v", c)
	}
	// The rate moves: the sats follow, the limits in £ stay.
	w.rate(repriced(mempoolPrices, "GBP", 30676))
	if c := walletCard(); !reflect.DeepEqual(c["limits"], wantLimits) || c["perTapSat"] != 16299.0 || c["dailySat"] != 65198.0 {
		t.Fatalf("at £30,676: %v", c)
	}
	// In EUR on a GBP server.
	status, out = w.do("PATCH", path, map[string]any{"currency": "EUR", "perTapMinor": 500, "dailyMinor": 2000})
	if status != 200 || out["limits"].(map[string]any)["currency"] != "EUR" || out["perTapSat"] != 6938.0 {
		t.Fatalf("€5 and €20: %d %v", status, out)
	}
	// Over the cap at the rate now: refused when saved, the cap in the currency.
	w.rate(mempoolPrices)
	status, out = w.do("PATCH", path, map[string]any{"currency": "GBP", "perTapMinor": 500, "dailyMinor": 122_705})
	if msg, _ := out["message"].(string); status != 400 || out["error"] != "bad_limits" || !strings.Contains(msg, "2,000,000 sat (£1,227.04") {
		t.Fatalf("over the cap: %d %v", status, out)
	}
	if status, out := w.do("PATCH", path, map[string]any{"perTapSat": 5000, "dailySat": 10000, "currency": "GBP", "perTapMinor": 500, "dailyMinor": 2000}); status != 400 || out["error"] != "malformed" {
		t.Fatalf("both forms: %d %v", status, out)
	}
	// No rate: a card in £ has nothing a tap would take.
	w.do("PATCH", path, gbp)
	w.noRate()
	if c := walletCard(); !reflect.DeepEqual(c["limits"], wantLimits) || c["perTapSat"] != 0.0 || c["dailySat"] != 0.0 {
		t.Fatalf("no rate: %v", c)
	}
	// Sat limits again: no limits object, the sats as set.
	status, out = w.do("PATCH", path, map[string]any{"perTapSat": 5000, "dailySat": 10000})
	if status != 200 || hasKey(out, "limits") || out["perTapSat"] != 5000.0 || out["dailySat"] != 10000.0 {
		t.Fatalf("sat limits: %d %v", status, out)
	}
	if c := walletCard(); hasKey(c, "limits") || c["perTapSat"] != 5000.0 {
		t.Fatalf("the wallet's card in sat: %v", c)
	}
}

// A sale priced in a currency logs the rate it was converted at and where
// that came from, once: not for a retry found by its price, a sale
// typed in sat, or a sale whose invoice phoenixd didn't make.
func TestAPricedSaleLogsItsRateOnce(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	p := mempoolPrices
	p.Time, p.MempoolTime = 1792037404+165, 1792037404
	p.From = []string{rates.Mempool, rates.Coinbase, rates.Kraken}
	w.rate(p)
	if status, _ := w.do("PUT", "/api/v1/currency", map[string]string{"currency": "GBP"}); status != 200 {
		t.Fatal("currency")
	}
	count := func() int { return strings.Count(w.logs.String(), " priced ") }
	w.f.SetDown(true)
	if status, _ := sellAt(till, uuid(), "GBP", 250); status == 201 || count() != 0 {
		t.Fatalf("a failed invoice: %d, log %q", status, w.logs.String())
	}
	w.f.SetDown(false)
	w.logs.Reset()
	id := uuid()
	if status, out := sellAt(till, id, "GBP", 250); status != 201 {
		t.Fatalf("£2.50: %d %v", status, out)
	}
	sat := rates.SatForMinor(250, 61352, "GBP")
	want := "api: sale " + id + " priced £2.50 = " + rates.Thousands(sat) + " sat at £61,352 a bitcoin, " + rates.Words(p) + "\n"
	if sat != 4075 || w.logs.String() != want {
		t.Fatalf("the line:\n got %q\nwant %q", w.logs.String(), want)
	}
	if !strings.Contains(want, "from mempool.space (") || !strings.Contains(want, "Coinbase and Kraken at ") {
		t.Fatalf("the words: %q", want)
	}
	if status, _ := sellAt(till, id, "GBP", 250); status != 200 || w.logs.String() != want {
		t.Fatalf("again: %d, log %q", status, w.logs.String())
	}
	if status, _ := sell(till, uuid(), 1000); status != 201 || w.logs.String() != want {
		t.Fatalf("in sat: %d, log %q", status, w.logs.String())
	}
}
