package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"maps"
	"math/rand/v2"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// activeCard registers a card and activates it.
func activeCard(t *testing.T, s *Store, id string) Account {
	t.Helper()
	ctx := context.Background()
	if _, err := s.ReserveCard(ctx, id, "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ActivateCard(ctx, id, 1); err != nil {
		t.Fatal(err)
	}
	return CardAccount(id)
}

func available(t *testing.T, s *Store, a Account) int64 {
	t.Helper()
	b, err := s.Balance(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	return b.AvailableMsat()
}

func TestCreditOncePerPayment(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	for i := 0; i < 2; i++ {
		done, err := s.Credit(ctx, card, 5_000_000, "hash-1", "top-up")
		if err != nil || done != (i == 0) {
			t.Fatalf("credit #%d: done=%v err=%v", i, done, err)
		}
	}
	if got := available(t, s, card); got != 5_000_000 {
		t.Fatalf("balance %d", got)
	}
	if got := available(t, s, World); got != -5_000_000 {
		t.Fatalf("world %d", got)
	}
}

// Money for a card that can't receive (wiped since its invoice was made) goes to pool.
func TestCreditForAWipedCardGoesToPool(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	if _, err := s.StartWipe(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Credit(ctx, card, 1000, "hash-2", "top-up"); err != nil {
		t.Fatal(err)
	}
	if available(t, s, card) != 0 || available(t, s, Pool) != 1000 {
		t.Fatalf("card %d pool %d", available(t, s, card), available(t, s, Pool))
	}
}

func TestMove(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	s.Credit(ctx, Pool, 3000, "h", "")
	if err := s.Move(ctx, Pool, card, 4000, ""); !errors.Is(err, ErrInsufficient) {
		t.Fatalf("over the balance: %v", err)
	}
	if err := s.Move(ctx, Pool, card, 2000, ""); err != nil {
		t.Fatal(err)
	}
	if available(t, s, Pool) != 1000 || available(t, s, card) != 2000 {
		t.Fatal("balances after the move")
	}
	if err := s.Move(ctx, Pool, World, 1, ""); err == nil {
		t.Fatal("moved money out to world")
	}
	other := "0123456789abcdef0123456789abcdef"
	s.ReserveCard(ctx, other, "", "") // programming: can't receive yet
	if err := s.Move(ctx, Pool, CardAccount(other), 1, ""); !errors.Is(err, ErrCannotReceive) {
		t.Fatalf("to a card still being added: %v", err)
	}
}

func TestHoldChecks(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	s.Credit(ctx, card, 100_000_000, "h", "") // 100k sat
	req := func(hash string, sat int64) HoldRequest {
		return HoldRequest{Account: card, Kind: KindSpend, AmountMsat: sat * 1000, FeeBudgetMsat: 1000, PaymentHash: hash, Invoice: "lnbc"}
	}
	if _, err := s.OpenHold(ctx, req("a", 20_001)); !errors.Is(err, ErrOverPerTap) {
		t.Fatalf("over per tap: %v", err)
	}
	h, err := s.OpenHold(ctx, req("a", 20_000))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.OpenHold(ctx, req("b", 1)); !errors.Is(err, ErrPaymentInProgress) {
		t.Fatalf("second payment: %v", err)
	}
	s.SettleHold(ctx, h.ID, 0)
	if _, err := s.OpenHold(ctx, req("a", 1)); !errors.Is(err, ErrDuplicatePayment) {
		t.Fatalf("same invoice again: %v", err)
	}
	h2, _ := s.OpenHold(ctx, req("b", 20_000))
	s.SettleHold(ctx, h2.ID, 0)
	if _, err := s.OpenHold(ctx, req("c", 10_001)); !errors.Is(err, ErrOverDaily) {
		t.Fatalf("over the 24-hour limit: %v", err)
	}
	// 24 hours later the limit has room again.
	later := time.Now().Add(25 * time.Hour)
	s.now = func() time.Time { return later }
	if _, err := s.OpenHold(ctx, req("c", 20_000)); err != nil {
		t.Fatalf("a day later: %v", err)
	}
}

func TestHoldNeedsTheFeeBudgetToo(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	s.Credit(ctx, card, 10_000, "h", "")
	r := HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 10_000, FeeBudgetMsat: 1, PaymentHash: "x", Invoice: "lnbc"}
	if _, err := s.OpenHold(ctx, r); !errors.Is(err, ErrInsufficient) {
		t.Fatalf("got %v", err)
	}
	if _, err := s.FreezeCard(ctx, id); err != nil {
		t.Fatal(err)
	}
	r.FeeBudgetMsat = 0
	if _, err := s.OpenHold(ctx, r); !errors.Is(err, ErrConflict) {
		t.Fatalf("a frozen card spent: %v", err)
	}
}

// A hold may take less than its budget, down to its minimum, when only that fits: its budget is then all that is left.
func TestHoldMayTakeItsMinimumBudget(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.Credit(ctx, Pool, 20_000, "p", "")
	r := HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 10_000, FeeBudgetMsat: 9_000, MinFeeBudgetMsat: 6_000, PaymentHash: "a", Invoice: "lnbc"}
	h, err := s.OpenHold(ctx, r)
	if err != nil || h.FeeBudgetMsat != 9_000 {
		t.Fatalf("with room for the full budget: %+v %v", h, err)
	}
	s.ReleaseHold(ctx, h.ID)
	r.AmountMsat, r.PaymentHash = 12_000, "b"
	h, err = s.OpenHold(ctx, r)
	if err != nil || h.FeeBudgetMsat != 8_000 || available(t, s, Pool) != 0 {
		t.Fatalf("room for the minimum: %+v %v, available %d", h, err, available(t, s, Pool))
	}
	if got, _ := s.GetHold(ctx, h.ID); got.FeeBudgetMsat != 8_000 {
		t.Fatalf("kept: %+v", got)
	}
	s.ReleaseHold(ctx, h.ID)
	r.AmountMsat, r.PaymentHash = 14_001, "c"
	if _, err := s.OpenHold(ctx, r); !errors.Is(err, ErrInsufficient) {
		t.Fatalf("no room for the minimum: %v", err)
	}
	r.AmountMsat = 1_000
	for _, min := range []int64{-1, 9_001} {
		r.MinFeeBudgetMsat = min
		if _, err := s.OpenHold(ctx, r); !errors.Is(err, ErrConflict) {
			t.Fatalf("minimum %d: %v", min, err)
		}
	}
}

