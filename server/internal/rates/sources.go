package rates

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The names of the three sources, in the order Prices.From keeps them.
const (
	Mempool  = "mempool.space"
	Coinbase = "Coinbase"
	Kraken   = "Kraken"
)

// quote is one source's answer: a price in each of the seven currencies, and
// the time the source gave, which only mempool.space does (0 for the others,
// whose prices are as of the request).
type quote struct {
	per  map[string]int64
	time int64
}

// named is a quote and the source it came from.
type named struct {
	name string
	q    quote
}

// price reads a decimal price as a whole unit, rounded half up. A price too
// large for an int64 is no more a price than a word is.
func price(s string) (int64, error) {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("%q isn't a number cardd can use", s)
	}
	return priceOf(f)
}

// priceOf is price for a number already read.
func priceOf(f float64) (int64, error) {
	if math.IsNaN(f) || f >= math.MaxInt64 {
		return 0, fmt.Errorf("%v isn't a number cardd can use", f)
	}
	v := int64(math.Round(f))
	if v < 1 {
		return 0, fmt.Errorf("%v isn't a positive number", f)
	}
	return v, nil
}

// parseMempool reads mempool.space's answer: its time, and each of the seven
// currencies as a positive number, a fraction rounded half up to a whole
// unit.
// Docs: https://mempool.space/docs/api/rest#get-price
func parseMempool(body []byte) (quote, error) {
	var raw map[string]json.Number
	if err := json.NewDecoder(bytes.NewReader(body)).Decode(&raw); err != nil {
		return quote{}, fmt.Errorf("rates: the answer isn't mempool.space's prices: %w", err)
	}
	t, err := strconv.ParseInt(raw["time"].String(), 10, 64)
	if err != nil || t <= 0 {
		return quote{}, errors.New("rates: the answer has no time")
	}
	q := quote{per: map[string]int64{}, time: t}
	for _, c := range Currencies {
		n, ok := raw[c]
		if !ok {
			return quote{}, fmt.Errorf("rates: the answer has no %s price", c)
		}
		v, err := price(n.String())
		if err != nil {
			return quote{}, fmt.Errorf("rates: the answer's %s price %w", c, err)
		}
		q.per[c] = v
	}
	return q, nil
}

