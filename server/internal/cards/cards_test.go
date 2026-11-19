package cards

import (
	"context"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/boltcard/karto/server/internal/cardkeys"
	"github.com/boltcard/karto/server/internal/rates"
	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/sun"
)

var (
	issuer, _ = hex.DecodeString("00000000000000000000000000000001")
	uid, _    = hex.DecodeString("04a39493cc8680")
)

const cardID = "e07ce1279d980ecb892a81924b67bf18" // from testvectors: ID for issuer 00..01, uid 04a39493cc8680

func newService(t *testing.T) (*Service, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "cardd.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	svc, err := New(st, issuer, "vm-1.lnvps.cloud")
	if err != nil {
		t.Fatal(err)
	}
	return svc, st
}

// tap returns the upper-case p and c a card programmed at version would write.
func tap(t *testing.T, version, counter uint32) (string, string) {
	t.Helper()
	k, err := cardkeys.Derive(issuer, uid, version)
	if err != nil {
		t.Fatal(err)
	}
	p, c, err := sun.Build(k.K1, k.K2, uid, counter, [5]byte{9, 9, 9, 9, 9})
	if err != nil {
		t.Fatal(err)
	}
	return strings.ToUpper(hex.EncodeToString(p)), strings.ToUpper(hex.EncodeToString(c))
}

func TestProgramThenCheck(t *testing.T) {
	ctx := context.Background()
	svc, _ := newService(t)
	if svc.LNURLW() != "lnurlw://vm-1.lnvps.cloud/ln" {
		t.Fatalf("LNURLW = %s", svc.LNURLW())
	}
	card, err := svc.Reserve(ctx, cardID, "")
	if err != nil || card.Version != 0 {
		t.Fatalf("reserve: %+v %v", card, err)
	}
	p, c := tap(t, 0, 0)
	card, err = svc.Confirm(ctx, cardID, p, c)
	if err != nil || card.State != store.StateActive || card.LastCounter != 0 {
		t.Fatalf("confirm: %+v %v", card, err)
	}
	p, c = tap(t, 0, 1)
	got, err := svc.Check(ctx, p, c, false)
	if err != nil || got.Card.ID != cardID || got.Counter != 1 {
		t.Fatalf("check: %+v %v", got, err)
	}
	if _, err := svc.Check(ctx, p, c, false); !errors.Is(err, store.ErrReplayed) {
		t.Fatalf("replayed tap: got %v", err)
	}
}

func TestConfirmRejectsWrongVersionKeys(t *testing.T) {
	ctx := context.Background()
	svc, _ := newService(t)
	svc.Reserve(ctx, cardID, "")
	p, c := tap(t, 1, 0) // phone wrote version-1 keys, cardd reserved version 0
	if _, err := svc.Confirm(ctx, cardID, p, c); !errors.Is(err, sun.ErrBadMAC) {
		t.Fatalf("got %v, want ErrBadMAC", err)
	}
}

func TestConfirmRejectsOtherCard(t *testing.T) {
	ctx := context.Background()
	svc, _ := newService(t)
	svc.Reserve(ctx, cardID, "")
	other := "0123456789abcdef0123456789abcdef"
	svc.Reserve(ctx, other, "")
	p, c := tap(t, 0, 0)
	if _, err := svc.Confirm(ctx, other, p, c); !errors.Is(err, ErrIDMismatch) {
		t.Fatalf("got %v, want ErrIDMismatch", err)
	}
}

func TestErrors(t *testing.T) {
	ctx := context.Background()
	svc, st := newService(t)
	p, c := tap(t, 0, 0)
	if _, err := svc.Check(ctx, p, c, false); !errors.Is(err, ErrUnknownCard) {
		t.Fatalf("unregistered: got %v", err)
	}
	if _, err := svc.Check(ctx, "ef963ff7828658a599f3041510671e88", "94eed9ee65337086", false); !errors.Is(err, sun.ErrNotOurs) {
		t.Fatalf("foreign card: got %v", err)
	}
	if _, err := svc.Check(ctx, "abc", c, false); !errors.Is(err, sun.ErrMalformed) {
		t.Fatalf("malformed: got %v", err)
	}
	for _, bad := range []string{"", "E07CE1279D980ECB892A81924B67BF18", cardID + "00", "../etc"} {
		if _, err := svc.Reserve(ctx, bad, ""); !errors.Is(err, ErrBadID) {
			t.Errorf("Reserve(%q) = %v, want ErrBadID", bad, err)
		}
	}
	svc.Reserve(ctx, cardID, "")
	svc.Confirm(ctx, cardID, p, c)
	st.ReserveCard(ctx, cardID, "", "") // active: conflict, no change
	if _, err := svc.Confirm(ctx, cardID, p, c); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("confirm twice: got %v", err)
	}
}