func TestSettleAndRelease(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	s.Credit(ctx, card, 50_000, "h", "")
	s.Credit(ctx, Pool, 10_000, "p", "")
	h, _ := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 40_000, FeeBudgetMsat: 5_000, PaymentHash: "1", Invoice: "lnbc"})
	if got := available(t, s, card); got != 5_000 {
		t.Fatalf("available while held: %d", got)
	}
	if _, err := s.ReleaseHold(ctx, h.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SettleHold(ctx, h.ID, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("settled a released hold: %v", err)
	}
	if got := available(t, s, card); got != 50_000 {
		t.Fatalf("after release: %d", got)
	}
	// A fee within the budget: the card pays amount + fee.
	h, _ = s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 40_000, FeeBudgetMsat: 5_000, PaymentHash: "2", Invoice: "lnbc"})
	s.SettleHold(ctx, h.ID, 2_000)
	s.SettleHold(ctx, h.ID, 2_000) // repeating is a no-op
	if available(t, s, card) != 8_000 || available(t, s, Fees) != 2_000 || available(t, s, World) != -60_000+40_000 {
		t.Fatalf("card %d fees %d world %d", available(t, s, card), available(t, s, Fees), available(t, s, World))
	}
	// A fee above the budget: the card pays what it has, pool the rest.
	h, _ = s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 7_000, FeeBudgetMsat: 1_000, PaymentHash: "3", Invoice: "lnbc"})
	s.SettleHold(ctx, h.ID, 3_000)
	if available(t, s, card) != 0 || available(t, s, Pool) != 8_000 {
		t.Fatalf("card %d pool %d", available(t, s, card), available(t, s, Pool))
	}
	hist, _ := s.History(ctx, card, 0, 10)
	if len(hist) != 4 || hist[0].Kind != KindSpend || hist[1].Kind != KindFeeAdjust || hist[1].AmountMsat != 2_000 {
		t.Fatalf("history: %+v", hist)
	}
}

// A Send out of all of Pool whose fee comes in above its tight budget is
// still paid: Pool goes below zero by the excess, and the server says so.
func TestAPoolSendAboveItsBudgetIsPaidAndLogged(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	var buf bytes.Buffer
	s.Log = log.New(&buf, "", 0)
	s.Credit(ctx, Pool, 50_000, "p", "")
	h, err := s.OpenHold(ctx, HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 40_000, FeeBudgetMsat: 20_000, MinFeeBudgetMsat: 6_000, PaymentHash: "1", Invoice: "lnbc"})
	if err != nil || h.FeeBudgetMsat != 10_000 {
		t.Fatalf("hold: %+v %v", h, err)
	}
	if _, err := s.SettleHold(ctx, h.ID, 12_500); err != nil {
		t.Fatal(err)
	}
	if got := available(t, s, Pool); got != -2_500 {
		t.Fatalf("pool %d, want -2500", got)
	}
	if available(t, s, Fees) != 12_500 || available(t, s, World) != -50_000+40_000 {
		t.Fatalf("fees %d world %d", available(t, s, Fees), available(t, s, World))
	}
	if !strings.Contains(buf.String(), "Pool is 2500 msat below zero") {
		t.Fatalf("log: %q", buf.String())
	}
	// Within the budget: nothing said.
	s.Credit(ctx, Pool, 52_500, "q", "")
	buf.Reset()
	h, _ = s.OpenHold(ctx, HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 40_000, FeeBudgetMsat: 20_000, MinFeeBudgetMsat: 6_000, PaymentHash: "2", Invoice: "lnbc"})
	s.SettleHold(ctx, h.ID, 6_000)
	if buf.Len() != 0 || available(t, s, Pool) != 4_000 {
		t.Fatalf("pool %d log %q", available(t, s, Pool), buf.String())
	}
}

func TestStartWipeMovesTheBalanceToPool(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	s.Credit(ctx, card, 9_000, "h", "")
	h, _ := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 1_000, PaymentHash: "1", Invoice: "lnbc"})
	if _, err := s.StartWipe(ctx, id); !errors.Is(err, ErrConflict) {
		t.Fatalf("wipe with a payment in progress: %v", err)
	}
	s.ReleaseHold(ctx, h.ID)
	for i := 0; i < 2; i++ {
		if c, err := s.StartWipe(ctx, id); err != nil || c.State != StateWiping {
			t.Fatalf("wipe #%d: %+v %v", i, c, err)
		}
	}
	if available(t, s, card) != 0 || available(t, s, Pool) != 9_000 {
		t.Fatalf("card %d pool %d", available(t, s, card), available(t, s, Pool))
	}
}

func TestFreezeAndLimits(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	activeCard(t, s, id)
	for i := 0; i < 2; i++ {
		if c, err := s.FreezeCard(ctx, id); err != nil || c.State != StateFrozen {
			t.Fatalf("freeze: %+v %v", c, err)
		}
	}
	if c, err := s.UnfreezeCard(ctx, id); err != nil || c.State != StateActive {
		t.Fatalf("unfreeze: %+v %v", c, err)
	}
	if c, err := s.SetLimits(ctx, id, 1000, 2000); err != nil || c.PerTapSat != 1000 || c.DailySat != 2000 {
		t.Fatalf("limits: %+v %v", c, err)
	}
	if c, _ := s.GetCard(ctx, id); c.PerTapSat != 1000 {
		t.Fatalf("limits not kept: %+v", c)
	}
}

func TestK1IsUsedOnce(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.IssueK1(ctx, "k", id, time.Now().Add(time.Minute))
	if got, err := s.ClaimK1(ctx, "k"); err != nil || got != id {
		t.Fatalf("claim: %q %v", got, err)
	}
	if _, err := s.ClaimK1(ctx, "k"); !errors.Is(err, ErrBadK1) {
		t.Fatalf("second claim: %v", err)
	}
	s.IssueK1(ctx, "old", id, time.Now().Add(-time.Second))
	if _, err := s.ClaimK1(ctx, "old"); !errors.Is(err, ErrBadK1) {
		t.Fatalf("expired: %v", err)
	}
}

func TestSeeSignatureOnce(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	exp := time.Now().Add(2 * time.Minute)
	if fresh, _ := s.SeeSignature(ctx, "a", exp); !fresh {
		t.Fatal("first sight")
	}
	if fresh, _ := s.SeeSignature(ctx, "a", exp); fresh {
		t.Fatal("second sight was fresh")
	}
	later := time.Now().Add(3 * time.Minute)
	s.now = func() time.Time { return later }
	if fresh, _ := s.SeeSignature(ctx, "a", later.Add(2*time.Minute)); !fresh {
		t.Fatal("not forgotten after it expired")
	}
}

