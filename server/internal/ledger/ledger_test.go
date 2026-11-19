package ledger_test

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/store"
)

const cardID = "e07ce1279d980ecb892a81924b67bf18"

var card = store.CardAccount(cardID)

type world struct {
	st   *store.Store
	path string
	f    *phoenixdtest.Fake
	l    *ledger.Ledger
}

// setup: an active card with 100k sat on it, phoenixd holding the same.
func setup(t *testing.T) *world {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "cardd.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	st.ReserveCard(ctx, cardID, "", "")
	st.ActivateCard(ctx, cardID, 1)
	st.Credit(ctx, card, 100_000_000, "topup", "")
	f := phoenixdtest.New()
	t.Cleanup(f.Close)
	f.BalanceSat = 100_000
	w := &world{st: st, path: path, f: f}
	w.l = ledger.New(st, phoenixd.New(f.URL, phoenixdtest.Password), log.New(io.Discard, "", 0))
	if err := w.l.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	return w
}

func (w *world) pay(t *testing.T, sat int64) (store.Hold, chan ledger.Outcome, string) {
	t.Helper()
	ctx := context.Background()
	bolt11, hash := w.f.Invoice(sat * 1000)
	inv, err := w.l.Decode(ctx, bolt11)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan ledger.Outcome, 1)
	h, err := w.l.Pay(ctx, card, store.KindSpend, bolt11, inv, done)
	if err != nil {
		t.Fatal(err)
	}
	return h, done, hash
}

func wait(t *testing.T, done chan ledger.Outcome) ledger.Outcome {
	t.Helper()
	select {
	case o := <-done:
		return o
	case <-time.After(5 * time.Second):
		t.Fatal("no outcome")
		return ledger.Outcome{}
	}
}

func available(t *testing.T, st *store.Store, a store.Account) int64 {
	b, err := st.Balance(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	return b.AvailableMsat()
}

func TestFeeBudget(t *testing.T) {
	// 0.5% rounded up, plus 5 sat: above phoenixd's 0.4% + 4 sat.
	for amount, want := range map[int64]int64{1_000_000: 10_000, 1: 5_001, 228_000: 6_140, 19_000_000: 100_000} {
		if got := ledger.FeeBudgetMsat(amount); got != want {
			t.Fatalf("%d msat: %d, want %d", amount, got, want)
		}
	}
}

func TestPaySettlesAtTheExactFee(t *testing.T) {
	w := setup(t)
	bolt11, hash := w.f.Invoice(10_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{FeeMsat: 40_123})
	inv, _ := w.l.Decode(context.Background(), bolt11)
	done := make(chan ledger.Outcome, 1)
	w.l.Pay(context.Background(), card, store.KindSpend, bolt11, inv, done)
	o := wait(t, done)
	if o.Pending || o.Hold.State != store.HoldSettled || o.Hold.FeeMsat != 40_123 {
		t.Fatalf("outcome %+v", o)
	}
	if got := available(t, w.st, card); got != 100_000_000-10_000_000-40_123 {
		t.Fatalf("balance %d", got)
	}
}

func TestAFailedPaymentGivesTheHoldBack(t *testing.T) {
	w := setup(t)
	bolt11, hash := w.f.Invoice(10_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Fail: true})
	inv, _ := w.l.Decode(context.Background(), bolt11)
	done := make(chan ledger.Outcome, 1)
	w.l.Pay(context.Background(), card, store.KindSpend, bolt11, inv, done)
	if o := wait(t, done); o.Hold.State != store.HoldReleased {
		t.Fatalf("outcome %+v", o)
	}
	if got := available(t, w.st, card); got != 100_000_000 {
		t.Fatalf("balance %d", got)
	}
}

