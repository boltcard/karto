package store

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Send out's Recent list: the addresses Pool's settled sends went to, newest first, and
// the ones the person took off.

var recentT0 = time.Unix(1_790_000_000, 0)

type recentWorld struct {
	t    *testing.T
	s    *Store
	n    int
	hold Hold
}

func newRecentWorld(t *testing.T) *recentWorld {
	t.Helper()
	s := open(t)
	s.now = func() time.Time { return recentT0 }
	if _, err := s.Credit(context.Background(), Pool, 1_000_000_000, "seed", "seed"); err != nil {
		t.Fatal(err)
	}
	return &recentWorld{t: t, s: s}
}

func (w *recentWorld) at(d time.Duration) { w.s.now = func() time.Time { return recentT0.Add(d) } }

// open opens a send from acct (kind) to dest, or to offer when offer isn't empty.
func (w *recentWorld) open(acct Account, kind Kind, dest, offer string) Hold {
	w.t.Helper()
	w.n++
	r := HoldRequest{Account: acct, Kind: kind, AmountMsat: 1000, FeeBudgetMsat: 100, Offer: offer, About: HoldAbout{Destination: dest}}
	if offer == "" {
		r.PaymentHash, r.Invoice = fmt.Sprintf("%064x", w.n), "lnbc1"
	}
	h, err := w.s.OpenHold(context.Background(), r)
	if err != nil {
		w.t.Fatal(err)
	}
	return h
}

// paid settles a Pool send to dest (or offer) at d; paidAt, when not zero, is
// when phoenixd says it was paid (earlier than d for one found late).
func (w *recentWorld) paid(dest, offer string, d, paidAt time.Duration) {
	w.t.Helper()
	w.at(d)
	h := w.open(Pool, KindSend, dest, offer)
	var at time.Time
	if paidAt != 0 {
		at = recentT0.Add(paidAt)
	}
	if _, err := w.s.SettleHoldWithProofAt(context.Background(), h.ID, 0, "", at); err != nil {
		w.t.Fatal(err)
	}
}

func (w *recentWorld) failed(dest string, d time.Duration) {
	w.t.Helper()
	w.at(d)
	h := w.open(Pool, KindSend, dest, "")
	if _, err := w.s.ReleaseHold(context.Background(), h.ID); err != nil {
		w.t.Fatal(err)
	}
}

func (w *recentWorld) list(ownHost string) []Recent {
	w.t.Helper()
	r, err := w.s.RecentSends(context.Background(), ownHost, 5)
	if err != nil {
		w.t.Fatal(err)
	}
	return r
}

func tos(r []Recent) string {
	var out []string
	for _, e := range r {
		out = append(out, e.To)
	}
	return strings.Join(out, ",")
}

func TestRecentListsSettledSendsNewestFirst(t *testing.T) {
	w := newRecentWorld(t)
	w.paid("alice@a.com", "", time.Minute, 0)
	w.paid("bob@b.com", "", 2*time.Minute, 0)
	r := w.list("vm.example.net")
	if tos(r) != "bob@b.com,alice@a.com" {
		t.Fatalf("list: %+v", r)
	}
	if r[0].Shown != "bob@b.com" || !r[0].PaidAt.Equal(recentT0.Add(2*time.Minute)) {
		t.Fatalf("bob's entry: %+v", r[0])
	}
}

func TestRecentSkipsFailedOpenAndInvoices(t *testing.T) {
	w := newRecentWorld(t)
	w.failed("failed@a.com", time.Minute)
	w.paid("", "", 2*time.Minute, 0) // an invoice: no address kept
	w.at(3 * time.Minute)
	w.open(Pool, KindSend, "open@a.com", "")
	if r := w.list("vm.example.net"); len(r) != 0 {
		t.Fatalf("list: %+v", r)
	}
}

func TestRecentOneEntryPerAddress(t *testing.T) {
	w := newRecentWorld(t)
	w.paid("alice@a.com", "", time.Minute, 0)
	w.failed("alice@a.com", 2*time.Minute)
	r := w.list("vm.example.net")
	if tos(r) != "alice@a.com" || !r[0].PaidAt.Equal(recentT0.Add(time.Minute)) {
		t.Fatalf("a failed send dates nothing: %+v", r)
	}
	w.paid("ALICE@a.com", "", 3*time.Minute, 0)
	r = w.list("vm.example.net")
	if len(r) != 1 || !r[0].PaidAt.Equal(recentT0.Add(3*time.Minute)) {
		t.Fatalf("one entry whatever the case: %+v", r)
	}
}

func TestRecentRawOffer(t *testing.T) {
	w := newRecentWorld(t)
	w.paid("an offer from Shop", "lno1qcp4abcdefghijklmnx7k2", time.Minute, 0)
	r := w.list("vm.example.net")
	if len(r) != 1 || r[0].To != "lno1qcp4abcdefghijklmnx7k2" || r[0].Shown != "lno1qcp4…x7k2" {
		t.Fatalf("list: %+v", r)
	}
}