func TestRequestIDs(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if prev, err := s.BeginRequest(ctx, "r1", "body"); prev != nil || err != nil {
		t.Fatalf("new: %v %v", prev, err)
	}
	if _, err := s.BeginRequest(ctx, "r1", "body"); !errors.Is(err, ErrRequestInProgress) {
		t.Fatalf("in progress: %v", err)
	}
	s.FinishRequest(ctx, "r1", 200, `{"ok":true}`)
	if prev, err := s.BeginRequest(ctx, "r1", "body"); err != nil || prev.Status != 200 || prev.Body != `{"ok":true}` {
		t.Fatalf("answered: %+v %v", prev, err)
	}
	if _, err := s.BeginRequest(ctx, "r1", "other"); !errors.Is(err, ErrRequestMismatch) {
		t.Fatalf("other body: %v", err)
	}
	// cardd stopped while handling r2: at the next start a retry runs again,
	// and r1's answer is kept.
	s.BeginRequest(ctx, "r2", "b")
	if err := s.TidyAtStart(ctx); err != nil {
		t.Fatal(err)
	}
	if prev, err := s.BeginRequest(ctx, "r2", "b"); prev != nil || err != nil {
		t.Fatalf("after a restart: %v %v", prev, err)
	}
	if prev, err := s.BeginRequest(ctx, "r1", "body"); err != nil || prev == nil {
		t.Fatalf("answer lost: %v %v", prev, err)
	}
}

// A move retried after cardd stopped before answering happens once.
func TestMoveOnceIsOncePerRef(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	s.Credit(ctx, Pool, 3000, "h", "")
	for i := 0; i < 2; i++ {
		if err := s.MoveOnce(ctx, "request:r1", Pool, card, 2000, ""); err != nil {
			t.Fatalf("move #%d: %v", i, err)
		}
	}
	if available(t, s, Pool) != 1000 || available(t, s, card) != 2000 {
		t.Fatalf("pool %d card %d", available(t, s, Pool), available(t, s, card))
	}
}

// One hold per send request id, whatever the invoice: a retry after a restart
// may have resolved a Lightning address to a new invoice.
func TestHoldRefIsOncePerRequest(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.Credit(ctx, Pool, 50_000_000, "p", "")
	r := HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 1_000, PaymentHash: "1", Invoice: "lnbc1", Ref: "request:s1"}
	h, err := s.OpenHold(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	s.SettleHold(ctx, h.ID, 0)
	r.PaymentHash, r.Invoice = "2", "lnbc2"
	if _, err := s.OpenHold(ctx, r); !errors.Is(err, ErrDuplicatePayment) {
		t.Fatalf("second hold for the request: %v", err)
	}
	if got, err := s.HoldByRef(ctx, "request:s1"); err != nil || got.ID != h.ID || got.State != HoldSettled {
		t.Fatalf("by ref: %+v %v", got, err)
	}
	if _, err := s.HoldByRef(ctx, "request:none"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown ref: %v", err)
	}
}

// phoenixd counts a payment on its way as gone, so the books leave out what
// open holds reserve.
func TestOwedLeavesOutOpenHolds(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	s.Credit(ctx, card, 50_000, "h", "")
	s.Credit(ctx, Pool, 10_000, "p", "")
	h, _ := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 40_000, FeeBudgetMsat: 5_000, PaymentHash: "1", Invoice: "lnbc"})
	if owed, _ := s.OwedMsat(ctx); owed != 15_000 {
		t.Fatalf("owed with a hold open: %d", owed)
	}
	s.SettleHold(ctx, h.ID, 2_000)
	if owed, _ := s.OwedMsat(ctx); owed != 18_000 {
		t.Fatalf("owed after settling: %d", owed)
	}
}

func TestAdjustPool(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	s.Credit(ctx, card, 50_000, "h", "")
	h, _ := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 1_000, PaymentHash: "1", Invoice: "lnbc"})
	if err := s.AdjustPool(ctx, -2_000, "x"); !errors.Is(err, ErrPaymentInProgress) {
		t.Fatalf("with a payment in progress: %v", err)
	}
	s.ReleaseHold(ctx, h.ID)
	if err := s.AdjustPool(ctx, -2_000, "phoenixd holds 2 sat less"); err != nil {
		t.Fatal(err)
	}
	if available(t, s, Pool) != -2_000 || available(t, s, card) != 50_000 {
		t.Fatalf("pool %d card %d", available(t, s, Pool), available(t, s, card))
	}
	if hist, _ := s.History(ctx, Pool, 0, 1); len(hist) != 1 || hist[0].Kind != KindAdjust {
		t.Fatalf("history: %+v", hist)
	}
}

