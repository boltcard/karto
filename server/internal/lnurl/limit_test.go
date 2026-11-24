package lnurl_test

import (
	"bytes"
	"encoding/json"
	"fmt"
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

// capped gives w's server a cap of 3 unpaid invoices an hour, 2 per client, on a clock the test moves.
func (w *world) capped(at *time.Time) {
	w.s.Unpaid = lnurl.NewUnpaidCap(lnurl.CapLimits{Window: time.Hour, Keep: time.Hour, Stranger: lnurl.Share{Overall: 3, PerClient: 2}, Known: lnurl.Share{Overall: 3, PerClient: 2}, KnownSat: 1000, KnownFor: 24 * time.Hour, KnownMax: 16}, func() time.Time { return *at })
}

// The invoices the public callbacks make and nobody pays stay in phoenixd's database for ever (it never
// deletes an expired one): at most so many an hour are made unpaid. A paid one frees its place at once.
func TestUnpaidInvoicesAreCapped(t *testing.T) {
	w := setup(t)
	at := time.Now()
	w.capped(&at)
	var prs []string
	for i, addr := range []string{"203.0.113.1", "203.0.113.2", "203.0.113.3"} {
		code, _, out := w.from(addr, "/lnurlp/pool/cb?amount=5000000")
		if code != http.StatusOK || out["pr"] == nil {
			t.Fatalf("invoice %d: %d %v", i+1, code, out)
		}
		prs = append(prs, out["pr"].(string))
	}
	made := w.f.Calls("/createinvoice")
	code, h, out := w.from("198.51.100.9", "/lnurlp/hosting/cb?amount=1000")
	if code != http.StatusTooManyRequests || out["status"] != "ERROR" ||
		out["reason"] != "This server has too many unpaid invoices just now. Try again later." || h.Get("Retry-After") != "3600" ||
		h.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("the 4th: %d %v %v", code, h, out)
	}
	if w.f.Calls("/createinvoice") != made {
		t.Fatal("phoenixd was asked for an invoice over the cap")
	}
	// The refund links share the cap.
	if code, _, _ := w.from("198.51.100.9", "/refund/"+w.tapLink()+"/cb?amount=1000"); code != http.StatusTooManyRequests {
		t.Fatalf("a refund over the cap: %d", code)
	}
	// One paid (the webhook credits it): its place is free.
	w.f.Receive(prs[1], 5000, 0)
	if w.balance("pool") != 5_000_000 {
		t.Fatalf("pool %d", w.balance("pool"))
	}
	if code, _, out := w.from("198.51.100.9", "/lnurlp/hosting/cb?amount=1000"); code != http.StatusOK || out["pr"] == nil {
		t.Fatalf("after a payment: %d %v", code, out)
	}
	at = at.Add(10 * time.Minute)
	if code, h, _ := w.from("198.51.100.8", "/lnurlp/hosting/cb?amount=1000"); code != http.StatusTooManyRequests || h.Get("Retry-After") != "3000" {
		t.Fatalf("ten minutes on: %d %v", code, h)
	}
	// An hour after the first ones were made, they leave the count.
	at = at.Add(50 * time.Minute)
	if code, _, out := w.from("198.51.100.8", "/lnurlp/hosting/cb?amount=1000"); code != http.StatusOK || out["pr"] == nil {
		t.Fatalf("an hour on: %d %v", code, out)
	}
}

// One client can't fill the cap: past its share it is refused, and others are not.
func TestOneClientHasAShareOfTheCap(t *testing.T) {
	w := setup(t)
	at := time.Now()
	w.capped(&at)
	token := w.tapLink()
	if code, _, _ := w.from("203.0.113.1", "/lnurlp/pool/cb?amount=1000"); code != http.StatusOK {
		t.Fatalf("first: %d", code)
	}
	at = at.Add(time.Minute)
	if code, _, _ := w.from("203.0.113.1", "/refund/"+token+"/cb?amount=1000"); code != http.StatusOK {
		t.Fatalf("second: %d", code)
	}
	code, h, out := w.from("203.0.113.1", "/lnurlp/pool/cb?amount=1000")
	if code != http.StatusTooManyRequests || h.Get("Retry-After") != "3540" || out["reason"] != "This server has too many unpaid invoices just now. Try again later." {
		t.Fatalf("over its share: %d %v %v", code, h, out)
	}
	if code, _, _ := w.from("203.0.113.2", "/lnurlp/pool/cb?amount=1000"); code != http.StatusOK {
		t.Fatalf("another client: %d", code)
	}
}

