package alerts

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/webpush"
)

func (h *harness) topup(id int64) {
	h.f.post(id, store.CardAccount(blueID), store.Line{Tx: store.Tx{Kind: store.KindTopup, AmountMsat: 123_000, CreatedAt: t0}})
}

func TestSendToInternalNtfyWithToken(t *testing.T) {
	h := newHarness(t)
	ntfy := make(chan request, 4)
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		plain, err := h.ph.open(body)
		if err != nil {
			t.Errorf("decrypting: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		ntfy <- request{r.URL.Path, r.URL.RawQuery, r.Header.Clone(), map[string]any{"raw": string(plain)}}
	}))
	defer internal.Close()
	h.s.NtfyPublic = "https://vm-1.lnvps.cloud:8443"
	h.s.NtfyInternal = internal.URL
	h.s.NtfyToken = "tk_cardd"
	h.f.endpoints["dev1"] = h.ph.endpoint("dev1", "https://VM-1.lnvps.cloud:8443/upAbc123def456?up=1")
	h.topup(41)
	h.start(t)
	h.s.Posted([]int64{41})
	var r request
	select {
	case r = <-ntfy:
	case <-time.After(5 * time.Second):
		t.Fatal("the internal ntfy got no POST")
	}
	h.sent(t)
	if r.path != "/upAbc123def456" || r.query != "up=1" {
		t.Errorf("posted to %s?%s, want /upAbc123def456?up=1", r.path, r.query)
	}
	if got := r.header.Get("Authorization"); got != "Bearer tk_cardd" {
		t.Errorf("Authorization %q, want the token", got)
	}
	if r.header.Get("Content-Encoding") != "aes128gcm" || r.header.Get("TTL") != "86400" || r.header.Get("Urgency") != "normal" {
		t.Errorf("headers %v", r.header)
	}
	if !strings.Contains(r.payload["raw"].(string), `"kind":"received"`) {
		t.Errorf("payload %s", r.payload["raw"])
	}
	if d, _, _ := h.f.counts("dev1"); d != 1 {
		t.Errorf("delivered %d times, want 1", d)
	}
	h.quiet(t) // nothing went to the public address
}

// An endpoint on the server's own ntfy that isn't a UnifiedPush topic is
// never posted inside the stack with the token, nor anywhere else.
func TestOwnNtfyOnlyTopics(t *testing.T) {
	for _, path := range []string{
		"/upAbc/../v1/account?up=1",
		"/v1/account?up=1",
		"/up%2Fabc?up=1",
		"/upAbc?up=1&poll=1",
		"/upAbc",
		"/upAbc?up=1#x",
	} {
		t.Run(path, func(t *testing.T) {
			h := newHarness(t)
			internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Errorf("the internal ntfy got %s?%s", r.URL.Path, r.URL.RawQuery)
			}))
			defer internal.Close()
			h.s.NtfyPublic = "https://vm-1.lnvps.cloud:8443"
			h.s.NtfyInternal = internal.URL
			h.s.NtfyToken = "tk_cardd"
			h.f.endpoints["dev1"] = h.ph.endpoint("dev1", "https://vm-1.lnvps.cloud:8443"+path)
			if err := h.s.Test(context.Background(), "dev1"); !errors.Is(err, ErrBadEndpoint) {
				t.Fatalf("err %v, want ErrBadEndpoint", err)
			}
			h.quiet(t)
			if _, f, _ := h.f.counts("dev1"); f != 1 {
				t.Errorf("failures %d, want 1", f)
			}
		})
	}
}

func TestSendElsewhereWithVAPID(t *testing.T) {
	h := newHarness(t)
	h.s.NtfyPublic = "https://vm-1.lnvps.cloud:8443"
	h.s.NtfyToken = "tk_cardd"
	h.f.post(46, store.CardAccount(blueID), store.Line{Tx: store.Tx{Kind: store.KindSpend, AmountMsat: -100_000, CreatedAt: t0}})
	h.start(t)
	h.s.Posted([]int64{46})
	r := h.next(t)
	h.sent(t)
	if r.path != "/push/abc" {
		t.Errorf("path %s", r.path)
	}
	if r.header.Get("Content-Encoding") != "aes128gcm" || r.header.Get("TTL") != "86400" || r.header.Get("Urgency") != "high" {
		t.Errorf("headers %v", r.header)
	}
	k, _ := webpush.ParseVAPID(h.f.vapid)
	if err := webpush.Verify(r.header.Get("Authorization"), h.srv.URL, k.PublicKey(), t0); err != nil {
		t.Errorf("VAPID header %q: %v", r.header.Get("Authorization"), err)
	}
	if r.payload["kind"] != "spent" || r.payload["tx"] != 46.0 {
		t.Errorf("payload %v", r.payload)
	}
	if d, _, _ := h.f.counts("dev1"); d != 1 {
		t.Errorf("delivered %d times, want 1", d)
	}
}

