package lnurl_test

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/lnurl"
	"github.com/boltcard/karto/server/internal/ratelimit"
)

// from fetches a public URL as Caddy hands on a request from the client at addr.
func (w *world) from(addr, path string) (int, http.Header, map[string]any) {
	w.t.Helper()
	req, _ := http.NewRequest("GET", w.pub.URL+path, nil)
	req.Header.Set("X-Forwarded-For", addr)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		w.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, resp.Header, out
}

// limited gives w's server a limiter of 2 at once per client, 3 overall, on a clock that stands still.
func (w *world) limited() {
	at := time.Now()
	w.s.Limit = ratelimit.New(ratelimit.Rate{Burst: 2, Every: 10 * time.Second}, ratelimit.Rate{Burst: 3, Every: time.Second}, 100,
		func() time.Time { return at })
}

func TestTooManyTopUpInvoicesAreRefused(t *testing.T) {
	w := setup(t)
	w.limited()
	for i := 0; i < 2; i++ {
		if code, _, out := w.from("203.0.113.7", "/lnurlp/pool/cb?amount=1000"); code != http.StatusOK || out["pr"] == nil {
			t.Fatalf("invoice %d: %d %v", i+1, code, out)
		}
	}
	made := w.f.Calls("/createinvoice")
	code, h, out := w.from("203.0.113.7", "/lnurlp/pool/cb?amount=1000")
	if code != http.StatusTooManyRequests || out["status"] != "ERROR" || out["reason"] != "This server is asked for too many invoices just now. Try again shortly." ||
		h.Get("Retry-After") != "10" || h.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("the 3rd: %d %v %v", code, h, out)
	}
	if w.f.Calls("/createinvoice") != made {
		t.Fatal("phoenixd was asked for an invoice over the limit")
	}
	// Another client still gets one, until the overall 3.
	if code, _, out := w.from("198.51.100.1", "/lnurlp/hosting/cb?amount=1000"); code != http.StatusOK || out["pr"] == nil {
		t.Fatalf("another client: %d %v", code, out)
	}
	if code, h, _ := w.from("198.51.100.2", "/lnurlp/pool/cb?amount=1000"); code != http.StatusTooManyRequests || h.Get("Retry-After") != "1" {
		t.Fatalf("over the overall cap: %d %v", code, h)
	}
}

func TestTooManyRefundInvoicesAreRefused(t *testing.T) {
	w := setup(t)
	w.limited()
	token := w.tapLink()
	for i := 0; i < 2; i++ {
		if code, _, out := w.from("203.0.113.7", "/refund/"+token+"/cb?amount=1000"); code != http.StatusOK || out["pr"] == nil {
			t.Fatalf("invoice %d: %d %v", i+1, code, out)
		}
	}
	made := w.f.Calls("/createinvoice")
	if code, _, out := w.from("203.0.113.7", "/refund/"+token+"/cb?amount=1000"); code != http.StatusTooManyRequests || out["status"] != "ERROR" {
		t.Fatalf("the 3rd: %d %v", code, out)
	}
	// The two callbacks share one limit.
	if code, _, _ := w.from("203.0.113.7", "/lnurlp/pool/cb?amount=1000"); code != http.StatusTooManyRequests {
		t.Fatalf("a top-up after the refunds: %d", code)
	}
	if w.f.Calls("/createinvoice") != made {
		t.Fatal("phoenixd was asked for an invoice over the limit")
	}
}

func TestARequestRefusedForItsAmountTakesNothing(t *testing.T) {
	w := setup(t)
	w.limited()
	for i := 0; i < 5; i++ {
		w.from("203.0.113.7", "/lnurlp/pool/cb?amount=1")
		w.from("203.0.113.7", "/lnurlp/nobody/cb?amount=1000")
	}
	if code, _, out := w.from("203.0.113.7", "/lnurlp/pool/cb?amount=1000"); code != http.StatusOK || out["pr"] == nil {
		t.Fatalf("after refusals: %d %v", code, out)
	}
}

func TestTheLimitIsLoggedNotOnEveryRefusal(t *testing.T) {
	w := setup(t)
	w.limited()
	var buf bytes.Buffer
	w.s.Log = log.New(&buf, "", 0)
	for i := 0; i < 10; i++ {
		w.from("203.0.113.7", "/lnurlp/pool/cb?amount=1000")
	}
	if n := strings.Count(buf.String(), "limit"); n != 1 {
		t.Fatalf("%d lines about the limit:\n%s", n, buf.String())
	}
	if strings.Contains(buf.String(), "203.0.113.7") {
		t.Fatalf("the log names the client: %s", buf.String())
	}
}

// cardd's own limit: 20 at once from one address, then one every 10 s.
func TestCarddsInvoiceLimit(t *testing.T) {
	at := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	l := lnurl.InvoiceLimit(func() time.Time { return at })
	for i := 0; i < 20; i++ {
		if ok, _ := l.Take("203.0.113.7"); !ok {
			t.Fatalf("take %d refused", i+1)
		}
	}
	if ok, retry := l.Take("203.0.113.7"); ok || retry != 10*time.Second {
		t.Fatalf("the 21st: %v, retry %v", ok, retry)
	}
}
