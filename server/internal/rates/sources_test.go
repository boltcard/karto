package rates

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

const coinbaseBody = `{"data":{"currency":"BTC","rates":{"AED":"224689.1","AUD":"113070.2","CAD":"111044.5","CHF":"64000.5","EUR":"70710.9","GBP":"61176.13","JPY":"12881983.80771","USD":"80852.3"}}}`

func TestParseCoinbase(t *testing.T) {
	q, err := parseCoinbase([]byte(coinbaseBody))
	if err != nil {
		t.Fatal(err)
	}
	if q.per["GBP"] != 61176 || q.per["JPY"] != 12881984 || q.time != 0 {
		t.Fatalf("got %v time %d", q.per, q.time)
	}
	if len(q.per) != 7 {
		t.Fatalf("want the seven currencies only, got %v", q.per)
	}
	bad := map[string]string{
		"base USD":    strings.Replace(coinbaseBody, `"BTC"`, `"USD"`, 1),
		"GBP missing": strings.Replace(coinbaseBody, `"GBP"`, `"GBX"`, 1),
		"GBP zero":    strings.Replace(coinbaseBody, `"61176.13"`, `"0"`, 1),
		"not JSON":    `<html>`,
	}
	for name, body := range bad {
		if _, err := parseCoinbase([]byte(body)); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func krakenBody(errs, cad, gbpBid string) string {
	return `{"error":` + errs + `,"result":{"BTC/USD":{"a":["80856.1","1","1.000"],"b":["80853.0","1","1.000"]},` +
		`"BTC/EUR":{"a":["70712.0","1","1.000"],"b":["70710.0","1","1.000"]},` +
		`"BTC/GBP":{"a":["61220.4","1","1.000"],"b":["` + gbpBid + `","1","1.000"]},` + cad +
		`"BTC/CHF":{"a":["64001.0","1","1.000"],"b":["64000.0","1","1.000"]},` +
		`"BTC/AUD":{"a":["113071.0","1","1.000"],"b":["113070.0","1","1.000"]},` +
		`"BTC/JPY":{"a":["12882000","1","1.000"],"b":["12881000","1","1.000"]}}}`
}

const krakenCAD = `"BTC/CAD":{"a":["111045.0","1","1.000"],"b":["111044.0","1","1.000"]},`

func TestParseKraken(t *testing.T) {
	q, err := parseKraken([]byte(krakenBody(`[]`, krakenCAD, "61217.6")))
	if err != nil {
		t.Fatal(err)
	}
	if q.per["GBP"] != 61219 || q.per["JPY"] != 12881500 || q.time != 0 {
		t.Fatalf("got %v time %d", q.per, q.time)
	}
	_, err = parseKraken([]byte(krakenBody(`["EAPI:Rate limit exceeded"]`, krakenCAD, "61217.6")))
	if err == nil || !strings.Contains(err.Error(), "EAPI:Rate limit exceeded") {
		t.Errorf("want the first error named, got %v", err)
	}
	if _, err := parseKraken([]byte(krakenBody(`[]`, "", "61217.6"))); err == nil {
		t.Error("CAD missing: want an error")
	}
	if _, err := parseKraken([]byte(krakenBody(`[]`, krakenCAD, "0"))); err == nil {
		t.Error("bid 0: want an error")
	}
	if _, err := parseKraken([]byte(`nope`)); err == nil {
		t.Error("not JSON: want an error")
	}
}

func TestParseMempoolKeepsItsTime(t *testing.T) {
	q, err := parseMempool([]byte(`{"time":1792037404,"USD":80854,"EUR":72070,"GBP":61352.4,"CAD":111000,"CHF":64000,"AUD":113000,"JPY":12880000}`))
	if err != nil {
		t.Fatal(err)
	}
	if q.time != 1792037404 || q.per["GBP"] != 61352 {
		t.Fatalf("got %v time %d", q.per, q.time)
	}
}

// gbp is a source's answer with GBP the only price that matters: the other
// six are the same everywhere.
func gbp(name string, price int64) named {
	per := map[string]int64{}
	for _, c := range Currencies {
		per[c] = 1000
	}
	per["GBP"] = price
	return named{name, quote{per: per}}
}

func TestMiddle(t *testing.T) {
	got := func(qs ...named) int64 {
		t.Helper()
		m, err := middle(qs)
		if err != nil {
			t.Fatal(err)
		}
		return m["GBP"]
	}
	if g := got(gbp(Mempool, 61000), gbp(Coinbase, 61300), gbp(Kraken, 61200)); g != 61200 {
		t.Errorf("three: got %d", g)
	}
	if g := got(gbp(Mempool, 61000), gbp(Kraken, 61301)); g != 61151 {
		t.Errorf("two: got %d", g)
	}
	if g := got(gbp(Coinbase, 60000), gbp(Kraken, 63000)); g != 61500 {
		t.Errorf("two at exactly 5%%: got %d", g)
	}
	if g := got(gbp(Kraken, 61219)); g != 61219 {
		t.Errorf("one: got %d", g)
	}
	_, err := middle([]named{gbp(Mempool, 60000), gbp(Coinbase, 63001)})
	var ap apartError
	if !errors.As(err, &ap) || ap.Currency != "GBP" {
		t.Fatalf("want apartError for GBP, got %v", err)
	}
	if !strings.Contains(err.Error(), "mempool.space") || !strings.Contains(err.Error(), "63,001") {
		t.Errorf("the error should name both figures: %v", err)
	}
	if _, err := middle(nil); !errors.Is(err, errNone) {
		t.Errorf("none: got %v", err)
	}
}

func TestMiddleNamesTheCurrencyMostApart(t *testing.T) {
	a, b := gbp(Mempool, 60000), gbp(Kraken, 61000)
	a.q.per["EUR"], b.q.per["EUR"] = 1000, 1100 // 10% apart
	a.q.per["CAD"], b.q.per["CAD"] = 1000, 2000 // 100% apart
	var ap apartError
	if _, err := middle([]named{a, b}); !errors.As(err, &ap) || ap.Currency != "CAD" {
		t.Fatalf("want CAD, got %v", err)
	}
}

func TestMiddleDoesNotOverflow(t *testing.T) {
	m, err := middle([]named{gbp(Mempool, math.MaxInt64), gbp(Coinbase, math.MaxInt64-1)})
	if err != nil {
		t.Fatal(err)
	}
	if m["GBP"] != math.MaxInt64 { // 2^63-1.5 rounds half up to 2^63-1
		t.Errorf("got %d", m["GBP"])
	}
}

func TestWords(t *testing.T) {
	at := time.Date(2026, 10, 17, 7, 22, 51, 0, time.UTC).Unix()
	mt := time.Date(2026, 10, 17, 7, 20, 6, 0, time.UTC).Unix()
	for _, c := range []struct {
		p    Prices
		want string
	}{
		{Prices{Time: at, From: []string{Mempool, Coinbase, Kraken}, MempoolTime: mt}, "from mempool.space (07:20:06), Coinbase and Kraken at 07:22:51"},
		{Prices{Time: at, From: []string{Coinbase, Kraken}}, "from Coinbase and Kraken at 07:22:51"},
		{Prices{Time: mt, From: []string{Mempool}, MempoolTime: mt}, "from mempool.space (07:20:06)"},
		{Prices{Time: at, From: []string{Kraken}}, "from Kraken at 07:22:51"},
		{Prices{Time: at, From: []string{Mempool, Kraken}, MempoolTime: mt}, "from mempool.space (07:20:06) and Kraken at 07:22:51"},
		{Prices{Time: mt}, "from mempool.space (07:20:06)"},
	} {
		if got := Words(c.p); got != c.want {
			t.Errorf("got %q, want %q", got, c.want)
		}
	}
}
