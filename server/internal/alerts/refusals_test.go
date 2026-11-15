package alerts

import (
	"errors"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"
)

func (h *harness) refuse(at time.Time, reason RefusalReason, msat int64) {
	h.at(at)
	h.s.Refused(Refusal{CardID: blueID, Reason: reason, AmountMsat: msat, At: at})
}

func window(start time.Time) string { return fmt.Sprintf("refused-%s-%d", blueID, start.Unix()) }

// wantRefusal checks a refusal's notification: its count, last reason, tag,
// and whether it updates one already shown.
func wantRefusal(t *testing.T, r request, count int, reason RefusalReason, tag string, update bool) {
	t.Helper()
	p := r.payload
	gotUpdate, _ := p["update"].(bool)
	if p["kind"] != "refused" || p["count"] != float64(count) || p["reason"] != string(reason) || p["tag"] != tag ||
		gotUpdate != update || p["card"] != blueID || p["name"] != "Blue" || p["tx"] != nil {
		t.Fatalf("payload %v, want a refusal of %s counting %d, tag %s, update %v", p, reason, count, tag, update)
	}
	if r.header.Get("Urgency") != "high" {
		t.Fatalf("urgency %q", r.header.Get("Urgency"))
	}
}

func TestRefusalFoldWithin60s(t *testing.T) {
	h := newHarness(t)
	h.start(t)
	h.refuse(t0, RefusedDaily, 5_000_000)
	wantRefusal(t, h.next(t), 1, RefusedDaily, window(t0), false)
	h.sent(t)
	// 30 s on: the same notification, counting two, updated silently.
	h.refuse(t0.Add(30*time.Second), RefusedFunds, 6_000_000)
	r := h.next(t)
	wantRefusal(t, r, 2, RefusedFunds, window(t0), true)
	if r.payload["sat"] != 6000.0 {
		t.Errorf("sat %v, want the last refusal's", r.payload["sat"])
	}
	h.sent(t)
	// Past the 60 s: a new notification with a tag of its own.
	h.refuse(t0.Add(61*time.Second), RefusedOff, 0)
	wantRefusal(t, h.next(t), 1, RefusedOff, window(t0.Add(61*time.Second)), false)
	h.sent(t)
	h.noTimer(t)
}

// Two terminals' refusals of one card at once make one
// notification counting both, never two.
func TestRefusalConcurrentPairOneNotification(t *testing.T) {
	h := newHarness(t)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.s.Refused(Refusal{CardID: blueID, Reason: RefusedFunds, AmountMsat: 5_000_000, At: t0})
		}()
	}
	wg.Wait()
	h.start(t)
	wantRefusal(t, h.next(t), 2, RefusedFunds, window(t0), true)
	h.sent(t)
	h.quiet(t)
}

// A retry of a count that a newer count of the same notification replaced
// is dropped, so the phone never goes back to the older count.
func TestRefusalRetrySupersededDropped(t *testing.T) {
	h := newHarness(t)
	h.codes = func(n int) int {
		if n == 1 {
			return http.StatusServiceUnavailable
		}
		return http.StatusCreated
	}
	h.start(t)
	h.refuse(t0, RefusedDaily, 0)
	wantRefusal(t, h.next(t), 1, RefusedDaily, window(t0), false)
	h.sent(t)
	retry := h.timer(t)
	h.refuse(t0.Add(10*time.Second), RefusedDaily, 0)
	wantRefusal(t, h.next(t), 2, RefusedDaily, window(t0), true)
	h.sent(t)
	retry.fn()
	h.sent(t)
	h.quiet(t)
	h.noTimer(t)
	if d, f, _ := h.f.counts("dev1"); d != 1 || f != 0 {
		t.Fatalf("delivered %d, failed %d: want 1 and 0", d, f)
	}
}

