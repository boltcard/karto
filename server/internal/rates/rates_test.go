package rates

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"maps"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// mempoolTime is the time of mempool.space's answer of 2026-10-15,
// and day is its prices.
const mempoolTime int64 = 1792037404

var day = map[string]int64{"USD": 80854, "EUR": 72070, "GBP": 61352, "CAD": 114850, "CHF": 67032, "AUD": 116376, "JPY": 12780023}

// at is cardd's clock in these tests: a minute after mempool.space's time.
var at = time.Unix(mempoolTime+60, 0)

// answer is mempool.space's prices at time t, each as day has it but for
// change's; a currency changed to "" is left out.
func answer(t int64, change map[string]string) string {
	fields := []string{fmt.Sprintf(`"time":%d`, t)}
	for _, c := range Currencies {
		v, changed := change[c]
		if !changed {
			v = strconv.FormatInt(day[c], 10)
		}
		if v != "" {
			fields = append(fields, fmt.Sprintf("%q:%s", c, v))
		}
	}
	return "{" + strings.Join(fields, ",") + "}"
}

// coinbaseAnswer is Coinbase's exchange rates for BTC at per's prices, with a
// currency beyond the seven, as Coinbase's answer has many.
func coinbaseAnswer(per map[string]int64) string {
	fields := []string{`"AED":"224689.1"`}
	for _, c := range Currencies {
		fields = append(fields, fmt.Sprintf(`%q:"%d"`, c, per[c]))
	}
	return `{"data":{"currency":"BTC","rates":{` + strings.Join(fields, ",") + `}}}`
}

// krakenAnswer is Kraken's tickers at per's prices: each pair's best bid a
// unit under the price and its best ask a unit over, so the middle is the
// price.
func krakenAnswer(per map[string]int64) string {
	var fields []string
	for _, c := range Currencies {
		fields = append(fields, fmt.Sprintf(`"BTC/%s":{"a":["%d.0","1","1.000"],"b":["%d.0","1","1.000"],"c":["%d.0","0.1"]}`,
			c, per[c]+1, per[c]-1, per[c]))
	}
	return `{"error":[],"result":{` + strings.Join(fields, ",") + `}}`
}

// with is day with one currency's price changed.
func with(c string, v int64) map[string]int64 {
	m := maps.Clone(day)
	m[c] = v
	return m
}

// padded is body (a JSON object) made n bytes long with spaces inside it.
func padded(body string, n int) string {
	return "{" + strings.Repeat(" ", n-len(body)) + body[1:]
}

// fake is one source: GET on its path answers with what it was last given,
// or hangs until the asker gives up.
type fake struct {
	*httptest.Server
	path   string
	mu     sync.Mutex
	status int
	body   string
	hang   bool
	asked  int
}

func newFake(t *testing.T, path, body string) *fake {
	t.Helper()
	f := &fake{path: path, status: http.StatusOK, body: body}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		status, body, hang := f.status, f.body, f.hang
		f.asked++
		f.mu.Unlock()
		if r.Method != http.MethodGet || r.URL.Path != f.path {
			http.NotFound(w, r)
			return
		}
		if hang {
			<-r.Context().Done()
			return
		}
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fake) url() string { return f.URL + f.path }

func (f *fake) set(status int, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status, f.body, f.hang = status, body, false
}

func (f *fake) hangs() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hang = true
}

func (f *fake) times() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.asked
}

// fakes are the three sources, each answering day's prices: mempool.space
// with its time, Coinbase and Kraken as of the request.
type fakes struct{ mempool, coinbase, kraken *fake }

func newFakes(t *testing.T) fakes {
	t.Helper()
	return fakes{
		mempool:  newFake(t, "/api/v1/prices", answer(mempoolTime, nil)),
		coinbase: newFake(t, "/v2/exchange-rates", coinbaseAnswer(day)),
		kraken:   newFake(t, "/0/public/Ticker", krakenAnswer(day)),
	}
}

func (f fakes) urls() URLs {
	return URLs{Mempool: f.mempool.url(), Coinbase: f.coinbase.url(), Kraken: f.kraken.url()}
}

// liveDown has Coinbase and Kraken answer HTTP 503: mempool.space alone.
func (f fakes) liveDown() {
	f.coinbase.set(http.StatusServiceUnavailable, "")
	f.kraken.set(http.StatusServiceUnavailable, "")
}

// closed are URLs no test reaches: a closed port.
var closed = URLs{
	Mempool:  "http://127.0.0.1:1/api/v1/prices",
	Coinbase: "http://127.0.0.1:1/v2/exchange-rates",
	Kraken:   "http://127.0.0.1:1/0/public/Ticker",
}