func TestGoneDeletesEndpoint(t *testing.T) {
	for _, code := range []int{http.StatusNotFound, http.StatusGone} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			h := newHarness(t)
			h.codes = func(int) int { return code }
			h.topup(41)
			h.start(t)
			h.s.Posted([]int64{41})
			h.next(t)
			h.sent(t)
			if _, f, gone := h.f.counts("dev1"); !gone || f != 0 {
				t.Errorf("deleted %v, failures %d: want deleted, none", gone, f)
			}
			h.noTimer(t)
		})
	}
}

func TestRetriesThenFailed(t *testing.T) {
	h := newHarness(t)
	h.codes = func(int) int { return http.StatusInternalServerError }
	h.topup(41)
	h.start(t)
	h.s.Posted([]int64{41})
	h.next(t)
	h.sent(t)
	for _, d := range []time.Duration{2 * time.Second, 10 * time.Second, 45 * time.Second} {
		if _, f, _ := h.f.counts("dev1"); f != 0 {
			t.Fatalf("failure counted before the retries ran out")
		}
		tm := h.timer(t)
		if tm.d != d {
			t.Fatalf("retry in %v, want %v", tm.d, d)
		}
		tm.fn()
		h.next(t)
		h.sent(t)
	}
	h.noTimer(t)
	if d, f, _ := h.f.counts("dev1"); d != 0 || f != 1 {
		t.Fatalf("delivered %d, failed %d: want 0 and 1", d, f)
	}
	if why := h.f.failed["dev1"][0]; !strings.Contains(why, "500") {
		t.Errorf("failure %q doesn't say the status", why)
	}
}

func TestRetryDoesNotDelayNext(t *testing.T) {
	h := newHarness(t)
	h.codes = func(n int) int {
		if n == 1 {
			return http.StatusServiceUnavailable
		}
		return http.StatusCreated
	}
	h.topup(41)
	h.topup(42)
	h.start(t)
	h.s.Posted([]int64{41})
	if r := h.next(t); r.payload["tx"] != 41.0 {
		t.Fatalf("first POST %v", r.payload)
	}
	h.sent(t)
	retry := h.timer(t) // the first is waiting to retry
	h.s.Posted([]int64{42})
	if r := h.next(t); r.payload["tx"] != 42.0 {
		t.Fatalf("second POST %v, want tx 42 before the retry", r.payload)
	}
	h.sent(t)
	retry.fn()
	if r := h.next(t); r.payload["tx"] != 41.0 {
		t.Fatalf("retry POST %v", r.payload)
	}
	h.sent(t)
	if d, f, _ := h.f.counts("dev1"); d != 2 || f != 0 {
		t.Fatalf("delivered %d, failed %d: want 2 and 0", d, f)
	}
}

// One device's push service never answering holds up no other device: the
// second gets both alerts at once, well inside any timeout.
func TestSlowDeviceDoesNotDelayAnother(t *testing.T) {
	h := newHarness(t)
	h.f.endpoints["dev0"] = h.ph.endpoint("dev0", h.srv.URL+"/slow")
	h.topup(41)
	h.topup(42)
	h.start(t)
	start := time.Now()
	h.s.Posted([]int64{41, 42})
	for _, tx := range []float64{41, 42} {
		if r := h.next(t); r.payload["tx"] != tx {
			t.Fatalf("POST %v, want tx %v", r.payload, tx)
		}
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("the second device waited %v", d)
	}
}

func TestRevokedBeforeDrainNoPost(t *testing.T) {
	h := newHarness(t)
	h.topup(41)
	h.s.Posted([]int64{41}) // queued while the phone is still registered
	h.f.DeletePushEndpoint(context.Background(), "dev1")
	h.start(t)
	h.job(t)
	h.quiet(t)

	// A retry finds the phone revoked in the meantime and posts nothing.
	h.f.endpoints["dev1"] = h.ph.endpoint("dev1", h.srv.URL+"/push/abc")
	h.codes = func(int) int { return http.StatusInternalServerError }
	h.topup(42)
	h.s.Posted([]int64{42})
	h.next(t)
	h.sent(t)
	retry := h.timer(t)
	h.f.DeletePushEndpoint(context.Background(), "dev1")
	retry.fn()
	h.sent(t)
	h.quiet(t)
	h.noTimer(t)
}

