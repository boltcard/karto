package renew_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/lnaddr"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/renew"
	"github.com/boltcard/karto/server/internal/store"
)

// fakeLNVPS answers the VM's Lightning-address routes as LNVPS does
// (lnvps_api/src/api/routes.rs, v1_lnurlp and v1_renew_vm_lnurlp): its
// invoices come from the fake phoenixd, described "VM renewal 1009 to <the
// expiry the amount buys>". A test changes it with with().
type fakeLNVPS struct {
	*httptest.Server
	f          *phoenixdtest.Fake
	mu         sync.Mutex
	expires    time.Time // the VM's real expiry
	msatPerDay int64
	asked      int       // pay requests answered
	until      time.Time // the expiry in the last invoice's description
	metadata   string    // the pay request's text/plain
	memo       func(until time.Time) string
	callback   string   // the callback's host
	extraMsat  int64    // added to each invoice's amount
	down       bool     // every route answers HTTP 500
	fail       bool     // the payment of each invoice fails
	hang       bool     // the payment of each invoice hangs until the test releases it
	hashes     []string // every invoice's payment hash, oldest first
}

func (lv *fakeLNVPS) with(change func(lv *fakeLNVPS)) {
	lv.mu.Lock()
	defer lv.mu.Unlock()
	change(lv)
}

func (lv *fakeLNVPS) get() fakeLNVPS {
	lv.mu.Lock()
	defer lv.mu.Unlock()
	return fakeLNVPS{asked: lv.asked, until: lv.until, hashes: append([]string(nil), lv.hashes...)}
}

func (lv *fakeLNVPS) serve(w http.ResponseWriter, r *http.Request) {
	lv.mu.Lock()
	defer lv.mu.Unlock()
	if lv.down {
		http.Error(w, "upstream down", http.StatusInternalServerError)
		return
	}
	switch r.URL.Path {
	case "/.well-known/lnurlp/" + vmID:
		lv.asked++
		meta, _ := json.Marshal([][]string{{"text/plain", lv.metadata}})
		json.NewEncoder(w).Encode(map[string]any{"tag": "payRequest", "callback": "http://" + lv.callback + "/api/v1/vm/" + vmID + "/renew-lnurlp",
			"minSendable": 100_000, "maxSendable": 1_000_000_000, "metadata": string(meta)})
	case "/api/v1/vm/" + vmID + "/renew-lnurlp":
		var amount int64
		fmt.Sscan(r.URL.Query().Get("amount"), &amount)
		lv.until = lv.expires.Add(time.Duration(amount*86_400/lv.msatPerDay) * time.Second)
		bolt11, hash := lv.f.InvoiceWithDescription(amount+lv.extraMsat, lv.memo(lv.until))
		lv.hashes = append(lv.hashes, hash)
		if lv.fail || lv.hang {
			lv.f.SetOutcome(hash, phoenixdtest.Outcome{Fail: lv.fail, Hang: lv.hang})
		}
		json.NewEncoder(w).Encode(map[string]any{"pr": bolt11, "routes": []any{}})
	default:
		http.NotFound(w, r)
	}
}

// lnvpsSetup is setup with LNVPS: the renewer's resolver reaches the fake
// for every host, and is pinned to api.lnvps.net as cardd's is.
func lnvpsSetup(t *testing.T, hostingSat int64) (*world, *fakeLNVPS) {
	t.Helper()
	w := setup(t, hostingSat)
	lv := &fakeLNVPS{f: w.f, expires: t0, msatPerDay: 221_395, metadata: "Extend VM " + vmID, callback: "api.lnvps.net",
		memo: func(until time.Time) string { return memo(vmID, until) }}
	lv.Server = httptest.NewServer(http.HandlerFunc(lv.serve))
	t.Cleanup(lv.Close)
	tr := &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, lv.Listener.Addr().String())
	}}
	w.r.Resolver = &lnaddr.Resolver{HTTP: &http.Client{Transport: tr}, Scheme: "http"}
	return w, lv
}

// syncBoth sets the VM's real expiry at LNVPS and syncs it: daysLeft from w.now.
func (w *world) syncBoth(t *testing.T, lv *fakeLNVPS, daysLeft, satPerDay float64, vatOK bool) {
	t.Helper()
	lv.with(func(lv *fakeLNVPS) {
		lv.expires = w.now.Add(time.Duration(daysLeft * float64(day)))
		lv.msatPerDay = int64(satPerDay * 1000)
	})
	w.sync(t, daysLeft, satPerDay, vatOK)
}

