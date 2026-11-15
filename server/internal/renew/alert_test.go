package renew_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/alerts"
	"github.com/boltcard/karto/server/internal/renew"
)

// fakeAlerts is the sender: what it was given, and whether its queue takes it.
type fakeAlerts struct {
	mu    sync.Mutex
	calls []alerts.Payload
	full  bool
}

func (f *fakeAlerts) Send(p alerts.Payload, urg alerts.Urgency) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, p)
	return !f.full && urg == alerts.UrgencyNormal
}

func (f *fakeAlerts) n() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// at is the next day (t0 is 10:00 UTC) at hh:mm UTC, days on.
func at(days, hh, mm int) time.Time {
	d := time.Date(t0.Year(), t0.Month(), t0.Day()+days, hh, mm, 0, 0, time.UTC)
	return d
}

// lowWorld: hosting holding hostingSat, the VM 9 days ahead (nothing to
// renew for two days, and two days past the 7 the job keeps it at: hosting's
// days are most of the runway), synced at the next day 08:00 UTC,
// with a fake sender.
func lowWorld(t *testing.T, hostingSat int64) (*world, *fakeAlerts) {
	t.Helper()
	w := setup(t, hostingSat)
	w.now = at(1, 8, 0)
	w.sync(t, 9, 221.395, true)
	fa := &fakeAlerts{}
	w.r.Alerts = fa
	return w, fa
}

// 1,000 sat at 221.395 sat a day is 4.5 days: one alert a day, at the first
// run from 09:00, also across a restart.
func TestLowFundingAlertsOnceADayFromNine(t *testing.T) {
	ctx := context.Background()
	w, fa := lowWorld(t, 1_000)
	w.now = at(1, 8, 30)
	w.r.RunOnce(ctx)
	if fa.n() != 0 {
		t.Fatalf("alerted at 08:30: %v", fa.calls)
	}
	w.now = at(1, 9, 10)
	w.r.RunOnce(ctx)
	if fa.n() != 1 {
		t.Fatalf("%d alerts at 09:10", fa.n())
	}
	if p := fa.calls[0]; p.Kind != "hosting" || p.Count != 4 || p.Msat != 1_000_000 || p.Tag != "hosting-low" || p.At != w.now.Unix() {
		t.Fatalf("payload %+v", p)
	}
	w.now = at(1, 10, 10)
	w.r.RunOnce(ctx)
	restarted := w.renewer()
	restarted.Alerts = fa
	w.now = at(1, 10, 20)
	restarted.RunOnce(ctx)
	if fa.n() != 1 {
		t.Fatalf("%d alerts the same day", fa.n())
	}
	w.now = at(2, 9, 5)
	restarted.RunOnce(ctx)
	if fa.n() != 2 {
		t.Fatalf("%d alerts by the next day", fa.n())
	}
}

func TestNoAlertFromSevenDays(t *testing.T) {
	w, fa := lowWorld(t, 2_000) // 9 days
	w.now = at(1, 9, 10)
	w.r.RunOnce(context.Background())
	if fa.n() != 0 {
		t.Fatalf("alerted with 9 days: %v", fa.calls)
	}
}

// East of UTC the day's renewal and 09:00 fall in one run: the alert is
// checked on what hosting has after the payment.
func TestTheAlertComesAfterTheDaysRenewal(t *testing.T) {
	ctx := context.Background()
	w, lv := lnvpsSetup(t, 1_661) // 7.5 days
	w.syncBoth(t, lv, 7, 221.395, true)
	off := 600
	if err := w.r.Sync(ctx, renew.Sync{Expires: t0.Add(7 * day).Unix(), SatPerDay: 221.395, VatOK: true, UTCOffsetMin: &off}); err != nil {
		t.Fatal(err)
	}
	fa := &fakeAlerts{}
	w.r.Alerts = fa
	w.now = at(1, 0, 30) // 10:30 at UTC+10
	w.r.RunOnce(ctx)
	if got := w.renewals(t); len(got) != 1 || got[0] != 134_000 {
		t.Fatalf("renewals %v", got)
	}
	if fa.n() != 1 || fa.calls[0].Count != 6 {
		t.Fatalf("alerts %v", fa.calls)
	}
}