// A message cardd can't encrypt is its own fault: logged, never booked as
// the endpoint's failure.
func TestEncryptFailureNotBooked(t *testing.T) {
	h := newHarness(t)
	ep := h.f.endpoints["dev1"]
	ep.Auth = base64.RawURLEncoding.EncodeToString(make([]byte, 8)) // not 16 bytes
	h.f.endpoints["dev1"] = ep
	h.topup(41)
	h.start(t)
	h.s.Posted([]int64{41})
	h.sent(t)
	h.quiet(t)
	h.noTimer(t)
	if d, f, gone := h.f.counts("dev1"); d != 0 || f != 0 || gone {
		t.Fatalf("delivered %d, failed %d, deleted %v: want nothing booked", d, f, gone)
	}
	wantLog(t, h.logs, "encrypting")
}

// Send queues a payload made elsewhere (hosting's low-funding alert) to
// every owner device, as a payment's.
func TestSendQueuesAPrebuiltPayloadToEveryOwnerDevice(t *testing.T) {
	h := newHarness(t)
	h.f.endpoints["dev2"] = h.ph.endpoint("dev2", h.srv.URL+"/push/def")
	h.start(t)
	if !h.s.Send(HostingLow(1_100_000, 5, t0), UrgencyNormal) {
		t.Fatal("Send said the queue was full")
	}
	paths := map[string]bool{}
	for range 2 {
		r := h.next(t)
		h.sent(t)
		paths[r.path] = true
		if r.payload["kind"] != "hosting" || r.payload["tag"] != "hosting-low" || r.payload["count"] != 5.0 || r.payload["account"] != "hosting" {
			t.Errorf("payload %v", r.payload)
		}
		if r.header.Get("Urgency") != "normal" {
			t.Errorf("urgency %q", r.header.Get("Urgency"))
		}
	}
	if !paths["/push/abc"] || !paths["/push/def"] {
		t.Errorf("posted to %v, want both devices", paths)
	}
}

func TestSendWithTheQueueFullSaysSo(t *testing.T) {
	h := newHarness(t)
	for range queueSize {
		if !h.s.Send(HostingLow(1_100_000, 5, t0), UrgencyNormal) {
			t.Fatal("the queue filled early")
		}
	}
	if h.s.Send(HostingLow(1_100_000, 5, t0), UrgencyNormal) {
		t.Fatal("Send said it queued into a full queue")
	}
}

func TestQueueFullDropsWithLog(t *testing.T) {
	h := newHarness(t)
	ids := make([]int64, queueSize+44)
	for i := range ids {
		ids[i] = int64(i + 1)
	}
	done := make(chan struct{})
	go func() { h.s.Posted(ids); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Posted blocked on a full queue")
	}
	wantLog(t, h.logs, "queue full: 44 transactions not alerted")

	h.s.Refused(Refusal{CardID: blueID, Reason: RefusedDaily, At: t0})
	wantLog(t, h.logs, "queue full: a refused tap of card b1ee not alerted")
}

func TestSenderTest(t *testing.T) {
	h := newHarness(t)
	if err := h.s.Test(context.Background(), "dev1"); err != nil {
		t.Fatal(err)
	}
	r := h.next(t)
	if r.payload["kind"] != "test" || r.header.Get("Urgency") != "high" {
		t.Errorf("payload %v urgency %q", r.payload, r.header.Get("Urgency"))
	}
	if d, _, _ := h.f.counts("dev1"); d != 1 {
		t.Errorf("delivered %d", d)
	}

	h.codes = func(int) int { return http.StatusBadRequest }
	if err := h.s.Test(context.Background(), "dev1"); err == nil || !strings.Contains(err.Error(), "400") {
		t.Errorf("err %v, want the 400", err)
	}
	h.next(t)
	if _, f, _ := h.f.counts("dev1"); f != 1 {
		t.Errorf("failures %d, want 1", f)
	}
	h.noTimer(t) // a test is answered at once, not retried

	h.codes = func(int) int { return http.StatusGone }
	if err := h.s.Test(context.Background(), "dev1"); !errors.Is(err, ErrGone) {
		t.Errorf("err %v, want ErrGone", err)
	}
	h.next(t)
	if err := h.s.Test(context.Background(), "dev1"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("err %v after the endpoint went, want store.ErrNotFound", err)
	}
}

// A failed post's error, logged and kept as the endpoint's failure, names the
// push service's origin and the cause, never the endpoint's path (the
// device's topic or token).
func TestPostErrorKeepsOnlyTheOrigin(t *testing.T) {
	secret := "https://fcm.googleapis.com/fcm/send/SECRET-TOKEN"
	err := postError(&url.Error{Op: "Post", URL: secret, Err: context.DeadlineExceeded})
	if strings.Contains(err.Error(), "SECRET") || !strings.Contains(err.Error(), "https://fcm.googleapis.com") {
		t.Errorf("error %q", err)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("error %q lost its cause", err)
	}
	if got := originOf("%%not a url"); got != "the push service" {
		t.Errorf("originOf a bad URL = %q", got)
	}
}
