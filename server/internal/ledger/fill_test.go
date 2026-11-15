package ledger_test

import (
	"bytes"
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/store"
)

// failing is phoenixd failing (HTTP 500) on the questions about chosen
// payments, and, with all, on every payment question: phoenixd whose
// payments database is locked, while its balance (from memory) still answers.
type failing struct {
	*phoenixd.Client
	mu       sync.Mutex
	hashes   map[string]bool // OutgoingByHash fails for these
	invoices map[string]bool // DecodeInvoice fails for these
	all      bool            // OutgoingByHash fails for every hash
	asked    map[string]int  // OutgoingByHash's calls, by hash
}

func newFailing(f *phoenixdtest.Fake) *failing {
	return &failing{Client: phoenixd.New(f.URL, phoenixdtest.Password), hashes: map[string]bool{}, invoices: map[string]bool{}, asked: map[string]int{}}
}

func serverError(what string) error {
	return &phoenixd.ServerError{Status: 500, Detail: what + ": HTTP 500: Internal Server Error"}
}

func (p *failing) OutgoingByHash(ctx context.Context, hash string) (phoenixd.Outgoing, error) {
	p.mu.Lock()
	bad := p.all || p.hashes[hash]
	p.asked[hash]++
	p.mu.Unlock()
	if bad {
		return phoenixd.Outgoing{}, serverError("GET /payments/outgoingbyhash/" + hash)
	}
	return p.Client.OutgoingByHash(ctx, hash)
}

func (p *failing) DecodeInvoice(ctx context.Context, bolt11 string) (phoenixd.Invoice, error) {
	p.mu.Lock()
	bad := p.invoices[bolt11]
	p.mu.Unlock()
	if bad {
		return phoenixd.Invoice{}, serverError("POST /decodeinvoice")
	}
	return p.Client.DecodeInvoice(ctx, bolt11)
}

func (p *failing) set(change func(p *failing)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	change(p)
}

// oldHolds pays n settled spends and sets them back to how a database from
// before migration 8 has them: nothing asked, no description.
func oldHolds(t *testing.T, w *world, n int) []store.Hold {
	t.Helper()
	var holds []store.Hold
	for range n {
		_, done, _ := w.pay(t, 10)
		holds = append(holds, wait(t, done).Hold)
	}
	forgetProofs(t, w.path)
	return holds
}

// fill runs FillProofs and checks what it counted.
func fill(t *testing.T, l *ledger.Ledger, found, unknown, skipped int) {
	t.Helper()
	f, u, s, err := l.FillProofs(context.Background())
	if err != nil || f != found || u != unknown || s != skipped {
		t.Fatalf("filled: %d found, %d unknown, %d skipped, %v; want %d, %d, %d", f, u, s, err, found, unknown, skipped)
	}
}