// Tap to check only reports cards whose setup finished.
func TestCheckRejectsCardStillProgramming(t *testing.T) {
	ctx := context.Background()
	svc, st := newService(t)
	svc.Reserve(ctx, cardID, "")
	p, c := tap(t, 0, 5)
	if _, err := svc.Check(ctx, p, c, false); !errors.Is(err, ErrNotActive) {
		t.Fatalf("got %v, want ErrNotActive", err)
	}
	if card, _ := st.GetCard(ctx, cardID); card.LastCounter != -1 {
		t.Fatalf("counter moved to %d", card.LastCounter)
	}
}

// A name is trimmed, one line, at most 40 characters; a rename needs one.
func TestNames(t *testing.T) {
	ctx := context.Background()
	svc, _ := newService(t)
	if c, err := svc.Reserve(ctx, cardID, "  Daily  "); err != nil || c.Name != "Daily" {
		t.Fatalf("trimmed: %+v %v", c, err)
	}
	for _, bad := range []string{strings.Repeat("x", 41), "two\nlines"} {
		if _, err := svc.Reserve(ctx, cardID, bad); !errors.Is(err, ErrBadName) {
			t.Errorf("Reserve name %q: got %v, want ErrBadName", bad, err)
		}
	}
	if _, err := svc.Rename(ctx, cardID, "   "); !errors.Is(err, ErrBadName) {
		t.Fatalf("empty rename: got %v, want ErrBadName", err)
	}
	if c, err := svc.Rename(ctx, cardID, "Kids"); err != nil || c.Name != "Kids" {
		t.Fatalf("rename: %+v %v", c, err)
	}
	if list, err := svc.List(ctx); err != nil || len(list) != 1 || list[0].Name != "Kids" {
		t.Fatalf("list: %+v %v", list, err)
	}
}

func TestWipeChecksTheID(t *testing.T) {
	ctx := context.Background()
	svc, _ := newService(t)
	if _, err := svc.Wipe(ctx, "../etc"); !errors.Is(err, ErrBadID) {
		t.Fatalf("Wipe: got %v, want ErrBadID", err)
	}
	if _, err := svc.Wiped(ctx, "../etc"); !errors.Is(err, ErrBadID) {
		t.Fatalf("Wiped: got %v, want ErrBadID", err)
	}
	if _, err := svc.Rename(ctx, "../etc", "x"); !errors.Is(err, ErrBadID) {
		t.Fatalf("Rename: got %v, want ErrBadID", err)
	}
}

// Phrase only: a tapped card is added back at the version the app found,
// with this tap's counter, so the same tap can't be replayed afterwards. Its
// host stays empty: its URL isn't rewritten yet, so it is on the re-point list
// until the re-point's check passes and sets it.
func TestAdopt(t *testing.T) {
	ctx := context.Background()
	svc, _ := newService(t)
	p, c := tap(t, 3, 17)
	card, err := svc.Adopt(ctx, 3, " Daily ", p, c)
	if err != nil || card.ID != cardID || card.Version != 3 || card.State != store.StateActive ||
		card.LastCounter != 17 || card.Name != "Daily" || card.Host != "" {
		t.Fatalf("adopt: %+v %v", card, err)
	}
	if _, err := svc.Check(ctx, p, c, false); !errors.Is(err, store.ErrReplayed) {
		t.Fatalf("the adopting tap again: got %v, want ErrReplayed", err)
	}
	p, c = tap(t, 3, 18)
	if got, err := svc.Check(ctx, p, c, false); err != nil || got.Counter != 18 {
		t.Fatalf("next tap: %+v %v", got, err)
	}
	p, c = tap(t, 3, 19)
	if _, err := svc.Adopt(ctx, 3, "", p, c); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("adopt twice: got %v, want ErrConflict", err)
	}
}