// source is a Source on f, cardd's clock at *now (a test may move it), its
// file in a new directory; and what it logs.
func source(t *testing.T, f fakes, now *time.Time) (*Source, *bytes.Buffer, string) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "rates.json")
	logs := &bytes.Buffer{}
	return New(f.urls(), file, f.mempool.Client(), func() time.Time { return *now }, log.New(logs, "", 0)), logs, file
}

func lines(b *bytes.Buffer) int { return strings.Count(b.String(), "\n") }

// all three, in From's order; and the words for a rate taken from them at at.
var (
	all      = []string{Mempool, Coinbase, Kraken}
	allWords = "from mempool.space (04:10:04), Coinbase and Kraken at 04:11:04"
)

// The failure lines of a source answering HTTP 503 for the first time.
const (
	mempoolDown  = "rates: mempool.space failed: HTTP 503; the others are still asked\n"
	coinbaseDown = "rates: Coinbase failed: HTTP 503; the others are still asked\n"
	krakenDown   = "rates: Kraken failed: HTTP 503; the others are still asked\n"
)

// The seven currencies mempool.space quotes, their minor units
// and how an amount in one is written, as the apps write it.
func TestTheSevenCurrencies(t *testing.T) {
	for _, c := range Currencies {
		if !Known(c) {
			t.Errorf("%s isn't known", c)
		}
	}
	for _, c := range []string{"", "gbp", "BTC", "XYZ", "none"} {
		if Known(c) {
			t.Errorf("%q is known", c)
		}
	}
	if Decimals("JPY") != 0 || Decimals("GBP") != 2 || Decimals("CHF") != 2 {
		t.Fatalf("decimals: JPY %d, GBP %d, CHF %d", Decimals("JPY"), Decimals("GBP"), Decimals("CHF"))
	}
	for _, c := range []struct {
		minor    int64
		currency string
		want     string
	}{
		{122_704, "GBP", "£1,227.04"},
		{255_600, "JPY", "¥255,600"},
		{420, "CHF", "CHF 4.20"},
		{1, "GBP", "£0.01"},
		{5, "EUR", "€0.05"},
		{150, "CAD", "CA$1.50"},
		{99, "AUD", "A$0.99"},
		{10_000_000_000, "USD", "$100,000,000.00"},
	} {
		if got := MinorText(c.minor, c.currency); got != c.want {
			t.Errorf("MinorText(%d, %s) = %q, want %q", c.minor, c.currency, got, c.want)
		}
	}
	err := NoRate("GBP", "type the price in sat.")
	if !errors.Is(err, ErrNoRate) || err.Error() != "No £ rate yet: type the price in sat." {
		t.Fatalf("NoRate: %v", err)
	}
	if got := NoRate("CHF", "set the limits in sat.").Error(); got != "No CHF rate yet: set the limits in sat." {
		t.Fatalf("NoRate for CHF: %q", got)
	}
}

// A price in minor units as sats: round(minor × 10^8 / (price ×
// 10^decimals)), half up; a limit as msat, rounded down; and the cap
// in a currency, to the nearest minor unit, for the refusals' words.
func TestConversions(t *testing.T) {
	for _, c := range []struct {
		minor, price int64
		currency     string
		sat          int64
	}{
		{250, 61352, "GBP", 4075},          // £2.50 is 4,074.85 sat
		{480, 12780023, "JPY", 3756},       // yen have no minor unit
		{1, 2_000_000, "GBP", 1},           // half a sat rounds up
		{3, 2_000_000, "GBP", 2},           // 1.5 sat is 2
		{1, 4_000_000, "GBP", 0},           // a quarter of a sat is none
		{122_704, 61352, "GBP", 2_000_000}, // the cap, exactly
		{122_705, 61352, "GBP", 2_000_016},
		{MaxMinor, 1, "GBP", 10_000_000_000_000_000},
		{250, 0, "GBP", 0}, // no price: nothing, not a panic
	} {
		if got := SatForMinor(c.minor, c.price, c.currency); got != c.sat {
			t.Errorf("SatForMinor(%d, %d, %s) = %d, want %d", c.minor, c.price, c.currency, got, c.sat)
		}
	}
	for _, c := range []struct {
		minor, price int64
		currency     string
		msat         int64
	}{
		{500, 61352, "GBP", 8_149_693},   // £5 is 8,149,693.6 msat
		{2000, 61352, "GBP", 32_598_774}, // £20
		{500, 30676, "GBP", 16_299_387},  // £5 when the price halves
		{500, 72070, "EUR", 6_937_699},
		{200_000, 61352, "GBP", 3_259_877_428}, // over the cap: the caller caps it
		{MaxMinor, 1, "JPY", math.MaxInt64},    // 10^21 msat saturates
		{500, 0, "GBP", 0},
	} {
		if got := MsatForMinorDown(c.minor, c.price, c.currency); got != c.msat {
			t.Errorf("MsatForMinorDown(%d, %d, %s) = %d, want %d", c.minor, c.price, c.currency, got, c.msat)
		}
	}
	for _, c := range []struct {
		sat, price int64
		currency   string
		minor      int64
	}{
		{2_000_000, 61352, "GBP", 122_704},
		{2_000_000, 12780023, "JPY", 255_600},
		{2_000_000, 72070, "EUR", 144_140},
	} {
		if got := MinorForSat(c.sat, c.price, c.currency); got != c.minor {
			t.Errorf("MinorForSat(%d, %d, %s) = %d, want %d", c.sat, c.price, c.currency, got, c.minor)
		}
	}
}