func TestRefusalHourCapSummary(t *testing.T) {
	h := newHarness(t)
	h.start(t)
	for i := range 3 {
		at := t0.Add(time.Duration(i) * 61 * time.Second)
		h.refuse(at, RefusedDaily, 5_000_000)
		wantRefusal(t, h.next(t), 1, RefusedDaily, window(at), false)
		h.sent(t)
	}
	// The fourth and fifth in the hour are held back for its end.
	h.refuse(t0.Add(183*time.Second), RefusedDaily, 5_000_000)
	h.quiet(t)
	summary := h.timer(t)
	if want := time.Hour - 183*time.Second; summary.d != want {
		t.Fatalf("summary in %v, want %v (the hour's end)", summary.d, want)
	}
	h.refuse(t0.Add(200*time.Second), RefusedFunds, 7_000_000)
	h.quiet(t)
	h.noTimer(t)

	h.at(t0.Add(time.Hour))
	summary.fn()
	wantRefusal(t, h.next(t), 2, RefusedFunds, fmt.Sprintf("refused-%s-hour-%d", blueID, t0.Add(time.Hour).Unix()), false)
	h.sent(t)

	// A new hour: alerts again.
	at := t0.Add(time.Hour + time.Second)
	h.refuse(at, RefusedPaused, 0)
	wantRefusal(t, h.next(t), 1, RefusedPaused, window(at), false)
	h.sent(t)
}

func TestRefusalHourEndsWithNoneHeld(t *testing.T) {
	h := newHarness(t)
	h.start(t)
	for i := range 3 {
		h.refuse(t0.Add(time.Duration(i)*61*time.Second), RefusedDaily, 0)
		h.next(t)
		h.sent(t)
	}
	// An hour after the first, the count starts again.
	h.refuse(t0.Add(time.Hour), RefusedDaily, 0)
	wantRefusal(t, h.next(t), 1, RefusedDaily, window(t0.Add(time.Hour)), false)
	h.sent(t)
	h.noTimer(t)
}

func TestRefusalsOfTwoCardsFoldApart(t *testing.T) {
	h := newHarness(t)
	h.f.cards["9ee"] = h.f.cards[blueID]
	h.start(t)
	h.s.Refused(Refusal{CardID: blueID, Reason: RefusedDaily, At: t0})
	h.next(t)
	h.sent(t)
	h.s.Refused(Refusal{CardID: "9ee", Reason: RefusedDaily, At: t0})
	r := h.next(t)
	h.sent(t)
	if r.payload["tag"] != fmt.Sprintf("refused-9ee-%d", t0.Unix()) || r.payload["count"] != 1.0 {
		t.Fatalf("payload %v, want the other card's own notification", r.payload)
	}
}

func TestRefusalOfUnknownCardQuiet(t *testing.T) {
	h := newHarness(t)
	h.start(t)
	h.s.Refused(Refusal{CardID: "nope", Reason: RefusedDaily, At: t0})
	h.job(t)
	h.quiet(t)
}

func (h *harness) endpointsFail(err error) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.endpointsErr = err
}

// The endpoints unread, a refusal's count isn't
// lost: its job is tried again, and the refusals meanwhile join it.
func TestRefusalEndpointsUnreadTriedAgainWithItsCount(t *testing.T) {
	h := newHarness(t)
	h.start(t)
	h.endpointsFail(errors.New("disk I/O error"))
	h.refuse(t0, RefusedDaily, 0)
	h.job(t)
	h.quiet(t)
	wantLog(t, h.logs, "alerts: reading the endpoints: disk I/O error")
	again := h.timer(t)
	if again.d != endpointsRetry {
		t.Fatalf("tried again in %v, want %v", again.d, endpointsRetry)
	}
	h.refuse(t0.Add(5*time.Second), RefusedFunds, 0)
	h.noTimer(t)
	h.endpointsFail(nil)
	again.fn()
	wantRefusal(t, h.next(t), 2, RefusedFunds, window(t0), true)
	h.sent(t)
	h.quiet(t)
}

// The same for the hour's summary, which holds its refusals until sent.
func TestRefusalSummaryEndpointsUnreadTriedAgain(t *testing.T) {
	h := newHarness(t)
	h.start(t)
	for i := range 3 {
		at := t0.Add(time.Duration(i) * 61 * time.Second)
		h.refuse(at, RefusedDaily, 0)
		h.next(t)
		h.sent(t)
	}
	h.refuse(t0.Add(183*time.Second), RefusedDaily, 0)
	summary := h.timer(t)
	h.endpointsFail(errors.New("disk I/O error"))
	h.at(t0.Add(time.Hour))
	summary.fn()
	h.job(t)
	h.quiet(t)
	again := h.timer(t)
	h.endpointsFail(nil)
	again.fn()
	wantRefusal(t, h.next(t), 1, RefusedDaily, fmt.Sprintf("refused-%s-hour-%d", blueID, t0.Add(time.Hour).Unix()), false)
	h.sent(t)
}