func TestAdoptRefuses(t *testing.T) {
	ctx := context.Background()
	svc, st := newService(t)
	p, c := tap(t, 2, 5)
	if _, err := svc.Adopt(ctx, 1, "", p, c); !errors.Is(err, sun.ErrBadMAC) {
		t.Fatalf("wrong version: got %v, want ErrBadMAC", err)
	}
	if _, err := svc.Adopt(ctx, 0, "", "ef963ff7828658a599f3041510671e88", "94eed9ee65337086"); !errors.Is(err, sun.ErrNotOurs) {
		t.Fatalf("foreign card: got %v, want ErrNotOurs", err)
	}
	if _, err := svc.Adopt(ctx, 2, strings.Repeat("x", 41), p, c); !errors.Is(err, ErrBadName) {
		t.Fatalf("long name: got %v, want ErrBadName", err)
	}
	if _, err := st.GetCard(ctx, cardID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a refused adopt added the card: %v", err)
	}
	// A card cardd already knows, in any state, is never adopted over.
	svc.Reserve(ctx, cardID, "")
	if _, err := svc.Adopt(ctx, 0, "", p, c); !errors.Is(err, sun.ErrBadMAC) {
		t.Fatalf("known card, wrong version: got %v, want ErrBadMAC", err)
	}
	if _, err := svc.Adopt(ctx, 2, "", p, c); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("known card: got %v, want ErrConflict", err)
	}
	if card, _ := st.GetCard(ctx, cardID); card.State != store.StateProgramming || card.LastCounter != -1 {
		t.Fatalf("known card changed: %+v", card)
	}
}

// After a re-point the card's URL names this server's host.
func TestSetHost(t *testing.T) {
	ctx := context.Background()
	svc, _ := newService(t)
	svc.Reserve(ctx, cardID, "")
	if card, err := svc.SetHost(ctx, cardID, "vm-2.lnvps.cloud"); err != nil || card.Host != "vm-2.lnvps.cloud" {
		t.Fatalf("set host: %+v %v", card, err)
	}
	if _, err := svc.SetHost(ctx, cardID, "https://vm-2.lnvps.cloud"); !errors.Is(err, ErrBadHost) {
		t.Fatalf("a URL: got %v, want ErrBadHost", err)
	}
	if _, err := svc.SetHost(ctx, "../etc", "vm-2.lnvps.cloud"); !errors.Is(err, ErrBadID) {
		t.Fatalf("bad id: got %v, want ErrBadID", err)
	}
	if _, err := svc.SetHost(ctx, "ffffffffffffffffffffffffffffffff", "vm-2.lnvps.cloud"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown card: got %v, want ErrNotFound", err)
	}
	svc.Wipe(ctx, cardID)
	svc.Wiped(ctx, cardID)
	if _, err := svc.SetHost(ctx, cardID, "vm-3.lnvps.cloud"); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("reset card: got %v, want ErrConflict", err)
	}
}

func TestValidHost(t *testing.T) {
	for _, ok := range []string{"vm-1001.lnvps.cloud", "localhost", "a.b-c.example"} {
		if err := ValidHost(ok); err != nil {
			t.Errorf("ValidHost(%q) = %v", ok, err)
		}
	}
	for _, bad := range []string{"", "https://vm-1.lnvps.cloud", "vm-1.lnvps.cloud/ln", "vm-1.lnvps.cloud:443", "vm 1", "-x.com", "x..com", "VM-1.LNVPS.CLOUD"} {
		if err := ValidHost(bad); !errors.Is(err, ErrBadHost) {
			t.Errorf("ValidHost(%q) = %v, want ErrBadHost", bad, err)
		}
	}
}

