package ledger_test

import (
	"bytes"
	"context"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/store"
)

// TestKillHelper is the process the kill test kills: it opens the store, pays
// an offer from pool, and waits to be killed while payoffer hangs. It runs
// only as that child (LEDGER_KILL_DB set). cardd's own code path from the
// hold to the call is this one (PayOfferOnce); the test kills its process
// with SIGKILL, so nothing of cardd's runs after.
func TestKillHelper(t *testing.T) {
	db := os.Getenv("LEDGER_KILL_DB")
	if db == "" {
		t.Skip("only as the kill test's child")
	}
	ctx := context.Background()
	st, err := store.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	l := ledger.New(st, phoenixd.New(os.Getenv("LEDGER_KILL_PHOENIXD"), phoenixdtest.Password), log.New(io.Discard, "", 0))
	if err := l.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := l.PayOfferOnce(ctx, "request:kill", store.Pool, store.KindSend, os.Getenv("LEDGER_KILL_OFFER"), 2_000_000, store.HoldAbout{}, nil); err != nil {
		t.Fatal(err)
	}
	select {} // until killed
}

// Killing cardd between the hold and phoenixd's answer: the
// next cardd finds the payment in phoenixd's list and settles it at its fee,
// or, with no record, releases the hold after the grace. The books are right
// both ways.
func TestKillingCarddMidOffer(t *testing.T) {
	for _, paid := range []bool{true, false} {
		name := "no record"
		if paid {
			name = "paid while down"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			db := filepath.Join(t.TempDir(), "cardd.db")
			st, err := store.Open(db)
			if err != nil {
				t.Fatal(err)
			}
			st.Credit(ctx, store.Pool, 10_000_000, "p", "")
			st.Close()
			f := phoenixdtest.New()
			defer f.Close()
			f.BalanceSat = 10_000
			offer := f.Offer(0, "", "")
			f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true, Unrecorded: !paid})
			// Runs before f.Close: a test that stops early leaves no payoffer hanging.
			defer f.ReleaseOffer(offer, true, 0)
			cmd := exec.Command(os.Args[0], "-test.run=^TestKillHelper$")
			cmd.Env = append(os.Environ(), "LEDGER_KILL_DB="+db, "LEDGER_KILL_PHOENIXD="+f.URL, "LEDGER_KILL_OFFER="+offer)
			var child bytes.Buffer // the child's output, said if the test fails
			cmd.Stdout, cmd.Stderr = &child, &child
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() {
				cmd.Process.Kill()
				cmd.Wait() // the buffer is read only once the child's output is done
				if t.Failed() {
					t.Logf("the child said:\n%s", child.String())
				}
			}()
			// Killed once the payment is under way at phoenixd, not merely once
			// payoffer was called: the call is counted before it is taken up.
			for start := time.Now(); len(f.OfferPayments(offer)) == 0; time.Sleep(10 * time.Millisecond) {
				if time.Since(start) > 20*time.Second {
					t.Fatal("the child's payment never got under way")
				}
			}
			cmd.Process.Kill() // SIGKILL: cardd stops between the hold and the answer
			cmd.Wait()
			f.ReleaseOffer(offer, !paid, 4_400)

			st, err = store.Open(db)
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			holds, _ := st.OpenHolds(ctx)
			if len(holds) != 1 || holds[0].PaymentHash != "" {
				t.Fatalf("after the kill: %+v", holds)
			}
			now := holds[0].CreatedAt.Add(ledger.UnsentGrace + time.Minute)
			l := ledger.New(st, phoenixd.New(f.URL, phoenixdtest.Password), log.New(io.Discard, "", 0))
			l.Now = func() time.Time { return now }
			if err := l.Resolve(ctx); err != nil {
				t.Fatal(err)
			}
			h, _ := st.GetHold(ctx, holds[0].ID)
			b, _ := st.Balance(ctx, store.Pool)
			switch {
			case paid && (h.State != store.HoldSettled || h.FeeMsat != 4_400 || b.AvailableMsat() != 10_000_000-2_000_000-4_400):
				t.Fatalf("paid while down: %+v, pool %+v", h, b)
			case !paid && (h.State != store.HoldReleased || b.AvailableMsat() != 10_000_000):
				t.Fatalf("no record: %+v, pool %+v", h, b)
			}
		})
	}
}
