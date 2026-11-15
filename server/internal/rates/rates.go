// Package rates is the price of a bitcoin in seven currencies, the middle of
// mempool.space's, Coinbase's and Kraken's prices, which cardd asks for every
// 5 minutes, and the arithmetic that turns an amount in one of them into
// sats. It imports only the standard library:
// the store, the cards and the API all use it.
package rates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// URLs are where the three sources are asked: cardd's flags may point them
// elsewhere, as its tests do.
type URLs struct{ Mempool, Coinbase, Kraken string }

// DefaultURLs are the three sources' own:
//   - mempool.space's prices: one object, whole units of each currency a
//     bitcoin, and the prices' time in Unix seconds, e.g.
//     {"time":1792037404,"USD":80854,"EUR":72070,"GBP":61352,...}.
//     Docs: https://mempool.space/docs/api/rest#get-price
//   - Coinbase's exchange rates for BTC: every currency it has, a bitcoin's
//     price in each as a decimal string.
//     Docs: https://docs.cdp.coinbase.com/coinbase-app/track-apis/exchange-rates
//   - Kraken's tickers for the seven BTC pairs; assetVersion=1 names them
//     BTC/USD, BTC/GBP, ..., as parseKraken reads them.
//     Docs: https://docs.kraken.com/api/docs/rest-api/get-ticker-information
var DefaultURLs = URLs{
	Mempool:  "https://mempool.space/api/v1/prices",
	Coinbase: "https://api.coinbase.com/v2/exchange-rates?currency=BTC",
	Kraken:   "https://api.kraken.com/0/public/Ticker?pair=XBTUSD,XBTEUR,XBTGBP,XBTCAD,XBTCHF,XBTAUD,XBTJPY&assetVersion=1",
}

// Currencies are the seven mempool.space quotes: a server's currency and a
// card's limits are in one of them.
var Currencies = []string{"USD", "EUR", "GBP", "CAD", "CHF", "AUD", "JPY"}

// Known reports whether c is one of the seven.
func Known(c string) bool { return slices.Contains(Currencies, c) }

// Decimals is how many digits a currency's minor unit has: yen have none.
func Decimals(c string) int {
	if c == "JPY" {
		return 0
	}
	return 2
}

// Symbol is what the apps write before an amount in the currency
// (app/src/money/fiat.ts): "£", "€", "$", "CA$", "A$", "CHF " and "¥".
func Symbol(c string) string {
	switch c {
	case "GBP":
		return "£"
	case "EUR":
		return "€"
	case "USD":
		return "$"
	case "CAD":
		return "CA$"
	case "AUD":
		return "A$"
	case "CHF":
		return "CHF "
	case "JPY":
		return "¥"
	}
	return c + " "
}

// MinorText writes minor units (0 or more) of a currency as the apps do:
// "£1,227.04", "¥255,600", "CHF 4.20".
func MinorText(minor int64, c string) string {
	if Decimals(c) == 0 {
		return Symbol(c) + Thousands(minor)
	}
	return fmt.Sprintf("%s%s.%02d", Symbol(c), Thousands(minor/100), minor%100)
}

