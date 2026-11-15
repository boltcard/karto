package api

import (
	"testing"
	"time"
)

// The one-new-sale-a-second gate: a turn is taken when it is allowed, and a
// failed attempt gives back its own turn only, never one a later attempt
// has taken since.
func TestTheSaleGateGivesBackOnlyAnAttemptsOwnTurn(t *testing.T) {
	var g saleGate
	t0 := time.Unix(1_790_000_000, 0)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	const gap = time.Second
	ok, before := g.allow("till", gap, at(0))
	if !ok || !before.IsZero() {
		t.Fatalf("the first turn: %v %v", ok, before)
	}
	if ok, _ := g.allow("till", gap, at(999)); ok {
		t.Fatal("a second turn inside the gap")
	}
	if ok, _ := g.allow("other", gap, at(1)); !ok {
		t.Fatal("another phone was held back")
	}
	// The first attempt is slow, and a later one takes a turn meanwhile; then the first fails.
	if ok, _ := g.allow("till", gap, at(1500)); !ok {
		t.Fatal("a turn after the gap")
	}
	g.giveBack("till", at(0), before)
	if ok, _ := g.allow("till", gap, at(1600)); ok {
		t.Fatal("the slow attempt's failure gave away the later attempt's turn")
	}
	// An attempt that fails at once gives its own turn back: the retry isn't too fast.
	ok, before = g.allow("till", gap, at(3000))
	if !ok {
		t.Fatal("a turn at 3 s")
	}
	g.giveBack("till", at(3000), before)
	if ok, _ := g.allow("till", gap, at(3001)); !ok {
		t.Fatal("the retry of a failed attempt was too fast")
	}
	// No gap, no limit (tests of other things); cardd sets a second.
	if ok, _ := g.allow("till", 0, at(3001)); !ok {
		t.Fatal("a gap of nothing held a sale back")
	}
}