// Limits in a currency
// follow the sat rules in minor units (1 to 10^10, the day's at least the
// tap's), and at cardd's rate now neither may be over 2,000,000 sat, which
// the refusal names in the currency; with no rate they are refused.
func TestLimitsInACurrency(t *testing.T) {
	ctx := context.Background()
	svc, st := newService(t)
	if _, err := st.ReserveCard(ctx, cardID, "Daily", "vm-1.lnvps.cloud"); err != nil {
		t.Fatal(err)
	}
	_, err := svc.SetLimitsMinor(ctx, cardID, "GBP", 500, 2000)
	if !errors.Is(err, rates.ErrNoRate) || err.Error() != "No £ rate yet: set the limits in sat." {
		t.Fatalf("no rate: %v", err)
	}
	st.Rate = func() (rates.Prices, bool) {
		return rates.Prices{Per: map[string]int64{"GBP": 61352}}, true
	}
	for _, bad := range []struct {
		currency      string
		perTap, daily int64
	}{
		{"XYZ", 500, 2000},
		{"gbp", 500, 2000},
		{"GBP", 0, 2000},
		{"GBP", -1, 2000},
		{"GBP", 500, 499},
		{"GBP", 1, rates.MaxMinor + 1},
		{"GBP", 500, 122_705}, // £1,227.05 a day is over 2,000,000 sat at £61,352
	} {
		if _, err := svc.SetLimitsMinor(ctx, cardID, bad.currency, bad.perTap, bad.daily); !errors.Is(err, ErrBadLimits) {
			t.Fatalf("%+v: %v, want ErrBadLimits", bad, err)
		}
	}
	_, err = svc.SetLimitsMinor(ctx, cardID, "GBP", 500, 122_705)
	if want := "cards: limits are up to 2,000,000 sat (£1,227.04 at today's rate), at least £0.01, and the 24-hour limit is at least the per-tap one"; err == nil || err.Error() != want {
		t.Fatalf("the words: %v", err)
	}
	if c, err := svc.SetLimitsMinor(ctx, cardID, "GBP", 122_704, 122_704); err != nil || c.PerTapMinor != 122_704 {
		t.Fatalf("at the cap exactly: %+v %v", c, err)
	}
	c, err := svc.SetLimitsMinor(ctx, cardID, "GBP", 500, 2000)
	if err != nil || c.LimitCurrency != "GBP" || c.PerTapMinor != 500 || c.DailyMinor != 2000 {
		t.Fatalf("£5 and £20: %+v %v", c, err)
	}
	if perTap, daily := svc.LimitsSat(c); perTap != 8150 || daily != 32599 {
		t.Fatalf("in sat: %d %d", perTap, daily)
	}
	if _, err := svc.SetLimitsMinor(ctx, cardID, "EUR", 500, 2000); !errors.Is(err, rates.ErrNoRate) {
		t.Fatalf("EUR with only GBP's rate: %v", err)
	}
	if _, err := svc.SetLimitsMinor(ctx, "NOT-HEX", "GBP", 500, 2000); !errors.Is(err, ErrBadID) {
		t.Fatalf("a bad id: %v", err)
	}
	c, err = svc.SetLimits(ctx, cardID, 5000, 10000)
	if err != nil || c.LimitCurrency != "" {
		t.Fatalf("sat limits again: %+v %v", c, err)
	}
	if perTap, daily := svc.LimitsSat(c); perTap != 5000 || daily != 10000 {
		t.Fatalf("sat limits in sat: %d %d", perTap, daily)
	}
}

// activeCard is the test card, active after the tap at counter 1.
func activeCard(t *testing.T) (*Service, *store.Store) {
	t.Helper()
	svc, st := newService(t)
	p, c := tap(t, 0, 1)
	svc.Reserve(context.Background(), cardID, "")
	if _, err := svc.Confirm(context.Background(), cardID, p, c); err != nil {
		t.Fatal(err)
	}
	return svc, st
}

// A tap refused for the card's state still names the card (alerts).
func TestSpendFrozenReturnsCard(t *testing.T) {
	ctx := context.Background()
	svc, _ := activeCard(t)
	svc.Freeze(ctx, cardID)
	p, c := tap(t, 0, 2)
	got, err := svc.Spend(ctx, p, c)
	if !errors.Is(err, ErrFrozen) || got.Card.ID != cardID || got.Counter != 2 {
		t.Fatalf("frozen: %+v %v", got, err)
	}
}

// A replayed counter names the card and the counter, as the card was read before the counter moved.
func TestSpendReplayReturnsCardAndCounter(t *testing.T) {
	ctx := context.Background()
	svc, _ := activeCard(t)
	p, c := tap(t, 0, 2)
	if _, err := svc.Spend(ctx, p, c); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Spend(ctx, p, c)
	if !errors.Is(err, store.ErrReplayed) || got.Card.ID != cardID || got.Counter != 2 || got.Card.LastCounter != 2 {
		t.Fatalf("replay: %+v %v", got, err)
	}
	// An unknown MAC gives nothing.
	got, err = svc.Spend(ctx, p, "0000000000000000")
	if err == nil || got.Card.ID != "" {
		t.Fatalf("bad MAC: %+v %v", got, err)
	}
}

func TestPeekLeavesCounter(t *testing.T) {
	ctx := context.Background()
	svc, st := activeCard(t)
	p, c := tap(t, 0, 5)
	got, err := svc.Peek(ctx, p, c)
	if err != nil || got.Card.ID != cardID || got.Counter != 5 {
		t.Fatalf("peek: %+v %v", got, err)
	}
	if card, _ := st.GetCard(ctx, cardID); card.LastCounter != 1 {
		t.Fatalf("counter moved to %d", card.LastCounter)
	}
	if _, err := svc.Spend(ctx, p, c); err != nil {
		t.Fatalf("spend after peek: %v", err)
	}
}

// restored is the test card, active at counter 1, as cardd restore leaves it:
// needing its owner's check.
func restored(t *testing.T) (*Service, *store.Store) {
	t.Helper()
	svc, st := activeCard(t)
	if err := st.PrepareRestored(context.Background(), "backup", "04aa", store.RestoredVM{ID: "2", Host: "vm-2.lnvps.cloud", IPv4: "192.0.2.2"}); err != nil {
		t.Fatal(err)
	}
	return svc, st
}

