package ledger_test

import (
	"context"
	"io"
	"log"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/store"
)

// A restart in the middle of a refund: a refund
// hold cardd left open is settled by Resolve when phoenixd paid it, and the
// sale shows its refund; one phoenixd failed leaves the sale refundable.
func TestRestartResolvesARefund(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	if err := w.st.AddDevice(ctx, store.Device{KeyID: "till-1", PublicKey: "04till1", Name: "Till 1", Role: store.RolePos}); err != nil {
		t.Fatal(err)
	}
	w.st.Credit(ctx, store.Pool, 50_000_000, "pool", "")
	w.f.BalanceSat += 50_000
	raw := phoenixd.New(w.f.URL, phoenixdtest.Password)
	sold := func(id string) {
		t.Helper()
		if _, err := w.st.NewSale(ctx, store.Sale{ID: id, Device: "till-1", AmountMsat: 5_000_000, PaymentHash: "hash-" + id, Invoice: "lnbc-" + id,
			ExpiresAt: time.Now().Add(10 * time.Minute)}); err != nil {
			t.Fatal(err)
		}
		if done, err := w.st.CreditSale(ctx, id, 5_000_000, "hash-"+id, "received"); err != nil || !done {
			t.Fatalf("crediting %s: %v %v", id, done, err)
		}
	}
	refunding := func(saleID string) (store.Hold, string, string) {
		t.Helper()
		bolt11, hash := w.f.Invoice(5_000_000)
		h, err := w.st.OpenHold(ctx, store.HoldRequest{Account: store.Pool, Kind: store.KindRefund, AmountMsat: 5_000_000, PaymentHash: hash, Invoice: bolt11,
			About: store.HoldAbout{SaleID: saleID}})
		if err != nil {
			t.Fatal(err)
		}
		return h, bolt11, hash
	}
	restart := func() *ledger.Ledger {
		return ledger.New(w.st, phoenixd.New(w.f.URL, phoenixdtest.Password), log.New(io.Discard, "", 0))
	}

	const paidSale, failedSale = "0b0e7a51-5a1e-4c3d-9a3e-000000000001", "0b0e7a51-5a1e-4c3d-9a3e-000000000002"
	sold(paidSale)
	h, bolt11, hash := refunding(paidSale) // phoenixd paid it while cardd was down
	w.f.SetOutcome(hash, phoenixdtest.Outcome{FeeMsat: 2_000})
	raw.PayInvoice(ctx, bolt11, 0)
	if err := restart().Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := w.st.SaleByID(ctx, paidSale)
	if err != nil || got.RefundTxID == 0 || got.RefundPending || got.RefundMsat != 5_000_000 {
		t.Fatalf("paid while down: sale %+v %v (hold %d)", got, err, h.ID)
	}

	sold(failedSale)
	_, bolt11, hash = refunding(failedSale) // phoenixd failed it while cardd was down
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	go raw.PayInvoice(ctx, bolt11, 0)
	time.Sleep(50 * time.Millisecond)
	w.f.Release(hash, true, 0)
	if err := restart().Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	got, err = w.st.SaleByID(ctx, failedSale)
	if err != nil || got.RefundTxID != 0 || got.RefundPending {
		t.Fatalf("failed while down: sale %+v %v", got, err)
	}
}