// Thousands writes n (0 or more) with a comma between each three digits.
func Thousands(n int64) string {
	s := strconv.FormatInt(n, 10)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// ErrNoRate is the refusal of an amount in a currency cardd has had no rate
// for since it started: answered "no_rate".
var ErrNoRate = errors.New("rates: no rate yet")

// NoRate is ErrNoRate in the phone's words: "No £ rate yet: " and then what
// to do instead, as "type the price in sat.".
func NoRate(currency, then string) error { return noRate{currency, then} }

type noRate struct{ currency, then string }

func (e noRate) Error() string {
	return "No " + strings.TrimSpace(Symbol(e.currency)) + " rate yet: " + e.then
}

func (e noRate) Is(target error) bool { return target == ErrNoRate }

// Prices are a bitcoin's price in each of the seven currencies, whole units,
// as the sources answered them. Per and From are never changed once made:
// Last's callers may read them without a copy.
type Prices struct {
	Time        int64            `json:"time"` // the rate's time, Unix seconds
	Per         map[string]int64 `json:"per"`
	From        []string         `json:"from,omitempty"`        // the sources taken, in the order of Mempool, Coinbase, Kraken
	MempoolTime int64            `json:"mempoolTime,omitempty"` // mempool.space's own time, when it is among From
}

// whole reports whether p has a time and a price of at least 1 in each of
// the seven currencies.
func whole(p Prices) bool {
	for _, c := range Currencies {
		if p.Per[c] < 1 {
			return false
		}
	}
	return p.Time > 0
}

const (
	every     = 5 * time.Minute  // between rounds
	busyHold  = 30 * time.Minute // a source that answered 429 isn't asked for this long
	fetchWait = 10 * time.Second // each source's time limit
	maxAhead  = 10 * time.Minute // how far mempool.space's time may be ahead of cardd's clock
)

// feed is one source: where it is asked, the most its answer's body may be
// and how the answer is read; and, under Source.mu, whether it is failing
// and until when a 429 holds it.
type feed struct {
	name, url string
	limit     int64
	parse     func([]byte) (quote, error)

	failing   bool      // its failure has been logged, its return not yet
	heldUntil time.Time // not asked before this, after a 429
}

// Source asks the three sources for their prices every 5 minutes and keeps
// the middle of their answers in memory and in a file beside the database:
// not in the database, whose backup makes a new version
// whenever it changes. Safe for use by several goroutines.
type Source struct {
	file    string
	client  *http.Client
	now     func() time.Time
	log     *log.Logger
	timeout time.Duration // each source's; fetchWait (tests shorten it)

	mu    sync.Mutex
	feeds []*feed // in From's order
	last  Prices
	have  bool
}

// New makes a Source asking urls (DefaultURLs in cardd) and keeping its rate
// in file (rates.json in cardd's data directory). The file's rate, if it is
// one, is the last rate until the first round: a restart has a rate at once.
// A file written before the three sources (no from) was
// mempool.space's alone, at its time. A nil client is a plain
// http.Client; a nil logger, the standard one.
func New(urls URLs, file string, client *http.Client, now func() time.Time, logger *log.Logger) *Source {
	if client == nil {
		client = &http.Client{}
	}
	if logger == nil {
		logger = log.Default()
	}
	s := &Source{file: file, client: client, now: now, log: logger, timeout: fetchWait, feeds: []*feed{
		{name: Mempool, url: urls.Mempool, limit: 4 << 10, parse: parseMempool},      // an answer is ~120 bytes
		{name: Coinbase, url: urls.Coinbase, limit: 128 << 10, parse: parseCoinbase}, // ~21 KB: every currency Coinbase has
		{name: Kraken, url: urls.Kraken, limit: 16 << 10, parse: parseKraken},        // ~2 KB
	}}
	raw, err := os.ReadFile(file)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		logger.Printf("rates: %v; no rate until the first fetch", err)
	default:
		var p Prices
		if err := json.Unmarshal(raw, &p); err != nil || !whole(p) {
			logger.Printf("rates: %s isn't a rate cardd wrote; no rate until the first fetch", file)
		} else {
			if len(p.From) == 0 {
				p.From, p.MempoolTime = []string{Mempool}, p.Time
			}
			s.last, s.have = p, true
		}
	}
	return s
}

// Last is the last good answer, or false when there has been none.
func (s *Source) Last() (Prices, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.last, s.have
}

// errBusy is a source's HTTP 429: it is held for 30 minutes.
var errBusy = errors.New("answered 429 Too Many Requests")