// available is what hosting has available, in msat.
func (w *world) available(t *testing.T) int64 {
	t.Helper()
	b, err := w.st.Balance(context.Background(), store.Hosting)
	if err != nil {
		t.Fatal(err)
	}
	return b.AvailableMsat()
}

// renewals is hosting's renew lines, newest first: the amount paid each time, in msat.
func (w *world) renewals(t *testing.T) []int64 {
	t.Helper()
	hist, err := w.st.History(context.Background(), store.Hosting, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	var out []int64
	for _, tx := range hist {
		if tx.Kind == store.KindRenew {
			out = append(out, -tx.AmountMsat-tx.FeeMsat)
		}
	}
	return out
}

func TestNoRenewalBeforeASyncWithVATWhilePausedOrWithTimeLeft(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 50_000)
	w.r.RunOnce(ctx)
	w.syncBoth(t, lv, 5, 221.395, false)
	w.r.RunOnce(ctx)
	w.syncBoth(t, lv, 5, 221.395, true)
	w.f.BalanceSat = 0
	w.l.Reconcile(ctx)
	w.r.RunOnce(ctx)
	w.f.BalanceSat = 50_000
	w.l.Reconcile(ctx)
	w.syncBoth(t, lv, 7, 221.395, true)
	w.r.RunOnce(ctx)
	if n := lv.get().asked; n != 0 || len(w.renewals(t)) != 0 {
		t.Fatalf("LNVPS asked %d times, renewals %v", n, w.renewals(t))
	}
	w.syncBoth(t, lv, 6.9, 221.395, true)
	w.r.RunOnce(ctx)
	if len(w.renewals(t)) != 1 {
		t.Fatal("no renewal at 6.9 days")
	}
}

// Under 7 days left, the job pays back to 7 (every day, about a day's
// worth); from 7 days, and with the VM far ahead, nothing.
func TestRenewsBelowSevenDaysToSeven(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 5, 221.395, true)
	w.r.RunOnce(ctx)
	// 2 days × 221.395 sat = 442.79 sat: 443.
	if got := w.renewals(t); len(got) != 1 || got[0] != 443_000 {
		t.Fatalf("renewals %v", got)
	}
	s := w.status(t)
	if s.Expires != lv.get().until.Unix() || s.Problem != "" || !s.WillRenew || w.available(t) != 49_557_000 {
		t.Fatalf("%+v (LNVPS's date %v)", s, lv.get().until)
	}
	w.now = t0.Add(time.Hour)
	w.r.RunOnce(ctx)
	if n := lv.get().asked; n != 1 {
		t.Fatalf("asked LNVPS %d times", n)
	}
	w, lv = lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 7, 221.395, true)
	w.r.RunOnce(ctx)
	if n := lv.get().asked; n != 0 || len(w.renewals(t)) != 0 {
		t.Fatalf("at 7 days: asked %d, renewals %v", n, w.renewals(t))
	}
}

func TestAVMFarAheadWaits(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 30, 221.395, true)
	w.r.RunOnce(ctx)
	if n := lv.get().asked; n != 0 || len(w.renewals(t)) != 0 {
		t.Fatalf("asked %d, renewals %v", n, w.renewals(t))
	}
}

// 6.9 days left needs 23 sat: LNVPS's smallest renewal, 100 sat, is paid, and
// it is not "not enough for a renewal".
func TestAFewSatsShortPaysTheSmallestRenewal(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 6.9, 221.395, true)
	w.r.RunOnce(ctx)
	if got, s := w.renewals(t), w.status(t); len(got) != 1 || got[0] != 100_000 || s.Problem != "" {
		t.Fatalf("renewals %v; %+v", got, s)
	}
}

// Kept at 7 days, the VM gets about a day's worth each UTC day.
func TestTwoDaysRunningEachPayADay(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 7, 221.395, true)
	w.now = t0.Add(24 * time.Hour)
	w.r.RunOnce(ctx)
	until1 := lv.get().until
	// LNVPS applies it (the fake never does by itself) and the app syncs it.
	lv.with(func(lv *fakeLNVPS) { lv.expires = until1 })
	if err := w.r.Sync(ctx, renew.Sync{Expires: until1.Unix(), SatPerDay: 221.395, VatOK: true}); err != nil {
		t.Fatal(err)
	}
	w.now = t0.Add(48 * time.Hour)
	w.r.RunOnce(ctx)
	if got := w.renewals(t); len(got) != 2 || got[1] != 222_000 || got[0] != 221_000 {
		t.Fatalf("renewals %v", got)
	}
}

