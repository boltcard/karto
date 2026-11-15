package lnurl_test

import (
	"context"
	"encoding/hex"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/cardkeys"
	"github.com/boltcard/karto/server/internal/lnurl"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/sun"
)

// rawGet is the exact body the terminal gets.
func rawGet(t *testing.T, w *world, path string) string {
	t.Helper()
	resp, err := http.Get(w.pub.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

// refusals collects what Server.Refused is told.
type refusals struct {
	mu  sync.Mutex
	got []lnurl.Refusal
}

func (r *refusals) add(x lnurl.Refusal) {
	r.mu.Lock()
	r.got = append(r.got, x)
	r.mu.Unlock()
}

func (r *refusals) all() []lnurl.Refusal {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]lnurl.Refusal(nil), r.got...)
}

func watch(w *world) *refusals {
	r := &refusals{}
	w.s.Refused = r.add
	return r
}

// one checks that exactly one refusal was told, and returns it.
func (r *refusals) one(t *testing.T) lnurl.Refusal {
	t.Helper()
	g := r.all()
	if len(g) != 1 {
		t.Fatalf("refusals told: %+v", g)
	}
	if g[0].CardID != cardID || g[0].At.IsZero() {
		t.Fatalf("refusal: %+v", g[0])
	}
	return g[0]
}

func (r *refusals) none(t *testing.T) {
	t.Helper()
	if g := r.all(); len(g) != 0 {
		t.Fatalf("expected no refusal, told: %+v", g)
	}
}

func TestRefusedFrozen(t *testing.T) {
	w := setup(t)
	r := watch(w)
	w.st.FreezeCard(context.Background(), cardID)
	if x := w.get(w.tap()); x["status"] != "ERROR" {
		t.Fatalf("frozen tap: %v", x)
	}
	if g := r.one(t); g.Reason != lnurl.RefusedOff || g.AmountMsat != 0 {
		t.Fatalf("refusal: %+v", g)
	}
}

func TestRefusedPausedNamesCard(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	r := watch(w)
	w.f.BalanceSat = 1
	w.l.Reconcile(ctx)
	tap := w.tap()
	if x := w.get(tap); !strings.Contains(x["reason"].(string), "paused") {
		t.Fatalf("paused: %v", x)
	}
	if g := r.one(t); g.Reason != lnurl.RefusedPaused {
		t.Fatalf("refusal: %+v", g)
	}
	// The paused refusal did not move the counter.
	if c, _ := w.st.GetCard(ctx, cardID); c.LastCounter != 1 {
		t.Fatalf("counter %d", c.LastCounter)
	}
}

func TestRefusedPausedUnknownCardQuiet(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	r := watch(w)
	w.f.BalanceSat = 1
	w.l.Reconcile(ctx)
	w.get("/ln?p=00000000000000000000000000000000&c=0000000000000000")
	r.none(t)
}

func TestRefusedRepeatRecentCurrentCounterQuiet(t *testing.T) {
	w := setup(t)
	r := watch(w)
	tap := w.tap()
	if x := w.get(tap); x["tag"] != "withdrawRequest" {
		t.Fatalf("first: %v", x)
	}
	if x := w.get(tap); !strings.Contains(x["reason"].(string), "already used") {
		t.Fatalf("retry: %v", x)
	}
	r.none(t)
}

func TestRefusedRepeatOldCounter(t *testing.T) {
	w := setup(t)
	r := watch(w)
	first := w.tap()
	w.get(first)
	w.get(w.tap()) // the counter moves on
	w.get(first)
	if g := r.one(t); g.Reason != lnurl.RefusedRepeated {
		t.Fatalf("refusal: %+v", g)
	}
}

func TestRefusedRepeatOfCurrentCounterAfterTwoMinutes(t *testing.T) {
	w := setup(t)
	r := watch(w)
	tap := w.tap()
	w.get(tap)
	w.s.Now = func() time.Time { return time.Now().Add(3 * time.Minute) }
	w.get(tap)
	if g := r.one(t); g.Reason != lnurl.RefusedRepeated {
		t.Fatalf("refusal: %+v", g)
	}
}

// Two taps with one counter at once: the loser's copy of the card is from before the winner moved
// the counter, and the handler reads the card again, so no loser is alerted.
func TestRefusedRepeatRaceReadsCardAgain(t *testing.T) {
	w := setup(t)
	r := watch(w)
	tap := w.tap()
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); w.get(tap) }()
	}
	wg.Wait()
	r.none(t)
}

func TestRefusedOverPerTapHasAmount(t *testing.T) {
	w := setup(t)
	r := watch(w)
	wr := w.get(w.tap())
	bolt11, _ := w.f.Invoice(20_001_000)
	w.get("/ln/cb?k1=" + wr["k1"].(string) + "&pr=" + bolt11)
	if g := r.one(t); g.Reason != lnurl.RefusedPerTap || g.AmountMsat != 20_001_000 {
		t.Fatalf("per tap: %+v", g)
	}
}

func TestRefusedOverDailyHasAmount(t *testing.T) {
	w := setup(t)
	if _, err := w.st.SetLimits(context.Background(), cardID, 100, 100); err != nil {
		t.Fatal(err)
	}
	r := watch(w)
	pay := func(sat int64) {
		wr := w.get(w.tap())
		bolt11, _ := w.f.Invoice(sat * 1000)
		w.get("/ln/cb?k1=" + wr["k1"].(string) + "&pr=" + bolt11)
	}
	pay(60)
	r.none(t)
	pay(60)
	if g := r.one(t); g.Reason != lnurl.RefusedDaily || g.AmountMsat != 60_000 {
		t.Fatalf("daily: %+v", g)
	}
}

