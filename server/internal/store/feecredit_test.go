package store

import (
	"context"
	"testing"
	"time"
)

// The fee credit cardd has accounted for is unknown until first set, and moves with a credit in that
// credit's own transaction: only when the credit was made.
func TestTheKeptFeeCreditMovesWithACredit(t *testing.T) {
	ctx := context.Background()
	s, _ := tills(t)
	if _, known, err := s.KeptFeeCredit(ctx); err != nil || known {
		t.Fatalf("before any: known %v %v", known, err)
	}
	kept := func() int64 {
		t.Helper()
		sat, known, err := s.KeptFeeCredit(ctx)
		if err != nil || !known {
			t.Fatalf("kept: %v %v", known, err)
		}
		return sat
	}
	// From unknown, a share taken counts from nothing.
	if done, err := s.CreditMoving(ctx, Pool, 0, 0, "h1", "set aside", FeeCreditMove{AddSat: 1_000}); err != nil || !done || kept() != 1_000 {
		t.Fatalf("first: %v %v", done, err)
	}
	if done, err := s.CreditMoving(ctx, Pool, 500_000, 0, "h2", "part set aside", FeeCreditMove{AddSat: 2_000}); err != nil || !done || kept() != 3_000 {
		t.Fatalf("second: %v %v, kept %d", done, err, kept())
	}
	// The same payment again (the sweep lists it every 5 minutes) is no credit, and moves nothing.
	if done, err := s.CreditMoving(ctx, Pool, 500_000, 0, "h2", "part set aside", FeeCreditMove{AddSat: 2_000}); err != nil || done || kept() != 3_000 {
		t.Fatalf("again: %v %v, kept %d", done, err, kept())
	}
	if done, err := s.CreditMoving(ctx, Pool, 500_000, 0, "h2", "", FeeCreditMove{Set: true, ToSat: 0}); err != nil || done || kept() != 3_000 {
		t.Fatalf("again, as a purchase: %v %v, kept %d", done, err, kept())
	}
	// A payment that bought room sets the figure to phoenixd's.
	if done, err := s.CreditMoving(ctx, Pool, 9_000_000, 0, "h3", "bought room", FeeCreditMove{Set: true, ToSat: 400}); err != nil || !done || kept() != 400 {
		t.Fatalf("a purchase: %v %v, kept %d", done, err, kept())
	}
	// No move at all leaves it, as Credit does.
	if done, err := s.Credit(ctx, Pool, 1_000, "h4", ""); err != nil || !done || kept() != 400 {
		t.Fatalf("a plain credit: %v %v, kept %d", done, err, kept())
	}
	// A sale's credit moves it the same way, and only once.
	sale(t, s, saleA, till1, 2_500_000)
	for i, want := range []bool{true, false} {
		done, err := s.CreditSaleMoving(ctx, saleA, 0, "hash-"+saleA, "set aside", FeeCreditMove{AddSat: 2_500})
		if err != nil || done != want || kept() != 2_900 {
			t.Fatalf("the sale, call %d: %v %v, kept %d", i, done, err, kept())
		}
	}
	if err := s.SetKeptFeeCredit(ctx, 7); err != nil || kept() != 7 {
		t.Fatalf("set outright: %v", err)
	}
	if got := available(t, s, Pool); got != 9_501_000 {
		t.Fatalf("pool %d", got)
	}
}

func TestCreditedAndRecentHolds(t *testing.T) {
	ctx := context.Background()
	s, now := tills(t)
	if yes, err := s.Credited(ctx, "h1"); err != nil || yes {
		t.Fatalf("before: %v %v", yes, err)
	}
	s.Credit(ctx, Pool, 5_000_000, "h1", "")
	if yes, err := s.Credited(ctx, "h1"); err != nil || !yes {
		t.Fatalf("after: %v %v", yes, err)
	}
	if yes, _ := s.Credited(ctx, ""); yes {
		t.Fatal("no payment hash counts as credited")
	}
	paidOut := func(since time.Duration) int64 {
		t.Helper()
		msat, err := s.PaidOutSince(ctx, now.Add(-since))
		if err != nil {
			t.Fatal(err)
		}
		return msat
	}
	if got := paidOut(time.Hour); got != 0 {
		t.Fatalf("no holds: %d", got)
	}
	// What a payment going out can free is its amount and its whole fee budget.
	h, err := s.OpenHold(ctx, HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 1_000_000, FeeBudgetMsat: 10_000, PaymentHash: "out"})
	if err != nil {
		t.Fatal(err)
	}
	if got := paidOut(10 * time.Second); got != 1_010_000 {
		t.Fatalf("a hold just opened: %d", got)
	}
	// Still under way, it counts however long ago it began: it may end at any moment.
	*now = now.Add(time.Minute)
	if got := paidOut(10 * time.Second); got != 1_010_000 {
		t.Fatalf("a hold a minute old and still open: %d", got)
	}
	// Ended, it counts from when it ended: that is when its room appeared.
	if _, err := s.SettleHold(ctx, h.ID, 2_000); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(10 * time.Second)
	if got := paidOut(10 * time.Second); got != 1_010_000 {
		t.Fatalf("a hold settled 10 seconds ago: %d", got)
	}
	if got := paidOut(9 * time.Second); got != 0 {
		t.Fatalf("a hold settled 10 seconds ago, within 9: %d", got)
	}
	// Two add up.
	if _, err := s.OpenHold(ctx, HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 500_000, FeeBudgetMsat: 7_000, PaymentHash: "out-2"}); err != nil {
		t.Fatal(err)
	}
	if got := paidOut(10 * time.Second); got != 1_517_000 {
		t.Fatalf("two: %d", got)
	}
}