// After a restore, a tap at a terminal is refused, however far on its
// counter, and names the card (alerts); the counter stays.
func TestSpendRefusesACardThatNeedsACheck(t *testing.T) {
	ctx := context.Background()
	svc, st := restored(t)
	p, c := tap(t, 0, 20)
	got, err := svc.Spend(ctx, p, c)
	if !errors.Is(err, ErrNeedsCheck) || got.Card.ID != cardID || got.Counter != 20 {
		t.Fatalf("spend: %+v %v", got, err)
	}
	if card, _ := st.GetCard(ctx, cardID); card.LastCounter != 1 || !card.NeedsCheck {
		t.Fatalf("after the refusal: %+v", card)
	}
	// Frozen as well, it says frozen: the person froze it.
	svc.Freeze(ctx, cardID)
	if _, err := svc.Spend(ctx, p, c); !errors.Is(err, ErrFrozen) {
		t.Fatalf("frozen: %v", err)
	}
}

// The owner's check (the card held to the wallet) takes the card's own
// counter and clears the mark: every tap recorded before it is refused as
// used, and the card pays again from the next.
func TestCheckAfterARestore(t *testing.T) {
	ctx := context.Background()
	svc, _ := restored(t)
	recorded := [][2]string{}
	for n := uint32(2); n <= 9; n++ {
		p, c := tap(t, 0, n)
		recorded = append(recorded, [2]string{p, c})
	}
	p, c := tap(t, 0, 10)
	got, err := svc.Check(ctx, p, c, true)
	if err != nil || got.Card.NeedsCheck || got.Card.LastCounter != 10 {
		t.Fatalf("check: %+v %v", got, err)
	}
	for _, r := range recorded {
		if _, err := svc.Spend(ctx, r[0], r[1]); !errors.Is(err, store.ErrReplayed) {
			t.Fatalf("recorded tap: %v", err)
		}
	}
	// The check's own tap, sent to a terminal, is used too.
	if _, err := svc.Spend(ctx, p, c); !errors.Is(err, store.ErrReplayed) {
		t.Fatalf("the check's tap: %v", err)
	}
	p, c = tap(t, 0, 11)
	if got, err := svc.Spend(ctx, p, c); err != nil || got.Card.LastCounter != 11 {
		t.Fatalf("the next tap: %+v %v", got, err)
	}
}

// A check the wallet didn't prove (an older wallet's, or a copy of a tap
// held to a phone) is refused for a card that needs one, and moves nothing;
// the next proved one clears it. An unmarked card is checked unproved as
// before.
func TestCheckAfterARestoreNeedsProof(t *testing.T) {
	ctx := context.Background()
	svc, st := restored(t)
	p, c := tap(t, 0, 5)
	if _, err := svc.Check(ctx, p, c, false); !errors.Is(err, ErrNeedsCheck) {
		t.Fatalf("unproved: %v", err)
	}
	if card, _ := st.GetCard(ctx, cardID); !card.NeedsCheck || card.LastCounter != 1 {
		t.Fatalf("after an unproved check: %+v", card)
	}
	if got, err := svc.Check(ctx, p, c, true); err != nil || got.Card.NeedsCheck || got.Card.LastCounter != 5 {
		t.Fatalf("proved: %+v %v", got, err)
	}
	p, c = tap(t, 0, 6)
	if got, err := svc.Check(ctx, p, c, false); err != nil || got.Card.LastCounter != 6 {
		t.Fatalf("unproved, once checked: %+v %v", got, err)
	}
}

// A check with a tap at or below the server's counter is refused, and the
// card still needs one.
func TestCheckAfterARestoreRefusesAnOldTap(t *testing.T) {
	ctx := context.Background()
	svc, st := restored(t)
	p, c := tap(t, 0, 1)
	if _, err := svc.Check(ctx, p, c, true); !errors.Is(err, store.ErrReplayed) {
		t.Fatalf("old tap: %v", err)
	}
	if card, _ := st.GetCard(ctx, cardID); !card.NeedsCheck {
		t.Fatalf("after an old tap: %+v", card)
	}
	// A frozen card is checked as well, and stays frozen.
	svc.Freeze(ctx, cardID)
	p, c = tap(t, 0, 5)
	if got, err := svc.Check(ctx, p, c, true); err != nil || got.Card.NeedsCheck || got.Card.State != store.StateFrozen {
		t.Fatalf("frozen check: %+v %v", got, err)
	}
}