func TestRefusedFunds(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	r := watch(w)
	w.st.Move(ctx, store.CardAccount(cardID), store.Pool, 100_000_000, "")
	wr := w.get(w.tap())
	bolt11, _ := w.f.Invoice(1_000_000)
	w.get("/ln/cb?k1=" + wr["k1"].(string) + "&pr=" + bolt11)
	if g := r.one(t); g.Reason != lnurl.RefusedFunds || g.AmountMsat != 1_000_000 {
		t.Fatalf("refusal: %+v", g)
	}
}

func TestRefusedInvoice(t *testing.T) {
	w := setup(t)
	r := watch(w)
	wr := w.get(w.tap())
	w.get("/ln/cb?k1=" + wr["k1"].(string) + "&pr=" + w.f.ExpiredInvoice(1000))
	if g := r.one(t); g.Reason != lnurl.RefusedInvoice || g.AmountMsat != 0 {
		t.Fatalf("refusal: %+v", g)
	}
}

func TestRefusedUnknownCardQuiet(t *testing.T) {
	w := setup(t)
	r := watch(w)
	w.get("/ln?p=00000000000000000000000000000000&c=0000000000000000")
	// A well-formed tap of a card this server never reserved.
	other, _ := hex.DecodeString("04a39493cc8681")
	k1, _ := cardkeys.K1(issuer)
	keys, _ := cardkeys.Derive(issuer, other, 0)
	p, c, _ := sun.Build(k1, keys.K2, other, 3, [5]byte{1})
	w.get("/ln?p=" + strings.ToUpper(hex.EncodeToString(p)) + "&c=" + strings.ToUpper(hex.EncodeToString(c)))
	r.none(t)
}

func TestRefusedBadK1Quiet(t *testing.T) {
	w := setup(t)
	r := watch(w)
	bolt11, _ := w.f.Invoice(1_000_000)
	w.get("/ln/cb?k1=" + strings.Repeat("ab", 32) + "&pr=" + bolt11)
	r.none(t)
}

// A phoenixd hiccup and a payment in progress are not the rules' refusals.
func TestRefusedNotForOtherErrors(t *testing.T) {
	w := setup(t)
	r := watch(w)
	wr := w.get(w.tap())
	bolt11, hash := w.f.Invoice(1_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	w.get("/ln/cb?k1=" + wr["k1"].(string) + "&pr=" + bolt11)
	wr = w.get(w.tap())
	b2, _ := w.f.Invoice(1000)
	w.get("/ln/cb?k1=" + wr["k1"].(string) + "&pr=" + b2) // in progress
	w.f.Release(hash, false, 0)
	r.none(t)
}

// The terminal's answers are what they were before refusals were told of.
func TestTerminalAnswersUnchanged(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	watch(w)
	body := func(path string) string {
		t.Helper()
		return rawGet(t, w, path)
	}
	cb := func(sat int64) string {
		wr := w.get(w.tap())
		bolt11, _ := w.f.Invoice(sat * 1000)
		return body("/ln/cb?k1=" + wr["k1"].(string) + "&pr=" + bolt11)
	}
	const (
		replay  = `{"reason":"This tap was already used. Tap the card again.","status":"ERROR"}` + "\n"
		frozen  = `{"reason":"This card is frozen.","status":"ERROR"}` + "\n"
		paused  = `{"reason":"Spending is paused on this card's server.","status":"ERROR"}` + "\n"
		perTap  = `{"reason":"That is over this card's limit per payment.","status":"ERROR"}` + "\n"
		funds   = `{"reason":"There isn't enough money on this card.","status":"ERROR"}` + "\n"
		badK1   = `{"reason":"This payment request has expired or was used. Tap the card again.","status":"ERROR"}` + "\n"
		unknown = `{"reason":"This card isn't registered on this server.","status":"ERROR"}` + "\n"
	)
	tap := w.tap()
	w.get(tap)
	if got := body(tap); got != replay {
		t.Fatalf("replay: %q", got)
	}
	if got := body("/ln?p=00000000000000000000000000000000&c=0000000000000000"); got != unknown {
		t.Fatalf("unknown: %q", got)
	}
	if got := cb(20_001); got != perTap {
		t.Fatalf("per tap: %q", got)
	}
	if got := body("/ln/cb?k1=" + strings.Repeat("ab", 32) + "&pr=x"); got != badK1 {
		t.Fatalf("bad k1: %q", got)
	}
	wr := w.get(w.tap())
	if got := body("/ln/cb?k1=" + wr["k1"].(string) + "&pr=" + w.f.ExpiredInvoice(1000)); got != `{"reason":"The terminal's invoice can't be paid: it has expired.","status":"ERROR"}`+"\n" {
		t.Fatalf("expired: %q", got)
	}
	w.st.Move(ctx, store.CardAccount(cardID), store.Pool, 100_000_000, "")
	if got := cb(1); got != funds {
		t.Fatalf("funds: %q", got)
	}
	w.st.FreezeCard(ctx, cardID)
	if got := body(w.tap()); got != frozen {
		t.Fatalf("frozen: %q", got)
	}
	w.st.UnfreezeCard(ctx, cardID)
	w.f.BalanceSat = 1
	w.l.Reconcile(ctx)
	if got := body(w.tap()); got != paused {
		t.Fatalf("paused: %q", got)
	}
}