// A payment out of an account tells the store's Changed at each change to
// its books: the money held, and the payment's end, settled or given back,
// once the books have the outcome. A held read of the account answers on
// it. One that phoenixd hasn't answered for tells nothing until it ends,
// and one Resolve ends later tells then too.
func TestAPaymentsChangesAreToldByTheStore(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	type told struct {
		accts []store.Account
		open  bool // told while the books still held it open
	}
	changed := make(chan told, 8)
	// Changed may not use the store (it is told under its caller's locks):
	// what the books say is read by the test, after it was told.
	w.st.Changed = func(accts []store.Account) { changed <- told{accts: accts} }
	heard := func(what string) told {
		t.Helper()
		select {
		case c := <-changed:
			holds, _ := w.st.OpenHolds(ctx)
			c.open = len(holds) > 0
			if len(c.accts) != 1 || c.accts[0] != card {
				t.Fatalf("%s: told of %v", what, c.accts)
			}
			return c
		case <-time.After(5 * time.Second):
			t.Fatalf("not told: %s", what)
			return told{}
		}
	}
	quiet := func(what string) {
		t.Helper()
		select {
		case c := <-changed:
			t.Fatalf("told of %v: %s", c.accts, what)
		case <-time.After(200 * time.Millisecond):
		}
	}
	_, done, _ := w.pay(t, 1_000)
	wait(t, done)
	heard("a payment's money held")
	if c := heard("a settled payment"); c.open {
		t.Fatal("told of a settled payment while the books still held it open")
	}
	bolt11, hash := w.f.Invoice(2_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Fail: true})
	inv, _ := w.l.Decode(ctx, bolt11)
	done = make(chan ledger.Outcome, 1)
	w.l.Pay(ctx, card, store.KindSpend, bolt11, inv, done)
	wait(t, done)
	heard("a failing payment's money held")
	if c := heard("a failed payment"); c.open {
		t.Fatal("told of a payment given back while the books still held it open")
	}
	// One that phoenixd hasn't answered for is told when its money is held, and not again until it ends.
	bolt11, hash = w.f.Invoice(3_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	inv, _ = w.l.Decode(ctx, bolt11)
	w.l.Pay(ctx, card, store.KindSpend, bolt11, inv, nil)
	heard("a hanging payment's money held")
	quiet("a payment still going")
	w.f.Release(hash, false, 0)
	heard("the hanging payment, once it ended")
	// One whose payinvoice gave no answer is ended by Resolve, which tells too.
	client := phoenixd.New(w.f.URL, phoenixdtest.Password)
	client.Pay = &http.Client{Timeout: 100 * time.Millisecond}
	l, _ := w.logged(t, client)
	bolt11, hash = w.f.Invoice(4_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	inv, _ = l.Decode(ctx, bolt11)
	done = make(chan ledger.Outcome, 1)
	if _, err := l.Pay(ctx, card, store.KindSpend, bolt11, inv, done); err != nil {
		t.Fatal(err)
	}
	if o := wait(t, done); !o.Pending {
		t.Fatalf("outcome %+v", o)
	}
	heard("an unanswered payment's money held")
	w.f.Release(hash, false, 0)
	quiet("a payment Resolve has not looked at yet")
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if c := heard("a payment Resolve ended"); c.open {
		t.Fatal("told of a payment Resolve ended while the books still held it open")
	}
}

// Resolve leaves a payment that is still being paid alone, then settles it.
func TestAHangingPaymentIsLeftAloneUntilItEnds(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	bolt11, hash := w.f.Invoice(5_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	inv, _ := w.l.Decode(ctx, bolt11)
	done := make(chan ledger.Outcome, 1)
	h, _ := w.l.Pay(ctx, card, store.KindSpend, bolt11, inv, done)
	time.Sleep(50 * time.Millisecond)
	if err := w.l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldOpen {
		t.Fatalf("resolved while in flight: %s", got.State)
	}
	w.f.Release(hash, false, 1_000)
	if o := wait(t, done); o.Hold.State != store.HoldSettled || o.Hold.FeeMsat != 1_000 {
		t.Fatalf("outcome %+v", o)
	}
}

// A restart (a new Ledger on the same database) finds the holds that were
// open when cardd stopped and asks phoenixd about each: never sent →
// released; paid → settled at phoenixd's fee; still pending → kept open.
func TestRestartResolvesOpenHolds(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.st.Credit(ctx, store.Pool, 50_000_000, "pool", "")
	w.f.BalanceSat += 50_000
	raw := phoenixd.New(w.f.URL, phoenixdtest.Password)
	open := func(sat int64) (store.Hold, string, string) {
		t.Helper()
		bolt11, hash := w.f.Invoice(sat * 1000)
		h, err := w.st.OpenHold(ctx, store.HoldRequest{Account: store.Pool, Kind: store.KindSend, AmountMsat: sat * 1000, PaymentHash: hash, Invoice: bolt11})
		if err != nil {
			t.Fatal(err)
		}
		return h, bolt11, hash
	}
	restart := func() *ledger.Ledger {
		return ledger.New(w.st, phoenixd.New(w.f.URL, phoenixdtest.Password), log.New(io.Discard, "", 0))
	}
	state := func(id int64) store.Hold {
		h, _ := w.st.GetHold(ctx, id)
		return h
	}

	never, _, _ := open(1000) // cardd stopped before calling payinvoice
	restart().Resolve(ctx)
	if h := state(never.ID); h.State != store.HoldOpen {
		t.Fatalf("released before phoenixd could have recorded it: %s", h.State)
	}
	later := restart()
	later.Now = func() time.Time { return time.Now().Add(3 * time.Minute) }
	later.Resolve(ctx)
	if h := state(never.ID); h.State != store.HoldReleased {
		t.Fatalf("never sent: %s", h.State)
	}

	paid, bolt11, hash := open(2000) // phoenixd paid it while cardd was down
	w.f.SetOutcome(hash, phoenixdtest.Outcome{FeeMsat: 7_000})
	raw.PayInvoice(ctx, bolt11, 0)
	restart().Resolve(ctx)
	if h := state(paid.ID); h.State != store.HoldSettled || h.FeeMsat != 7_000 {
		t.Fatalf("paid while down: %+v", h)
	}

	pending, bolt11, hash := open(3000) // still in flight in phoenixd
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	go raw.PayInvoice(ctx, bolt11, 0)
	time.Sleep(50 * time.Millisecond)
	l := restart()
	l.Resolve(ctx)
	if h := state(pending.ID); h.State != store.HoldOpen {
		t.Fatalf("pending: %s", h.State)
	}
	w.f.Release(hash, true, 0)
	l.Resolve(ctx)
	if h := state(pending.ID); h.State != store.HoldReleased {
		t.Fatalf("failed later: %s", h.State)
	}
}

// A payment phoenixd made while cardd was down is booked, when cardd finds it,
// at the time phoenixd paid it, not when it was found.
func TestARecoveredPaymentIsDatedWhenPhoenixdPaidIt(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.st.Credit(ctx, store.Pool, 50_000_000, "pool", "")
	w.f.BalanceSat += 50_000
	bolt11, hash := w.f.Invoice(2_000_000)
	h, err := w.st.OpenHold(ctx, store.HoldRequest{Account: store.Pool, Kind: store.KindSend, AmountMsat: 2_000_000, PaymentHash: hash, Invoice: bolt11})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := phoenixd.New(w.f.URL, phoenixdtest.Password).PayInvoice(ctx, bolt11, 0); err != nil {
		t.Fatal(err)
	}
	w.f.SetCompleted(hash, h.CreatedAt) // paid in the second the hold was opened
	// cardd comes back at least a second later.
	time.Sleep(time.Until(h.CreatedAt.Add(time.Second + 50*time.Millisecond)))
	ledger.New(w.st, phoenixd.New(w.f.URL, phoenixdtest.Password), log.New(io.Discard, "", 0)).Resolve(ctx)
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldSettled {
		t.Fatalf("not settled: %s", got.State)
	}
	hist, _ := w.st.History(ctx, store.Pool, 0, 1)
	if len(hist) != 1 || !hist[0].CreatedAt.Equal(h.CreatedAt) {
		t.Fatalf("the line is dated %v, want %v, when phoenixd paid it", hist[0].CreatedAt, h.CreatedAt)
	}
}

func TestReconcilePausesSpending(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.f.BalanceSat = 99_998 // phoenixd has 2 sat less than the books
	if err := w.l.Reconcile(ctx); err == nil {
		t.Fatal("reconcile passed")
	}
	bolt11, _ := w.f.Invoice(1000)
	inv, _ := w.l.Decode(ctx, bolt11)
	if _, err := w.l.Pay(ctx, card, store.KindSpend, bolt11, inv, nil); !errors.Is(err, ledger.ErrPaused) {
		t.Fatalf("paused: %v", err)
	}
	w.f.BalanceSat = 99_999 // within 1 sat of rounding
	if err := w.l.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	w.f.Down = true
	if err := w.l.Reconcile(ctx); err == nil {
		t.Fatal("reconcile passed with phoenixd down")
	}
	if paused, _ := w.l.Paused(); !paused {
		t.Fatal("not paused with phoenixd down")
	}
}

// phoenixd's balance leaves out a payment on its way; so do the books.
func TestReconcileIgnoresMoneyInFlight(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	bolt11, hash := w.f.Invoice(5_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	inv, _ := w.l.Decode(ctx, bolt11)
	done := make(chan ledger.Outcome, 1)
	w.l.Pay(ctx, card, store.KindSpend, bolt11, inv, done)
	time.Sleep(50 * time.Millisecond)
	if err := w.l.Reconcile(ctx); err != nil {
		t.Fatalf("while the payment is on its way: %v", err)
	}
	w.f.Release(hash, false, 1_000)
	wait(t, done)
	if err := w.l.Reconcile(ctx); err != nil {
		t.Fatalf("after it settled: %v", err)
	}
}

// `cardd ledger reconcile`: the books are set to phoenixd's balance, the
// difference goes to pool, and spending starts again.
func TestCorrectBooksTheDifferenceToPool(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.f.BalanceSat = 99_990
	if err := w.l.Reconcile(ctx); err == nil {
		t.Fatal("reconcile passed")
	}
	diff, err := w.l.Correct(ctx, nil)
	if err != nil || diff != -10_000 {
		t.Fatalf("correct: %d %v", diff, err)
	}
	if paused, _ := w.l.Paused(); paused || available(t, w.st, store.Pool) != -10_000 || available(t, w.st, card) != 100_000_000 {
		t.Fatalf("paused %v pool %d", paused, available(t, w.st, store.Pool))
	}
	if diff, err := w.l.Correct(ctx, nil); err != nil || diff != 0 {
		t.Fatalf("again: %d %v", diff, err)
	}
	bolt11, hash := w.f.Invoice(1_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	inv, _ := w.l.Decode(ctx, bolt11)
	w.l.Pay(ctx, card, store.KindSpend, bolt11, inv, nil)
	if _, err := w.l.Correct(ctx, nil); !errors.Is(err, store.ErrPaymentInProgress) {
		t.Fatalf("with a payment in progress: %v", err)
	}
	w.f.Release(hash, false, 0)
}

func TestANewLedgerIsPausedUntilItHasReconciled(t *testing.T) {
	w := setup(t)
	l := ledger.New(w.st, phoenixd.New(w.f.URL, phoenixdtest.Password), log.New(io.Discard, "", 0))
	if paused, _ := l.Paused(); !paused {
		t.Fatal("spending allowed before the first check")
	}
}

func TestDecodeRefusesWhatCantBePaid(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	if _, err := w.l.Decode(ctx, w.f.ExpiredInvoice(1000)); !errors.Is(err, ledger.ErrBadInvoice) {
		t.Fatalf("expired: %v", err)
	}
	if _, err := w.l.Decode(ctx, "lnbcgarbage"); !errors.Is(err, ledger.ErrBadInvoice) {
		t.Fatalf("garbage: %v", err)
	}
	// phoenixd names an invoice's chain as lightning-kmp does, in lower case.
	if _, err := w.l.Decode(ctx, w.f.ChainInvoice(1000, "testnet3")); !errors.Is(err, ledger.ErrBadInvoice) || !strings.Contains(err.Error(), "it is for testnet3") {
		t.Fatalf("testnet: %v", err)
	}
	// phoenixd not answering is not the invoice's fault.
	w.f.Down = true
	if _, err := w.l.Decode(ctx, w.f.ExpiredInvoice(1000)); errors.Is(err, ledger.ErrBadInvoice) || !errors.Is(err, phoenixd.ErrUnreachable) {
		t.Fatalf("phoenixd down: %v", err)
	}
}

func TestTheSameInvoiceIsPaidOnce(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	bolt11, hash := w.f.Invoice(1_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	inv, _ := w.l.Decode(ctx, bolt11)
	w.st.Credit(ctx, store.Pool, 10_000_000, "pool", "")
	w.f.BalanceSat += 10_000
	if _, err := w.l.Pay(ctx, card, store.KindSpend, bolt11, inv, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := w.l.Pay(ctx, store.Pool, store.KindSend, bolt11, inv, nil); !errors.Is(err, store.ErrDuplicatePayment) {
		t.Fatalf("second payment of the same invoice: %v", err)
	}
	w.f.Release(hash, false, 0)
}

// A send's request id pays once, even with a new invoice for the same address.
func TestPayOnceIsOncePerRef(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	for i, want := range []error{nil, store.ErrDuplicatePayment} {
		bolt11, _ := w.f.Invoice(1_000_000)
		inv, _ := w.l.Decode(ctx, bolt11)
		done := make(chan ledger.Outcome, 1)
		if _, err := w.l.PayOnce(ctx, "request:s1", card, store.KindSpend, bolt11, inv, store.HoldAbout{}, done); !errors.Is(err, want) {
			t.Fatalf("pay #%d: %v", i, err)
		}
		if want == nil {
			wait(t, done)
		}
	}
	if paid := w.f.Paid(); len(paid) != 1 {
		t.Fatalf("paid %d invoices", len(paid))
	}
}

// A payinvoice that timed out may still be taken up by phoenixd later: the
// 2-minute grace for "no record" counts from when cardd gave up waiting, not
// from when the hold was opened.
func TestATimedOutPaymentKeepsItsGrace(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	var skew atomic.Int64 // how far the ledger's clock is ahead
	client := phoenixd.New(w.f.URL, phoenixdtest.Password)
	client.Pay = &http.Client{Timeout: 100 * time.Millisecond}
	l := ledger.New(w.st, client, log.New(io.Discard, "", 0))
	l.Now = func() time.Time { return time.Now().Add(time.Duration(skew.Load())) }
	if err := l.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	bolt11, hash := w.f.Invoice(1_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true, Unrecorded: true})
	defer w.f.Release(hash, true, 0)
	inv, _ := l.Decode(ctx, bolt11)
	done := make(chan ledger.Outcome, 1)
	skew.Store(int64(3 * time.Minute)) // payinvoice waited 3 minutes before giving up
	h, err := l.Pay(ctx, card, store.KindSpend, bolt11, inv, done)
	if err != nil {
		t.Fatal(err)
	}
	if o := wait(t, done); !o.Pending {
		t.Fatalf("outcome %+v", o)
	}
	l.Resolve(ctx)
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldOpen {
		t.Fatalf("released straight after giving up: %s", got.State)
	}
	skew.Store(int64(6 * time.Minute))
	l.Resolve(ctx)
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldReleased {
		t.Fatalf("never released: %s", got.State)
	}
}

// Setting the books is the way out of a pause, nothing else: it first sweeps
// in top-ups whose webhook was missed (else one would be booked to pool and
// then credited again), and leaves books that add up alone.
func TestCorrectSweepsFirstAndLeavesBooksThatAddUp(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.f.BalanceSat = 100_500 // phoenixd holds more than the books: they add up
	if diff, err := w.l.Correct(ctx, nil); err != nil || diff != 0 || available(t, w.st, store.Pool) != 0 {
		t.Fatalf("books that add up: %d %v, pool %d", diff, err, available(t, w.st, store.Pool))
	}
	// phoenixd lost 6,000 sat and received a 5,000 sat top-up cardd hasn't credited yet.
	w.f.BalanceSat = 99_000
	swept := 0
	sweep := func(ctx context.Context) error {
		swept++
		_, err := w.st.Credit(ctx, store.Pool, 5_000_000, "late-topup", "")
		return err
	}
	diff, err := w.l.Correct(ctx, sweep)
	if err != nil || swept != 1 || diff != -6_000_000 {
		t.Fatalf("correct: %d %v (swept %d)", diff, err, swept)
	}
	if err := sweep(ctx); err != nil { // the top-up is credited once
		t.Fatal(err)
	}
	if err := w.l.Reconcile(ctx); err != nil {
		t.Fatalf("after the sweep ran again: %v", err)
	}
}

// phoenixd refusing a payinvoice (HTTP 4xx) sent nothing: the hold is
// released at once, without waiting for a record that will never come.
func TestARefusedPaymentIsReleasedAtOnce(t *testing.T) {
	w := setup(t)
	bolt11, hash := w.f.Invoice(10_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Refuse: true})
	inv, _ := w.l.Decode(context.Background(), bolt11)
	done := make(chan ledger.Outcome, 1)
	w.l.Pay(context.Background(), card, store.KindSpend, bolt11, inv, done)
	if o := wait(t, done); o.Pending || o.Hold.State != store.HoldReleased {
		t.Fatalf("outcome %+v", o)
	}
	if got := available(t, w.st, card); got != 100_000_000 {
		t.Fatalf("balance %d", got)
	}
}

// An invoice without an amount is paid for the amount the payer gives, in
// whole sats (phoenixd's payinvoice takes amountSat); one with an amount must
// agree with any amount given.
func TestAnInvoiceWithoutAnAmount(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	bolt11, hash := w.f.Invoice(0)
	if _, err := w.l.Decode(ctx, bolt11); !errors.Is(err, ledger.ErrBadInvoice) {
		t.Fatalf("no amount given: %v", err)
	}
	if _, err := w.l.DecodeFor(ctx, bolt11, 1_500); !errors.Is(err, ledger.ErrBadInvoice) {
		t.Fatalf("not whole sats: %v", err)
	}
	inv, err := w.l.DecodeFor(ctx, bolt11, 2_000_000)
	if err != nil || inv.AmountMsat != 2_000_000 {
		t.Fatalf("decode: %+v %v", inv, err)
	}
	w.f.SetOutcome(hash, phoenixdtest.Outcome{FeeMsat: 3_000})
	done := make(chan ledger.Outcome, 1)
	w.l.Pay(ctx, card, store.KindSpend, bolt11, inv, done)
	if o := wait(t, done); o.Hold.State != store.HoldSettled || w.f.PaidMsat(hash) != 2_000_000 {
		t.Fatalf("outcome %+v, phoenixd paid %d", o, w.f.PaidMsat(hash))
	}
	if got := available(t, w.st, card); got != 100_000_000-2_000_000-3_000 {
		t.Fatalf("balance %d", got)
	}
	withAmount, _ := w.f.Invoice(1_000_000)
	if _, err := w.l.DecodeFor(ctx, withAmount, 2_000_000); !errors.Is(err, ledger.ErrBadInvoice) {
		t.Fatalf("amounts that disagree: %v", err)
	}
	if _, err := w.l.DecodeFor(ctx, withAmount, 1_000_000); err != nil {
		t.Fatalf("amounts that agree: %v", err)
	}
}

// The renewal job waits for the ledger's first check: Checked closes once it
// has run, whether the books added up or not.
func TestCheckedClosesAfterTheFirstCheck(t *testing.T) {
	for _, down := range []bool{false, true} {
		w := setup(t)
		w.f.SetDown(down)
		l := ledger.New(w.st, phoenixd.New(w.f.URL, phoenixdtest.Password), log.New(io.Discard, "", 0))
		select {
		case <-l.Checked():
			t.Fatal("checked before running")
		default:
		}
		ctx, cancel := context.WithCancel(context.Background())
		go l.Run(ctx)
		select {
		case <-l.Checked():
		case <-time.After(5 * time.Second):
			t.Fatal("never checked")
		}
		if paused, _ := l.Paused(); paused != down {
			t.Fatalf("phoenixd down %v: paused %v", down, paused)
		}
		cancel()
	}
}

// restored: setup's database as `cardd restore` leaves it (restore.reconcile
// pending), and a ledger as cardd serve starts on it, with its clock at now.
func (w *world) restored(t *testing.T, now *time.Time) *ledger.Ledger {
	t.Helper()
	if err := w.st.PrepareRestored(context.Background(), "a1b2 3 1790000000", "", store.RestoredVM{ID: "1003", Host: "vm-1003.lnvps.cloud", IPv4: "45.67.89.170"}); err != nil {
		t.Fatal(err)
	}
	return w.restart(now)
}

// restart is a new Ledger on the same database (cardd restarted).
func (w *world) restart(now *time.Time) *ledger.Ledger {
	pd := phoenixd.New(w.f.URL, phoenixdtest.Password)
	l := ledger.New(w.st, pd, log.New(io.Discard, "", 0))
	l.Liquidity = pd.Liquidity
	l.Now = func() time.Time { return *now }
	return l
}

// step is one of Run's ticks as far as a restore goes: open holds resolved,
// the restore's step, the check.
func step(t *testing.T, l *ledger.Ledger) {
	t.Helper()
	ctx := context.Background()
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if err := l.CheckRestore(ctx); err != nil {
		t.Fatal(err)
	}
	l.Reconcile(ctx)
}

func restoreState(t *testing.T, l *ledger.Ledger) ledger.RestoreState {
	t.Helper()
	r, err := l.Restore(context.Background())
	if err != nil || r == nil {
		t.Fatalf("restore: %+v %v", r, err)
	}
	return *r
}

// After a restore, spending waits for phoenixd's channel to be back in its
// normal state and for the snapshot's holds to be resolved; then the books are
// set to phoenixd's balance, extra money to pool, once.
func TestARestoreWaitsForTheChannelThenSetsTheBooks(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	now := time.Now()
	l := w.restored(t, &now)
	w.f.BalanceSat = 120_000 // 20,000 sat came in after the backup
	w.f.Channel, w.f.ChannelState = true, "Offline"
	step(t, l)
	if paused, reason := l.Paused(); !paused || !strings.Contains(reason, "waiting for the channel to come back after a restore") {
		t.Fatalf("offline: paused %v %q", paused, reason)
	}
	if r := restoreState(t, l); r.State != "pending" || r.From != "a1b2 3 1790000000" || r.ReconciledAt != 0 {
		t.Fatalf("offline: %+v", r)
	}
	if _, err := l.Correct(ctx, nil); !errors.Is(err, ledger.ErrRestorePending) {
		t.Fatalf("set the books while pending: %v", err)
	}
	w.f.ChannelState = "Syncing"
	step(t, l)
	// A hold the snapshot held: phoenixd has no record of it, so it is released after the grace.
	bolt11, hash := w.f.Invoice(1_000_000)
	h, err := w.st.OpenHold(ctx, store.HoldRequest{Account: card, Kind: store.KindSpend, AmountMsat: 1_000_000, PaymentHash: hash, Invoice: bolt11})
	if err != nil {
		t.Fatal(err)
	}
	w.f.ChannelState = "Normal"
	step(t, l)
	if r := restoreState(t, l); r.State != "pending" || available(t, w.st, store.Pool) != 0 {
		t.Fatalf("with a hold open: %+v, pool %d", r, available(t, w.st, store.Pool))
	}
	now = now.Add(3 * time.Minute)
	step(t, l)
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldReleased {
		t.Fatalf("hold %s", got.State)
	}
	r := restoreState(t, l)
	if r.State != "done" || r.ReconciledMsat != 20_000_000 || r.ReconciledAt != now.Unix() || available(t, w.st, store.Pool) != 20_000_000 {
		t.Fatalf("set: %+v, pool %d", r, available(t, w.st, store.Pool))
	}
	if paused, reason := l.Paused(); paused {
		t.Fatalf("still paused: %q", reason)
	}
	if available(t, w.st, card) != 100_000_000 {
		t.Fatalf("a card was touched: %d", available(t, w.st, card))
	}
	now = now.Add(time.Minute)
	step(t, l)
	if again := restoreState(t, l); again != r || available(t, w.st, store.Pool) != 20_000_000 {
		t.Fatalf("again: %+v, pool %d", again, available(t, w.st, store.Pool))
	}
	if _, err := l.Correct(ctx, nil); err != nil {
		t.Fatalf("set the books once done: %v", err)
	}
}

// A shortfall comes out of pool, which may go below zero; a difference under
// 1 sat (phoenixd's rounding) is left.
func TestARestoreSetsTheBooksBothWays(t *testing.T) {
	ctx := context.Background()
	for _, c := range []struct {
		balanceSat, extraMsat, want int64
	}{
		{90_000, 0, -10_000_000},
		{100_000, 500, 0},   // 500 msat short
		{100_001, 1, 0},     // 999 msat over
		{100_001, 0, 1_000}, // 1 sat over
	} {
		w := setup(t)
		if c.extraMsat != 0 {
			w.st.Credit(ctx, store.Pool, c.extraMsat, "rounding", "")
		}
		now := time.Now()
		l := w.restored(t, &now)
		w.f.BalanceSat, w.f.Channel = c.balanceSat, true
		step(t, l)
		r := restoreState(t, l)
		if r.State != "done" || r.ReconciledMsat != c.want || available(t, w.st, store.Pool) != c.extraMsat+c.want {
			t.Fatalf("%+v: %+v, pool %d", c, r, available(t, w.st, store.Pool))
		}
		if paused, reason := l.Paused(); paused {
			t.Fatalf("%+v: paused %q", c, reason)
		}
		if txs, _ := w.st.History(ctx, store.Pool, 0, 10); c.want == 0 && len(txs) > 1 {
			t.Fatalf("%+v: booked %+v", c, txs)
		}
	}
}

// No channel 30 minutes after phoenixd first answered: the restore waits for
// the person, who may set the books to phoenixd's balance (only then). The
// wait counts from the first answer even across a restart.
func TestNoChannelAfterARestoreWaitsForThePerson(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	now := time.Now()
	l := w.restored(t, &now)
	w.f.BalanceSat = 105_000
	w.f.SetDown(true)
	l.CheckRestore(ctx)
	if _, err := w.st.GetMeta(ctx, "restore.waiting_since"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("the wait started with phoenixd down: %v", err)
	}
	w.f.SetDown(false)
	step(t, l)
	if v, _ := w.st.GetMeta(ctx, "restore.waiting_since"); v != fmt.Sprint(now.Unix()) {
		t.Fatalf("waiting since %q", v)
	}
	if _, err := l.SetBooksAfterRestore(ctx); !errors.Is(err, ledger.ErrNotNoChannel) {
		t.Fatalf("restore-books while pending: %v", err)
	}
	now = now.Add(29 * time.Minute)
	step(t, l)
	if r := restoreState(t, l); r.State != "pending" {
		t.Fatalf("after 29 minutes: %+v", r)
	}
	now = now.Add(2 * time.Minute)
	l = w.restart(&now)
	step(t, l)
	if r := restoreState(t, l); r.State != "no_channel" {
		t.Fatalf("after 31 minutes and a restart: %+v", r)
	}
	if paused, reason := l.Paused(); !paused || !strings.Contains(reason, "no channel came back") {
		t.Fatalf("no channel: paused %v %q", paused, reason)
	}
	if _, err := l.Correct(ctx, nil); !errors.Is(err, ledger.ErrRestorePending) {
		t.Fatalf("set the books with no channel: %v", err)
	}
	step(t, l)
	if available(t, w.st, store.Pool) != 0 {
		t.Fatalf("booked on its own: %d", available(t, w.st, store.Pool))
	}
	bolt11, hash := w.f.Invoice(1_000_000)
	h, _ := w.st.OpenHold(ctx, store.HoldRequest{Account: card, Kind: store.KindSpend, AmountMsat: 1_000_000, PaymentHash: hash, Invoice: bolt11})
	if _, err := l.SetBooksAfterRestore(ctx); !errors.Is(err, store.ErrPaymentInProgress) {
		t.Fatalf("with a payment in progress: %v", err)
	}
	w.st.ReleaseHold(ctx, h.ID)
	booked, err := l.SetBooksAfterRestore(ctx)
	if err != nil || booked != 5_000_000 || available(t, w.st, store.Pool) != 5_000_000 {
		t.Fatalf("restore-books: %d %v, pool %d", booked, err, available(t, w.st, store.Pool))
	}
	if r := restoreState(t, l); r.State != "done" || r.ReconciledMsat != 5_000_000 || r.ReconciledAt != now.Unix() {
		t.Fatalf("after: %+v", r)
	}
	if paused, reason := l.Paused(); paused {
		t.Fatalf("still paused: %q", reason)
	}
	if _, err := l.SetBooksAfterRestore(ctx); !errors.Is(err, ledger.ErrNotNoChannel) {
		t.Fatalf("again: %v", err)
	}
}

// A backup that owes nothing, restored where phoenixd has no channel at all:
// no money can be missing, so the books are set at once instead of after
// RestoreWait and a scare; a channel that comes back later (money received
// after the backup) is booked then, as after the person's restore-books.
func TestARestoreOwingNothingWithNoChannelSetsTheBooksAtOnce(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	if err := w.st.AdjustPool(ctx, -100_000_000, "spent before the backup"); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	l := w.restored(t, &now)
	w.f.BalanceSat, w.f.Channel = 0, false
	step(t, l)
	r := restoreState(t, l)
	if r.State != "done" || r.ReconciledMsat != 0 || r.ReconciledAt != now.Unix() {
		t.Fatalf("owing nothing, no channel: %+v", r)
	}
	if paused, reason := l.Paused(); paused {
		t.Fatalf("paused: %q", reason)
	}
	if _, err := w.st.GetMeta(ctx, "restore.channel_later"); err != nil {
		t.Fatalf("a late channel isn't awaited: %v", err)
	}
	// cardd restarts meanwhile: the late channel is still booked, and the books' first time kept.
	first := now.Unix()
	now = now.Add(time.Hour)
	l = w.restart(&now)
	w.f.BalanceSat, w.f.Channel, w.f.ChannelState = 7_000, true, "Normal"
	step(t, l)
	if r := restoreState(t, l); r.State != "done" || r.ReconciledMsat != 7_000_000 || r.ReconciledAt != first || available(t, w.st, store.Pool) != -93_000_000 {
		t.Fatalf("a late channel: %+v, pool %d", r, available(t, w.st, store.Pool))
	}
}

// Owing nothing but with a channel coming up, or with phoenixd holding a
// snapshot's hold open, the restore waits as before.
func TestARestoreOwingNothingWaitsForAChannelComingUp(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.st.AdjustPool(ctx, -100_000_000, "spent before the backup")
	now := time.Now()
	l := w.restored(t, &now)
	w.f.BalanceSat, w.f.Channel, w.f.ChannelState = 0, true, "Offline"
	step(t, l)
	if r := restoreState(t, l); r.State != "pending" {
		t.Fatalf("a channel not up: %+v", r)
	}
	w.f.Channel = false
	step(t, l)
	if r := restoreState(t, l); r.State != "done" {
		t.Fatalf("no channel at all: %+v", r)
	}

	// The books owe nothing only because a snapshot's hold reserves it all:
	// it may yet be released, so the restore waits for that first.
	w = setup(t)
	w.st.Move(ctx, card, store.Pool, 100_000_000, "")
	w.st.AdjustPool(ctx, -99_000_000, "spent before the backup")
	l = w.restored(t, &now)
	w.f.BalanceSat, w.f.Channel = 0, false
	bolt11, hash := w.f.Invoice(995_000)
	if _, err := w.st.OpenHold(ctx, store.HoldRequest{Account: store.Pool, Kind: store.KindSend, AmountMsat: 995_000, FeeBudgetMsat: 5_000, PaymentHash: hash, Invoice: bolt11}); err != nil {
		t.Fatal(err)
	}
	if owed, _ := w.st.OwedMsat(ctx); owed != 0 {
		t.Fatalf("owed %d", owed)
	}
	if err := l.CheckRestore(ctx); err != nil {
		t.Fatal(err)
	}
	if r := restoreState(t, l); r.State != "pending" {
		t.Fatalf("a hold open: %+v", r)
	}
}

// noChannel is w's restore stopped at no_channel: phoenixd answered with no
// channel for RestoreWait.
func (w *world) noChannel(t *testing.T, now *time.Time) *ledger.Ledger {
	t.Helper()
	l := w.restored(t, now)
	step(t, l)
	*now = now.Add(31 * time.Minute)
	step(t, l)
	if r := restoreState(t, l); r.State != "no_channel" {
		t.Fatalf("no channel: %+v", r)
	}
	return l
}

// A channel that comes back after no_channel sets the books on its own, as if
// it had come in time, and only once; one that isn't up yet waits.
func TestALateChannelSetsTheBooksOnce(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	now := time.Now()
	w.f.BalanceSat = 112_000
	l := w.noChannel(t, &now)
	w.f.Channel, w.f.ChannelState = true, "Syncing"
	now = now.Add(time.Minute)
	step(t, l)
	if r := restoreState(t, l); r.State != "no_channel" || available(t, w.st, store.Pool) != 0 {
		t.Fatalf("syncing: %+v, pool %d", r, available(t, w.st, store.Pool))
	}
	bolt11, hash := w.f.Invoice(1_000_000)
	h, _ := w.st.OpenHold(ctx, store.HoldRequest{Account: card, Kind: store.KindSpend, AmountMsat: 1_000_000, PaymentHash: hash, Invoice: bolt11})
	w.f.ChannelState = "Normal"
	if err := l.CheckRestore(ctx); err != nil {
		t.Fatal(err)
	}
	if r := restoreState(t, l); r.State != "no_channel" {
		t.Fatalf("with a hold open: %+v", r)
	}
	w.st.ReleaseHold(ctx, h.ID)
	now = now.Add(time.Minute)
	step(t, l)
	r := restoreState(t, l)
	if r.State != "done" || r.ReconciledMsat != 12_000_000 || r.ReconciledAt != now.Unix() || available(t, w.st, store.Pool) != 12_000_000 {
		t.Fatalf("set: %+v, pool %d", r, available(t, w.st, store.Pool))
	}
	if paused, reason := l.Paused(); paused {
		t.Fatalf("still paused: %q", reason)
	}
	now = now.Add(time.Minute)
	step(t, l)
	if again := restoreState(t, l); again != r || available(t, w.st, store.Pool) != 12_000_000 {
		t.Fatalf("a second tick booked: %+v, pool %d", again, available(t, w.st, store.Pool))
	}
	if txs, _ := w.st.History(ctx, store.Pool, 0, 10); len(txs) != 1 {
		t.Fatalf("pool's history: %+v", txs)
	}
}

// The person's restore-books is refused while phoenixd has a channel that
// isn't up yet (it would set the books with the channel's money missing),
// and while phoenixd doesn't answer.
func TestRestoreBooksWaitsForAChannelComingUp(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	now := time.Now()
	l := w.noChannel(t, &now)
	w.f.Channel, w.f.ChannelState = true, "Offline"
	if _, err := l.SetBooksAfterRestore(ctx); !errors.Is(err, ledger.ErrChannelNotUp) {
		t.Fatalf("a channel not up: %v", err)
	}
	w.f.SetDown(true)
	if _, err := l.SetBooksAfterRestore(ctx); !errors.Is(err, phoenixd.ErrUnreachable) {
		t.Fatalf("phoenixd down: %v", err)
	}
	w.f.SetDown(false)
	if r := restoreState(t, l); r.State != "no_channel" || available(t, w.st, store.Pool) != 0 {
		t.Fatalf("refused but booked: %+v, pool %d", r, available(t, w.st, store.Pool))
	}
	w.f.Channel = false
	if _, err := l.SetBooksAfterRestore(ctx); err != nil {
		t.Fatalf("no channel at all: %v", err)
	}
	if r := restoreState(t, l); r.State != "done" {
		t.Fatalf("after: %+v", r)
	}
}

// Without a restore nothing of this runs.
func TestNoRestoreNoChange(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	now := time.Now()
	l := w.restart(&now)
	w.f.BalanceSat, w.f.Channel = 120_000, true
	before, _ := w.st.ListMeta(ctx)
	step(t, l)
	if r, err := l.Restore(ctx); r != nil || err != nil {
		t.Fatalf("restore: %+v %v", r, err)
	}
	if after, _ := w.st.ListMeta(ctx); fmt.Sprint(after) != fmt.Sprint(before) || available(t, w.st, store.Pool) != 0 {
		t.Fatalf("meta %v → %v, pool %d", before, after, available(t, w.st, store.Pool))
	}
	if paused, _ := l.Paused(); paused {
		t.Fatal("paused")
	}
	if _, err := l.SetBooksAfterRestore(ctx); !errors.Is(err, ledger.ErrNotNoChannel) {
		t.Fatalf("restore-books: %v", err)
	}
}

// Books set by hand with no channel at all are set again, once, when a channel
// comes back; set with a channel up, nothing is waited for.
func TestAChannelAfterTheManualSetIsBooked(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	now := time.Now()
	w.f.BalanceSat = 90_000
	l := w.noChannel(t, &now)
	if booked, err := l.SetBooksAfterRestore(ctx); err != nil || booked != -10_000_000 {
		t.Fatalf("manual set: %d %v", booked, err)
	}
	if v, err := w.st.GetMeta(ctx, "restore.channel_later"); err != nil || v == "" {
		t.Fatalf("channel_later: %q %v", v, err)
	}
	step(t, l)
	w.f.Channel, w.f.ChannelState, w.f.BalanceSat = true, "Syncing", 130_000
	step(t, l)
	if available(t, w.st, store.Pool) != -10_000_000 {
		t.Fatalf("booked before the channel was up: %d", available(t, w.st, store.Pool))
	}
	w.f.ChannelState = "Normal"
	now = now.Add(time.Minute)
	step(t, l)
	owed, _ := w.st.OwedMsat(ctx)
	if owed != 130_000*1000 || available(t, w.st, store.Pool) != 30_000_000 {
		t.Fatalf("owed %d, pool %d", owed, available(t, w.st, store.Pool))
	}
	if _, err := w.st.GetMeta(ctx, "restore.channel_later"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("key kept: %v", err)
	}
	if r := restoreState(t, l); r.State != "done" || r.ReconciledMsat != 40_000_000 {
		t.Fatalf("state %+v", r)
	}
	txs, _ := w.st.History(ctx, store.Pool, 0, 10)
	step(t, l)
	if again, _ := w.st.History(ctx, store.Pool, 0, 10); len(again) != len(txs) || len(txs) != 2 {
		t.Fatalf("history %d then %d", len(txs), len(again))
	}

	// With a channel up when the person sets the books, nothing is awaited.
	w2 := setup(t)
	now2 := time.Now()
	l2 := w2.noChannel(t, &now2)
	w2.f.Channel, w2.f.ChannelState, w2.f.BalanceSat = true, "Normal", 90_000
	if _, err := l2.SetBooksAfterRestore(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := w2.st.GetMeta(ctx, "restore.channel_later"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("channel_later with a channel up: %v", err)
	}
}

// Whoever keeps count of phoenixd's fee credit is told when the books are
// set to phoenixd's balance:
// by Correct whenever it has run its course, the books found to add up or
// set (so Set the books, or `cardd ledger reconcile`, is always the person's
// way to have that figure taken afresh), and by a restore's reconcile; not
// when Correct refuses.
func TestSettingTheBooksTellsBooksSet(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	told := 0
	w.l.BooksSet = func(context.Context) { told++ }
	if diff, err := w.l.Correct(ctx, nil); err != nil || diff != 0 || told != 1 {
		t.Fatalf("books that add up: %d %v, told %d times", diff, err, told)
	}
	w.f.BalanceSat = 90_000
	if diff, err := w.l.Correct(ctx, nil); err != nil || diff != -10_000_000 || told != 2 {
		t.Fatalf("books set: %d %v, told %d times", diff, err, told)
	}
	// A payment in progress: Correct refuses, and nobody is told.
	if _, err := w.st.OpenHold(ctx, store.HoldRequest{Account: card, Kind: store.KindSpend, AmountMsat: 1_000, FeeBudgetMsat: 0, PaymentHash: "in-flight"}); err != nil {
		t.Fatal(err)
	}
	if _, err := w.l.Correct(ctx, nil); !errors.Is(err, store.ErrPaymentInProgress) || told != 2 {
		t.Fatalf("with a payment in progress: %v, told %d times", err, told)
	}
	w = setup(t)
	now := time.Now()
	l := w.restored(t, &now)
	told = 0
	l.BooksSet = func(context.Context) { told++ }
	w.f.BalanceSat, w.f.Channel = 90_000, true
	step(t, l)
	if r := restoreState(t, l); r.State != "done" || told != 1 {
		t.Fatalf("after a restore: %+v, told %d times", r, told)
	}
}

// logged is a ledger on the world's database and phoenixd whose log is kept.
func (w *world) logged(t *testing.T, client *phoenixd.Client) (*ledger.Ledger, *bytes.Buffer) {
	t.Helper()
	logs := &bytes.Buffer{}
	if client == nil {
		client = phoenixd.New(w.f.URL, phoenixdtest.Password)
	}
	l := ledger.New(w.st, client, log.New(logs, "", 0))
	if err := l.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	logs.Reset()
	return l, logs
}

// A payment that was sent is settled from phoenixd's own record of it, read
// by the id payinvoice answered with, and logs one line with its times: from
// the money held to phoenixd's answer, from there to the books, and how long
// phoenixd's record says the payment itself took. A slow payment can be
// explained from the log. No invoice and no amount is in it.
func TestAPaymentOutLogsItsTimes(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	l, logs := w.logged(t, nil)
	bolt11, hash := w.f.Invoice(10_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{FeeMsat: 40_123})
	inv, _ := l.Decode(ctx, bolt11)
	done := make(chan ledger.Outcome, 1)
	h, err := l.Pay(ctx, card, store.KindSpend, bolt11, inv, done)
	if err != nil {
		t.Fatal(err)
	}
	if o := wait(t, done); o.Pending || o.Hold.State != store.HoldSettled || o.Hold.FeeMsat != 40_123 {
		t.Fatalf("outcome %+v", o)
	}
	if n := w.f.Calls("/payments/outgoingbyhash/" + hash); n != 0 {
		t.Fatalf("asked by hash %d times: a payment with an id is read by it", n)
	}
	want := regexp.MustCompile(fmt.Sprintf(`^ledger: hold %d paid \(spend out of card:%s, %s\): phoenixd answered \d+ ms after the money was held, in the books \d+ ms later; phoenixd's record: \d+ ms\n$`, h.ID, cardID, hash))
	if got := logs.String(); !want.MatchString(got) || strings.Contains(got, bolt11) || strings.Contains(got, "10000") {
		t.Fatalf("log: %q", got)
	}
}

// A phoenixd that answers payinvoice without an id, or has no route to read
// a payment by one, is asked by the payment's hash, as before.
func TestAPaymentWithoutAnIDIsSettledByItsHash(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.f.Set(func(f *phoenixdtest.Fake) { f.MissingRoute = "/payments/outgoing/" })
	l, logs := w.logged(t, nil)
	bolt11, hash := w.f.Invoice(10_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{FeeMsat: 40_123})
	inv, _ := l.Decode(ctx, bolt11)
	done := make(chan ledger.Outcome, 1)
	l.Pay(ctx, card, store.KindSpend, bolt11, inv, done)
	if o := wait(t, done); o.Pending || o.Hold.State != store.HoldSettled || o.Hold.FeeMsat != 40_123 {
		t.Fatalf("outcome %+v", o)
	}
	if got := logs.String(); !strings.Contains(got, " paid (spend out of ") || strings.Count(got, "\n") != 1 {
		t.Fatalf("log: %q", got)
	}
}

// A payment that failed says how long it took to fail.
func TestAFailedPaymentLogsItsTime(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	l, logs := w.logged(t, nil)
	bolt11, hash := w.f.Invoice(10_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Fail: true})
	inv, _ := l.Decode(ctx, bolt11)
	done := make(chan ledger.Outcome, 1)
	h, _ := l.Pay(ctx, card, store.KindSpend, bolt11, inv, done)
	if o := wait(t, done); o.Hold.State != store.HoldReleased {
		t.Fatalf("outcome %+v", o)
	}
	want := regexp.MustCompile(fmt.Sprintf(`^ledger: hold %d failed \(spend out of card:%s, %s\) \d+ ms after the money was held: no route\n$`, h.ID, cardID, hash))
	if got := logs.String(); !want.MatchString(got) {
		t.Fatalf("log: %q", got)
	}
}

// A payment phoenixd gave no answer for is ended later from phoenixd's
// record (Resolve), and that says so in the log too: how long after the
// money was held it was found, and how long the record says it took.
func TestAPaymentEndedLaterLogsIt(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	client := phoenixd.New(w.f.URL, phoenixdtest.Password)
	client.Pay = &http.Client{Timeout: 100 * time.Millisecond}
	l, logs := w.logged(t, client)
	w.st.Credit(ctx, store.Pool, 5_000_000, "pool", "")
	w.f.Set(func(f *phoenixdtest.Fake) { f.BalanceSat += 5_000 })
	paid, paidHash := w.f.Invoice(1_000_000)
	failed, failedHash := w.f.Invoice(2_000_000)
	// Each is let go once, whatever becomes of the test: the fake waits for a hanging payinvoice when it closes.
	let := map[string]*sync.Once{paidHash: {}, failedHash: {}}
	release := func(hash string, fail bool, feeMsat int64) { let[hash].Do(func() { w.f.Release(hash, fail, feeMsat) }) }
	t.Cleanup(func() { release(paidHash, true, 0); release(failedHash, true, 0) })
	var holds []store.Hold
	for i, bolt11 := range []string{paid, failed} {
		hash := []string{paidHash, failedHash}[i]
		w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
		inv, _ := l.Decode(ctx, bolt11)
		done := make(chan ledger.Outcome, 1)
		h, err := l.Pay(ctx, []store.Account{card, store.Pool}[i], []store.Kind{store.KindSpend, store.KindSend}[i], bolt11, inv, done)
		if err != nil {
			t.Fatal(err)
		}
		if o := wait(t, done); !o.Pending {
			t.Fatalf("outcome %+v", o)
		}
		holds = append(holds, h)
	}
	release(paidHash, false, 1_500)
	release(failedHash, true, 0)
	logs.Reset()
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	got := logs.String()
	for _, want := range []string{
		fmt.Sprintf(`(?m)^ledger: hold %d paid \(spend out of card:%s, %s\), found \d+ s after the money was held; phoenixd's record: \d+ ms$`, holds[0].ID, cardID, paidHash),
		fmt.Sprintf(`(?m)^ledger: hold %d failed \(send out of pool, %s\), found \d+ s after the money was held; phoenixd's record: \d+ ms$`, holds[1].ID, failedHash),
	} {
		if !regexp.MustCompile(want).MatchString(got) {
			t.Fatalf("log: %q\nwant: %s", got, want)
		}
	}
}

// phoenixd's record of a paid payment carries its preimage, by id and by
// hash; one phoenixd has forgotten (a restored server's) has no record.
func TestOutgoingCarriesThePreimage(t *testing.T) {
	w := setup(t)
	_, done, hash := w.pay(t, 1_000)
	if o := wait(t, done); o.Pending {
		t.Fatalf("pending: %+v", o)
	}
	pd := phoenixd.New(w.f.URL, phoenixdtest.Password)
	o, err := pd.OutgoingByHash(context.Background(), hash)
	if err != nil || o.Status != phoenixd.OutgoingPaid || o.Preimage == "" || o.Preimage != w.f.Preimage(hash) {
		t.Fatalf("by hash: %+v %v", o, err)
	}
	w.f.Forget(hash)
	if o, err := pd.OutgoingByHash(context.Background(), hash); err != nil || o.Status != phoenixd.OutgoingNone {
		t.Fatalf("forgotten: %+v %v", o, err)
	}
}

// A paid payment's hold keeps its preimage and the invoice's description,
// whether settled at once or found later by Resolve.
func TestAPaymentKeepsItsProof(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	bolt11, hash := w.f.InvoiceWithDescription(1_000_000, "Coffee\nand cake")
	inv, err := w.l.Decode(ctx, bolt11)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan ledger.Outcome, 1)
	if _, err := w.l.Pay(ctx, card, store.KindSpend, bolt11, inv, done); err != nil {
		t.Fatal(err)
	}
	o := wait(t, done)
	h, _ := w.st.GetHold(ctx, o.Hold.ID)
	if h.Preimage != w.f.Preimage(hash) || h.Preimage == "" || h.About.Description != "Coffee and cake" {
		t.Fatalf("settled at once: %+v", h)
	}

	// Found later: payinvoice gave no answer in time (the outcome is
	// Pending), then the payment went through, and Resolve reads the record
	// (as TestAPaymentEndedLaterLogsIt does).
	client := phoenixd.New(w.f.URL, phoenixdtest.Password)
	client.Pay = &http.Client{Timeout: 100 * time.Millisecond}
	l, _ := w.logged(t, client)
	bolt11, hash = w.f.Invoice(2_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	let := new(sync.Once)
	t.Cleanup(func() { let.Do(func() { w.f.Release(hash, true, 0) }) }) // the fake waits for a hanging payinvoice when it closes
	inv, _ = l.Decode(ctx, bolt11)
	done = make(chan ledger.Outcome, 1)
	held, err := l.PayOnce(ctx, "request:r", card, store.KindSpend, bolt11, inv, store.HoldAbout{Comment: "later"}, done)
	if err != nil {
		t.Fatal(err)
	}
	if o := wait(t, done); !o.Pending {
		t.Fatalf("answered: %+v", o)
	}
	let.Do(func() { w.f.Release(hash, false, 0) })
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	h, _ = w.st.GetHold(ctx, held.ID)
	if h.State != store.HoldSettled || h.Preimage != w.f.Preimage(hash) || h.About.Comment != "later" {
		t.Fatalf("found later: %+v", h)
	}
}

// Old sends' proofs, filled once from phoenixd: a payment
// phoenixd has is found, one it forgot is kept empty, and phoenixd down marks
// nothing and is tried again. An expired invoice's description is read too.
func TestFillProofs(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	var holds []store.Hold
	var invoices []string
	for _, d := range []string{"Old coffee", "Old tea"} {
		bolt11, _ := w.f.InvoiceWithDescription(1_000_000, d)
		inv, _ := w.l.Decode(ctx, bolt11)
		done := make(chan ledger.Outcome, 1)
		if _, err := w.l.Pay(ctx, card, store.KindSpend, bolt11, inv, done); err != nil {
			t.Fatal(err)
		}
		holds = append(holds, wait(t, done).Hold)
		invoices = append(invoices, bolt11)
	}
	// As a database from before migration 8 has them: nothing asked, no
	// description, and their invoices long expired.
	forgetProofs(t, w.path)
	for _, b := range invoices {
		w.f.Age(b, 48*time.Hour)
	}
	if _, err := w.l.Decode(ctx, invoices[0]); !errors.Is(err, ledger.ErrBadInvoice) {
		t.Fatalf("not expired: %v", err)
	}
	w.f.Forget(holds[1].PaymentHash)

	w.f.SetDown(true)
	if _, _, _, err := w.l.FillProofs(ctx); err == nil {
		t.Fatal("phoenixd down: no error")
	}
	if left, _ := w.st.HoldsToAsk(ctx, 0, 10); len(left) != 2 {
		t.Fatalf("phoenixd down marked something: %d left", len(left))
	}
	w.f.SetDown(false)
	found, unknown, _, err := w.l.FillProofs(ctx)
	if err != nil || found != 1 || unknown != 1 {
		t.Fatalf("filled: %d found, %d unknown, %v", found, unknown, err)
	}
	h0, _ := w.st.GetHold(ctx, holds[0].ID)
	h1, _ := w.st.GetHold(ctx, holds[1].ID)
	if h0.Preimage == "" || !h0.PreimageAsked || h0.About.Description != "Old coffee" {
		t.Fatalf("found: %+v", h0)
	}
	if h1.Preimage != "" || !h1.PreimageAsked || h1.About.Description != "Old tea" {
		t.Fatalf("forgotten by phoenixd: %+v", h1)
	}
	if left, _ := w.st.HoldsToAsk(ctx, 0, 10); len(left) != 0 {
		t.Fatalf("%d left after filling", len(left))
	}
}

// forgetProofs sets every hold back to how migration 8 leaves an old one: no
// preimage asked, no description.
func forgetProofs(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`UPDATE holds SET preimage = NULL, description = ''`); err != nil {
		t.Fatal(err)
	}
}

// badProof is phoenixd whose records of paid payments give a preimage that
// isn't one.
type badProof struct{ *phoenixd.Client }

func (b badProof) OutgoingByID(ctx context.Context, id string) (phoenixd.Outgoing, error) {
	o, err := b.Client.OutgoingByID(ctx, id)
	if o.Preimage != "" {
		o.Preimage = "not a preimage"
	}
	return o, err
}

func (b badProof) OutgoingByHash(ctx context.Context, hash string) (phoenixd.Outgoing, error) {
	o, err := b.Client.OutgoingByHash(ctx, hash)
	if o.Preimage != "" {
		o.Preimage = "not a preimage"
	}
	return o, err
}

// A preimage from phoenixd that isn't 64 hex characters is kept as unknown:
// settling leaves the hold not asked, and the fill-in pass keeps it empty.
func TestAMalformedPreimageIsNotKept(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	l := ledger.New(w.st, badProof{phoenixd.New(w.f.URL, phoenixdtest.Password)}, log.New(io.Discard, "", 0))
	if err := l.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	bolt11, _ := w.f.Invoice(1_000_000)
	inv, _ := l.Decode(ctx, bolt11)
	done := make(chan ledger.Outcome, 1)
	if _, err := l.Pay(ctx, card, store.KindSpend, bolt11, inv, done); err != nil {
		t.Fatal(err)
	}
	o := wait(t, done)
	h, _ := w.st.GetHold(ctx, o.Hold.ID)
	if h.State != store.HoldSettled || h.PreimageAsked || h.Preimage != "" {
		t.Fatalf("settled: %+v", h)
	}
	found, unknown, _, err := l.FillProofs(ctx)
	if err != nil || found != 0 || unknown != 1 {
		t.Fatalf("filled: %d found, %d unknown, %v", found, unknown, err)
	}
	h, _ = w.st.GetHold(ctx, o.Hold.ID)
	if !h.PreimageAsked || h.Preimage != "" {
		t.Fatalf("filled: %+v", h)
	}
}

// refusing is phoenixd refusing every question about a payment out with
// status.
type refusing struct {
	*phoenixd.Client
	status int
}

func (r refusing) OutgoingByHash(ctx context.Context, hash string) (phoenixd.Outgoing, error) {
	return phoenixd.Outgoing{}, &phoenixd.RefusedError{Status: r.status, Detail: "GET /payments/outgoingbyhash/" + hash}
}

// Only a 400 from phoenixd is a question it will never answer, kept as not
// known; any other refusal (a wrong password's 401) stops the pass with
// nothing marked.
func TestFillProofsKeepsOnlyA400AsUnknown(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	h, done, _ := w.pay(t, 1_000)
	wait(t, done)
	forgetProofs(t, w.path)

	wrong := ledger.New(w.st, phoenixd.New(w.f.URL, "wrong-password"), log.New(io.Discard, "", 0))
	if _, _, _, err := wrong.FillProofs(ctx); !errors.Is(err, phoenixd.ErrRefused) {
		t.Fatalf("a 401: %v", err)
	}
	if left, _ := w.st.HoldsToAsk(ctx, 0, 10); len(left) != 1 {
		t.Fatalf("a 401 marked something: %d left", len(left))
	}

	bad := ledger.New(w.st, refusing{phoenixd.New(w.f.URL, phoenixdtest.Password), http.StatusBadRequest}, log.New(io.Discard, "", 0))
	found, unknown, _, err := bad.FillProofs(ctx)
	if err != nil || found != 0 || unknown != 1 {
		t.Fatalf("a 400: %d found, %d unknown, %v", found, unknown, err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); !got.PreimageAsked || got.Preimage != "" {
		t.Fatalf("a 400: %+v", got)
	}
}

// A description given that cleans to nothing gives way to the invoice's.
func TestABlankDescriptionIsTheInvoices(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	bolt11, _ := w.f.InvoiceWithDescription(1_000_000, "Tea")
	inv, _ := w.l.Decode(ctx, bolt11)
	done := make(chan ledger.Outcome, 1)
	h, err := w.l.PayOnce(ctx, "", card, store.KindSpend, bolt11, inv, store.HoldAbout{Description: " \n\t "}, done)
	if err != nil {
		t.Fatal(err)
	}
	wait(t, done)
	if got, _ := w.st.GetHold(ctx, h.ID); got.About.Description != "Tea" {
		t.Fatalf("description %q", got.About.Description)
	}
}

// The invoice's own description comes first; one given (an LNURL pay
// request's text/plain) is kept only for an invoice that carries none.
func TestTheInvoicesDescriptionComesFirst(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	described, _ := w.f.InvoiceWithDescription(1_000_000, "Tea")
	bare, _ := w.f.Invoice(1_000_000)
	// LUD-06's: a description hash only, and no description, as phoenixd's decode reports it.
	hashOnly, _, err := phoenixd.New(w.f.URL, phoenixdtest.Password).CreateInvoice(ctx, 1_000, strings.Repeat("ab", 32), "", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ bolt11, want string }{{described, "Tea"}, {bare, "Shop"}, {hashOnly, "Shop"}} {
		inv, _ := w.l.Decode(ctx, c.bolt11)
		done := make(chan ledger.Outcome, 1)
		h, err := w.l.PayOnce(ctx, "", card, store.KindSpend, c.bolt11, inv, store.HoldAbout{Description: "Shop"}, done)
		if err != nil {
			t.Fatal(err)
		}
		wait(t, done)
		if got, _ := w.st.GetHold(ctx, h.ID); got.About.Description != c.want {
			t.Fatalf("description %q, want %q", got.About.Description, c.want)
		}
	}
}

// Run fills old proofs in the background after its first check, without the
// first check waiting for it.
func TestRunFillsOldProofs(t *testing.T) {
	w := setup(t)
	ctx := context.Background()
	h, done, _ := w.pay(t, 1_000)
	wait(t, done)
	forgetProofs(t, w.path)
	l := ledger.New(w.st, phoenixd.New(w.f.URL, phoenixdtest.Password), log.New(io.Discard, "", 0))
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go l.Run(rctx)
	<-l.Checked()
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, _ := w.st.GetHold(ctx, h.ID)
		if got.PreimageAsked {
			if got.Preimage == "" {
				t.Fatalf("filled without a preimage: %+v", got)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("never filled")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A payment that gave no answer keeps its grace across a restart:
// the time cardd gave up is on the hold, not in memory.
func TestTheGraceSurvivesARestart(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	bolt11, hash := w.f.Invoice(1_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true, Unrecorded: true})
	defer w.f.Release(hash, true, 0) // so a failed check doesn't hang the fake's Close
	inv, _ := w.l.Decode(ctx, bolt11)
	client := phoenixd.New(w.f.URL, phoenixdtest.Password)
	client.Pay.Timeout = 200 * time.Millisecond // payinvoice gives no answer
	l := ledger.New(w.st, client, log.New(io.Discard, "", 0))
	l.Reconcile(ctx)
	// The paying ledger's clock 3 minutes ahead, as TestATimedOutPaymentKeepsItsGrace
	// does: it gives up "3 minutes after" the hold was made, so a grace counted
	// from the hold's creation would be over at the restart below, and one
	// counted from gave_up_at is not.
	l.Now = func() time.Time { return time.Now().Add(3 * time.Minute) }
	done := make(chan ledger.Outcome, 1)
	h, err := l.Pay(ctx, card, store.KindSpend, bolt11, inv, done)
	if err != nil {
		t.Fatal(err)
	}
	if o := wait(t, done); !o.Pending {
		t.Fatalf("no answer should be pending: %+v", o)
	}
	got, _ := w.st.GetHold(ctx, h.ID)
	if got.GaveUpAt.IsZero() {
		t.Fatal("gave_up_at not kept")
	}
	// A restart 1 minute after giving up, 4 after the hold: within the grace
	// only if it counts from gave_up_at.
	now := got.GaveUpAt.Add(time.Minute)
	l2 := w.restart(&now)
	if err := l2.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldOpen {
		t.Fatalf("released within the grace after a restart: %+v", got)
	}
}

func TestTheGraceHoldsIfTheGaveUpWriteIsLost(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	bolt11, hash := w.f.Invoice(1_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true, Unrecorded: true})
	defer w.f.Release(hash, true, 0)
	inv, _ := w.l.Decode(ctx, bolt11)
	client := phoenixd.New(w.f.URL, phoenixdtest.Password)
	client.Pay.Timeout = 200 * time.Millisecond
	l := ledger.New(w.st, client, log.New(io.Discard, "", 0))
	l.Reconcile(ctx)
	l.Now = func() time.Time { return time.Now().Add(3 * time.Minute) }
	done := make(chan ledger.Outcome, 1)
	h, err := l.Pay(ctx, card, store.KindSpend, bolt11, inv, done)
	if err != nil {
		t.Fatal(err)
	}
	if o := wait(t, done); !o.Pending {
		t.Fatalf("no answer should be pending: %+v", o)
	}
	got, _ := w.st.GetHold(ctx, h.ID)
	if got.GaveUpAt.IsZero() {
		t.Fatal("gave_up_at not kept")
	}
	gaveUp := got.GaveUpAt
	// The write is lost behind the ledger's back.
	db, err := sql.Open("sqlite", "file:"+w.path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`UPDATE holds SET gave_up_at = NULL WHERE id = ?`, h.ID); err != nil {
		t.Fatal(err)
	}
	now := gaveUp.Add(time.Minute)
	l.Now = func() time.Time { return now }
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldOpen {
		t.Fatalf("released within the grace after a lost write: %+v", got)
	}
}

func TestOfferReasonSentences(t *testing.T) {
	for in, want := range map[string]string{
		"no response to the invoice request":                            "The receiving wallet didn't answer: it may be offline. Try again later.",
		"recipient responded to the invoice request with an error":      "The receiving wallet refused the payment.",
		"recipient returned an invalid response to the invoice request": "The receiving wallet answered with an invoice that doesn't match the offer.",
		"recipient returned an invoice that does not match the request": "The receiving wallet answered with an invoice that doesn't match the offer.",
		"something phoenixd made up":                                    "",
		"":                                                              "",
	} {
		if got := ledger.OfferReason(in); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
}

func TestAnOfferWithNoAnswerIsPendingAndKeepsWhenCarddGaveUp(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	offer := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true})
	defer w.f.ReleaseOffer(offer, false, 0)
	client := phoenixd.New(w.f.URL, phoenixdtest.Password)
	client.Pay.Timeout = 200 * time.Millisecond
	l := ledger.New(w.st, client, log.New(io.Discard, "", 0))
	l.Reconcile(ctx)
	h, done := w.payOffer(t, l, offer, 1_000, "request:n1")
	o := wait(t, done)
	if !o.Pending {
		t.Fatalf("no answer should be pending: %+v", o)
	}
	got, _ := w.st.GetHold(ctx, h.ID)
	if got.State != store.HoldOpen || got.PaymentHash != "" || got.GaveUpAt.IsZero() {
		t.Fatalf("hold: %+v", got)
	}
}

// A payoffer that answers HTTP 500 may have sent: like payinvoice's, the hold
// stays open (no release, no settle) with when cardd gave up, and a later
// Resolve inside the grace leaves it open to settle or release by phoenixd's
// record.
func TestAPayoffer500LeavesTheHoldOpen(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	offer := w.f.Offer(0, "", "")
	w.f.Set(func(f *phoenixdtest.Fake) { f.Broken = "/payoffer" })
	h, done := w.payOffer(t, w.l, offer, 1_000, "request:500")
	if o := wait(t, done); !o.Pending {
		t.Fatalf("a 500 from payoffer: %+v", o)
	}
	check := func(when string) {
		t.Helper()
		got, _ := w.st.GetHold(ctx, h.ID)
		if got.State != store.HoldOpen || got.PaymentHash != "" || got.GaveUpAt.IsZero() {
			t.Fatalf("%s: hold %+v", when, got)
		}
	}
	check("after the 500")
	if err := w.l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	check("after Resolve inside the grace")
}

// pool gives the world's pool amountSat, and phoenixd as much more.
func (w *world) pool(t *testing.T, amountSat int64) {
	t.Helper()
	ctx := context.Background()
	w.st.Credit(ctx, store.Pool, amountSat*1000, fmt.Sprintf("pool-%d", amountSat), "")
	w.f.Set(func(f *phoenixdtest.Fake) { f.BalanceSat += amountSat })
	if err := w.l.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
}

func (w *world) payOffer(t *testing.T, l *ledger.Ledger, offer string, sat int64, ref string) (store.Hold, chan ledger.Outcome) {
	t.Helper()
	done := make(chan ledger.Outcome, 1)
	h, err := l.PayOfferOnce(context.Background(), ref, store.Pool, store.KindSend, offer, sat*1000, store.HoldAbout{Destination: "₿alice@example.com"}, done)
	if err != nil {
		t.Fatal(err)
	}
	return h, done
}

func TestAnOfferIsPaidAndSettledAtItsFee(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	offer := w.f.Offer(0, "Coffee", "Ana's Café")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{FeeMsat: 4_400})
	h, done := w.payOffer(t, w.l, offer, 1_000, "request:o1")
	if h.PaymentHash != "" || h.Offer != offer {
		t.Fatalf("held: %+v", h)
	}
	o := wait(t, done)
	if o.Pending || o.Hold.State != store.HoldSettled || o.Hold.FeeMsat != 4_400 || o.Hold.PaymentHash != w.f.OfferPayments(offer)[0] || o.Hold.PaymentID == "" {
		t.Fatalf("outcome: %+v", o)
	}
	if got := available(t, w.st, store.Pool); got != 50_000_000-1_000_000-4_400 {
		t.Fatalf("pool %d", got)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.About.Destination != "₿alice@example.com" {
		t.Fatalf("destination: %+v", got.About)
	}
}

func TestAnOfferThatWasntPaidIsReleasedWithItsReason(t *testing.T) {
	cases := []struct {
		name   string
		out    phoenixdtest.OfferOutcome
		reason string
	}{
		{"no invoice", phoenixdtest.OfferOutcome{Fail: "no response to the invoice request"}, "The receiving wallet didn't answer: it may be offline. Try again later."},
		{"the payee's error", phoenixdtest.OfferOutcome{Fail: "recipient responded to the invoice request with an error"}, "The receiving wallet refused the payment."},
		{"a mismatched invoice", phoenixdtest.OfferOutcome{Fail: "recipient returned an invoice that does not match the request"}, "The receiving wallet answered with an invoice that doesn't match the offer."},
		{"the payment failed", phoenixdtest.OfferOutcome{FailPaid: true}, ""},
		{"an early failure, no record", phoenixdtest.OfferOutcome{EarlyFail: true}, ""},
		{"refused", phoenixdtest.OfferOutcome{Refuse: true}, ""},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := setup(t)
			w.pool(t, 50_000)
			offer := w.f.Offer(0, "", "")
			w.f.SetOfferOutcome(offer, c.out)
			start := time.Now()
			_, done := w.payOffer(t, w.l, offer, 1_000, fmt.Sprintf("request:f%d", i))
			o := wait(t, done)
			if o.Pending || o.Hold.State != store.HoldReleased || o.Hold.Reason != c.reason {
				t.Fatalf("outcome: %+v", o)
			}
			if (c.out.FailPaid || c.out.EarlyFail) && o.Hold.PaymentHash == "" {
				t.Fatalf("the payment's hash should be kept on the hold: %+v", o.Hold)
			}
			if time.Since(start) > 5*time.Second {
				t.Fatal("a failure answer waited: it must release at once")
			}
			if got := available(t, w.st, store.Pool); got != 50_000_000 {
				t.Fatalf("pool %d", got)
			}
		})
	}
}

func TestOneOfferAtATimeAndOncePerRef(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	offer := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true})
	_, done := w.payOffer(t, w.l, offer, 1_000, "request:a")
	defer w.f.ReleaseOffer(offer, false, 0)
	if _, err := w.l.PayOfferOnce(ctx, "request:b", store.Pool, store.KindSend, offer, 1_000_000, store.HoldAbout{}, nil); !errors.Is(err, store.ErrPaymentInProgress) {
		t.Fatalf("a second while one is held: %v", err)
	}
	for i := 0; len(w.f.OfferPayments(offer)) == 0 && i < 500; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	w.f.ReleaseOffer(offer, false, 0)
	wait(t, done)
	if _, err := w.l.PayOfferOnce(ctx, "request:a", store.Pool, store.KindSend, offer, 1_000_000, store.HoldAbout{}, nil); !errors.Is(err, store.ErrDuplicatePayment) {
		t.Fatalf("the same ref again: %v", err)
	}
	// An offer may rightly be paid again, under a new ref.
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{})
	_, done = w.payOffer(t, w.l, offer, 1_000, "request:c")
	if o := wait(t, done); o.Hold.State != store.HoldSettled {
		t.Fatalf("paid again: %+v", o)
	}
}