// parseCoinbase reads Coinbase's exchange rates for BTC: each of the seven
// currencies a positive decimal in a string, rounded half up. Other currencies
// in the answer are ignored.
// Docs: https://docs.cdp.coinbase.com/coinbase-app/track-apis/exchange-rates
func parseCoinbase(body []byte) (quote, error) {
	var raw struct {
		Data struct {
			Currency string            `json:"currency"`
			Rates    map[string]string `json:"rates"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return quote{}, fmt.Errorf("rates: the answer isn't Coinbase's rates: %w", err)
	}
	if raw.Data.Currency != "BTC" {
		return quote{}, fmt.Errorf("rates: Coinbase's rates are for %q, not BTC", raw.Data.Currency)
	}
	q := quote{per: map[string]int64{}}
	for _, c := range Currencies {
		s, ok := raw.Data.Rates[c]
		if !ok {
			return quote{}, fmt.Errorf("rates: Coinbase's answer has no %s rate", c)
		}
		v, err := price(s)
		if err != nil {
			return quote{}, fmt.Errorf("rates: Coinbase's %s rate %w", c, err)
		}
		q.per[c] = v
	}
	return q, nil
}

// parseKraken reads Kraken's tickers for the seven BTC pairs: a price is the
// middle of the best bid and the best ask, both positive, rounded half up. A
// non-empty error list is a failure, named by its first entry.
// Docs: https://docs.kraken.com/api/docs/rest-api/get-ticker-information
func parseKraken(body []byte) (quote, error) {
	var raw struct {
		Error  []string `json:"error"`
		Result map[string]struct {
			Ask []string `json:"a"`
			Bid []string `json:"b"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return quote{}, fmt.Errorf("rates: the answer isn't Kraken's tickers: %w", err)
	}
	if len(raw.Error) > 0 {
		return quote{}, fmt.Errorf("rates: Kraken answered %s", raw.Error[0])
	}
	q := quote{per: map[string]int64{}}
	for _, c := range Currencies {
		t, ok := raw.Result["BTC/"+c]
		if !ok || len(t.Ask) == 0 || len(t.Bid) == 0 {
			return quote{}, fmt.Errorf("rates: Kraken's answer has no BTC/%s ticker", c)
		}
		ask, err := strconv.ParseFloat(t.Ask[0], 64)
		if err != nil || ask <= 0 {
			return quote{}, fmt.Errorf("rates: Kraken's %s ask %q isn't a positive number", c, t.Ask[0])
		}
		bid, err := strconv.ParseFloat(t.Bid[0], 64)
		if err != nil || bid <= 0 {
			return quote{}, fmt.Errorf("rates: Kraken's %s bid %q isn't a positive number", c, t.Bid[0])
		}
		v, err := priceOf((bid + ask) / 2)
		if err != nil {
			return quote{}, fmt.Errorf("rates: Kraken's %s middle price %w", c, err)
		}
		q.per[c] = v
	}
	return q, nil
}

// errNone is a round in which no source gave a price.
var errNone = errors.New("rates: no source answered")

// figure is one source's price in a currency.
type figure struct {
	Name  string
	Price int64
}

// apartError is two sources more than 5% apart in a currency, the one that
// differs most: neither is taken, as there is no third to say which is right.
type apartError struct {
	Currency string
	A, B     figure
}

func (e apartError) Error() string {
	return fmt.Sprintf("rates: %s and %s are more than 5%% apart in %s (%s and %s a bitcoin); neither is taken",
		e.A.Name, e.B.Name, e.Currency, Thousands(e.A.Price), Thousands(e.B.Price))
}

// middle is the price of each currency from the sources taken:
// the median of three, the mean of two (half up) unless they are more than 5%
// apart in some currency, and one's own.
func middle(qs []named) (map[string]int64, error) {
	if len(qs) == 0 {
		return nil, errNone
	}
	out := map[string]int64{}
	switch len(qs) {
	case 1:
		for _, c := range Currencies {
			out[c] = qs[0].q.per[c]
		}
	case 2:
		a, b := qs[0], qs[1]
		var worst *apartError
		var worstDiff, worstMin int64
		for _, c := range Currencies {
			x, y := a.q.per[c], b.q.per[c]
			lo, hi := min(x, y), max(x, y)
			diff := hi - lo
			// diff × 20 > lo, without the multiply: for whole numbers it is
			// diff > lo/20 rounded down.
			if diff > lo/20 {
				// Largest diff/lo: diff × worstMin > worstDiff × lo.
				l := new(big.Int).Mul(big.NewInt(diff), big.NewInt(worstMin))
				r := new(big.Int).Mul(big.NewInt(worstDiff), big.NewInt(lo))
				if worst == nil || l.Cmp(r) > 0 {
					worst = &apartError{c, figure{a.name, x}, figure{b.name, y}}
					worstDiff, worstMin = diff, lo
				}
			}
			sum := new(big.Int).Add(big.NewInt(x), big.NewInt(y))
			out[c] = halfUp(sum, big.NewInt(2))
		}
		if worst != nil {
			return nil, *worst
		}
	default:
		for _, c := range Currencies {
			ps := make([]int64, len(qs))
			for i, q := range qs {
				ps[i] = q.q.per[c]
			}
			slices.Sort(ps)
			out[c] = ps[len(ps)/2]
		}
	}
	return out, nil
}

// Words is where a rate came from, for the log: "from mempool.space
// (07:20:06), Coinbase and Kraken at 07:22:51". mempool.space's own time is in
// brackets beside its name; the rate's time follows "at" when Coinbase or
// Kraken is among the sources. Times are UTC. A rate with no From was
// mempool.space's alone, at the rate's time.
func Words(p Prices) string {
	from, mt := p.From, p.MempoolTime
	if len(from) == 0 {
		from, mt = []string{Mempool}, p.Time
	}
	names := make([]string, len(from))
	live := false
	for i, n := range from {
		names[i] = n
		if n == Mempool {
			names[i] += " (" + clock(mt) + ")"
		} else {
			live = true
		}
	}
	s := "from " + names[0]
	if len(names) > 1 {
		s = "from " + strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
	}
	if live {
		s += " at " + clock(p.Time)
	}
	return s
}

// clock is a Unix time as hh:mm:ss in UTC.
func clock(unix int64) string { return time.Unix(unix, 0).UTC().Format("15:04:05") }
