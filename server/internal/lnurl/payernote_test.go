package lnurl_test

import (
	"bytes"
	"context"
	"log"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/store"
)

// A payer's note on a top-up (LUD-12,
// https://github.com/lnurl/luds/blob/luds/12.md).

// noted asks pool's callback for an invoice of sat with comment as its note.
func (w *world) noted(sat int64, comment string) map[string]any {
	w.t.Helper()
	return w.get("/lnurlp/pool/cb?amount=" + strconv.FormatInt(sat*1000, 10) + "&comment=" + url.QueryEscape(comment))
}

// noteOf is the payer's note on the line of bolt11's payment.
func (w *world) noteOf(bolt11 string) string {
	w.t.Helper()
	info, _ := w.f.InvoiceInfo(bolt11)
	note, err := w.st.PayerNoteOf(context.Background(), info.PaymentHash)
	if err != nil {
		w.t.Fatal(err)
	}
	return note
}

func TestThePayRequestOffersANote(t *testing.T) {
	w := setup(t)
	if pr := w.get("/.well-known/lnurlp/pool"); pr["commentAllowed"] != 140.0 {
		t.Fatalf("payRequest: %v", pr)
	}
}

func TestATopUpsNoteReachesItsLine(t *testing.T) {
	w := setup(t)
	bolt11 := w.noted(30_000, "refund, order 1043")["pr"].(string)
	w.f.Receive(bolt11, 30_000, 0)
	w.credited(bolt11)
	h, _ := w.st.History(context.Background(), store.Pool, 0, 1)
	if len(h) != 1 || h[0].PayerNote != "refund, order 1043" || h[0].AmountMsat != 30_000_000 {
		t.Fatalf("pool's line: %+v", h)
	}
}

func TestANotesCleaningAtTheCallback(t *testing.T) {
	w := setup(t)
	x := func(n int) string { return strings.Repeat("x", n) }
	for _, c := range []struct{ comment, want string }{
		{"", ""},
		{"\x00\x07​", ""},
		{"  a\nb  ", "a b"},
		{strings.Repeat("é", 140), strings.Repeat("é", 140)},
		{x(141), x(140) + "…"},
		// Each ZWJ (a format character) becomes a space: 144 code points, cut at 140.
		{x(139) + "\U0001F468‍\U0001F469‍\U0001F467", x(139) + "\U0001F468…"},
		{"a\xffb", "a�b"},
	} {
		cb := w.noted(1_000, c.comment)
		bolt11, ok := cb["pr"].(string)
		if !ok {
			t.Fatalf("%q: %v", c.comment, cb)
		}
		w.f.Receive(bolt11, 1_000, 0)
		w.credited(bolt11)
		if got := w.noteOf(bolt11); got != c.want {
			t.Errorf("%q: note %q, want %q", c.comment, got, c.want)
		}
	}
}

func TestAHugeNoteIsRefused(t *testing.T) {
	w := setup(t)
	before := w.f.InvoiceCount()
	cb := w.noted(1_000, strings.Repeat("y", 2_049))
	if cb["status"] != "ERROR" || cb["reason"] != "The note is too long." || cb["pr"] != nil {
		t.Fatalf("2,049 bytes: %v", cb)
	}
	if n := w.f.InvoiceCount(); n != before {
		t.Fatalf("invoices made: %d", n-before)
	}
	if cb := w.noted(1_000, strings.Repeat("y", 2_048)); cb["pr"] == nil {
		t.Fatalf("2,048 bytes: %v", cb)
	}
}

func TestAFailedNoteFailsTheCallback(t *testing.T) {
	w := setup(t)
	w.st.Close()
	cb := w.noted(1_000, "thanks")
	if cb["status"] != "ERROR" || cb["reason"] != "The server can't make an invoice right now." || cb["pr"] != nil {
		t.Fatalf("callback: %v", cb)
	}
}

func TestTheLogGivesANotesLengthNotItsText(t *testing.T) {
	w := setup(t)
	read := w.logged()
	bolt11 := w.noted(3_000, "refund, order 1043")["pr"].(string)
	w.f.Receive(bolt11, 3_000, 0)
	w.credited(bolt11)
	eventually(t, "the credit logged", func() bool { return strings.Contains(read(), "top-up") })
	got := read()
	if !strings.Contains(got, ", payer's note 18 chars") || strings.Contains(got, "refund") {
		t.Fatalf("log: %q", got)
	}
}

// The start sweep credits a payment phoenixd took while cardd was down, then
// prunes: a note older than the window keeps its line.
func TestTheStartSweepCreditsBeforeThePrune(t *testing.T) {
	w := setup(t)
	w.f.Set(func(f *phoenixdtest.Fake) { f.WebhookURL = "" })
	bolt11 := w.noted(5_000, "float for Saturday")["pr"].(string)
	w.f.Receive(bolt11, 5_000, 0)
	w.s.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go w.s.RunSweep(ctx)
	w.credited(bolt11)
	if got := w.noteOf(bolt11); got != "float for Saturday" {
		t.Fatalf("note %q", got)
	}
}

// After a good sweep cardd prunes the notes of invoices unpaid for over an
// hour, and says how many (a flood shows in the log); a payment that comes
// later still credits, without its note.
func TestAGoodSweepPrunesAnUnpaidNoteAfterAnHour(t *testing.T) {
	w := setup(t)
	bolt11 := w.noted(5_000, "float for Saturday")["pr"].(string)
	w.s.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	read := w.logged()
	ctx, stop := context.WithCancel(context.Background())
	go w.s.RunSweep(ctx)
	eventually(t, "the prune logged", func() bool { return strings.Contains(read(), "lnurl: pruned 1 payers' notes") })
	stop()
	w.f.Receive(bolt11, 5_000, 0)
	w.credited(bolt11)
	if got := w.noteOf(bolt11); got != "" {
		t.Fatalf("note %q, want it pruned", got)
	}
}

// logged sends the server's log to a buffer that RunSweep's and the
// webhook's goroutines can write while the test reads it, and returns its
// reader.
func (w *world) logged() func() string {
	l := &lockedWriter{}
	w.s.Log = log.New(l, "", 0)
	return func() string {
		l.mu.Lock()
		defer l.mu.Unlock()
		return l.b.String()
	}
}

type lockedWriter struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func TestAFailedSweepPrunesNothing(t *testing.T) {
	w := setup(t)
	bolt11 := w.noted(5_000, "float for Saturday")["pr"].(string)
	w.s.Now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	w.f.SetDown(true)
	read := w.logged()
	ctx, stop := context.WithCancel(context.Background())
	go w.s.RunSweep(ctx)
	eventually(t, "the start sweep failed", func() bool { return strings.Contains(read(), "lnurl: sweep:") })
	stop()
	w.f.SetDown(false)
	w.f.Receive(bolt11, 5_000, 0)
	w.credited(bolt11)
	if got := w.noteOf(bolt11); got != "float for Saturday" {
		t.Fatalf("note %q", got)
	}
}
