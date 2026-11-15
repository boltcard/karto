package store

import (
	"context"
	"slices"
	"testing"
	"time"
)

// Changed is told, once a transaction has committed, the accounts whose
// books it changed: those of a ledger transaction's legs (not world, not
// fees) and a hold's. Once for a transaction, whatever it posted; never for
// a write that did nothing or a transaction that failed. A held read of an
// account answers on it.
func TestChangedIsToldTheAccountsOfEachWrite(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	const id2 = "00000000000000000000000000000002"
	card2 := activeCard(t, s, id2)
	var got [][]Account
	s.Changed = func(accounts []Account) { got = append(got, slices.Clone(accounts)) }
	// told: the write just made told Changed once, of these accounts (none: not at all).
	told := func(what string, err error, want ...Account) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		calls := got
		got = nil
		if len(want) == 0 {
			if len(calls) != 0 {
				t.Fatalf("%s: told %v, want nothing", what, calls)
			}
			return
		}
		if len(calls) != 1 {
			t.Fatalf("%s: told %d times (%v), want once", what, len(calls), calls)
		}
		slices.Sort(calls[0])
		slices.Sort(want)
		if !slices.Equal(calls[0], want) {
			t.Fatalf("%s: told %v, want %v", what, calls[0], want)
		}
	}
	credit := func(acct Account, msat int64, ref string) error {
		_, err := s.Credit(ctx, acct, msat, ref, "")
		return err
	}

	told("a top-up", credit(card, 50_000_000, "h1"), card)
	told("the same top-up again", credit(card, 50_000_000, "h1"))
	// A top-up the books credit nothing of (all of it went to phoenixd's fee
	// credit) still names its account, and is in that account's history.
	told("a top-up of nothing", credit(Pool, 0, "h0"), Pool)
	if txs, err := s.History(ctx, Pool, 0, 10); err != nil || len(txs) != 1 || txs[0].Kind != KindTopup || txs[0].AmountMsat != 0 {
		t.Fatalf("pool's history after a top-up of nothing: %+v %v", txs, err)
	}
	// One with no ref (none is made so today) has its leg too: the leg is found by the transaction, not by its ref.
	told("a top-up of nothing with no ref", credit(Pool, 0, ""), Pool)
	if txs, err := s.History(ctx, Pool, 0, 10); err != nil || len(txs) != 2 || txs[0].AmountMsat != 0 {
		t.Fatalf("pool's history after two top-ups of nothing: %+v %v", txs, err)
	}
	told("a move", s.MoveOnce(ctx, "m1", card, Pool, 10_000_000, ""), card, Pool)
	told("the same move again", s.MoveOnce(ctx, "m1", card, Pool, 10_000_000, ""))
	if err := s.Move(ctx, card, Pool, 1_000_000_000, ""); err == nil {
		t.Fatal("a move of more than there is went through")
	}
	told("a move that failed", nil)

	h, err := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 1_000_000, FeeBudgetMsat: 10_000, PaymentHash: "p1"})
	told("a hold opened", err, card)
	_, err = s.SettleHold(ctx, h.ID, 5_000)
	told("a hold settled", err, card)
	_, err = s.SettleHold(ctx, h.ID, 5_000)
	told("a settled hold settled again", err)
	h, err = s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 1_000_000, FeeBudgetMsat: 10_000, PaymentHash: "p2"})
	told("a second hold opened", err, card)
	_, err = s.ReleaseHold(ctx, h.ID)
	told("a hold released", err, card)
	_, err = s.ReleaseHold(ctx, h.ID)
	told("a released hold released again", err)
	// A fee over the budget, on a card with no more than the hold: pool pays
	// the rest in a transaction of its own, and Changed is still told once.
	told("the second card's top-up", credit(card2, 1_010_000, "h2"), card2)
	h, err = s.OpenHold(ctx, HoldRequest{Account: card2, Kind: KindSpend, AmountMsat: 1_000_000, FeeBudgetMsat: 10_000, PaymentHash: "p3"})
	told("its hold opened", err, card2)
	_, err = s.SettleHold(ctx, h.ID, 50_000)
	told("its hold settled over the budget", err, card2, Pool)

	if err := s.AddDevice(ctx, Device{KeyID: "1111111111111111", PublicKey: "0411", Name: "Till 1", Role: RolePos}); err != nil {
		t.Fatal(err)
	}
	for i, sale := range []string{"0a000000-0000-4000-8000-00000000000a", "0b000000-0000-4000-8000-00000000000b"} {
		hash := []string{"s1", "s2"}[i]
		if _, err := s.NewSale(ctx, Sale{ID: sale, Device: "1111111111111111", AmountMsat: 2_500_000, PaymentHash: hash, Invoice: "lnbc" + hash,
			ExpiresAt: time.Now().Add(10 * time.Minute)}); err != nil {
			t.Fatal(err)
		}
		got = nil // a sale made is no change to the books
		_, err := s.CreditSale(ctx, sale, []int64{2_500_000, 0}[i], hash, "")
		told([]string{"a sale", "a sale that brought nothing"}[i], err, Shop)
	}

	told("the books set", s.AdjustPool(ctx, 5_000, "set"), Pool)
	_, err = s.StartWipe(ctx, id)
	told("a wipe", err, card, Pool)
	told("a top-up for a card that can't receive", credit(card, 1_000, "h3"), Pool)
}