// Renewing daily, a second renewal can be counted before a sync has checked
// the first: a sync that shows the first but not the second, 10 minutes on,
// still stops the job.
func TestTwoDailyRenewalsAndAnUnappliedSecond(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 7, 221.395, true)
	w.now = t0.Add(24 * time.Hour)
	w.r.RunOnce(ctx)
	until1 := lv.get().until
	lv.with(func(lv *fakeLNVPS) { lv.expires = until1 })
	w.now = t0.Add(48 * time.Hour)
	w.r.RunOnce(ctx)
	if got := w.renewals(t); len(got) != 2 {
		t.Fatalf("renewals %v", got)
	}
	w.now = w.now.Add(11 * time.Minute)
	w.r.Sync(ctx, renew.Sync{Expires: until1.Unix(), SatPerDay: 221.395, VatOK: true})
	if s := w.status(t); !strings.Contains(s.Problem, "LNVPS hasn't applied") || s.WillRenew {
		t.Fatalf("%+v", s)
	}
}

func TestARenewalIsCapped(t *testing.T) {
	ctx := context.Background()
	// 5 days × 2,000 sat is 10,000 sat: 8,000 at most.
	w, lv := lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 2, 2_000, true)
	w.r.RunOnce(ctx)
	if got := w.renewals(t); len(got) != 1 || got[0] != 8_000_000 {
		t.Fatalf("renewals %v", got)
	}
	// And no more than hosting can pay with its fee budget: 2,980 sat + 14.9 + 5 of 3,000.
	w, lv = lnvpsSetup(t, 3_000)
	w.syncBoth(t, lv, 2, 2_000, true)
	w.r.RunOnce(ctx)
	if got := w.renewals(t); len(got) != 1 || got[0] != 2_980_000 {
		t.Fatalf("renewals %v", got)
	}
}

func TestTooLittleToRenewAsksLNVPSNothing(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 104)
	w.syncBoth(t, lv, 5, 221.395, true)
	w.r.RunOnce(ctx)
	s := w.status(t)
	if lv.get().asked != 0 || !strings.Contains(s.Problem, "Hosting has 104 sat") || s.ProblemAt != t0.Unix() || s.WillRenew {
		t.Fatalf("asked %d; %+v", lv.get().asked, s)
	}
}

// Topped up after too little to renew, hosting can pay: the job will renew at
// its next run (it doesn't wait on the problem), so cardd says so, and the
// problem is no longer reported (it once showed a red "paid only until" with
// 36 days in hosting, an hour before the job renewed).
func TestATopUpEndsTooLittleToRenew(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 104)
	w.syncBoth(t, lv, 2, 221.395, true)
	w.r.RunOnce(ctx)
	if _, err := w.st.Credit(ctx, store.Hosting, 8_000_000, "top-up", ""); err != nil {
		t.Fatal(err)
	}
	if s := w.status(t); !s.WillRenew || s.Problem != "" || s.ProblemAt != 0 {
		t.Fatalf("%+v", s)
	}
	// Still too little after a top-up: the problem stands.
	w, lv = lnvpsSetup(t, 50)
	w.syncBoth(t, lv, 2, 221.395, true)
	w.r.RunOnce(ctx)
	w.st.Credit(ctx, store.Hosting, 30_000, "top-up", "")
	if s := w.status(t); s.WillRenew || !strings.Contains(s.Problem, "Hosting has 50 sat") {
		t.Fatalf("%+v", s)
	}
}

// A payment that failed is tried again the next UTC day, not before, even
// after a restart; the day's renewal then clears the problem.
func TestOnceAUTCDayAcrossARestart(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 5, 221.395, true)
	lv.with(func(lv *fakeLNVPS) { lv.fail = true })
	w.r.RunOnce(ctx)
	if s := w.status(t); !strings.Contains(s.Problem, "failed") || s.WillRenew || w.available(t) != 50_000_000 {
		t.Fatalf("%+v", s)
	}
	restarted := w.renewer()
	restarted.Resolver = w.r.Resolver
	for _, r := range []*renew.Renewer{w.r, restarted} {
		w.now = t0.Add(13*time.Hour + 59*time.Minute) // 23:59 UTC
		r.RunOnce(ctx)
	}
	if n := lv.get().asked; n != 1 {
		t.Fatalf("asked LNVPS %d times on the first day", n)
	}
	lv.with(func(lv *fakeLNVPS) { lv.fail = false })
	w.now = t0.Add(14 * time.Hour) // the next day
	restarted.RunOnce(ctx)
	if s := w.status(t); len(w.renewals(t)) != 1 || s.Problem != "" || !s.WillRenew {
		t.Fatalf("renewals %v; %+v", w.renewals(t), s)
	}
}