func TestAnOfferIsRefusedWhilePausedAndInPartSats(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	offer := w.f.Offer(0, "", "")
	if _, err := w.l.PayOfferOnce(ctx, "request:p", store.Pool, store.KindSend, offer, 1_000_500, store.HoldAbout{}, nil); !errors.Is(err, ledger.ErrBadInvoice) {
		t.Fatalf("part of a sat: %v", err)
	}
	w.f.Set(func(f *phoenixdtest.Fake) { f.BalanceSat = 0 })
	w.l.Reconcile(ctx)
	if _, err := w.l.PayOfferOnce(ctx, "request:q", store.Pool, store.KindSend, offer, 1_000_000, store.HoldAbout{}, nil); !errors.Is(err, ledger.ErrPaused) {
		t.Fatalf("paused: %v", err)
	}
}

// ledgerGivingUp is a ledger whose payoffer and payinvoice give no answer
// within 200 ms, as when phoenixd's answer is lost, logging to the buffer.
func (w *world) ledgerGivingUp(t *testing.T) (*ledger.Ledger, *bytes.Buffer) {
	t.Helper()
	client := phoenixd.New(w.f.URL, phoenixdtest.Password)
	client.Pay.Timeout = 200 * time.Millisecond
	logs := &bytes.Buffer{}
	l := ledger.New(w.st, client, log.New(logs, "", 0))
	if err := l.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	return l, logs
}