func asked(t *testing.T, w *world, h store.Hold) store.Hold {
	t.Helper()
	got, err := w.st.GetHold(context.Background(), h.ID)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// A payment phoenixd fails on, while it answers for others, doesn't stop the
// ones after it; after three runs in which phoenixd answered for another one
// it is kept as asked and not known.
func TestAHoldPhoenixdFailsOnDoesntStopTheRest(t *testing.T) {
	w := setup(t)
	holds := oldHolds(t, w, 3)
	p := newFailing(w.f)
	p.hashes[holds[0].PaymentHash] = true
	p.hashes[holds[2].PaymentHash] = true
	var out bytes.Buffer
	l := ledger.New(w.st, p, log.New(&out, "", 0))

	// The first is asked before phoenixd has answered anything: skipped, not
	// counted. The good one between, then the last, counted once.
	fill(t, l, 1, 0, 2)
	if got := asked(t, w, holds[1]); !got.PreimageAsked || got.Preimage == "" {
		t.Fatalf("the good one: %+v", got)
	}
	fill(t, l, 0, 0, 2) // holds[0] counted once, holds[2] twice
	if n := strings.Count(out.String(), "phoenixd failed ("); n != 2 {
		t.Fatalf("a failing hold's first failure logged %d times for two holds:\n%s", n, out.String())
	}
	fill(t, l, 0, 1, 1) // holds[2] given up
	fill(t, l, 0, 1, 0) // and holds[0]
	for _, h := range []store.Hold{holds[0], holds[2]} {
		if got := asked(t, w, h); !got.PreimageAsked || got.Preimage != "" {
			t.Fatalf("given up: %+v", got)
		}
	}
	if !strings.Contains(out.String(), "phoenixd failed 3 times, kept as not known") {
		t.Fatalf("giving up not logged:\n%s", out.String())
	}
	if left, _ := w.st.HoldsToAsk(context.Background(), 0, 10); len(left) != 0 {
		t.Fatalf("%d left", len(left))
	}
}

// A failing hold in the first batch doesn't keep the pass from the next
// batch: the walk goes on past it.
func TestTheWalkGoesPastAFailingHold(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	holds := oldHolds(t, w, 1)
	// More holds than one batch (fillBatch, 100): settled holds written
	// straight into the store, their hashes unknown to phoenixd (a 404).
	for i := range 101 {
		h, err := w.st.OpenHold(ctx, store.HoldRequest{Account: card, Kind: store.KindSpend, AmountMsat: 1_000, PaymentHash: phoenixdHash(i), Invoice: "lnbc1"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.st.SettleHold(ctx, h.ID, 0); err != nil {
			t.Fatal(err)
		}
	}
	forgetProofs(t, w.path)
	p := newFailing(w.f)
	p.hashes[holds[0].PaymentHash] = true
	l := ledger.New(w.st, p, log.New(&bytes.Buffer{}, "", 0))
	fill(t, l, 0, 101, 1)
	if left, _ := w.st.HoldsToAsk(ctx, 0, 200); len(left) != 1 || left[0].ID != holds[0].ID {
		t.Fatalf("left: %v", left)
	}
}

func phoenixdHash(i int) string {
	return strings.Repeat("0", 60) + string("0123456789abcdef"[i/16%16]) + string("0123456789abcdef"[i%16]) + "ff"
}

// phoenixd failing on every payment question (its payments database locked,
// its balance still answering from memory) is phoenixd as a whole: the run
// stops, and nothing is marked or counted against a hold, however long it
// lasts.
func TestPhoenixdFailingOnEveryPaymentCountsNothing(t *testing.T) {
	w := setup(t)
	holds := oldHolds(t, w, 3)
	p := newFailing(w.f)
	p.hashes[holds[0].PaymentHash] = true
	p.hashes[holds[1].PaymentHash] = true
	l := ledger.New(w.st, p, log.New(&bytes.Buffer{}, "", 0))
	fill(t, l, 1, 0, 2) // holds[2] answers: phoenixd is known to answer for it
	p.set(func(p *failing) { p.all = true })
	for range 5 {
		var failed *phoenixd.ServerError
		if _, _, _, err := l.FillProofs(context.Background()); !errors.As(err, &failed) {
			t.Fatalf("not stopped: %v", err)
		}
	}
	for _, h := range holds[:2] {
		if got := asked(t, w, h); got.PreimageAsked {
			t.Fatalf("marked while phoenixd failed on everything: %+v", got)
		}
	}
	// phoenixd better: the five stopped runs counted nothing, so three more
	// runs are needed to give up.
	p.set(func(p *failing) { p.all = false })
	fill(t, l, 0, 0, 2)
	fill(t, l, 0, 0, 2)
	fill(t, l, 0, 2, 0)
}

// A failing hold with nothing yet known to phoenixd but a payment cardd has
// the proof of: that payment is the check, and the failure counts.
func TestAPaymentWithAProofIsTheCheck(t *testing.T) {
	w := setup(t)
	holds := oldHolds(t, w, 1)
	_, done, _ := w.pay(t, 10) // a new payment: settled with its proof
	known := wait(t, done).Hold
	p := newFailing(w.f)
	p.hashes[holds[0].PaymentHash] = true
	l := ledger.New(w.st, p, log.New(&bytes.Buffer{}, "", 0))
	fill(t, l, 0, 0, 1)
	fill(t, l, 0, 0, 1)
	fill(t, l, 0, 1, 0)
	if n := p.asked[known.PaymentHash]; n != 3 {
		t.Fatalf("the payment with a proof asked %d times as the check, want 3", n)
	}
}

// A hold that failed twice and then answers is filled with its proof, not
// given up on; one that failed three times beside it is given up on.
func TestAHoldThatAnswersAfterFailingIsFilled(t *testing.T) {
	w := setup(t)
	holds := oldHolds(t, w, 3)
	p := newFailing(w.f)
	p.hashes[holds[0].PaymentHash] = true
	p.hashes[holds[1].PaymentHash] = true
	l := ledger.New(w.st, p, log.New(&bytes.Buffer{}, "", 0))
	fill(t, l, 1, 0, 2) // holds[2] found; the two before it not counted yet
	fill(t, l, 0, 0, 2)
	fill(t, l, 0, 0, 2)
	p.set(func(p *failing) { delete(p.hashes, holds[0].PaymentHash) })
	fill(t, l, 1, 1, 0)
	if got := asked(t, w, holds[0]); got.Preimage == "" {
		t.Fatalf("filled after failing: %+v", got)
	}
	if got := asked(t, w, holds[1]); !got.PreimageAsked || got.Preimage != "" {
		t.Fatalf("given up: %+v", got)
	}
}

// Only the decode failing: phoenixd answered the payment question, so it
// counts; the proof phoenixd gave is kept when the pass gives up, with no
// description.
func TestGivingUpKeepsAProofFound(t *testing.T) {
	w := setup(t)
	holds := oldHolds(t, w, 1)
	p := newFailing(w.f)
	p.invoices[holds[0].Invoice] = true
	var out bytes.Buffer
	l := ledger.New(w.st, p, log.New(&out, "", 0))
	fill(t, l, 0, 0, 1)
	fill(t, l, 0, 0, 1)
	fill(t, l, 1, 0, 0)
	if got := asked(t, w, holds[0]); !got.PreimageAsked || got.Preimage == "" || got.About.Description != "" {
		t.Fatalf("given up after the decode failed: %+v", got)
	}
	if !strings.Contains(out.String(), "kept with its proof, no description") {
		t.Fatalf("giving up's line:\n%s", out.String())
	}
}

// A preimage phoenixd gave in an earlier run (only the decode failed) is
// kept when the run that gives up fails on the payment question itself.
func TestAPreimageSeenEarlierIsKept(t *testing.T) {
	w := setup(t)
	holds := oldHolds(t, w, 2)
	p := newFailing(w.f)
	p.invoices[holds[0].Invoice] = true
	l := ledger.New(w.st, p, log.New(&bytes.Buffer{}, "", 0))
	fill(t, l, 1, 0, 1) // holds[1] found, so phoenixd is known to answer
	fill(t, l, 0, 0, 1)
	p.set(func(p *failing) { p.hashes[holds[0].PaymentHash] = true })
	fill(t, l, 1, 0, 0)
	if got := asked(t, w, holds[0]); got.Preimage == "" {
		t.Fatalf("the preimage seen before was lost: %+v", got)
	}
}

// The first hold failing before phoenixd has answered anything: skipped
// without being counted, and the next one found.
func TestTheFirstHoldFailingBeforeAnyAnswer(t *testing.T) {
	w := setup(t)
	holds := oldHolds(t, w, 2)
	p := newFailing(w.f)
	p.hashes[holds[0].PaymentHash] = true
	var out bytes.Buffer
	l := ledger.New(w.st, p, log.New(&out, "", 0))
	fill(t, l, 1, 0, 1)
	if got := asked(t, w, holds[1]); got.Preimage == "" {
		t.Fatalf("the next one: %+v", got)
	}
	if strings.Contains(out.String(), "phoenixd failed (") {
		t.Fatalf("counted before phoenixd was known to answer:\n%s", out.String())
	}
}

// A payinvoice that answers HTTP 500 may have sent: the hold stays open, to
// be resolved later, and isn't released as a refusal would be.
func TestAPayinvoice500LeavesTheHoldOpen(t *testing.T) {
	w := setup(t)
	w.f.Set(func(f *phoenixdtest.Fake) { f.Broken = "/payinvoice" })
	h, done, _ := w.pay(t, 10)
	if o := wait(t, done); !o.Pending {
		t.Fatalf("a 500 from payinvoice: %+v", o)
	}
	if got := asked(t, w, h); got.State != store.HoldOpen {
		t.Fatalf("hold %+v", got)
	}
}

// A stopped run is logged once while its error stays the same, not every
// minute (phoenixd down for an hour is one line).
func TestAStoppedRunIsLoggedOnce(t *testing.T) {
	w := setup(t)
	oldHolds(t, w, 1)
	var out bytes.Buffer
	l := ledger.New(w.st, phoenixd.New(w.f.URL, phoenixdtest.Password), log.New(&out, "", 0))
	if err := l.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	w.f.SetDown(true)
	for range 3 {
		l.FillLaterForTest(context.Background())
		waitIdle(t, l)
	}
	if n := strings.Count(out.String(), "then stopped"); n != 1 {
		t.Fatalf("stopped logged %d times:\n%s", n, out.String())
	}
	w.f.SetDown(false)
	l.FillLaterForTest(context.Background())
	waitIdle(t, l)
	if !strings.Contains(out.String(), "ledger: proofs: 1 found, 0 phoenixd didn't know") {
		t.Fatalf("the run after:\n%s", out.String())
	}
}

// While spending is paused (the books or phoenixd aren't right yet) the
// pass doesn't start; once the books add up it does.
func TestNoFillingWhilePaused(t *testing.T) {
	w := setup(t)
	holds := oldHolds(t, w, 1)
	l := ledger.New(w.st, phoenixd.New(w.f.URL, phoenixdtest.Password), log.New(&bytes.Buffer{}, "", 0))
	if paused, _ := l.Paused(); !paused {
		t.Fatal("a new ledger isn't paused")
	}
	l.FillLaterForTest(context.Background())
	if l.FillingForTest() {
		t.Fatal("a run started while paused")
	}
	time.Sleep(50 * time.Millisecond)
	if got := asked(t, w, holds[0]); got.PreimageAsked {
		t.Fatalf("filled while paused: %+v", got)
	}
	if err := l.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	l.FillLaterForTest(context.Background())
	waitIdle(t, l)
	if got := asked(t, w, holds[0]); got.Preimage == "" {
		t.Fatalf("not filled once the books add up: %+v", got)
	}
}

// byID is phoenixd knowing one payment by its id only, and noting every hash
// it is asked by.
type byID struct {
	*phoenixd.Client
	id, preimage string
	hashes       []string
}

func (p *byID) OutgoingByID(ctx context.Context, id string) (phoenixd.Outgoing, error) {
	if id == p.id {
		return phoenixd.Outgoing{Status: phoenixd.OutgoingPaid, Preimage: p.preimage}, nil
	}
	return p.Client.OutgoingByID(ctx, id)
}

func (p *byID) OutgoingByHash(ctx context.Context, hash string) (phoenixd.Outgoing, error) {
	p.hashes = append(p.hashes, hash)
	return p.Client.OutgoingByHash(ctx, hash)
}

// Should phoenixd ever answer payoffer with an id and no hash (0.9.2 never
// does), an offer's hold settles with that id and no hash; it is
// asked for its proof by that id, never by an empty hash, and is no hash for the
// fill-in pass's check to ask with.
func TestAnOffersHoldWithOnlyAnIDIsAskedByIt(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	h, err := w.st.OpenHold(ctx, store.HoldRequest{Account: card, Kind: store.KindSpend, AmountMsat: 1_000, FeeBudgetMsat: 5_000, Offer: "lno1x"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.st.SetHoldPayment(ctx, h.ID, "", "id-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.st.SettleHold(ctx, h.ID, 0); err != nil {
		t.Fatal(err)
	}
	forgetProofs(t, w.path)
	p := &byID{Client: phoenixd.New(w.f.URL, phoenixdtest.Password), id: "id-1", preimage: strings.Repeat("cd", 32)}
	l := ledger.New(w.st, p, log.New(&bytes.Buffer{}, "", 0))
	fill(t, l, 1, 0, 0)
	if got := asked(t, w, h); got.Preimage != p.preimage || got.PaymentHash != "" {
		t.Fatalf("filled: %+v", got)
	}
	if len(p.hashes) != 0 {
		t.Fatalf("asked by hash: %q", p.hashes)
	}
	if known, err := w.st.KnownPaidHash(ctx); err != nil || known != "" {
		t.Fatalf("a hold with no hash given to the check: %q %v", known, err)
	}
}

func waitIdle(t *testing.T, l *ledger.Ledger) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for l.FillingForTest() {
		if time.Now().After(deadline) {
			t.Fatal("still filling")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