// Random top-ups, moves, holds, settles, releases and wipes: every
// transaction sums to zero, no card goes negative, every hold resolves once,
// and the person's accounts always add up to what came in less what went out.
func TestLedgerProperties(t *testing.T) {
	for seed := uint64(1); seed <= 8; seed++ {
		t.Run(fmt.Sprint(seed), func(t *testing.T) {
			ctx := context.Background()
			s := open(t)
			r := rand.New(rand.NewPCG(seed, 0))
			ids := []string{"00000000000000000000000000000001", "00000000000000000000000000000002", "00000000000000000000000000000003"}
			for _, c := range ids {
				activeCard(t, s, c)
			}
			accts := []Account{Pool, Hosting, CardAccount(ids[0]), CardAccount(ids[1]), CardAccount(ids[2])}
			var in, out int64 // what came in, what left (amounts + fees)
			resolved := map[int64]HoldState{}
			for step := 0; step < 250; step++ {
				a := accts[r.IntN(len(accts))]
				amt := int64(r.IntN(20_000_000) + 1)
				switch r.IntN(6) {
				case 0:
					if done, err := s.Credit(ctx, a, amt, fmt.Sprint("p", step), ""); err != nil {
						t.Fatal(err)
					} else if done {
						in += amt
					}
				case 1:
					s.Move(ctx, a, accts[r.IntN(len(accts))], amt, "")
				case 2:
					kind := KindSpend
					if _, isCard := a.CardID(); !isCard {
						kind = KindSend
					}
					s.OpenHold(ctx, HoldRequest{Account: a, Kind: kind, AmountMsat: amt, FeeBudgetMsat: amt/100 + 10_000, PaymentHash: fmt.Sprint("h", step), Invoice: "lnbc"})
				case 3, 4:
					holds, _ := s.OpenHolds(ctx)
					if len(holds) == 0 {
						continue
					}
					h := holds[r.IntN(len(holds))]
					if r.IntN(2) == 0 {
						fee := int64(r.IntN(int(h.FeeBudgetMsat * 2)))
						if _, err := s.SettleHold(ctx, h.ID, fee); err != nil {
							t.Fatal(err)
						}
						out += h.AmountMsat + fee
						resolved[h.ID] = HoldSettled
					} else {
						if _, err := s.ReleaseHold(ctx, h.ID); err != nil {
							t.Fatal(err)
						}
						resolved[h.ID] = HoldReleased
					}
				case 5:
					if id, isCard := a.CardID(); isCard && r.IntN(10) == 0 {
						s.StartWipe(ctx, id)
					}
				}
				var total, world, fees int64
				s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(amount_msat), 0) FROM ledger_entry`).Scan(&total)
				if total != 0 {
					t.Fatalf("step %d: entries sum to %d", step, total)
				}
				for _, c := range accts[2:] {
					if b, _ := s.Balance(ctx, c); b.EntriesMsat < 0 {
						t.Fatalf("step %d: %s went negative: %d", step, c, b.EntriesMsat)
					}
				}
				world, fees = available(t, s, World), available(t, s, Fees)
				liab, _ := s.LiabilitiesMsat(ctx)
				if world != -in+out-fees || liab != in-out {
					t.Fatalf("step %d: world %d fees %d liabilities %d, in %d out %d", step, world, fees, liab, in, out)
				}
				var held int64
				holds, _ := s.OpenHolds(ctx)
				for _, h := range holds {
					held += h.AmountMsat + h.FeeBudgetMsat
				}
				if owed, _ := s.OwedMsat(ctx); owed != liab-held {
					t.Fatalf("step %d: owed %d, liabilities %d less held %d", step, owed, liab, held)
				}
			}
			for id, st := range resolved {
				h, _ := s.GetHold(ctx, id)
				if h.State != st {
					t.Fatalf("hold %d is %s, was resolved %s", id, h.State, st)
				}
			}
		})
	}
}

// The 24-hour limit counts a spend from when its hold was opened: one
// authorised 25 hours ago no longer counts, even if it settled an hour ago.
func TestTheDailyLimitCountsFromAuthorisation(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	s.Credit(ctx, card, 100_000_000, "h", "")
	start := time.Now()
	at := func(d time.Duration) { s.now = func() time.Time { return start.Add(d) } }
	h, _ := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 20_000_000, PaymentHash: "1", Invoice: "lnbc"})
	at(24*time.Hour + 30*time.Minute)
	s.SettleHold(ctx, h.ID, 0)
	at(25 * time.Hour)
	if used, _ := s.SpentLast24hMsat(ctx, card); used != 0 {
		t.Fatalf("used %d", used)
	}
	h2, _ := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 20_000_000, PaymentHash: "2", Invoice: "lnbc"})
	s.SettleHold(ctx, h2.ID, 0)
	h3, _ := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 20_000_000, PaymentHash: "3", Invoice: "lnbc"})
	s.SettleHold(ctx, h3.ID, 0)
	if _, err := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 10_000_001, PaymentHash: "4", Invoice: "lnbc"}); !errors.Is(err, ErrOverDaily) {
		t.Fatalf("over the 24-hour limit: %v", err)
	}
}

// A payment settled after it was made (found after a restart) is dated when
// phoenixd paid it, within the hold's life; the hold's resolved_at is now.
func TestASettledLineIsDatedWhenItWasPaid(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	s.Credit(ctx, card, 100_000_000, "h", "")
	start := time.Unix(time.Now().Unix(), 0)
	at := func(d time.Duration) { s.now = func() time.Time { return start.Add(d) } }
	for i, c := range []struct {
		name   string
		paidAt time.Time
		want   time.Time
	}{
		{"paid while cardd was down", start.Add(10 * time.Second), start.Add(10 * time.Second)},
		{"no time from phoenixd", time.Time{}, start.Add(time.Minute)},
		{"a time after now", start.Add(2 * time.Minute), start.Add(time.Minute)},
		{"a time before the hold", start.Add(-time.Hour), start},
	} {
		at(0)
		h, err := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 40_000, FeeBudgetMsat: 5_000, PaymentHash: fmt.Sprint(i), Invoice: "lnbc"})
		if err != nil {
			t.Fatal(err)
		}
		at(time.Minute)
		if _, err := s.SettleHoldWithProofAt(ctx, h.ID, 1_000, "", c.paidAt); err != nil {
			t.Fatal(err)
		}
		hist, _ := s.History(ctx, card, 0, 1)
		if len(hist) != 1 || !hist[0].CreatedAt.Equal(c.want) {
			t.Errorf("%s: dated %v, want %v", c.name, hist[0].CreatedAt, c.want)
		}
		var resolved int64
		s.db.QueryRowContext(ctx, `SELECT resolved_at FROM holds WHERE id = ?`, h.ID).Scan(&resolved)
		if resolved != start.Add(time.Minute).Unix() {
			t.Errorf("%s: resolved at %d, want now", c.name, resolved)
		}
	}
}

// History carries each transaction's routing fee, from its fees leg.
func TestHistoryShowsTheFee(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	s.Credit(ctx, card, 50_000, "h", "")
	h, _ := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 40_000, FeeBudgetMsat: 5_000, PaymentHash: "1", Invoice: "lnbc"})
	s.SettleHold(ctx, h.ID, 2_123)
	hist, _ := s.History(ctx, card, 0, 10)
	if len(hist) != 2 || hist[0].AmountMsat != -42_123 || hist[0].FeeMsat != 2_123 || hist[1].FeeMsat != 0 {
		t.Fatalf("history: %+v", hist)
	}
}

// A k1 can be looked at without using it up; ClaimK1 still uses it once.
func TestLookUpAK1WithoutUsingIt(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.IssueK1(ctx, "k", id, time.Now().Add(time.Minute))
	for i := 0; i < 2; i++ {
		if got, err := s.LookupK1(ctx, "k"); err != nil || got != id {
			t.Fatalf("look #%d: %q %v", i, got, err)
		}
	}
	s.ClaimK1(ctx, "k")
	if _, err := s.LookupK1(ctx, "k"); !errors.Is(err, ErrBadK1) {
		t.Fatalf("after its claim: %v", err)
	}
	if _, err := s.LookupK1(ctx, "unknown"); !errors.Is(err, ErrBadK1) {
		t.Fatalf("unknown: %v", err)
	}
}

// A request the phone gave up on is forgotten, so its retry runs again; an
// answered one is never forgotten this way.
func TestForgetARequestThePhoneGaveUpOn(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.BeginRequest(ctx, "r1", "b")
	if err := s.ForgetRequest(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	if prev, err := s.BeginRequest(ctx, "r1", "b"); prev != nil || err != nil {
		t.Fatalf("after forgetting: %v %v", prev, err)
	}
	s.FinishRequest(ctx, "r1", 200, "{}")
	s.ForgetRequest(ctx, "r1")
	if prev, _ := s.BeginRequest(ctx, "r1", "b"); prev == nil {
		t.Fatal("an answered request was forgotten")
	}
}

// Renewals are counted once each: the settled holds of one kind on one
// account, after the last one counted, oldest first.
func TestSettledHoldsAfter(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.Credit(ctx, Hosting, 50_000_000, "h", "")
	s.Credit(ctx, Pool, 50_000_000, "p", "")
	hold := func(acct Account, kind Kind, hash string) Hold {
		t.Helper()
		h, err := s.OpenHold(ctx, HoldRequest{Account: acct, Kind: kind, AmountMsat: 1_000_000, FeeBudgetMsat: 20_000, PaymentHash: hash, Invoice: "lnbc-" + hash})
		if err != nil {
			t.Fatal(err)
		}
		return h
	}
	a := hold(Hosting, KindRenew, "a")
	s.SettleHold(ctx, a.ID, 3000)
	b := hold(Hosting, KindRenew, "b")
	s.ReleaseHold(ctx, b.ID)
	sent := hold(Pool, KindSend, "s")
	s.SettleHold(ctx, sent.ID, 0)
	c := hold(Hosting, KindRenew, "c")
	s.SettleHold(ctx, c.ID, 0)
	hold(Hosting, KindRenew, "d") // still open
	ids := func(after int64) []int64 {
		t.Helper()
		hs, err := s.SettledHolds(ctx, Hosting, KindRenew, after)
		if err != nil {
			t.Fatal(err)
		}
		var out []int64
		for _, h := range hs {
			if h.Kind != KindRenew || h.State != HoldSettled || h.Invoice != "lnbc-"+h.PaymentHash {
				t.Fatalf("hold %+v", h)
			}
			out = append(out, h.ID)
		}
		return out
	}
	if got := ids(0); fmt.Sprint(got) != fmt.Sprint([]int64{a.ID, c.ID}) {
		t.Fatalf("after 0: %v", got)
	}
	if got := ids(a.ID); fmt.Sprint(got) != fmt.Sprint([]int64{c.ID}) {
		t.Fatalf("after a: %v", got)
	}
	if got := ids(c.ID); len(got) != 0 {
		t.Fatalf("after c: %v", got)
	}
	hist, _ := s.History(ctx, Hosting, 0, 10)
	if len(hist) < 2 || hist[0].Kind != KindRenew || hist[0].AmountMsat != -1_000_000 || hist[1].AmountMsat != -1_003_000 || hist[1].FeeMsat != 3000 {
		t.Fatalf("history %+v", hist)
	}
}

// txLegs is a transaction's legs by account, found by its ref.
func txLegs(t *testing.T, s *Store, ref string) map[Account]int64 {
	t.Helper()
	rows, err := s.db.Query(`SELECT e.account, e.amount_msat FROM ledger_entry e JOIN ledger_tx t ON t.id = e.tx_id WHERE t.ref = ?`, ref)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	legs := map[Account]int64{}
	for rows.Next() {
		var a Account
		var msat int64
		if err := rows.Scan(&a, &msat); err != nil {
			t.Fatal(err)
		}
		legs[a] += msat
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return legs
}

// A top-up that bought room books the channel's fee to fees: three legs summing to zero,
// the account credited what arrived, the history row's fee the fee, and the
// person's money the same as without the fee.
func TestATopUpBooksTheChannelFeeToFees(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if done, err := s.CreditMoving(ctx, Pool, 7_673_000, 22_327_000, "h1", "received 7673 sat after 22327000 msat of channel fees", FeeCreditMove{}); err != nil || !done {
		t.Fatalf("credit: %v %v", done, err)
	}
	if got, want := txLegs(t, s, "h1"), map[Account]int64{World: -30_000_000, Pool: 7_673_000, Fees: 22_327_000}; !maps.Equal(got, want) {
		t.Fatalf("legs %v, want %v", got, want)
	}
	if got := available(t, s, Pool); got != 7_673_000 {
		t.Fatalf("pool %d", got)
	}
	if owed, err := s.OwedMsat(ctx); err != nil || owed != 7_673_000 {
		t.Fatalf("owed %d %v", owed, err)
	}
	h, err := s.History(ctx, Pool, 0, 10)
	if err != nil || len(h) != 1 || h[0].AmountMsat != 7_673_000 || h[0].FeeMsat != 22_327_000 {
		t.Fatalf("history %+v %v", h, err)
	}

	// Credited 0 with a fee: this payment and earlier fee credit paid for the
	// room. The account keeps its leg of nothing, so the row is in its history.
	if done, err := s.CreditMoving(ctx, Pool, 0, 2_500_000, "h2", "received 0 sat after 2500000 msat of channel fees", FeeCreditMove{}); err != nil || !done {
		t.Fatalf("credit 0: %v %v", done, err)
	}
	if got, want := txLegs(t, s, "h2"), map[Account]int64{World: -2_500_000, Pool: 0, Fees: 2_500_000}; !maps.Equal(got, want) {
		t.Fatalf("credit 0 legs %v, want %v", got, want)
	}
	if h, err := s.History(ctx, Pool, 0, 10); err != nil || len(h) != 2 || h[0].AmountMsat != 0 || h[0].FeeMsat != 2_500_000 {
		t.Fatalf("credit 0 history %+v %v", h, err)
	}

	// For a card that can't receive (still being programmed), the money goes
	// to pool as before, and the fee is booked the same.
	if _, err := s.ReserveCard(ctx, id, "", ""); err != nil {
		t.Fatal(err)
	}
	if done, err := s.CreditMoving(ctx, CardAccount(id), 1_000_000, 21_411_000, "h3", "received 1000 sat after 21411000 msat of channel fees", FeeCreditMove{}); err != nil || !done {
		t.Fatalf("credit for a card: %v %v", done, err)
	}
	if got, want := txLegs(t, s, "h3"), map[Account]int64{World: -22_411_000, Pool: 1_000_000, Fees: 21_411_000}; !maps.Equal(got, want) {
		t.Fatalf("legs for a card %v, want %v", got, want)
	}

	// No fee: the two legs of before.
	if _, err := s.Credit(ctx, Pool, 5_000_000, "h4", "received 5000 sat"); err != nil {
		t.Fatal(err)
	}
	if got, want := txLegs(t, s, "h4"), map[Account]int64{World: -5_000_000, Pool: 5_000_000}; !maps.Equal(got, want) {
		t.Fatalf("legs without a fee %v, want %v", got, want)
	}

	if _, err := s.CreditMoving(ctx, Pool, 1_000, -1, "h5", "", FeeCreditMove{}); err == nil {
		t.Fatal("a negative fee was taken")
	}
}

// Migration 7
// fills in a top-up's channel fee from its note, on a database cardd wrote
// before it: a fees leg and world's leg grown by it (inserted where a top-up
// credited 0 has none); every other transaction as it was.
func TestMigrationSevenBooksOldTopUpsChannelFees(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migrations[:6] {
		if _, err := db.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`PRAGMA user_version = 6;
		INSERT INTO ledger_tx (id, kind, ref, note, created_at) VALUES
			(1, 'topup', 'h1', 'received 7673 sat after 22327000 msat of channel fees', 1),
			(2, 'topup', 'h2', 'received 500 sat after 21411000 msat of channel fees (for card:` + id + `, which can''t receive)', 2),
			(3, 'topup', 'h3', 'received 0 sat after 2500000 msat of channel fees', 3),
			(4, 'topup', 'h4', 'received 1000 sat', 4),
			(5, 'topup', 'h5', 'received 900 sat after 100000 msat of channel fees', 5),
			(6, 'topup', 'h6', '2500 sat went to phoenixd''s fee credit (not spendable; it pays toward the first channel)', 6),
			(7, 'sale', 'h7', 'received 700 sat after 300000 msat of channel fees', 7),
			(8, 'spend', 'h8', 'paid 3f9a', 8),
			(9, 'topup', 'h9', 'received 10 sat after nothing msat of channel fees', 9);
		INSERT INTO ledger_entry (tx_id, account, amount_msat) VALUES
			(1, 'world', -7673000), (1, 'pool', 7673000),
			(2, 'world', -500000), (2, 'pool', 500000),
			(3, 'pool', 0),
			(4, 'world', -1000000), (4, 'pool', 1000000),
			(5, 'world', -1000000), (5, 'pool', 900000), (5, 'fees', 100000),
			(6, 'pool', 0),
			(7, 'world', -700000), (7, 'shop', 700000),
			(8, 'pool', -101000), (8, 'world', 100000), (8, 'fees', 1000),
			(9, 'world', -10000), (9, 'pool', 10000)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, _ := s.UserVersion(ctx); v != SchemaVersion() {
		t.Fatalf("user_version %d, want %d", v, SchemaVersion())
	}
	want := map[string]map[Account]int64{
		"h1": {World: -30_000_000, Pool: 7_673_000, Fees: 22_327_000},
		"h2": {World: -21_911_000, Pool: 500_000, Fees: 21_411_000},
		"h3": {World: -2_500_000, Pool: 0, Fees: 2_500_000},
		"h4": {World: -1_000_000, Pool: 1_000_000},
		"h5": {World: -1_000_000, Pool: 900_000, Fees: 100_000},
		"h6": {Pool: 0},
		"h7": {World: -700_000, Shop: 700_000},
		"h8": {Pool: -101_000, World: 100_000, Fees: 1_000},
		"h9": {World: -10_000, Pool: 10_000},
	}
	for ref, legs := range want {
		if got := txLegs(t, s, ref); !maps.Equal(got, legs) {
			t.Errorf("%s: legs %v, want %v", ref, got, legs)
		}
	}
	var unbalanced int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM (SELECT tx_id FROM ledger_entry GROUP BY tx_id HAVING SUM(amount_msat) != 0)`).Scan(&unbalanced); err != nil || unbalanced != 0 {
		t.Fatalf("%d transactions don't sum to zero (%v)", unbalanced, err)
	}
	if owed, err := s.OwedMsat(ctx); err != nil || owed != 7_673_000+500_000+1_000_000+900_000+700_000-101_000+10_000 {
		t.Fatalf("owed %d %v: the person's money moved", owed, err)
	}
	var temp int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM sqlite_temp_master WHERE name = 'migration7'`).Scan(&temp); err != nil || temp != 0 {
		t.Fatalf("the migration's temporary table was left (%d, %v)", temp, err)
	}
}

// Migration 8 links
// each settled hold to the ledger transaction it was booked as, by the note
// SettleHold writes ("paid <hash>") and the kind; nothing else moves.
func TestMigrationEightLinksSettledHolds(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migrations[:7] {
		if _, err := db.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`PRAGMA user_version = 7;
		INSERT INTO ledger_tx (id, kind, ref, note, created_at) VALUES
			(1, 'send', NULL, 'paid aa', 1),
			(2, 'spend', NULL, 'paid bb', 2),
			(3, 'renew', NULL, 'paid cc', 3),
			(4, 'spend', NULL, 'paid dd', 4),
			(5, 'fee-adjust', NULL, 'routing fee 9000 msat was above the 5000 msat budget', 5);
		INSERT INTO ledger_entry (tx_id, account, amount_msat) VALUES
			(1, 'pool', -101000), (1, 'world', 100000), (1, 'fees', 1000),
			(2, 'pool', -50000), (2, 'world', 50000),
			(3, 'hosting', -70000), (3, 'world', 70000),
			(4, 'pool', -30000), (4, 'world', 30000),
			(5, 'pool', -4000), (5, 'hosting', 4000);
		INSERT INTO holds (id, account, kind, amount_msat, fee_budget_msat, payment_hash, invoice, state, fee_msat, created_at, resolved_at, ref) VALUES
			(1, 'pool', 'send', 100000, 5000, 'aa', 'lnbc1aa', 'settled', 1000, 1, 1, 'request:x'),
			(2, 'pool', 'spend', 50000, 5000, 'bb', 'lnbc1bb', 'settled', 0, 2, 2, NULL),
			(3, 'hosting', 'renew', 70000, 5000, 'cc', 'lnbc1cc', 'settled', 0, 3, 3, NULL),
			(4, 'pool', 'send', 30000, 5000, 'dd', 'lnbc1dd', 'settled', 0, 4, 4, NULL),
			(5, 'pool', 'send', 20000, 5000, 'ee', 'lnbc1ee', 'released', NULL, 5, 5, NULL),
			(6, 'pool', 'send', 20000, 5000, 'ff', 'lnbc1ff', 'open', NULL, 6, NULL, NULL)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, _ := s.UserVersion(ctx); v != SchemaVersion() {
		t.Fatalf("user_version %d, want %d", v, SchemaVersion())
	}
	links := map[int64]int64{}
	rows, err := s.db.QueryContext(ctx, `SELECT id, COALESCE(tx_id, 0) FROM holds ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id, tx int64
		rows.Scan(&id, &tx)
		links[id] = tx
	}
	rows.Close()
	// 4 is a send whose transaction says spend: not the same kind, no link.
	want := map[int64]int64{1: 1, 2: 2, 3: 3, 4: 0, 5: 0, 6: 0}
	for id, tx := range want {
		if links[id] != tx {
			t.Fatalf("hold %d linked to %d, want %d (all: %v)", id, links[id], tx, links)
		}
	}
	var unasked, empty int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM holds WHERE preimage IS NULL`).Scan(&unasked)
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM holds WHERE destination = '' AND description = '' AND comment = ''`).Scan(&empty)
	if unasked != 6 || empty != 6 {
		t.Fatalf("new columns: %d unasked, %d empty, want 6 and 6", unasked, empty)
	}
	var comments int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM ledger_tx WHERE comment = ''`).Scan(&comments)
	if comments != 5 {
		t.Fatalf("ledger_tx comments: %d empty, want 5", comments)
	}
	for acct, want := range map[Account]int64{Pool: -101000 - 50000 - 30000 - 4000, Hosting: -70000 + 4000} {
		if b, _ := s.Balance(ctx, acct); b.EntriesMsat != want {
			t.Fatalf("%s: %d, want %d", acct, b.EntriesMsat, want)
		}
	}
}

// A hold keeps what the payment was; settling it books the line with the
// person's note, links the hold to it and keeps the proof. A
// settle without a preimage leaves it unasked, for the fill-in pass.
func TestSettlingKeepsTheProofAndTheNote(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if _, err := s.Credit(ctx, Pool, 1_000_000, "p", ""); err != nil {
		t.Fatal(err)
	}
	about := HoldAbout{Destination: "alice@example.com", Description: "Coffee", Comment: "with Sam"}
	h, err := s.OpenHold(ctx, HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 100_000, FeeBudgetMsat: 5_000, PaymentHash: "h1", Invoice: "lnbc1h1", About: about})
	if err != nil {
		t.Fatal(err)
	}
	if h.About != about || h.PreimageAsked {
		t.Fatalf("opened: %+v", h)
	}
	pre := strings.Repeat("ab", 32)
	h, err = s.SettleHoldWithProof(ctx, h.ID, 1_000, pre)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetHold(ctx, h.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.About != about || got.Preimage != pre || !got.PreimageAsked || got.TxID == 0 {
		t.Fatalf("settled: %+v", got)
	}
	var note, comment string
	s.db.QueryRowContext(ctx, `SELECT note, comment FROM ledger_tx WHERE id = ?`, got.TxID).Scan(&note, &comment)
	if note != "paid h1" || comment != "with Sam" {
		t.Fatalf("line: %q %q", note, comment)
	}

	h2, err := s.OpenHold(ctx, HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 100_000, FeeBudgetMsat: 5_000, PaymentHash: "h2", Invoice: "lnbc1h2"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SettleHoldWithProof(ctx, h2.ID, 0, ""); err != nil {
		t.Fatal(err)
	}
	got2, _ := s.GetHold(ctx, h2.ID)
	if got2.PreimageAsked || got2.TxID == 0 {
		t.Fatalf("settled without a preimage: %+v", got2)
	}
	// Settling again is a no-op: the line isn't booked twice.
	if _, err := s.SettleHoldWithProof(ctx, h.ID, 1_000, pre); err != nil {
		t.Fatal(err)
	}
	var lines int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM ledger_tx WHERE kind = 'send'`).Scan(&lines)
	if lines != 2 {
		t.Fatalf("%d send lines, want 2", lines)
	}
}