// underWay waits until the fake has taken up a payment for the offer: only
// then may it be released, or its payment looked at.
func (w *world) underWay(t *testing.T, offer string) {
	t.Helper()
	for start := time.Now(); len(w.f.OfferPayments(offer)) == 0; time.Sleep(10 * time.Millisecond) {
		if time.Since(start) > 5*time.Second {
			t.Fatal("the offer's payment never got under way")
		}
	}
}

// In these tests a hanging payoffer is also released in a defer, so that
// f.Close can't hang on it if a test stops early; a second release only
// rewrites the fake's record after the test has looked.

func TestResolveMatchesAPaidOfferInPhoenixdsUnits(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	l, _ := w.ledgerGivingUp(t)
	offer := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true})
	defer w.f.ReleaseOffer(offer, true, 0)
	h, done := w.payOffer(t, l, offer, 1_000, "request:u")
	if o := wait(t, done); !o.Pending {
		t.Fatalf("no answer should be pending: %+v", o)
	}
	w.underWay(t, offer)
	// Paid with a fee that isn't whole sats: phoenixd's sent is 1,004 sat
	// (rounded down), fees 4,400 msat.
	hash := w.f.ReleaseOffer(offer, false, 4_400)
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	got, _ := w.st.GetHold(ctx, h.ID)
	if got.State != store.HoldSettled || got.FeeMsat != 4_400 || got.PaymentHash != hash || got.PaymentID == "" {
		t.Fatalf("settled? %+v", got)
	}
	if a := available(t, w.st, store.Pool); a != 50_000_000-1_000_000-4_400 {
		t.Fatalf("pool %d", a)
	}
}