// A round with the three answering takes the middle of their prices:
// the rate's time is cardd's clock at the round's start, as
// Coinbase's and Kraken's prices are as of the request, and mempool.space's
// own time is kept beside it for the log's words. Nothing is logged.
func TestTheMiddleOfThreeIsTaken(t *testing.T) {
	f := newFakes(t)
	f.mempool.set(http.StatusOK, answer(mempoolTime, map[string]string{"GBP": "61000"}))
	f.coinbase.set(http.StatusOK, coinbaseAnswer(with("GBP", 61300)))
	f.kraken.set(http.StatusOK, krakenAnswer(with("GBP", 61200)))
	now := at
	s, logs, _ := source(t, f, &now)
	if err := s.Fetch(context.Background()); err != nil {
		t.Fatal(err)
	}
	p, ok := s.Last()
	if !ok || !reflect.DeepEqual(p.Per, with("GBP", 61200)) || !reflect.DeepEqual(p.From, all) ||
		p.Time != at.Unix() || p.MempoolTime != mempoolTime {
		t.Fatalf("last %+v %v", p, ok)
	}
	if logs.Len() != 0 {
		t.Fatalf("logged %q", logs.String())
	}
}

// A good round is taken and kept in rates.json, written whole, its sources
// and mempool.space's time with it, so a restart has it at once.
// Before any round there is no rate.
func TestAGoodAnswerIsTakenAndKeptForARestart(t *testing.T) {
	ctx := context.Background()
	f := newFakes(t)
	now := at
	s, logs, file := source(t, f, &now)
	if _, ok := s.Last(); ok {
		t.Fatal("a rate before any fetch")
	}
	if lastPer(s)["GBP"] != 0 {
		t.Fatal("a GBP price before any fetch")
	}
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	p, ok := s.Last()
	if !ok || p.Time != at.Unix() || p.MempoolTime != mempoolTime || !reflect.DeepEqual(p.From, all) || !reflect.DeepEqual(p.Per, day) {
		t.Fatalf("last %+v %v", p, ok)
	}
	if price := lastPer(s)["JPY"]; price != 12780023 {
		t.Fatalf("JPY %d", price)
	}
	if _, ok := lastPer(s)["BTC"]; ok {
		t.Fatal("a price for BTC")
	}
	if logs.Len() != 0 {
		t.Fatalf("logged %q for a good round", logs.String())
	}
	// A restart reads the file, and asks no source for it.
	f.mempool.set(http.StatusInternalServerError, "")
	asked := []int{f.mempool.times(), f.coinbase.times(), f.kraken.times()}
	again := New(f.urls(), file, f.mempool.Client(), func() time.Time { return at }, log.New(io.Discard, "", 0))
	if p2, ok := again.Last(); !ok || !reflect.DeepEqual(p2, p) {
		t.Fatalf("after a restart: %+v %v, want %+v", p2, ok, p)
	}
	if got := []int{f.mempool.times(), f.coinbase.times(), f.kraken.times()}; !reflect.DeepEqual(got, asked) {
		t.Fatal("New asked a source")
	}
	// Written to a temporary name and renamed: nothing else is left beside it.
	entries, err := os.ReadDir(filepath.Dir(file))
	if err != nil || len(entries) != 1 || entries[0].Name() != "rates.json" {
		t.Fatalf("beside the database: %v %v", entries, err)
	}
}

// With mempool.space alone the rate's time is its own.
func TestMempoolAloneKeepsItsTime(t *testing.T) {
	f := newFakes(t)
	f.liveDown()
	now := at
	s, logs, _ := source(t, f, &now)
	if err := s.Fetch(context.Background()); err != nil {
		t.Fatal(err)
	}
	p, ok := s.Last()
	if !ok || p.Time != mempoolTime || p.MempoolTime != mempoolTime || !reflect.DeepEqual(p.From, []string{Mempool}) || !reflect.DeepEqual(p.Per, day) {
		t.Fatalf("last %+v %v", p, ok)
	}
	if logs.String() != coinbaseDown+krakenDown {
		t.Fatalf("logged %q", logs.String())
	}
}

