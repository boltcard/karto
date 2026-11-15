package renew_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"path/filepath"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/renew"
	"github.com/boltcard/karto/server/internal/store"
)

const (
	vmID = "1009"
	day  = 24 * time.Hour
)

// t0 is the tests' "now": the renewer's clock starts here and tests move it.
var t0 = time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC)

type world struct {
	st  *store.Store
	f   *phoenixdtest.Fake
	l   *ledger.Ledger
	r   *renew.Renewer
	now time.Time
}

// setup: VM 1009, hosting holding hostingSat, phoenixd holding the same, the
// books checked.
func setup(t *testing.T, hostingSat int64) *world {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "cardd.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	st.SetMeta(ctx, "vm.id", vmID)
	st.Credit(ctx, store.Hosting, hostingSat*1000, "h", "")
	f := phoenixdtest.New()
	t.Cleanup(f.Close)
	f.BalanceSat = hostingSat
	l := ledger.New(st, phoenixd.New(f.URL, phoenixdtest.Password), log.New(io.Discard, "", 0))
	if err := l.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	w := &world{st: st, f: f, l: l, now: t0}
	w.r = w.renewer()
	return w
}

// renewer is a Renewer on w's database, as cardd starts one (again after a restart).
func (w *world) renewer() *renew.Renewer {
	return &renew.Renewer{Store: w.st, Ledger: w.l, Decoder: phoenixd.New(w.f.URL, phoenixdtest.Password),
		LNVPS: "http://api.lnvps.net", Now: func() time.Time { return w.now }, Log: log.New(io.Discard, "", 0)}
}

// sync is the app's PUT /hosting: daysLeft from w.now.
func (w *world) sync(t *testing.T, daysLeft, satPerDay float64, vatOK bool) {
	t.Helper()
	exp := w.now.Add(time.Duration(daysLeft * float64(day)))
	if err := w.r.Sync(context.Background(), renew.Sync{Expires: exp.Unix(), SatPerDay: satPerDay, VatOK: vatOK}); err != nil {
		t.Fatal(err)
	}
}

func (w *world) status(t *testing.T) renew.Status {
	t.Helper()
	s, err := w.r.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// memo is LNVPS's renewal invoice description, its date as chrono writes one.
func memo(vm string, until time.Time) string {
	return fmt.Sprintf("VM renewal %s to %s", vm, until.UTC().Format("2006-01-02 15:04:05.000000 UTC"))
}

// settledRenewal pays a renewal invoice from hosting through the ledger, as
// the job does, and waits for it to settle.
func (w *world) settledRenewal(t *testing.T, sat int64, description string) store.Hold {
	t.Helper()
	ctx := context.Background()
	bolt11, _ := w.f.InvoiceWithDescription(sat*1000, description)
	inv, err := w.l.DecodeFor(ctx, bolt11, sat*1000)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan ledger.Outcome, 1)
	if _, err := w.l.PayOnce(ctx, "", store.Hosting, store.KindRenew, bolt11, inv, store.HoldAbout{}, done); err != nil {
		t.Fatal(err)
	}
	select {
	case o := <-done:
		if o.Hold.State != store.HoldSettled {
			t.Fatalf("not settled: %+v", o)
		}
		return o.Hold
	case <-time.After(5 * time.Second):
		t.Fatal("no outcome")
		return store.Hold{}
	}
}

func TestSyncChecksItsValues(t *testing.T) {
	ctx := context.Background()
	w := setup(t, 10_000)
	good := renew.Sync{Expires: t0.Add(40 * day).Unix(), SatPerDay: 221.3949, VatOK: true}
	if err := w.r.Sync(ctx, good); err != nil {
		t.Fatal(err)
	}
	s := w.status(t)
	if !s.Synced || s.Expires != good.Expires || s.MsatPerDay != 221_395 || !s.VatOK || s.SyncedAt != t0.Unix() || s.DaysLeft != 40 {
		t.Fatalf("%+v", s)
	}
	for name, bad := range map[string]renew.Sync{
		"under 20 sat a day":      {Expires: good.Expires, SatPerDay: 19.99},
		"over 20,000 sat a day":   {Expires: good.Expires, SatPerDay: 20_000.01},
		"not a number":            {Expires: good.Expires, SatPerDay: math.NaN()},
		"infinite":                {Expires: good.Expires, SatPerDay: math.Inf(1)},
		"over a year ago":         {Expires: t0.Add(-366 * day).Unix(), SatPerDay: 221},
		"over two years from now": {Expires: t0.Add(731 * day).Unix(), SatPerDay: 221},
	} {
		if err := w.r.Sync(ctx, bad); !errors.Is(err, renew.ErrBadSync) {
			t.Fatalf("%s: %v", name, err)
		}
		if after := w.status(t); after != s {
			t.Fatalf("%s changed the estimate: %+v", name, after)
		}
	}
}