func TestResolveFollowsAMatchedPaymentsState(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	l, _ := w.ledgerGivingUp(t)
	offer := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true})
	defer w.f.ReleaseOffer(offer, true, 0)
	h, done := w.payOffer(t, l, offer, 2_000, "request:s")
	wait(t, done)
	w.underWay(t, offer)
	// Still on its way: found, its hash kept, left open.
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	got, _ := w.st.GetHold(ctx, h.ID)
	if got.State != store.HoldOpen || got.PaymentHash == "" {
		t.Fatalf("pending: %+v", got)
	}
	// Then failed: released, by its hash now, as any hold.
	w.f.ReleaseOffer(offer, true, 0)
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldReleased {
		t.Fatalf("failed: %+v", got)
	}
}

func TestAnUnrecordedOfferIsReleasedAfterTheGraceOnly(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	l, _ := w.ledgerGivingUp(t)
	offer := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true, Unrecorded: true})
	defer w.f.ReleaseOffer(offer, true, 0)
	// Beside it, payments the match must rule out: an on-chain one of the
	// same amount, and a card's invoice of the same amount (its hash is its hold's).
	w.f.OnChainOut(1_000_000)
	_, cardDone, _ := w.pay(t, 1_000)
	wait(t, cardDone)
	h, done := w.payOffer(t, l, offer, 1_000, "request:n")
	wait(t, done)
	w.underWay(t, offer)
	got, _ := w.st.GetHold(ctx, h.ID)
	now := got.GaveUpAt.Add(time.Minute)
	l.Now = func() time.Time { return now }
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldOpen {
		t.Fatalf("released within the grace, or matched to another payment: %+v", got)
	}
	now = got.GaveUpAt.Add(ledger.UnsentGrace + time.Second)
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldReleased {
		t.Fatalf("not released after the grace: %+v", got)
	}
}

