package lnurl

import (
	"context"
	"io"
	"log"
	"path/filepath"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/store"
)

// The sweep asks the books whether a payment is credited before it goes for
// the one-credit-at-a-time lock, as the webhook's path does: a look every 2
// seconds over payments long credited never queues behind a credit that
// holds the lock for seconds (one waiting for phoenixd's fee credit).
func TestTheSweepDoesNotQueueForAPaymentAlreadyCredited(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "cardd.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	f := phoenixdtest.New()
	t.Cleanup(f.Close)
	f.Channel = true
	client := phoenixd.New(f.URL, phoenixdtest.Password)
	s := &Server{Store: st, Invoices: client, Log: log.New(io.Discard, "", 0), Now: time.Now}
	bolt11, hash, err := client.CreateInvoiceDescribed(ctx, 5_000, "top-up", "pool", 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	f.Receive(bolt11, 5_000, 0)
	if err := s.Sweep(ctx, 0); err != nil {
		t.Fatal(err)
	}
	if yes, err := st.Credited(ctx, hash); err != nil || !yes {
		t.Fatalf("credited %v %v", yes, err)
	}
	s.crediting.Lock() // a credit is under way, and stays so
	defer s.crediting.Unlock()
	swept := make(chan error, 1)
	go func() { swept <- s.Sweep(ctx, 0) }()
	select {
	case err := <-swept:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the sweep is waiting for the lock, with nothing left to credit")
	}
}

// The sweep's loop also prunes the refund links of taps that paid nothing:
// one made 25 hours ago and never claimed is gone after the
// first sweep.
func TestSweepPrunesRefundLinks(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	st, err := store.Open(filepath.Join(t.TempDir(), "cardd.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	const card = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	st.ReserveCard(ctx, card, "", "")
	st.ActivateCard(ctx, card, 1)
	if err := st.NewRefundLink(ctx, "old", card, "k1-old", time.Now().Add(400*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	f := phoenixdtest.New()
	t.Cleanup(f.Close)
	client := phoenixd.New(f.URL, phoenixdtest.Password)
	later := func() time.Time { return time.Now().Add(25 * time.Hour) }
	s := &Server{Store: st, Invoices: client, Log: log.New(io.Discard, "", 0), Now: later}
	go s.RunSweep(ctx)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := st.RefundLinkCard(ctx, "old"); err != nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the unclaimed link is still there after the first sweep")
}