// Fetch is one round: every source not on hold is asked at
// once, each under its own time limit, and the middle of the good answers is
// taken. A source's failure is logged when it starts and when it ends, a 429
// with its hold; a round that takes nothing logs why, and the last rate is
// kept. The error is nil when a rate was taken, or none was needed: the kept
// rate is newer than mempool.space's alone, or every source is on hold.
// Otherwise it says why nothing was taken: no source answered, two were more
// than 5% apart, or ctx is done (cardd is stopping: nothing is logged).
func (s *Source) Fetch(ctx context.Context) error {
	start := s.now()
	s.mu.Lock()
	var asked []*feed
	held := map[*feed]string{} // a source on hold, and why it wasn't asked
	for _, f := range s.feeds {
		if !start.Before(f.heldUntil) {
			asked = append(asked, f)
		} else {
			held[f] = "held until " + f.heldUntil.UTC().Format("15:04")
		}
	}
	s.mu.Unlock()
	if len(asked) == 0 {
		return nil
	}
	quotes := make([]quote, len(asked))
	errs := make([]error, len(asked))
	var wg sync.WaitGroup
	for i, f := range asked {
		wg.Add(1)
		go func() {
			defer wg.Done()
			quotes[i], errs[i] = s.get(ctx, f)
		}()
	}
	wg.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}

	// What each source said, logged once the lock is let go.
	var said []string
	var taken []named
	why := map[*feed]string{}
	s.mu.Lock()
	for i, f := range asked {
		err := errs[i]
		if err == nil && f.name == Mempool {
			if ahead := time.Unix(quotes[i].time, 0).Sub(start); ahead > maxAhead {
				err = fmt.Errorf("its time is %s ahead of cardd's clock", ahead.Round(time.Second))
			}
		}
		switch {
		case errors.Is(err, errBusy):
			f.heldUntil = start.Add(busyHold)
			said = append(said, fmt.Sprintf("rates: %s %v: not asked until %s", f.name, err, f.heldUntil.UTC().Format("15:04")))
		case err != nil && !f.failing:
			said = append(said, fmt.Sprintf("rates: %s failed: %s; the others are still asked", f.name, reason(err)))
		case err == nil && f.failing:
			said = append(said, fmt.Sprintf("rates: %s answers again", f.name))
		}
		f.failing = err != nil
		if err != nil {
			why[f] = reason(err)
		} else {
			taken = append(taken, named{f.name, quotes[i]})
		}
	}
	last, had := s.last, s.have
	var reasons []string // in the sources' order, the held ones too
	for _, f := range s.feeds {
		if r, ok := held[f]; ok {
			reasons = append(reasons, f.name+": "+r)
		} else if r, ok := why[f]; ok {
			reasons = append(reasons, f.name+": "+r)
		}
	}
	s.mu.Unlock()

	kept := "there is no rate yet"
	if had {
		kept = "the rate " + Words(last) + " is kept"
	}
	per, err := middle(taken)
	var apart apartError
	switch {
	case errors.Is(err, errNone):
		said = append(said, fmt.Sprintf("rates: no source answered (%s); %s", strings.Join(reasons, ", "), kept))
	case errors.As(err, &apart):
		said = append(said, fmt.Sprintf("rates: %s and %s are more than 5%% apart (%s %s and %s); %s",
			apart.A.Name, apart.B.Name, apart.Currency, Thousands(apart.A.Price), Thousands(apart.B.Price), kept))
	}
	for _, line := range said {
		s.log.Print(line)
	}
	if err != nil {
		return err
	}
	// The rate's time: cardd's clock at the round's start when
	// Coinbase or Kraken is among the sources, as their prices are as of the
	// request; mempool.space's own when it is alone.
	p := Prices{Time: start.Unix(), Per: per}
	for _, n := range taken {
		p.From = append(p.From, n.name)
		if n.name == Mempool {
			p.MempoolTime = n.q.time
		}
	}
	if len(taken) == 1 && taken[0].name == Mempool {
		p.Time = p.MempoolTime
	}
	s.take(p)
	return nil
}

// reason is a source's failure without the package's prefix, for a line
// that has it already.
// A transport failure is named without the request's URL, which the line
// has no use for.
func reason(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return strings.TrimPrefix(err.Error(), "rates: ")
}