// A record that appears late, within the grace (the invoice fetch was slow),
// is found and settled; and an offer's grace counts from gave_up_at across a
// restart, as an invoice's does: the paying ledger's clock is 3 minutes
// ahead, so gave_up_at is, and the restarted ledger's "now" is past the grace
// counted from the hold's creation but within it from gave_up_at.
func TestALateRecordWithinTheGraceIsFound(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	l, _ := w.ledgerGivingUp(t)
	ahead := time.Now().Add(3 * time.Minute)
	l.Now = func() time.Time { return ahead }
	offer := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true, Unrecorded: true})
	defer w.f.ReleaseOffer(offer, true, 0)
	h, done := w.payOffer(t, l, offer, 1_500, "request:late")
	wait(t, done)
	w.underWay(t, offer)
	got, _ := w.st.GetHold(ctx, h.ID)
	now := got.GaveUpAt.Add(time.Minute)
	if !now.After(got.CreatedAt.Add(ledger.UnsentGrace)) {
		t.Fatalf("the test's clock: now %v is within the grace from the hold's creation %v", now, got.CreatedAt)
	}
	l2 := w.restart(&now)
	if err := l2.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldOpen {
		t.Fatalf("released within the grace after a restart: %+v", got)
	}
	w.f.ReleaseOffer(offer, false, 2_000)
	if err := l2.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldSettled || got.FeeMsat != 2_000 {
		t.Fatalf("the late record: %+v", got)
	}
}