// mempool.space alone with a time older than the kept rate's keeps the kept
// rate, which is newer, silently: no change and no failure. Its
// next newer answer is taken.
func TestMempoolAloneOlderKeepsTheKeptRateSilently(t *testing.T) {
	ctx := context.Background()
	f := newFakes(t)
	now := at
	s, logs, _ := source(t, f, &now)
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	kept, _ := s.Last()
	f.liveDown()
	f.mempool.set(http.StatusOK, answer(mempoolTime+30, map[string]string{"GBP": "61400"}))
	now = now.Add(5 * time.Minute)
	if err := s.Fetch(ctx); err != nil {
		t.Fatalf("an older answer: %v", err)
	}
	if p, _ := s.Last(); !reflect.DeepEqual(p, kept) {
		t.Fatalf("the rate after an older answer: %+v, want %+v", p, kept)
	}
	if logs.String() != coinbaseDown+krakenDown {
		t.Fatalf("logged %q", logs.String())
	}
	f.mempool.set(http.StatusOK, answer(at.Unix()+120, map[string]string{"GBP": "61400"}))
	now = now.Add(5 * time.Minute)
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	if p, _ := s.Last(); p.Time != at.Unix()+120 || p.MempoolTime != at.Unix()+120 || p.Per["GBP"] != 61400 || !reflect.DeepEqual(p.From, []string{Mempool}) {
		t.Fatalf("a newer answer: %+v", p)
	}
	if lines(logs) != 2 {
		t.Fatalf("logged %q", logs.String())
	}
}

// A source's failure is logged when it starts and when it ends, not every
// round.
func TestAFailingSourceIsLoggedOnceAndItsReturnOnce(t *testing.T) {
	ctx := context.Background()
	f := newFakes(t)
	f.kraken.set(http.StatusServiceUnavailable, "")
	now := at
	s, logs, _ := source(t, f, &now)
	for i := 0; i < 3; i++ {
		if err := s.Fetch(ctx); err != nil {
			t.Fatalf("round %d: %v", i, err)
		}
		now = now.Add(5 * time.Minute)
	}
	if p, _ := s.Last(); !reflect.DeepEqual(p.From, []string{Mempool, Coinbase}) {
		t.Fatalf("from %v", p.From)
	}
	if logs.String() != krakenDown {
		t.Fatalf("logged %q", logs.String())
	}
	f.kraken.set(http.StatusOK, krakenAnswer(day))
	for i := 0; i < 2; i++ {
		if err := s.Fetch(ctx); err != nil {
			t.Fatal(err)
		}
		now = now.Add(5 * time.Minute)
	}
	if logs.String() != krakenDown+"rates: Kraken answers again\n" {
		t.Fatalf("logged %q", logs.String())
	}
	if p, _ := s.Last(); !reflect.DeepEqual(p.From, all) {
		t.Fatalf("from %v", p.From)
	}
}