func TestAFailureBeforeAHoldIsTriedTheNextHour(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 5, 221.395, true)
	lv.with(func(lv *fakeLNVPS) { lv.down = true })
	w.r.RunOnce(ctx)
	if s := w.status(t); s.Problem == "" || len(w.renewals(t)) != 0 {
		t.Fatalf("%+v", s)
	}
	lv.with(func(lv *fakeLNVPS) { lv.down = false })
	w.now = t0.Add(time.Hour)
	w.r.RunOnce(ctx)
	if len(w.renewals(t)) != 1 || w.status(t).Problem != "" {
		t.Fatalf("renewals %v; %+v", w.renewals(t), w.status(t))
	}
}

// Every part of LNVPS's answer must be for this VM, or nothing is paid.
func TestOnlyThisVMsRenewalIsPaid(t *testing.T) {
	ctx := context.Background()
	for name, change := range map[string]func(lv *fakeLNVPS){
		"a pay request for another VM":       func(lv *fakeLNVPS) { lv.metadata = "Extend VM 10090" },
		"a pay request saying more":          func(lv *fakeLNVPS) { lv.metadata = "Extend VM 1009, and more" },
		"an invoice for another VM":          func(lv *fakeLNVPS) { lv.memo = func(until time.Time) string { return memo("1017", until) } },
		"an invoice without a description":   func(lv *fakeLNVPS) { lv.memo = func(time.Time) string { return "" } },
		"a callback on another host":         func(lv *fakeLNVPS) { lv.callback = "evil.example.com" },
		"an invoice for more than was asked": func(lv *fakeLNVPS) { lv.extraMsat = 1000 },
	} {
		w, lv := lnvpsSetup(t, 50_000)
		w.syncBoth(t, lv, 5, 221.395, true)
		lv.with(change)
		w.r.RunOnce(ctx)
		if s := w.status(t); len(w.f.Paid()) != 0 || s.Problem == "" || w.available(t) != 50_000_000 {
			t.Fatalf("%s: paid %v; %+v", name, w.f.Paid(), s)
		}
	}
}

func TestRenewNow(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 50_000)
	if _, _, err := w.r.RenewNow(ctx, "request:r0", 1); !errors.Is(err, renew.ErrNotSynced) {
		t.Fatalf("before a sync: %v", err)
	}
	w.syncBoth(t, lv, 40, 221.395, false)
	if _, _, err := w.r.RenewNow(ctx, "request:r0", 1); !errors.Is(err, renew.ErrVAT) {
		t.Fatalf("VAT: %v", err)
	}
	w.syncBoth(t, lv, 40, 221.395, true)
	for _, days := range []int{0, -1, 366} {
		if _, _, err := w.r.RenewNow(ctx, "request:r0", days); !errors.Is(err, renew.ErrBadDays) {
			t.Fatalf("%d days: %v", days, err)
		}
	}
	w.f.BalanceSat = 0
	w.l.Reconcile(ctx)
	if _, _, err := w.r.RenewNow(ctx, "request:r0", 1); !errors.Is(err, ledger.ErrPaused) || w.status(t).Problem != "" {
		t.Fatalf("paused: %v; %+v", err, w.status(t))
	}
	w.f.BalanceSat = 50_000
	w.l.Reconcile(ctx)
	// 365 days is 80,810 sat, more than hosting has.
	if _, _, err := w.r.RenewNow(ctx, "request:r0", 365); !errors.Is(err, store.ErrInsufficient) {
		t.Fatalf("a year: %v", err)
	}
	if n := lv.get().asked; n != 0 {
		t.Fatalf("asked LNVPS %d times before a renewal could be paid", n)
	}
	h, done, err := w.r.RenewNow(ctx, "request:r1", 1)
	if err != nil || h.AmountMsat != 222_000 {
		t.Fatalf("%+v %v", h, err)
	}
	if o := <-done; o.Hold.State != store.HoldSettled {
		t.Fatalf("%+v", o)
	}
	if s := w.status(t); s.Expires != lv.get().until.Unix() {
		t.Fatalf("expires %v, LNVPS's date %v", time.Unix(s.Expires, 0).UTC(), lv.get().until)
	}
	if _, _, err := w.r.RenewNow(ctx, "request:r1", 1); !errors.Is(err, store.ErrDuplicatePayment) {
		t.Fatalf("the same request again: %v", err)
	}
	if got := w.renewals(t); len(got) != 1 {
		t.Fatalf("renewals %v", got)
	}
}