func TestTwoMatchesAreLeftHeld(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	l, logs := w.ledgerGivingUp(t)
	offer := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true})
	defer w.f.ReleaseOffer(offer, true, 0)
	h, done := w.payOffer(t, l, offer, 3_000, "request:t")
	wait(t, done)
	w.underWay(t, offer)
	// A payment of the same amount that no hold of cardd's made.
	other := w.f.Offer(0, "", "")
	if _, err := phoenixd.New(w.f.URL, phoenixdtest.Password).PayOffer(ctx, other, 3_000); err != nil {
		t.Fatal(err)
	}
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldOpen || got.PaymentHash != "" {
		t.Fatalf("guessed: %+v", got)
	}
	if !strings.Contains(logs.String(), "matches 2 payments; left held") {
		t.Fatalf("log: %s", logs)
	}
}

func TestARecordFromBeforeTheHoldIsMatchedLoudly(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	l, logs := w.ledgerGivingUp(t)
	offer := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true})
	defer w.f.ReleaseOffer(offer, true, 0)
	h, done := w.payOffer(t, l, offer, 4_000, "request:b")
	wait(t, done)
	w.underWay(t, offer)
	w.f.PaymentCreatedAt(w.f.OfferPayments(offer)[0], h.CreatedAt.Add(-5*time.Second))
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.PaymentHash == "" {
		t.Fatalf("not matched: %+v", got)
	}
	if !strings.Contains(logs.String(), "before the hold") {
		t.Fatalf("log: %s", logs)
	}
}