// One line as an account sees it, with what the payment was:
// a send's from its hold, a top-up's hash from its ref, a sale's from its
// row; another account's line is not found. A note set from one side of a
// move shows on the other.
func TestALineAndItsNote(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if _, err := s.CreditMoving(ctx, Pool, 2_000_000, 0, "hash-topup", "received 2000 sat", FeeCreditMove{}); err != nil {
		t.Fatal(err)
	}
	h, err := s.OpenHold(ctx, HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 100_000, FeeBudgetMsat: 5_000, PaymentHash: "hash-send", Invoice: "lnbc1send",
		About: HoldAbout{Destination: "alice@example.com", Description: "Coffee", Comment: "with Sam"}})
	if err != nil {
		t.Fatal(err)
	}
	pre := strings.Repeat("ef", 32)
	if h, err = s.SettleHoldWithProof(ctx, h.ID, 1_000, pre); err != nil {
		t.Fatal(err)
	}
	if err := s.MoveOnce(ctx, "request:m", Pool, Hosting, 50_000, "moved by the phone"); err != nil {
		t.Fatal(err)
	}
	hist, err := s.History(ctx, Pool, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	// newest first: the move, the send, the top-up
	move, send, topup := hist[0], hist[1], hist[2]
	if send.Comment != "with Sam" {
		t.Fatalf("history's note: %+v", send)
	}

	l, err := s.Line(ctx, Pool, send.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := LinePayment{Hash: "hash-send", Invoice: "lnbc1send", Description: "Coffee", Destination: "alice@example.com", Preimage: pre, PreimageAsked: true}
	if l.Payment == nil || *l.Payment != want || l.Note != "paid hash-send" || l.FeeMsat != 1_000 {
		t.Fatalf("send's line: %+v %+v", l, l.Payment)
	}
	if l, err = s.Line(ctx, Pool, topup.ID); err != nil || l.Payment == nil || l.Payment.Hash != "hash-topup" || l.Payment.Invoice != "" {
		t.Fatalf("top-up's line: %+v %v", l, err)
	}
	if l, err = s.Line(ctx, Pool, move.ID); err != nil || l.Payment != nil || l.Other != Hosting {
		t.Fatalf("move's line: %+v %v", l, err)
	}
	if _, err := s.Line(ctx, Hosting, send.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another account's line: %v", err)
	}
	if _, err := s.Line(ctx, Pool, 999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an unknown line: %v", err)
	}

	if l, err = s.SetComment(ctx, Pool, move.ID, "rent"); err != nil || l.Comment != "rent" {
		t.Fatalf("set: %+v %v", l, err)
	}
	if l, err = s.Line(ctx, Hosting, move.ID); err != nil || l.Comment != "rent" || l.Other != Pool {
		t.Fatalf("the move from hosting's side: %+v %v", l, err)
	}
	if l, err = s.SetComment(ctx, Pool, move.ID, ""); err != nil || l.Comment != "" {
		t.Fatalf("removed: %+v %v", l, err)
	}
	if _, err := s.SetComment(ctx, Shop, move.ID, "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("set on another account's line: %v", err)
	}
}

// Migration 10: an offer's hold, phoenixd's payment id, when cardd gave up waiting, and why
// a payment wasn't sent. Old holds keep their facts.
func TestMigrationTenKeepsOldHolds(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migrations[:9] {
		if _, err := db.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`PRAGMA user_version = 9;
		INSERT INTO holds (id, account, kind, amount_msat, fee_budget_msat, payment_hash, invoice, state, created_at)
		VALUES (1, 'pool', 'send', 100000, 5000, 'aa', 'lnbc1aa', 'open', 1)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, _ := s.UserVersion(ctx); v != SchemaVersion() {
		t.Fatalf("user_version %d, want %d", v, SchemaVersion())
	}
	h, err := s.GetHold(ctx, 1)
	if err != nil || h.PaymentHash != "aa" || h.Offer != "" || h.PaymentID != "" || !h.GaveUpAt.IsZero() || h.Reason != "" {
		t.Fatalf("old hold: %+v %v", h, err)
	}
}

func TestAnOffersHoldHasNoHashUntilItIsKnown(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.Credit(ctx, Pool, 10_000_000, "p", "")
	s.Credit(ctx, Hosting, 10_000_000, "h", "")
	h, err := s.OpenHold(ctx, HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 1_000_000, FeeBudgetMsat: 10_000, Offer: "lno1abc", Ref: "request:a"})
	if err != nil || h.PaymentHash != "" || h.Offer != "lno1abc" {
		t.Fatalf("offer hold: %+v %v", h, err)
	}
	// One hold with no hash on the whole server: hosting's offer waits.
	if _, err := s.OpenHold(ctx, HoldRequest{Account: Hosting, Kind: KindRenew, AmountMsat: 1_000, FeeBudgetMsat: 5_000, Offer: "lno1def"}); !errors.Is(err, ErrPaymentInProgress) {
		t.Fatalf("a second unhashed hold: %v", err)
	}
	// An invoice from hosting still goes: it has a hash.
	inv, err := s.OpenHold(ctx, HoldRequest{Account: Hosting, Kind: KindRenew, AmountMsat: 1_000, FeeBudgetMsat: 5_000, PaymentHash: "bb", Invoice: "lnbc1bb"})
	if err != nil {
		t.Fatalf("an invoice beside it: %v", err)
	}
	// Neither, or both: refused.
	if _, err := s.OpenHold(ctx, HoldRequest{Account: Hosting, Kind: KindRenew, AmountMsat: 1_000, FeeBudgetMsat: 5_000}); !errors.Is(err, ErrConflict) {
		t.Fatalf("no hash, no offer: %v", err)
	}
	if _, err := s.OpenHold(ctx, HoldRequest{Account: Hosting, Kind: KindRenew, AmountMsat: 1_000, FeeBudgetMsat: 5_000, PaymentHash: "cc", Offer: "lno1x"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("hash and offer: %v", err)
	}
	if known, _ := s.HoldPaymentKnown(ctx, "id-1", "dd"); known {
		t.Fatal("known before it was set")
	}
	got, err := s.SetHoldPayment(ctx, h.ID, "dd", "id-1")
	if err != nil || got.PaymentHash != "dd" || got.PaymentID != "id-1" {
		t.Fatalf("set: %+v %v", got, err)
	}
	if known, _ := s.HoldPaymentKnown(ctx, "id-1", ""); !known {
		t.Fatal("not known by its id")
	}
	if known, _ := s.HoldPaymentKnown(ctx, "", "dd"); !known {
		t.Fatal("not known by its hash")
	}
	if known, _ := s.HoldPaymentKnown(ctx, "", ""); known {
		t.Fatal("empty id and hash match nothing")
	}
	// The same again is fine; another hash is a conflict.
	if _, err := s.SetHoldPayment(ctx, h.ID, "dd", "id-1"); err != nil {
		t.Fatalf("again: %v", err)
	}
	if _, err := s.SetHoldPayment(ctx, h.ID, "ee", "id-2"); !errors.Is(err, ErrConflict) {
		t.Fatalf("another hash: %v", err)
	}
	// Pool's offer has its hash now, so it no longer counts as unhashed:
	// once hosting's invoice is done, hosting's offer may open.
	s.ReleaseHold(ctx, inv.ID)
	if _, err := s.OpenHold(ctx, HoldRequest{Account: Hosting, Kind: KindRenew, AmountMsat: 1_000, FeeBudgetMsat: 5_000, Offer: "lno1def"}); err != nil {
		t.Fatalf("a second offer once the first has its hash: %v", err)
	}
}

// Two offers racing for the one unhashed slot: exactly one opens.
func TestTwoOffersRaceForTheUnhashedSlot(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.Credit(ctx, Pool, 10_000_000, "p", "")
	s.Credit(ctx, Hosting, 10_000_000, "h", "")
	errs := make(chan error, 2)
	for _, a := range []Account{Pool, Hosting} {
		go func() {
			_, err := s.OpenHold(ctx, HoldRequest{Account: a, Kind: KindSend, AmountMsat: 1_000_000, FeeBudgetMsat: 10_000, Offer: "lno1" + string(a)})
			errs <- err
		}()
	}
	e1, e2 := <-errs, <-errs
	if (e1 == nil) == (e2 == nil) || !(errors.Is(e1, ErrPaymentInProgress) || errors.Is(e2, ErrPaymentInProgress)) {
		t.Fatalf("both or neither opened: %v, %v", e1, e2)
	}
}

func TestGaveUpAndReasonAreKept(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.Credit(ctx, Pool, 10_000_000, "p", "")
	h, _ := s.OpenHold(ctx, HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 1_000_000, FeeBudgetMsat: 10_000, Offer: "lno1abc"})
	at := time.Unix(1_800_000_000, 0)
	if err := s.SetHoldGaveUp(ctx, h.ID, at); err != nil {
		t.Fatal(err)
	}
	r, err := s.ReleaseHoldBecause(ctx, h.ID, "The receiving wallet refused the payment.")
	if err != nil || r.State != HoldReleased || r.Reason != "The receiving wallet refused the payment." || !r.GaveUpAt.Equal(at) {
		t.Fatalf("released: %+v %v", r, err)
	}
	if got, _ := s.GetHold(ctx, h.ID); got.Reason != r.Reason || !got.GaveUpAt.Equal(at) {
		t.Fatalf("read back: %+v", got)
	}
}

// A line's hold is read in a set order: the oldest, should a line ever have
// two (one hold per line in practice).
func TestALinesHoldIsTheOldest(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.Credit(ctx, Pool, 10_000_000, "topup", "")
	var holds []Hold
	for _, hash := range []string{"hash-first", "hash-second"} {
		h, err := s.OpenHold(ctx, HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 1_000, PaymentHash: hash, Invoice: "lnbc1" + hash})
		if err != nil {
			t.Fatal(err)
		}
		if h, err = s.SettleHold(ctx, h.ID, 0); err != nil {
			t.Fatal(err)
		}
		holds = append(holds, h)
	}
	// The second hold given the first's line, newer id first in the table's order.
	if _, err := s.db.ExecContext(ctx, `UPDATE holds SET tx_id = (SELECT tx_id FROM holds WHERE id = ?) WHERE id = ?`, holds[0].ID, holds[1].ID); err != nil {
		t.Fatal(err)
	}
	var tx int64
	if err := s.db.QueryRowContext(ctx, `SELECT tx_id FROM holds WHERE id = ?`, holds[0].ID).Scan(&tx); err != nil {
		t.Fatal(err)
	}
	for range 5 {
		l, err := s.Line(ctx, Pool, tx)
		if err != nil || l.Payment == nil || l.Payment.Hash != "hash-first" {
			t.Fatalf("line %d: %+v %v", tx, l.Payment, err)
		}
	}
}