func TestRunWaitsForTheLedgersFirstCheck(t *testing.T) {
	w, lv := lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 5, 221.395, true)
	checked := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.r.Run(ctx, checked)
	time.Sleep(100 * time.Millisecond)
	if n := lv.get().asked; n != 0 {
		t.Fatalf("asked LNVPS %d times before the first check", n)
	}
	close(checked)
	for deadline := time.Now().Add(5 * time.Second); len(w.renewals(t)) == 0; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("no renewal after the first check")
		}
	}
}

// One payment from hosting at a time: the job meets a Renew now on its way,
// pays nothing, records no problem, and renews at its next run.
func TestRenewNowAndTheJobNeverOverlap(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 5, 221.395, true)
	lv.with(func(lv *fakeLNVPS) { lv.hang = true })
	h, done, err := w.r.RenewNow(ctx, "request:r1", 1)
	if err != nil {
		t.Fatal(err)
	}
	lv.with(func(lv *fakeLNVPS) { lv.hang = false })
	w.r.RunOnce(ctx)
	if s := w.status(t); s.Problem != "" || len(w.f.Paid()) != 0 || len(lv.get().hashes) != 2 {
		t.Fatalf("paid %v; %+v", w.f.Paid(), s)
	}
	w.f.Release(h.PaymentHash, false, 0)
	if o := <-done; o.Hold.State != store.HoldSettled {
		t.Fatalf("%+v", o)
	}
	w.now = t0.Add(time.Hour)
	w.r.RunOnce(ctx)
	if got := w.renewals(t); len(got) != 2 || w.status(t).Problem != "" {
		t.Fatalf("renewals %v; %+v", got, w.status(t))
	}
}

// Without the VM's id cardd can't know whose Lightning address to pay.
func TestWithoutTheVMsIDNothingIsPaid(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 5, 221.395, true)
	w.st.SetMeta(ctx, "vm.id", "")
	w.r.RunOnce(ctx)
	if s := w.status(t); lv.get().asked != 0 || !strings.Contains(s.Problem, "the VM's id isn't known") {
		t.Fatalf("asked %d; %+v", lv.get().asked, s)
	}
}

// A sync with 7 days or more left clears an old problem: nothing is due, and
// a stale problem would keep saying cardd won't renew.
func TestASyncWithTimeLeftClearsAnOldProblem(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 40, 221.395, true)
	lv.with(func(lv *fakeLNVPS) { lv.down = true })
	if _, _, err := w.r.RenewNow(ctx, "request:r1", 1); err == nil || w.status(t).Problem == "" || w.status(t).WillRenew {
		t.Fatalf("%v; %+v", err, w.status(t))
	}
	w.syncBoth(t, lv, 6.9, 221.395, true)
	if s := w.status(t); s.Problem == "" {
		t.Fatalf("cleared with 6.9 days left: %+v", s)
	}
	w.syncBoth(t, lv, 7.1, 221.395, true)
	if s := w.status(t); s.Problem != "" || s.ProblemAt != 0 || !s.WillRenew {
		t.Fatalf("%+v", s)
	}
}

// LNVPS has failed to credit Lightning-address payments before (its
// fix_lnurlp_topups tool). A sync that shows a counted renewal never arrived
// stops the job, which would otherwise pay again every day the app syncs; a
// sync soon after paying is only LNVPS being slow.
func TestARenewalLNVPSNeverAppliedStopsTheJob(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 50_000)
	w.syncBoth(t, lv, 5, 221.395, true)
	w.r.RunOnce(ctx)
	until := lv.get().until
	old := renew.Sync{Expires: t0.Add(5 * day).Unix(), SatPerDay: 221.395, VatOK: true}
	w.now = t0.Add(5 * time.Minute)
	if err := w.r.Sync(ctx, old); err != nil {
		t.Fatal(err)
	}
	if s := w.status(t); s.Problem != "" {
		t.Fatalf("5 minutes on: %+v", s)
	}
	w.now = t0.Add(time.Hour)
	w.r.Sync(ctx, old)
	if s := w.status(t); !strings.Contains(s.Problem, "LNVPS hasn't applied") || s.WillRenew {
		t.Fatalf("an hour on: %+v", s)
	}
	w.now = t0.Add(24 * time.Hour)
	w.r.RunOnce(ctx)
	if got := w.renewals(t); len(got) != 1 {
		t.Fatalf("paid again: %v", got)
	}
	w.r.Sync(ctx, renew.Sync{Expires: until.Unix(), SatPerDay: 221.395, VatOK: true})
	if s := w.status(t); s.Problem != "" || !s.WillRenew {
		t.Fatalf("once LNVPS shows it: %+v", s)
	}
}