// A failed payment of the hold's amount that no hold made (paid from this
// phoenixd outside cardd) is never taken as the hold's: its hash isn't kept,
// and the hold, whose own payment has no record yet, stays held for the grace.
func TestAFailedRecordIsNeverTheHolds(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	l, _ := w.ledgerGivingUp(t)
	offer := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true, Unrecorded: true})
	defer w.f.ReleaseOffer(offer, true, 0)
	h, done := w.payOffer(t, l, offer, 1_000, "request:fx")
	wait(t, done)
	w.underWay(t, offer)
	foreign := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(foreign, phoenixdtest.OfferOutcome{FailPaid: true})
	if _, err := phoenixd.New(w.f.URL, phoenixdtest.Password).PayOffer(ctx, foreign, 1_000); err != nil {
		t.Fatal(err)
	}
	foreignHash := w.f.OfferPayments(foreign)[0]
	got, _ := w.st.GetHold(ctx, h.ID)
	now := got.GaveUpAt.Add(time.Minute)
	l.Now = func() time.Time { return now }
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldOpen || got.PaymentHash != "" || got.PaymentID != "" {
		t.Fatalf("took the failed payment within the grace: %+v", got)
	}
	now = got.GaveUpAt.Add(ledger.UnsentGrace + time.Second)
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldReleased || got.PaymentHash == foreignHash || got.PaymentHash != "" {
		t.Fatalf("after the grace: %+v (the failed payment is %s)", got, foreignHash)
	}
}

// listedTwice is phoenixd listing every payment twice, as a list whose order
// moved between pages could.
type listedTwice struct{ *phoenixd.Client }

func (d listedTwice) ListOutgoing(ctx context.Context, fromMs, toMs int64, limit, offset int) ([]phoenixd.OutgoingRecord, error) {
	page, err := d.Client.ListOutgoing(ctx, fromMs, toMs, limit, offset)
	return append(page, page...), err
}

// A payment phoenixd lists twice is one payment: matched, not "matches 2".
func TestARecordListedTwiceCountsOnce(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	client := phoenixd.New(w.f.URL, phoenixdtest.Password)
	client.Pay.Timeout = 200 * time.Millisecond
	logs := &bytes.Buffer{}
	l := ledger.New(w.st, listedTwice{client}, log.New(logs, "", 0))
	if err := l.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	offer := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true})
	defer w.f.ReleaseOffer(offer, true, 0)
	h, done := w.payOffer(t, l, offer, 2_500, "request:d")
	wait(t, done)
	w.underWay(t, offer)
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldOpen || got.PaymentHash != w.f.OfferPayments(offer)[0] {
		t.Fatalf("not matched: %+v; log: %s", got, logs)
	}
}

// idlessTwice is phoenixd listing every payment twice with no id: two
// records that can't be told apart, nor attached to a hold.
type idlessTwice struct{ *phoenixd.Client }

func (d idlessTwice) ListOutgoing(ctx context.Context, fromMs, toMs int64, limit, offset int) ([]phoenixd.OutgoingRecord, error) {
	page, err := d.Client.ListOutgoing(ctx, fromMs, toMs, limit, offset)
	var out []phoenixd.OutgoingRecord
	for _, r := range page {
		r.ID = ""
		out = append(out, r, r)
	}
	return out, err
}

// A record with no id is never counted: two id-less records of the same
// amount don't become one match by sharing the empty id.
func TestARecordWithNoIDIsNeverMatched(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.pool(t, 50_000)
	client := phoenixd.New(w.f.URL, phoenixdtest.Password)
	client.Pay.Timeout = 200 * time.Millisecond
	logs := &bytes.Buffer{}
	l := ledger.New(w.st, idlessTwice{client}, log.New(logs, "", 0))
	if err := l.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	offer := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true})
	defer w.f.ReleaseOffer(offer, true, 0)
	h, done := w.payOffer(t, l, offer, 2_500, "request:e")
	wait(t, done)
	w.underWay(t, offer)
	if err := l.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := w.st.GetHold(ctx, h.ID); got.State != store.HoldOpen || got.PaymentHash != "" || got.PaymentID != "" {
		t.Fatalf("an id-less record was matched: %+v; log: %s", got, logs)
	}
}

// An invoice's hold keeps phoenixd's payment id from payinvoice's answer
// too, as an offer's does.
func TestAPaidInvoicesHoldKeepsItsPaymentID(t *testing.T) {
	w := setup(t)
	h, done, _ := w.pay(t, 1_000)
	if o := wait(t, done); o.Pending || o.Hold.State != store.HoldSettled {
		t.Fatalf("outcome: %+v", o)
	}
	if got, _ := w.st.GetHold(context.Background(), h.ID); got.PaymentID == "" {
		t.Fatalf("no payment id kept: %+v", got)
	}
}

// phoenixd answering HTTP 500 to decodeinvoice is phoenixd failing, not an
// invoice that can't be read: unreachable, never ErrBadInvoice.
func TestDecodeWhenPhoenixdAnswers500IsUnreachable(t *testing.T) {
	w := setup(t)
	bolt11, _ := w.f.Invoice(1_000_000)
	w.f.Set(func(f *phoenixdtest.Fake) { f.Broken = "/decodeinvoice" })
	_, err := w.l.DecodeFor(context.Background(), bolt11, 0)
	if !errors.Is(err, phoenixd.ErrUnreachable) || errors.Is(err, ledger.ErrBadInvoice) {
		t.Fatalf("a 500 from decodeinvoice: %v", err)
	}
}