func TestAFullQueueDoesNotMarkTheDay(t *testing.T) {
	ctx := context.Background()
	w, fa := lowWorld(t, 1_000)
	fa.full = true
	w.now = at(1, 9, 10)
	w.r.RunOnce(ctx)
	fa.full = false
	w.now = at(1, 10, 10)
	w.r.RunOnce(ctx)
	w.now = at(1, 11, 10)
	w.r.RunOnce(ctx)
	if fa.n() != 2 {
		t.Fatalf("%d tries, want the full one and one more", fa.n())
	}
}

// The days the VM is paid beyond the 7 the job keeps it at count with
// hosting's own: 1,000 sat (4.5 days) with the VM 30 days ahead is a
// runway of 27.5 days, no alert; 9 days ahead, 6.5 days, an alert; 10 days
// ahead, 7.5 days, none.
func TestTheDaysPaidBeyondSevenCount(t *testing.T) {
	for _, c := range []struct {
		ahead float64
		want  int
	}{{30, 0}, {10, 0}, {9, 1}} {
		w, fa := lowWorld(t, 1_000)
		w.now = at(1, 9, 10)
		w.sync(t, c.ahead, 221.395, true)
		w.r.RunOnce(context.Background())
		if fa.n() != c.want {
			t.Fatalf("%v days ahead: %d alerts, want %d", c.ahead, fa.n(), c.want)
		}
		if c.want == 1 && fa.calls[0].Count != 4 {
			t.Fatalf("%v days ahead: the payload counts hosting's own days: %+v", c.ahead, fa.calls[0])
		}
	}
}

// A paused server still says hosting is low.
func TestAPausedServerStillAlerts(t *testing.T) {
	ctx := context.Background()
	w, fa := lowWorld(t, 1_000)
	w.f.BalanceSat = 0
	w.l.Reconcile(ctx)
	if paused, _ := w.l.Paused(); !paused {
		t.Fatal("not paused")
	}
	w.now = at(1, 9, 10)
	w.r.RunOnce(ctx)
	if fa.n() != 1 {
		t.Fatalf("%d alerts", fa.n())
	}
}

// The app's sync gives the phone's offset from UTC; a sync without one (an
// older app) keeps the last.
func TestTheSyncsOffsetMovesTheHour(t *testing.T) {
	ctx := context.Background()
	w, fa := lowWorld(t, 1_000)
	off := -300
	if err := w.r.Sync(ctx, renew.Sync{Expires: w.now.Add(9 * day).Unix(), SatPerDay: 221.395, VatOK: true, UTCOffsetMin: &off}); err != nil {
		t.Fatal(err)
	}
	w.now = at(1, 13, 30) // 08:30 at UTC−5
	w.r.RunOnce(ctx)
	if fa.n() != 0 {
		t.Fatalf("alerted at 08:30 local")
	}
	w.now = at(1, 14, 10)
	w.r.RunOnce(ctx)
	if fa.n() != 1 {
		t.Fatalf("%d alerts at 09:10 local", fa.n())
	}
	w.sync(t, 9, 221.395, true)
	w.now = at(2, 13, 30)
	w.r.RunOnce(ctx)
	if fa.n() != 1 {
		t.Fatalf("a sync without an offset forgot it")
	}
	for _, bad := range []int{-721, 841} {
		if err := w.r.Sync(ctx, renew.Sync{Expires: w.now.Add(30 * day).Unix(), SatPerDay: 221.395, VatOK: true, UTCOffsetMin: &bad}); err == nil {
			t.Fatalf("took an offset of %d minutes", bad)
		}
	}
}

// Without a sender (tests, a server before alerts) nothing happens.
func TestNoSenderNoAlert(t *testing.T) {
	w, _ := lowWorld(t, 1_000)
	w.r.Alerts = nil
	w.now = at(1, 9, 10)
	w.r.RunOnce(context.Background())
}
