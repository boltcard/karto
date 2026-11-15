package alerts

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// request is one POST a push service got, its body decrypted.
type request struct {
	path, query string
	header      http.Header
	payload     map[string]any
}

type timer struct {
	d  time.Duration
	fn func()
}

// harness is a Sender posting to a TLS push service in the test, with a
// clock and timers the test moves by hand.
type harness struct {
	s     *Sender
	f     *fakeStore
	ph    phone
	srv   *httptest.Server
	reqs  chan request
	jobs  chan struct{}
	sends chan struct{}
	logs  *syncBuffer
	codes func(n int) int // the status for the nth POST (from 1)

	mu     sync.Mutex
	now    time.Time
	timers []timer
	posts  int
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{f: gbpStore(t), ph: newPhone(t), reqs: make(chan request, 64), jobs: make(chan struct{}, 64), sends: make(chan struct{}, 64), logs: &syncBuffer{}, now: t0}
	h.codes = func(int) int { return http.StatusCreated }
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/slow" { // a push service that never answers
			io.ReadAll(r.Body) // so the server sees the client hang up
			<-r.Context().Done()
			return
		}
		body, _ := io.ReadAll(r.Body)
		plain, err := h.ph.open(body)
		if err != nil {
			t.Errorf("decrypting a POST to %s: %v", r.URL.Path, err)
		}
		var p map[string]any
		if err := json.Unmarshal(plain, &p); err != nil {
			t.Errorf("payload %q: %v", plain, err)
		}
		h.mu.Lock()
		h.posts++
		n := h.posts
		h.mu.Unlock()
		w.WriteHeader(h.codes(n))
		h.reqs <- request{r.URL.Path, r.URL.RawQuery, r.Header.Clone(), p}
	})
	h.srv = httptest.NewTLSServer(handler)
	t.Cleanup(h.srv.Close)
	h.f.endpoints["dev1"] = h.ph.endpoint("dev1", h.srv.URL+"/push/abc")
	h.s = &Sender{
		Store:  h.f,
		Prices: fresh,
		HTTP:   h.srv.Client(),
		Log:    log.New(h.logs, "", 0),
		Now:    h.clock,
		Check:  func(string) error { return nil }, // the test's service is on loopback
		after:  h.after,
		onJob:  func() { h.jobs <- struct{}{} },
		onSend: func() { h.sends <- struct{}{} },
	}
	return h
}

func (h *harness) clock() time.Time {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.now
}

func (h *harness) at(t time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.now = t
}

func (h *harness) after(d time.Duration, fn func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.timers = append(h.timers, timer{d, fn})
}

// timer takes the next timer set, failing if there is none.
func (h *harness) timer(t *testing.T) timer {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.timers) == 0 {
		t.Fatal("no timer was set")
	}
	tm := h.timers[0]
	h.timers = h.timers[1:]
	return tm
}

func (h *harness) noTimer(t *testing.T) {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.timers) > 0 {
		t.Fatalf("%d timers set, want none (first in %v)", len(h.timers), h.timers[0].d)
	}
}

func (h *harness) start(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { h.s.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
}

func (h *harness) next(t *testing.T) request {
	t.Helper()
	select {
	case r := <-h.reqs:
		return r
	case <-time.After(5 * time.Second):
		t.Fatal("no POST came")
		return request{}
	}
}

// job waits for the sender to finish handling one job.
func (h *harness) job(t *testing.T) {
	t.Helper()
	select {
	case <-h.jobs:
	case <-time.After(5 * time.Second):
		t.Fatal("the sender handled no job")
	}
}

// sent waits for a device's worker to finish handling one message.
func (h *harness) sent(t *testing.T) {
	t.Helper()
	select {
	case <-h.sends:
	case <-time.After(5 * time.Second):
		t.Fatal("no device's worker handled a message")
	}
}

func (h *harness) quiet(t *testing.T) {
	t.Helper()
	select {
	case r := <-h.reqs:
		t.Fatalf("a POST came, want none: %v", r.payload)
	case <-time.After(50 * time.Millisecond):
	}
}

func wantLog(t *testing.T, logs *syncBuffer, s string) {
	t.Helper()
	if !strings.Contains(logs.String(), s) {
		t.Fatalf("log %q lacks %q", logs.String(), s)
	}
}