func TestStatus(t *testing.T) {
	ctx := context.Background()
	w := setup(t, 13_000)
	if s := w.status(t); s.Synced || s.WillRenew || s.Expires != 0 {
		t.Fatalf("before a sync: %+v", s)
	}
	w.sync(t, 10, 221.395, true)
	s := w.status(t)
	if s.DaysLeft != 10 || math.Abs(s.FundingDays-13_000/221.395) > 1e-9 || !s.WillRenew || s.Problem != "" {
		t.Fatalf("%+v", s)
	}
	w.now = t0.Add(36 * time.Hour)
	if s := w.status(t); s.DaysLeft != 8.5 {
		t.Fatalf("a day and a half later: %+v", s)
	}
	w.sync(t, 10, 221.395, false)
	if s := w.status(t); s.WillRenew || s.VatOK {
		t.Fatalf("VAT: %+v", s)
	}
	w.sync(t, 10, 221.395, true)
	w.f.BalanceSat = 0
	w.l.Reconcile(ctx)
	if s := w.status(t); s.WillRenew {
		t.Fatalf("paused: %+v", s)
	}
	// 104 sat can't pay 100 sat with its 5.5 sat fee budget.
	poor := setup(t, 104)
	poor.sync(t, 10, 221.395, true)
	if s := poor.status(t); s.WillRenew || s.FundingDays >= 1 {
		t.Fatalf("hosting nearly empty: %+v", s)
	}
}

func TestASettledRenewalSetsTheEstimateFromLNVPSsDate(t *testing.T) {
	ctx := context.Background()
	w := setup(t, 50_000)
	w.sync(t, 10, 221.395, true)
	until := t0.Add(30*day + 1234567*time.Microsecond)
	w.settledRenewal(t, 4428, memo(vmID, until))
	for i, r := range []*renew.Renewer{w.r, w.r, w.renewer()} { // again, and after a restart: counted once
		if err := r.Count(ctx); err != nil {
			t.Fatal(err)
		}
		if s := w.status(t); s.Expires != until.Unix() {
			t.Fatalf("count #%d: expires %v, want %v", i, time.Unix(s.Expires, 0).UTC(), until)
		}
	}
	// An earlier date never moves the estimate back.
	w.settledRenewal(t, 222, memo(vmID, t0.Add(5*day)))
	w.r.Count(ctx)
	if s := w.status(t); s.Expires != until.Unix() {
		t.Fatalf("moved back to %v", time.Unix(s.Expires, 0).UTC())
	}
}

// chrono writes the fraction only when there is one, in 3, 6 or 9 digits.
func TestLNVPSsDateInEveryShape(t *testing.T) {
	ctx := context.Background()
	for i, date := range []string{"2026-11-09 14:22:33", "2026-11-09 14:22:33.123", "2026-11-09 14:22:33.123456", "2026-11-09 14:22:33.123456789"} {
		w := setup(t, 50_000)
		w.sync(t, 10, 221.395, true)
		w.settledRenewal(t, int64(4000+i), "VM renewal 1009 to "+date+" UTC")
		if err := w.r.Count(ctx); err != nil {
			t.Fatal(err)
		}
		if s := w.status(t); s.Expires != time.Date(2026, 11, 9, 14, 22, 33, 0, time.UTC).Unix() {
			t.Fatalf("%q: expires %v", date, time.Unix(s.Expires, 0).UTC())
		}
	}
}