func TestRecentBitcoinNameOffer(t *testing.T) {
	w := newRecentWorld(t)
	w.paid("₿alice@phoenixwallet.me", "lno1qqqqqqqqqqqqqqqqqqqqqq", time.Minute, 0)
	r := w.list("vm.example.net")
	if len(r) != 1 || r[0].To != "alice@phoenixwallet.me" || r[0].Shown != "₿alice@phoenixwallet.me" {
		t.Fatalf("list: %+v", r)
	}
	// A raw offer's destination is its own description (api offerDestination):
	// a description shaped like a ₿ name is the offer's text, not a name the
	// person looked up, so the entry stays the offer.
	t.Run("rawOfferWhoseDescriptionLooksLikeAName", func(t *testing.T) {
		w := newRecentWorld(t)
		w.at(time.Minute)
		h, err := w.s.OpenHold(context.Background(), HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 1000, FeeBudgetMsat: 100,
			Offer: "lno1ssssssssssssssssssssss", About: HoldAbout{Destination: "₿mum@evil.example", Description: "₿mum@evil.example"}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.s.SettleHold(context.Background(), h.ID, 0); err != nil {
			t.Fatal(err)
		}
		if r := w.list("vm.example.net"); len(r) != 1 || r[0].To != "lno1ssssssssssssssssssssss" || r[0].Shown != "lno1ssss…ssss" {
			t.Fatalf("list: %+v", r)
		}
	})
	t.Run("rawOfferWithBitcoinSignDescription", func(t *testing.T) {
		w := newRecentWorld(t)
		w.paid("₿ tips jar", "lno1rrrrrrrrrrrrrrrrrrrrrr", time.Minute, 0)
		if r := w.list("vm.example.net"); len(r) != 1 || r[0].To != "lno1rrrrrrrrrrrrrrrrrrrrrr" {
			t.Fatalf("list: %+v", r)
		}
	})
}

func TestRecentCapAfterFiltering(t *testing.T) {
	w := newRecentWorld(t)
	for i := 1; i <= 7; i++ {
		w.paid(fmt.Sprintf("u%d@a.com", i), "", time.Duration(i)*time.Minute, 0)
	}
	w.paid("pool@vm.example.net", "", 8*time.Minute, 0)
	w.at(9 * time.Minute)
	if err := w.s.RemoveRecent(context.Background(), "u7@a.com"); err != nil {
		t.Fatal(err)
	}
	if got := tos(w.list("vm.example.net")); got != "u6@a.com,u5@a.com,u4@a.com,u3@a.com,u2@a.com" {
		t.Fatalf("list: %s", got)
	}
}

func TestRecentRemoveAndPayAgain(t *testing.T) {
	w := newRecentWorld(t)
	ctx := context.Background()
	w.paid("alice@a.com", "", time.Minute, 0)
	w.at(2 * time.Minute)
	if err := w.s.RemoveRecent(ctx, "Alice@a.com"); err != nil {
		t.Fatal(err)
	}
	if r := w.list("vm.example.net"); len(r) != 0 {
		t.Fatalf("removed: %+v", r)
	}
	w.paid("alice@a.com", "", 3*time.Minute, 0)
	if got := tos(w.list("vm.example.net")); got != "alice@a.com" {
		t.Fatalf("paid again: %s", got)
	}
	w.at(4 * time.Minute)
	if err := w.s.RemoveRecent(ctx, "alice@a.com"); err != nil {
		t.Fatal(err)
	}
	if r := w.list("vm.example.net"); len(r) != 0 {
		t.Fatalf("removed again: %+v", r)
	}
}

func TestRecentShownTimeIsTheLinesTime(t *testing.T) {
	w := newRecentWorld(t)
	// bob's send, opened at 30 s, was found settled at 10 min, though phoenixd
	// paid it at 1 min; alice's was paid at 5 min.
	w.at(30 * time.Second)
	h := w.open(Pool, KindSend, "bob@b.com", "")
	w.at(10 * time.Minute)
	if _, err := w.s.SettleHoldWithProofAt(context.Background(), h.ID, 0, "", recentT0.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	w.paid("alice@a.com", "", 5*time.Minute, 0)
	r := w.list("vm.example.net")
	if tos(r) != "alice@a.com,bob@b.com" || !r[1].PaidAt.Equal(recentT0.Add(time.Minute)) {
		t.Fatalf("list: %+v", r)
	}
}

func TestRecentOtherAccountsNotListed(t *testing.T) {
	w := newRecentWorld(t)
	ctx := context.Background()
	if err := w.s.Move(ctx, Pool, Hosting, 100_000, "m"); err != nil {
		t.Fatal(err)
	}
	h := w.open(Hosting, KindRenew, "renew@lnvps.net", "")
	if _, err := w.s.SettleHold(ctx, h.ID, 0); err != nil {
		t.Fatal(err)
	}
	if r := w.list("vm.example.net"); len(r) != 0 {
		t.Fatalf("list: %+v", r)
	}
}

func TestMigration13AddsRecentRemoved(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migrations[:12] {
		if _, err := db.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`PRAGMA user_version = 12;
		INSERT INTO holds (account, kind, amount_msat, fee_budget_msat, payment_hash, invoice, state, created_at, resolved_at, destination)
		VALUES ('pool', 'send', 1000, 0, 'aa', 'lnbc1', 'settled', 1, 2, 'alice@a.com')`); err != nil {
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
	r, err := s.RecentSends(ctx, "vm.example.net", 5)
	if err != nil || len(r) != 1 || r[0].To != "alice@a.com" || r[0].PaidAt.Unix() != 2 {
		t.Fatalf("recent: %+v %v", r, err)
	}
	if err := s.RemoveRecent(ctx, "alice@a.com"); err != nil {
		t.Fatal(err)
	}
}