// A 429 holds that source, and only it, for 30 minutes; the line
// says until when, to the minute.
func TestA429HoldsThatSourceOnly(t *testing.T) {
	ctx := context.Background()
	f := newFakes(t)
	now := at
	s, logs, _ := source(t, f, &now)
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	f.coinbase.set(http.StatusTooManyRequests, "")
	now = now.Add(5 * time.Minute) // 04:16:04
	if err := s.Fetch(ctx); err != nil {
		t.Fatalf("the others answered: %v", err)
	}
	if logs.String() != "rates: Coinbase answered 429 Too Many Requests: not asked until 04:46\n" {
		t.Fatalf("logged %q", logs.String())
	}
	f.coinbase.set(http.StatusOK, coinbaseAnswer(day))
	for i := 0; i < 5; i++ { // 04:21:04 to 04:41:04
		now = now.Add(5 * time.Minute)
		if err := s.Fetch(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if c, m, k := f.coinbase.times(), f.mempool.times(), f.kraken.times(); c != 2 || m != 7 || k != 7 {
		t.Fatalf("asked: Coinbase %d, mempool.space %d, Kraken %d times", c, m, k)
	}
	if p, _ := s.Last(); !reflect.DeepEqual(p.From, []string{Mempool, Kraken}) || p.Time != now.Unix() {
		t.Fatalf("during the hold: %+v", p)
	}
	now = at.Add(35 * time.Minute) // 04:46:04: the hold is over
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	if f.coinbase.times() != 3 {
		t.Fatalf("Coinbase asked %d times after its hold", f.coinbase.times())
	}
	if p, _ := s.Last(); !reflect.DeepEqual(p.From, all) {
		t.Fatalf("after the hold: %+v", p)
	}
	if lines(logs) != 2 || !strings.HasSuffix(logs.String(), "\nrates: Coinbase answers again\n") {
		t.Fatalf("logged %q", logs.String())
	}
}

// A source on hold is named in the line of a round in which no source
// answered, with when it is next asked.
func TestNoSourceAnsweredNamesASourceOnHold(t *testing.T) {
	ctx := context.Background()
	f := newFakes(t)
	now := at
	s, logs, _ := source(t, f, &now)
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	f.coinbase.set(http.StatusTooManyRequests, "")
	now = now.Add(5 * time.Minute) // 04:16:04, held until 04:46
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	f.mempool.set(http.StatusServiceUnavailable, "")
	f.kraken.set(http.StatusServiceUnavailable, "")
	logs.Reset()
	now = now.Add(5 * time.Minute)
	if err := s.Fetch(ctx); err == nil {
		t.Fatal("no error")
	}
	want := "rates: no source answered (mempool.space: HTTP 503, Coinbase: held until 04:46, Kraken: HTTP 503); the rate "
	if !strings.Contains(logs.String(), want) {
		t.Fatalf("logged %q, want it to contain %q", logs.String(), want)
	}
}

// Two sources more than 5% apart are neither taken: the last rate is kept
// and the line names both figures. Exactly 5% apart, their
// mean is taken.
func TestTwoApartKeepTheLastRate(t *testing.T) {
	ctx := context.Background()
	f := newFakes(t)
	now := at
	s, logs, _ := source(t, f, &now)
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	kept, _ := s.Last()
	f.mempool.set(http.StatusServiceUnavailable, "")
	f.coinbase.set(http.StatusOK, coinbaseAnswer(with("GBP", 60000)))
	f.kraken.set(http.StatusOK, krakenAnswer(with("GBP", 63001)))
	now = now.Add(5 * time.Minute)
	if err := s.Fetch(ctx); err == nil {
		t.Fatal("two apart taken")
	}
	if p, _ := s.Last(); !reflect.DeepEqual(p, kept) {
		t.Fatalf("the rate after two apart: %+v, want %+v", p, kept)
	}
	want := mempoolDown + "rates: Coinbase and Kraken are more than 5% apart (GBP 60,000 and 63,001); the rate " + allWords + " is kept\n"
	if logs.String() != want {
		t.Fatalf("logged %q, want %q", logs.String(), want)
	}
	f.kraken.set(http.StatusOK, krakenAnswer(with("GBP", 63000)))
	now = now.Add(5 * time.Minute)
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	if p, _ := s.Last(); p.Per["GBP"] != 61500 || !reflect.DeepEqual(p.From, []string{Coinbase, Kraken}) || p.MempoolTime != 0 || p.Time != now.Unix() {
		t.Fatalf("exactly 5%% apart: %+v", p)
	}
	if lines(logs) != 2 {
		t.Fatalf("logged %q", logs.String())
	}
}

// A round in which no source answered keeps the last rate, and says so each
// time with each source's reason; a round with every source on
// hold asks nothing and logs nothing.
func TestNoSourceAnsweredKeepsTheLastRate(t *testing.T) {
	ctx := context.Background()
	f := newFakes(t)
	down := func() {
		f.mempool.set(http.StatusServiceUnavailable, "")
		f.liveDown()
	}
	t.Run("no rate yet", func(t *testing.T) {
		down()
		now := at
		s, logs, _ := source(t, f, &now)
		if err := s.Fetch(ctx); err == nil {
			t.Fatal("no error")
		}
		want := mempoolDown + coinbaseDown + krakenDown +
			"rates: no source answered (mempool.space: HTTP 503, Coinbase: HTTP 503, Kraken: HTTP 503); there is no rate yet\n"
		if logs.String() != want {
			t.Fatalf("logged %q, want %q", logs.String(), want)
		}
	})
	f.mempool.set(http.StatusOK, answer(mempoolTime, nil))
	f.coinbase.set(http.StatusOK, coinbaseAnswer(day))
	f.kraken.set(http.StatusOK, krakenAnswer(day))
	now := at
	s, logs, _ := source(t, f, &now)
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	kept, _ := s.Last()
	down()
	noneLine := "rates: no source answered (mempool.space: HTTP 503, Coinbase: HTTP 503, Kraken: HTTP 503); the rate " + allWords + " is kept\n"
	for i, want := range []string{mempoolDown + coinbaseDown + krakenDown + noneLine, noneLine} {
		logs.Reset()
		now = now.Add(5 * time.Minute)
		if err := s.Fetch(ctx); err == nil {
			t.Fatalf("round %d: no error", i)
		}
		if p, _ := s.Last(); !reflect.DeepEqual(p, kept) {
			t.Fatalf("round %d: %+v, want %+v", i, p, kept)
		}
		if logs.String() != want {
			t.Fatalf("round %d: logged %q, want %q", i, logs.String(), want)
		}
	}
	for _, fk := range []*fake{f.mempool, f.coinbase, f.kraken} {
		fk.set(http.StatusTooManyRequests, "")
	}
	logs.Reset()
	now = now.Add(5 * time.Minute) // 04:26:04
	if err := s.Fetch(ctx); err == nil {
		t.Fatal("three 429s: no error")
	}
	if lines(logs) != 4 || !strings.HasPrefix(logs.String(), "rates: mempool.space answered 429 Too Many Requests: not asked until 04:56\n") ||
		!strings.Contains(logs.String(), "\nrates: no source answered (") {
		t.Fatalf("three 429s: logged %q", logs.String())
	}
	asked := []int{f.mempool.times(), f.coinbase.times(), f.kraken.times()}
	logs.Reset()
	now = now.Add(5 * time.Minute)
	if err := s.Fetch(ctx); err != nil {
		t.Fatalf("every source on hold: %v", err)
	}
	if got := []int{f.mempool.times(), f.coinbase.times(), f.kraken.times()}; !reflect.DeepEqual(got, asked) {
		t.Fatalf("every source on hold, yet asked: %v, was %v", got, asked)
	}
	if logs.Len() != 0 {
		t.Fatalf("every source on hold: logged %q", logs.String())
	}
	if p, _ := s.Last(); !reflect.DeepEqual(p, kept) {
		t.Fatalf("every source on hold: %+v", p)
	}
}

// The sources are asked at once, each under its own time limit: a hanging
// source costs the round its limit, not the others' answers.
func TestAHangingSourceCostsTheRoundItsLimitOnly(t *testing.T) {
	ctx := context.Background()
	f := newFakes(t)
	f.kraken.hangs()
	now := at
	s, logs, _ := source(t, f, &now)
	s.timeout = 200 * time.Millisecond
	start := time.Now()
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took >= time.Second {
		t.Fatalf("the round took %v", took)
	}
	if p, _ := s.Last(); !reflect.DeepEqual(p.From, []string{Mempool, Coinbase}) {
		t.Fatalf("from %v", p.From)
	}
	if lines(logs) != 1 || !strings.HasPrefix(logs.String(), "rates: Kraken failed: ") {
		t.Fatalf("logged %q", logs.String())
	}
	// Two hanging cost the round one limit, not two: they are asked at once.
	f.mempool.hangs()
	s.timeout = 800 * time.Millisecond // serial would take 1.6 s
	now = now.Add(5 * time.Minute)
	start = time.Now()
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took >= 1400*time.Millisecond {
		t.Fatalf("two hanging: the round took %v", took)
	}
	if p, _ := s.Last(); !reflect.DeepEqual(p.From, []string{Coinbase}) {
		t.Fatalf("two hanging: from %v", p.From)
	}
}

// Each source's body is read under its own limit: 4 KiB for
// mempool.space, 128 KiB for Coinbase, 16 KiB for Kraken. A body of the limit
// is taken; one byte more is that source's failure, and the others are taken.
func TestABodyOverItsLimitIsThatSourcesFailure(t *testing.T) {
	for _, c := range []struct {
		name  string
		limit int
		body  string
		pick  func(fakes) *fake
		rest  []string
	}{
		{Mempool, 4 << 10, answer(mempoolTime, nil), func(f fakes) *fake { return f.mempool }, []string{Coinbase, Kraken}},
		{Coinbase, 128 << 10, coinbaseAnswer(day), func(f fakes) *fake { return f.coinbase }, []string{Mempool, Kraken}},
		{Kraken, 16 << 10, krakenAnswer(day), func(f fakes) *fake { return f.kraken }, []string{Mempool, Coinbase}},
	} {
		t.Run(c.name, func(t *testing.T) {
			ctx := context.Background()
			f := newFakes(t)
			now := at
			s, logs, _ := source(t, f, &now)
			c.pick(f).set(http.StatusOK, padded(c.body, c.limit))
			if err := s.Fetch(ctx); err != nil {
				t.Fatal(err)
			}
			if p, _ := s.Last(); !reflect.DeepEqual(p.From, all) {
				t.Fatalf("a body of %d bytes: from %v", c.limit, p.From)
			}
			c.pick(f).set(http.StatusOK, padded(c.body, c.limit+1))
			now = now.Add(5 * time.Minute)
			if err := s.Fetch(ctx); err != nil {
				t.Fatal(err)
			}
			if p, _ := s.Last(); !reflect.DeepEqual(p.From, c.rest) {
				t.Fatalf("a body of %d bytes: from %v", c.limit+1, p.From)
			}
			if lines(logs) != 1 || !strings.HasPrefix(logs.String(), "rates: "+c.name+" failed: ") ||
				!strings.HasSuffix(logs.String(), "; the others are still asked\n") {
				t.Fatalf("logged %q", logs.String())
			}
		})
	}
}

// A rates.json written before the three sources (no from) was mempool.space's
// alone, at its time.
func TestAnOldFileLoadsAsMempoolSpaces(t *testing.T) {
	file := filepath.Join(t.TempDir(), "rates.json")
	raw, err := json.Marshal(map[string]any{"time": mempoolTime, "per": day})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	logs := &bytes.Buffer{}
	s := New(closed, file, nil, func() time.Time { return at }, log.New(logs, "", 0))
	p, ok := s.Last()
	if !ok || p.Time != mempoolTime || p.MempoolTime != mempoolTime || !reflect.DeepEqual(p.From, []string{Mempool}) || !reflect.DeepEqual(p.Per, day) {
		t.Fatalf("last %+v %v", p, ok)
	}
	if w := Words(p); w != "from mempool.space (04:10:04)" {
		t.Fatalf("words %q", w)
	}
	if logs.Len() != 0 {
		t.Fatalf("logged %q", logs.String())
	}
}

// A round cut short by cardd stopping says nothing.
func TestAStoppingRoundSaysNothing(t *testing.T) {
	f := newFakes(t)
	f.kraken.hangs()
	now := at
	s, logs, _ := source(t, f, &now)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()
	if err := s.Fetch(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("a stopped round: %v", err)
	}
	if logs.Len() != 0 {
		t.Fatalf("logged %q", logs.String())
	}
	if _, ok := s.Last(); ok {
		t.Fatal("a stopped round took a rate")
	}
}

// With mempool.space alone, any other failure of it keeps the last rate and
// logs two lines: its failure and the round's. An answer is
// taken only if it parses, each of the seven is a positive number, its time
// is not more than 10 minutes ahead of cardd's clock, and its body is under
// 4 KiB.
func TestAFailureKeepsTheLastRate(t *testing.T) {
	later := mempoolTime + 30
	for _, c := range []struct {
		name   string
		status int
		body   string
		hang   bool
	}{
		{"HTTP 500", http.StatusInternalServerError, answer(later, nil), false},
		{"a timeout", 0, "", true},
		{"a body missing a currency", http.StatusOK, answer(later, map[string]string{"JPY": ""}), false},
		{"a price of 0", http.StatusOK, answer(later, map[string]string{"GBP": "0"}), false},
		{"a price under half a unit", http.StatusOK, answer(later, map[string]string{"GBP": "0.4"}), false},
		{"a negative price", http.StatusOK, answer(later, map[string]string{"EUR": "-72070"}), false},
		{"a price that isn't a number", http.StatusOK, answer(later, map[string]string{"USD": `"lots"`}), false},
		{"a price too large to hold", http.StatusOK, answer(later, map[string]string{"USD": "1e30"}), false},
		{"no time", http.StatusOK, strings.Replace(answer(later, nil), fmt.Sprintf(`"time":%d,`, later), "", 1), false},
		{"a time 11 minutes ahead of cardd's clock", http.StatusOK, answer(at.Unix()+11*60, nil), false},
		{"not JSON", http.StatusOK, "<html>busy</html>", false},
		{"a body over 4 KiB", http.StatusOK, "{" + strings.Repeat(" ", 4096) + answer(later, nil)[1:], false},
	} {
		t.Run(c.name, func(t *testing.T) {
			ctx := context.Background()
			f := newFakes(t)
			f.liveDown()
			now := at
			s, logs, _ := source(t, f, &now)
			s.timeout = 50 * time.Millisecond
			if err := s.Fetch(ctx); err != nil {
				t.Fatal(err)
			}
			kept, _ := s.Last()
			logs.Reset()
			if c.hang {
				f.mempool.hangs()
			} else {
				f.mempool.set(c.status, c.body)
			}
			if err := s.Fetch(ctx); err == nil {
				t.Fatal("no error")
			}
			if p, ok := s.Last(); !ok || !reflect.DeepEqual(p, kept) {
				t.Fatalf("the rate after the failure: %+v %v, want %+v", p, ok, kept)
			}
			if lines(logs) != 2 || !strings.HasPrefix(logs.String(), "rates: mempool.space failed: ") ||
				!strings.Contains(logs.String(), "\nrates: no source answered (mempool.space: ") {
				t.Fatalf("logged %q, want two lines", logs.String())
			}
			if strings.Contains(logs.String(), "http://") || strings.Contains(logs.String(), "Get ") {
				t.Fatalf("the request's URL is in the lines: %q", logs.String())
			}
			if c.hang && !strings.Contains(logs.String(), "mempool.space failed: context deadline exceeded;") {
				t.Fatalf("a timeout is not named plainly: %q", logs.String())
			}
		})
	}
}

// A fraction (mempool.space sends whole units today) is rounded to a whole
// unit, half up.
func TestAFractionIsRoundedToAWholeUnit(t *testing.T) {
	f := newFakes(t)
	f.liveDown()
	f.mempool.set(http.StatusOK, answer(mempoolTime, map[string]string{"GBP": "61352.5", "USD": "80854.49"}))
	now := at
	s, _, _ := source(t, f, &now)
	if err := s.Fetch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if gbp := lastPer(s)["GBP"]; gbp != 61353 {
		t.Fatalf("GBP %d, want 61353", gbp)
	}
	if usd := lastPer(s)["USD"]; usd != 80854 {
		t.Fatalf("USD %d, want 80854", usd)
	}
}

// An answer of mempool.space alone up to 10 minutes ahead of cardd's clock is
// taken, and one with the kept rate's own time too: neither is older.
func TestAnAnswerAheadOrAtTheSameTimeIsTaken(t *testing.T) {
	ctx := context.Background()
	f := newFakes(t)
	f.liveDown()
	ahead := at.Unix() + 9*60
	f.mempool.set(http.StatusOK, answer(ahead, nil))
	now := at
	s, logs, _ := source(t, f, &now)
	if err := s.Fetch(ctx); err != nil {
		t.Fatalf("9 minutes ahead: %v", err)
	}
	logs.Reset()
	f.mempool.set(http.StatusOK, answer(ahead, map[string]string{"GBP": "61400"}))
	if err := s.Fetch(ctx); err != nil {
		t.Fatalf("the same time again: %v", err)
	}
	if gbp := lastPer(s)["GBP"]; gbp != 61400 {
		t.Fatalf("GBP %d, want 61400", gbp)
	}
	if logs.Len() != 0 {
		t.Fatalf("logged %q", logs.String())
	}
}

// A price that moves over 20% from the kept one is logged, and taken: the
// size of a price isn't checked.
func TestABigMoveIsLoggedAndTaken(t *testing.T) {
	ctx := context.Background()
	f := newFakes(t)
	f.liveDown()
	now := at
	s, logs, _ := source(t, f, &now)
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	logs.Reset()
	f.mempool.set(http.StatusOK, answer(mempoolTime+300, map[string]string{"GBP": "80000"}))
	now = now.Add(5 * time.Minute)
	if err := s.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	if gbp := lastPer(s)["GBP"]; gbp != 80000 {
		t.Fatalf("GBP %d, want 80000", gbp)
	}
	if lines(logs) != 1 || !strings.Contains(logs.String(), "GBP moved over 20%") {
		t.Fatalf("logged %q", logs.String())
	}
}

// A rates.json cardd didn't write whole is logged and set aside at start:
// the server has no rate until its first fetch.
func TestAFileThatIsntARateIsIgnored(t *testing.T) {
	for _, content := range []string{"{}", `{"time":1,"per":{"GBP":1}}`, "not json"} {
		file := filepath.Join(t.TempDir(), "rates.json")
		if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		logs := &bytes.Buffer{}
		s := New(closed, file, nil, func() time.Time { return at }, log.New(logs, "", 0))
		if _, ok := s.Last(); ok {
			t.Fatalf("%q read as a rate", content)
		}
		if lines(logs) != 1 {
			t.Fatalf("%q: logged %q, want one line", content, logs.String())
		}
	}
}

// Run fetches at once (the rate is there seconds after start) and
// stops with its context.
func TestRunFetchesAtOnceAndStopsWithItsContext(t *testing.T) {
	f := newFakes(t)
	s := New(f.urls(), filepath.Join(t.TempDir(), "rates.json"), f.mempool.Client(), func() time.Time { return at }, log.New(io.Discard, "", 0))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if p, ok := s.Last(); ok {
			if !reflect.DeepEqual(p.From, all) {
				cancel()
				t.Fatalf("from %v", p.From)
			}
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("no rate 5 s after Run started")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run didn't stop with its context")
	}
}

// lastPer is the source's last prices by currency (nil with none).
func lastPer(s *Source) map[string]int64 {
	p, _ := s.Last()
	return p.Per
}