// Without a date to read (or one for another VM), the estimate moves on by
// what was paid, not the fee, at 95%: behind LNVPS until the next sync.
func TestTheFallbackWhenTheDateCantBeRead(t *testing.T) {
	ctx := context.Background()
	w := setup(t, 50_000)
	w.sync(t, 10, 221.395, true)
	want := t0.Add(10 * day).Unix()
	for _, description := range []string{"VM renewal 1009", memo("1017", t0.Add(90*day)), "VM renewal 1009 to soon", "VM renewal 1009 to 2026-12-01 10:00:00+00:00"} {
		w.settledRenewal(t, 2214, description)
		if err := w.r.Count(ctx); err != nil {
			t.Fatal(err)
		}
		want += 2_214_000 * 86_400 * 95 / (221_395 * 100)
		if s := w.status(t); s.Expires != want {
			t.Fatalf("%q: expires %d, want %d", description, s.Expires, want)
		}
	}
}

// A sync after a renewal settled already includes it: nothing is added.
func TestASyncAfterARenewalIsNotAddedTo(t *testing.T) {
	ctx := context.Background()
	w := setup(t, 50_000)
	w.sync(t, 10, 221.395, true)
	w.settledRenewal(t, 2214, "VM renewal 1009")
	w.sync(t, 19.5, 221.395, true)
	if err := w.r.Count(ctx); err != nil {
		t.Fatal(err)
	}
	if s := w.status(t); s.Expires != t0.Add(19*day+12*time.Hour).Unix() {
		t.Fatalf("expires %v", time.Unix(s.Expires, 0).UTC())
	}
}

type decoderFunc func(ctx context.Context, bolt11 string) (phoenixd.Invoice, error)

func (f decoderFunc) DecodeInvoice(ctx context.Context, bolt11 string) (phoenixd.Invoice, error) {
	return f(ctx, bolt11)
}

// phoenixd unreachable: counted at the next run. phoenixd unable to read the
// invoice: counted by its amount, rather than never.
func TestARenewalWhoseInvoiceCantBeReadIsStillCounted(t *testing.T) {
	ctx := context.Background()
	w := setup(t, 50_000)
	w.sync(t, 10, 221.395, true)
	w.settledRenewal(t, 2214, memo(vmID, t0.Add(30*day)))
	w.r.Decoder = decoderFunc(func(context.Context, string) (phoenixd.Invoice, error) {
		return phoenixd.Invoice{}, phoenixd.ErrUnreachable
	})
	if err := w.r.Count(ctx); !errors.Is(err, phoenixd.ErrUnreachable) || w.status(t).Expires != t0.Add(10*day).Unix() {
		t.Fatalf("%v; %+v", err, w.status(t))
	}
	w.r.Decoder = decoderFunc(func(context.Context, string) (phoenixd.Invoice, error) {
		return phoenixd.Invoice{}, phoenixd.ErrRefused
	})
	if err := w.r.Count(ctx); err != nil {
		t.Fatal(err)
	}
	if s := w.status(t); s.Expires != t0.Add(10*day).Unix()+2_214_000*86_400*95/(221_395*100) {
		t.Fatalf("%+v", s)
	}
}

// phoenixd answering HTTP 500 to decodeinvoice is phoenixd failing, not an
// invoice it can't read: the renewal is counted at the next run, by its
// invoice's date, not now by its amount.
func TestARenewalIsNotCountedByItsAmountWhenPhoenixdAnswers500(t *testing.T) {
	ctx := context.Background()
	w := setup(t, 50_000)
	w.sync(t, 10, 221.395, true)
	w.settledRenewal(t, 2214, memo(vmID, t0.Add(30*day)))
	w.f.Set(func(f *phoenixdtest.Fake) { f.Broken = "/decodeinvoice" })
	if err := w.r.Count(ctx); !errors.Is(err, phoenixd.ErrUnreachable) || w.status(t).Expires != t0.Add(10*day).Unix() {
		t.Fatalf("%v; %+v", err, w.status(t))
	}
	w.f.Set(func(f *phoenixdtest.Fake) { f.Broken = "" })
	if err := w.r.Count(ctx); err != nil {
		t.Fatal(err)
	}
	if s := w.status(t); s.Expires != t0.Add(30*day).Unix() {
		t.Fatalf("counted by its amount, not its date: %+v", s)
	}
}