// A client that hangs up once phoenixd has been asked doesn't get its place back: phoenixd made the invoice.
func TestAClientHangingUpKeepsItsPlace(t *testing.T) {
	w := setup(t)
	at := time.Now()
	w.s.Unpaid = lnurl.NewUnpaidCap(lnurl.CapLimits{Window: time.Hour, Keep: time.Hour, Stranger: lnurl.Share{Overall: 3, PerClient: 1}, Known: lnurl.Share{Overall: 3, PerClient: 1}, KnownSat: 1000, KnownFor: 24 * time.Hour, KnownMax: 16}, func() time.Time { return at })
	w.f.InvoiceDelay = 300 * time.Millisecond
	req, _ := http.NewRequest("GET", w.pub.URL+"/lnurlp/pool/cb?amount=1000", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.1")
	if _, err := (&http.Client{Timeout: 50 * time.Millisecond}).Do(req); err == nil {
		t.Fatal("the client didn't hang up")
	}
	w.f.InvoiceDelay = 0
	deadline := time.Now().Add(5 * time.Second)
	for {
		code, _, _ := w.from("203.0.113.1", "/lnurlp/pool/cb?amount=1000")
		if code == http.StatusTooManyRequests {
			break
		}
		if code != http.StatusTooManyRequests && w.f.Calls("/createinvoice") > 1 {
			t.Fatalf("its place was given back: %d, %d invoices", code, w.f.Calls("/createinvoice"))
		}
		if time.Now().After(deadline) {
			t.Fatal("still no answer for the invoice the client hung up on")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if n := w.f.Calls("/createinvoice"); n != 1 {
		t.Fatalf("%d invoices", n)
	}
}

// An invoice phoenixd didn't make takes no place.
func TestAFailedInvoiceTakesNoPlace(t *testing.T) {
	w := setup(t)
	at := time.Now()
	w.capped(&at)
	w.f.SetDown(true)
	for i := 0; i < 5; i++ {
		if code, _, out := w.from("203.0.113.1", "/lnurlp/pool/cb?amount=1000"); out["status"] != "ERROR" || code == http.StatusTooManyRequests {
			t.Fatalf("phoenixd down %d: %d %v", i+1, code, out)
		}
	}
	w.f.SetDown(false)
	for i := 0; i < 2; i++ {
		if code, _, out := w.from("203.0.113.1", "/lnurlp/pool/cb?amount=1000"); code != http.StatusOK || out["pr"] == nil {
			t.Fatalf("invoice %d: %d %v", i+1, code, out)
		}
	}
}

// Places reserved for invoices being made count, so invoices asked for together never pass the cap; with
// only those holding the places, a place should be free within a second.
func TestUnpaidCapCountsInvoicesBeingMade(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := lnurl.NewUnpaidCap(lnurl.CapLimits{Window: time.Hour, Keep: time.Hour, Stranger: lnurl.Share{Overall: 2, PerClient: 2}, Known: lnurl.Share{Overall: 2, PerClient: 2}, KnownSat: 1000, KnownFor: 24 * time.Hour, KnownMax: 16}, func() time.Time { return at })
	la, ok, _ := c.Reserve("a")
	if !ok {
		t.Fatal("first")
	}
	lb, ok, _ := c.Reserve("b")
	if !ok {
		t.Fatal("second")
	}
	if _, ok, r := c.Reserve("c"); ok || !r.Overall || r.Retry != time.Second {
		t.Fatalf("third while two are being made: %v %+v", ok, r)
	}
	c.Release("a", la)
	c.Made("b", lb, "bb")
	at = at.Add(10 * time.Minute)
	la, ok, _ = c.Reserve("a")
	if !ok {
		t.Fatal("after a release")
	}
	c.Made("a", la, "aa")
	if _, ok, r := c.Reserve("c"); ok || r.Retry != 50*time.Minute {
		t.Fatalf("full: %v %+v", ok, r)
	}
	c.Paid("bb", 0)
	if _, ok, _ := c.Reserve("c"); !ok {
		t.Fatal("after a payment")
	}
}

// alerted gives w's server a cap on a clock the test moves, and records each alert: own=true for a known
// client over its own share, false for the whole cap. answer is what Capped returns (true: queued).
func (w *world) alerted(at *time.Time, window time.Duration, stranger, known lnurl.Share, answer func() bool) *[]bool {
	w.s.Unpaid = lnurl.NewUnpaidCap(lnurl.CapLimits{Window: window, Keep: 2 * window, Stranger: stranger, Known: known,
		KnownSat: 1000, KnownFor: 24 * time.Hour, KnownMax: 16}, func() time.Time { return *at })
	w.s.Now = func() time.Time { return *at }
	told := &[]bool{}
	w.s.Capped = func(own bool) bool {
		*told = append(*told, own)
		return answer()
	}
	return told
}

func yes() bool { return true }

// knownClient has addr bring 1,000 sat through an invoice of its own.
func (w *world) knownClient(t *testing.T, addr string) {
	t.Helper()
	code, _, out := w.from(addr, "/lnurlp/pool/cb?amount=1000000")
	if code != http.StatusOK || out["pr"] == nil {
		t.Fatalf("%s: %d %v", addr, code, out)
	}
	w.f.Receive(out["pr"].(string), 1000, 0)
}

// The owner is told when the whole cap turns payers away: at once, then after an hour, six hours, and then once a
// day while it goes on; a refusal more than an hour after the last starts afresh. A stranger refused at the
// strangers' limit while known clients still have room is the whole cap's refusal.
func TestTheOwnerIsToldWhenTheCapTurnsPayersAway(t *testing.T) {
	w := setup(t)
	at := time.Unix(1_790_000_000, 0)
	t0 := at
	told := w.alerted(&at, 100*time.Hour, lnurl.Share{Overall: 3, PerClient: 1}, lnurl.Share{Overall: 4, PerClient: 1}, yes)
	for _, addr := range []string{"203.0.113.1", "203.0.113.2", "203.0.113.3"} {
		if code, _, _ := w.from(addr, "/lnurlp/pool/cb?amount=1000"); code != http.StatusOK {
			t.Fatalf("%s: %d", addr, code)
		}
	}
	var when []time.Duration
	refuse := func() {
		t.Helper()
		n := len(*told)
		if code, _, _ := w.from("198.51.100.9", "/lnurlp/pool/cb?amount=1000"); code != http.StatusTooManyRequests {
			t.Fatalf("at %v: %d", at.Sub(t0), code)
		}
		if len(*told) > n {
			if (*told)[n] {
				t.Fatalf("at %v: told as one client's", at.Sub(t0))
			}
			when = append(when, at.Sub(t0))
		}
	}
	for at = t0; !at.After(t0.Add(56 * time.Hour)); at = at.Add(30 * time.Minute) {
		refuse()
	}
	want := []time.Duration{0, time.Hour, 7 * time.Hour, 31 * time.Hour, 55 * time.Hour}
	if fmt.Sprint(when) != fmt.Sprint(want) {
		t.Fatalf("told at %v, want %v", when, want)
	}
	at = t0.Add(57*time.Hour + 30*time.Minute) // 90 minutes after the last refusal
	refuse()
	if when[len(when)-1] != 57*time.Hour+30*time.Minute {
		t.Fatalf("a new flood wasn't told at once: %v", when)
	}
}

// A stranger over its own share is refused without a word to the owner: it may be the flood itself.
func TestAStrangerOverItsShareIsNotTold(t *testing.T) {
	w := setup(t)
	at := time.Unix(1_790_000_000, 0)
	told := w.alerted(&at, 10*time.Minute, lnurl.Share{Overall: 10, PerClient: 1}, lnurl.Share{Overall: 10, PerClient: 2}, yes)
	for i := 0; i < 4; i++ {
		w.from("203.0.113.1", "/lnurlp/pool/cb?amount=1000")
	}
	if len(*told) != 0 {
		t.Fatalf("told %v", *told)
	}
}

// A known client over its own share (a wallet's servers that many payers share) is told, at most once a day. Its
// share is its known places and a stranger's.
func TestAKnownClientOverItsShareIsToldOnceADay(t *testing.T) {
	w := setup(t)
	at := time.Unix(1_790_000_000, 0)
	t0 := at
	told := w.alerted(&at, 10*time.Minute, lnurl.Share{Overall: 10, PerClient: 1}, lnurl.Share{Overall: 10, PerClient: 2}, yes)
	over := func(addr string) {
		t.Helper()
		w.knownClient(t, addr)
		for i := 0; i < 3; i++ {
			if code, _, _ := w.from(addr, "/lnurlp/pool/cb?amount=1000"); code != http.StatusOK {
				t.Fatalf("%s %d: %d", addr, i+1, code)
			}
		}
		if code, _, _ := w.from(addr, "/lnurlp/pool/cb?amount=1000"); code != http.StatusTooManyRequests {
			t.Fatalf("%s over its share: %d", addr, code)
		}
	}
	over("203.0.113.1")
	if fmt.Sprint(*told) != "[true]" {
		t.Fatalf("first: %v", *told)
	}
	at = t0.Add(time.Hour)
	over("203.0.113.2")
	if len(*told) != 1 {
		t.Fatalf("within the day: %v", *told)
	}
	at = t0.Add(24 * time.Hour)
	over("203.0.113.3")
	if fmt.Sprint(*told) != "[true true]" {
		t.Fatalf("a day on: %v", *told)
	}
}

// An alert the sender couldn't queue doesn't count as told: the next refusal tries again.
func TestADroppedAlertIsToldAgain(t *testing.T) {
	w := setup(t)
	at := time.Unix(1_790_000_000, 0)
	answers := []bool{false, true}
	told := w.alerted(&at, 10*time.Minute, lnurl.Share{Overall: 1, PerClient: 1}, lnurl.Share{Overall: 1, PerClient: 1}, func() bool {
		a := answers[0]
		answers = answers[1:]
		return a
	})
	w.from("203.0.113.1", "/lnurlp/pool/cb?amount=1000")
	for i := 0; i < 3; i++ {
		at = at.Add(time.Minute)
		w.from("203.0.113.2", "/lnurlp/pool/cb?amount=1000")
	}
	if len(*told) != 2 {
		t.Fatalf("told %d times", len(*told))
	}
}

// Retry-After is the wait until a place is free for the client asking: for a known client refused by both lanes,
// the lane whose oldest invoice leaves first.
func TestRetryAfterIsTheWaitForAPlace(t *testing.T) {
	w := setup(t)
	at := time.Unix(1_790_000_000, 0)
	t0 := at
	w.alerted(&at, 10*time.Minute, lnurl.Share{Overall: 2, PerClient: 2}, lnurl.Share{Overall: 2, PerClient: 2}, yes)
	w.knownClient(t, "203.0.113.1")
	w.knownClient(t, "203.0.113.2")
	for i := 0; i < 2; i++ { // the known lane, made at t0
		if code, _, _ := w.from("203.0.113.1", "/lnurlp/pool/cb?amount=1000"); code != http.StatusOK {
			t.Fatalf("known %d: %d", i+1, code)
		}
	}
	at = t0.Add(time.Minute)
	for i := 0; i < 2; i++ { // the stranger lane, made at t0+1m
		if code, _, _ := w.from("198.51.100.1", "/lnurlp/pool/cb?amount=1000"); code != http.StatusOK {
			t.Fatalf("stranger %d: %d", i+1, code)
		}
	}
	at = t0.Add(2*time.Minute + 30*time.Second)
	if code, h, _ := w.from("203.0.113.2", "/lnurlp/pool/cb?amount=1000"); code != http.StatusTooManyRequests || h.Get("Retry-After") != "450" {
		t.Fatalf("%d %v", code, h.Get("Retry-After"))
	}
}

// The known places full is told on its own schedule, so a strangers' flood told before doesn't hide it.
func TestTheKnownLaneFullIsToldApartFromStrangers(t *testing.T) {
	w := setup(t)
	at := time.Unix(1_790_000_000, 0)
	t0 := at
	told := w.alerted(&at, 100*time.Hour, lnurl.Share{Overall: 1, PerClient: 1}, lnurl.Share{Overall: 1, PerClient: 1}, yes)
	w.knownClient(t, "203.0.113.1")
	w.knownClient(t, "203.0.113.2")
	ask := func(addr string, after time.Duration, want int) {
		t.Helper()
		at = t0.Add(after)
		if code, _, _ := w.from(addr, "/lnurlp/pool/cb?amount=1000"); code != want {
			t.Fatalf("%s at %v: %d, want %d", addr, after, code, want)
		}
	}
	ask("198.51.100.1", 0, http.StatusOK)                           // the stranger place
	ask("198.51.100.2", 0, http.StatusTooManyRequests)              // the strangers' cap: told
	ask("198.51.100.2", 10*time.Minute, http.StatusTooManyRequests) // not told again yet
	ask("203.0.113.1", 15*time.Minute, http.StatusOK)               // the known place
	ask("203.0.113.2", 20*time.Minute, http.StatusTooManyRequests)  // the known lane full: told
	ask("203.0.113.2", 30*time.Minute, http.StatusTooManyRequests)  // not again yet
	if fmt.Sprint(*told) != "[false false]" {
		t.Fatalf("told %v", *told)
	}
	ask("203.0.113.2", 80*time.Minute, http.StatusTooManyRequests) // an hour after it was told
	if fmt.Sprint(*told) != "[false false false]" {
		t.Fatalf("an hour on: told %v", *told)
	}
}