// Run asks at once, then every 5 minutes, until ctx is done.
func (s *Source) Run(ctx context.Context) {
	for {
		s.Fetch(ctx)
		t := time.NewTimer(every)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// get asks one source for its prices: one request, under the time limit,
// its body read under the source's size limit.
func (s *Source) get(ctx context.Context, f *feed) (quote, error) {
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.url, nil)
	if err != nil {
		return quote{}, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return quote{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests {
		return quote{}, errBusy
	}
	if resp.StatusCode != http.StatusOK {
		return quote{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(http.MaxBytesReader(nil, resp.Body, f.limit))
	if err != nil {
		return quote{}, fmt.Errorf("reading the answer: %w", err)
	}
	return f.parse(body)
}

// take keeps a round's rate, unless it is mempool.space's alone and older
// than the kept rate, which is newer: no change, and no failure.
// It logs a price that moved over 20% and writes the file.
func (s *Source) take(p Prices) {
	s.mu.Lock()
	last, had := s.last, s.have
	if had && p.Time < last.Time && slices.Equal(p.From, []string{Mempool}) {
		s.mu.Unlock()
		return
	}
	s.last, s.have = p, true
	s.mu.Unlock()
	if had {
		for _, c := range Currencies {
			was, now := float64(last.Per[c]), float64(p.Per[c])
			if math.Abs(now-was) > 0.2*was {
				s.log.Printf("rates: %s moved over 20%%, from %d to %d a bitcoin", c, last.Per[c], p.Per[c])
			}
		}
	}
	if err := s.keep(p); err != nil {
		s.log.Printf("rates: the rate is in use but not kept for a restart: %v", err)
	}
}

// keep writes p to the file whole: to a temporary name beside it, then
// renamed over it.
func (s *Source) keep(p Prices) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(s.file), ".rates-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name()) // nothing to remove once renamed
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), s.file)
}

// MaxMinor is the most minor units an amount typed in a currency may be:
// £100 million, checked before any arithmetic.
const MaxMinor int64 = 10_000_000_000

// scale is 10^decimals of the currency.
func scale(c string) *big.Int {
	if Decimals(c) == 0 {
		return big.NewInt(1)
	}
	return big.NewInt(100)
}

// SatForMinor is a price of minor units (0 or more) as whole sats at
// pricePerBTC: round(minor × 10^8 / (price × 10^decimals)), half
// up. Worked in big integers, so no figure overflows; 0 for a price under 1.
// The phones' preview (app/src/money/fiat.ts, minorToMsat) is the same sum.
func SatForMinor(minor, pricePerBTC int64, currency string) int64 {
	if pricePerBTC < 1 || minor < 0 {
		return 0
	}
	num := new(big.Int).Mul(big.NewInt(minor), big.NewInt(100_000_000))
	den := new(big.Int).Mul(big.NewInt(pricePerBTC), scale(currency))
	return halfUp(num, den)
}

// MsatForMinorDown is a limit of minor units (0 or more) as msat at
// pricePerBTC, rounded down to the msat: what a tap is checked
// against. It saturates at math.MaxInt64; the caller caps it.
func MsatForMinorDown(minor, pricePerBTC int64, currency string) int64 {
	if pricePerBTC < 1 || minor < 0 {
		return 0
	}
	num := new(big.Int).Mul(big.NewInt(minor), big.NewInt(100_000_000_000))
	den := new(big.Int).Mul(big.NewInt(pricePerBTC), scale(currency))
	return clamp(num.Quo(num, den))
}

// MinorForSat is sats as minor units of a currency at pricePerBTC, to the
// nearest (half up): the 2,000,000 sat cap in the currency, for a refusal's
// words.
func MinorForSat(sat, pricePerBTC int64, currency string) int64 {
	if pricePerBTC < 1 || sat < 0 {
		return 0
	}
	num := new(big.Int).Mul(big.NewInt(sat), big.NewInt(pricePerBTC))
	num.Mul(num, scale(currency))
	return halfUp(num, big.NewInt(100_000_000))
}

// halfUp is num/den rounded half up, for num ≥ 0 and den > 0: (2·num + den) / (2·den).
func halfUp(num, den *big.Int) int64 {
	n := new(big.Int).Lsh(num, 1)
	n.Add(n, den)
	d := new(big.Int).Lsh(den, 1)
	return clamp(n.Quo(n, d))
}

// clamp is n as an int64, or math.MaxInt64 when it is larger.
func clamp(n *big.Int) int64 {
	if n.IsInt64() {
		return n.Int64()
	}
	return math.MaxInt64
}
