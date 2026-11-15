package store

import (
	"context"
	"errors"
	"testing"
)

// One refund per sale: checked inside OpenHold's transaction, so two phones can't both pass,
// and a refund to this server's own card booked in one transaction.

const refundCard = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// soldAndPaid makes saleA paid for 8,000 sat, so Shop holds it.
func soldAndPaid(t *testing.T) *Store {
	t.Helper()
	s, _ := tills(t)
	sale(t, s, saleA, till1, 8_000_000)
	paid(t, s, saleA, 8_000_000)
	return s
}

func refundHold(s *Store, hash string) (Hold, error) {
	return s.OpenHold(context.Background(), HoldRequest{Account: Shop, Kind: KindRefund, AmountMsat: 7_650_000,
		FeeBudgetMsat: 0, PaymentHash: hash, Invoice: "lnbc-" + hash, About: HoldAbout{SaleID: saleA}})
}

func TestRefundHoldOnce(t *testing.T) {
	s := soldAndPaid(t)
	if _, err := refundHold(s, "r1"); err != nil {
		t.Fatal(err)
	}
	if _, err := refundHold(s, "r2"); !errors.Is(err, ErrAlreadyRefunded) {
		t.Fatalf("second: %v", err)
	}
	got, _ := s.SaleByID(context.Background(), saleA)
	if !got.RefundPending || got.RefundTxID != 0 {
		t.Fatalf("while on its way: %+v", got)
	}
}

// A race: the first refund settles (in about 0.2 s)
// before a second phone's hold opens. No open hold is left, but the sale is
// refunded, and that is read inside the second hold's transaction.
func TestRefundHoldOnceAcrossSettle(t *testing.T) {
	ctx := context.Background()
	s := soldAndPaid(t)
	h, err := refundHold(s, "r1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SettleHoldWithProofAt(ctx, h.ID, 0, "", h.CreatedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := refundHold(s, "r2"); !errors.Is(err, ErrAlreadyRefunded) {
		t.Fatalf("after the first settled: %v", err)
	}
}

func TestRefundHoldNotPaid(t *testing.T) {
	s, _ := tills(t)
	sale(t, s, saleA, till1, 8_000_000)
	shopMoney(t, s, 20_000_000, "float")
	if _, err := refundHold(s, "r1"); !errors.Is(err, ErrNotPaid) {
		t.Fatalf("open sale: %v", err)
	}
	_, err := s.OpenHold(context.Background(), HoldRequest{Account: Shop, Kind: KindRefund, AmountMsat: 1_000_000, PaymentHash: "r2", Invoice: "lnbc",
		About: HoldAbout{SaleID: saleB}})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown sale: %v", err)
	}
}

func TestRefundHoldReleasedFreesSale(t *testing.T) {
	ctx := context.Background()
	s := soldAndPaid(t)
	h, err := refundHold(s, "r1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReleaseHold(ctx, h.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := refundHold(s, "r2"); err != nil {
		t.Fatalf("after a failed refund: %v", err)
	}
}

func TestRefundSettleBooks(t *testing.T) {
	ctx := context.Background()
	s := soldAndPaid(t)
	shopMoney(t, s, 1_000_000, "float")
	h, err := s.OpenHold(ctx, HoldRequest{Account: Shop, Kind: KindRefund, AmountMsat: 7_650_000, FeeBudgetMsat: 5_000,
		PaymentHash: "r1", Invoice: "lnbc-r1", About: HoldAbout{SaleID: saleA}})
	if err != nil {
		t.Fatal(err)
	}
	h, err = s.SettleHoldWithProofAt(ctx, h.ID, 3_000, "", h.CreatedAt)
	if err != nil {
		t.Fatal(err)
	}
	if got := available(t, s, Shop); got != 9_000_000-7_650_000-3_000 {
		t.Fatalf("shop has %d", got)
	}
	line, err := s.Line(ctx, Shop, h.TxID)
	if err != nil || line.Kind != KindRefund || line.Note != "refund of sale "+saleA+", paid r1" || line.Sale == nil || line.Sale.ID != saleA {
		t.Fatalf("%+v %v", line, err)
	}
	got, _ := s.SaleByID(ctx, saleA)
	if got.RefundTxID != h.TxID || got.RefundPending || got.RefundMsat != 7_650_000 || got.RefundFrom != Shop {
		t.Fatalf("sale %+v", got)
	}
}

func TestRefundToCard(t *testing.T) {
	ctx := context.Background()
	s := soldAndPaid(t)
	shopMoney(t, s, 2_000_000, "float")
	card := activeCard(t, s, refundCard)
	id, err := s.RefundToCard(ctx, "request:one", saleA, Shop, refundCard, 8_000_000)
	if err != nil || id == 0 {
		t.Fatalf("%d %v", id, err)
	}
	if available(t, s, Shop) != 2_000_000 || available(t, s, card) != 8_000_000 {
		t.Fatalf("shop %d card %d", available(t, s, Shop), available(t, s, card))
	}
	again, err := s.RefundToCard(ctx, "request:one", saleA, Shop, refundCard, 8_000_000)
	if err != nil || again != id || available(t, s, card) != 8_000_000 {
		t.Fatalf("the same request again: %d %v, card %d", again, err, available(t, s, card))
	}
	if _, err := s.RefundToCard(ctx, "request:two", saleA, Shop, refundCard, 8_000_000); !errors.Is(err, ErrAlreadyRefunded) {
		t.Fatalf("another request: %v", err)
	}
	got, _ := s.SaleByID(ctx, saleA)
	if got.RefundTxID != id || got.RefundMsat != 8_000_000 || got.RefundFrom != Shop {
		t.Fatalf("sale %+v", got)
	}
}

func TestRefundToCardRefusals(t *testing.T) {
	ctx := context.Background()
	s := soldAndPaid(t)
	activeCard(t, s, refundCard)
	if _, err := s.RefundToCard(ctx, "request:big", saleA, Shop, refundCard, 9_000_000); !errors.Is(err, ErrInsufficient) {
		t.Fatalf("shop short: %v", err)
	}
	if _, err := refundHold(s, "r1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RefundToCard(ctx, "request:busy", saleA, Shop, refundCard, 100_000); !errors.Is(err, ErrPaymentInProgress) && !errors.Is(err, ErrAlreadyRefunded) {
		t.Fatalf("a hold open: %v", err)
	}
	s2 := soldAndPaid(t)
	activeCard(t, s2, refundCard)
	if _, err := s2.StartWipe(ctx, refundCard); err != nil {
		t.Fatal(err)
	}
	if _, err := s2.RefundToCard(ctx, "request:wipe", saleA, Shop, refundCard, 1_000_000); !errors.Is(err, ErrCannotReceive) {
		t.Fatalf("a card being wiped: %v", err)
	}
}
