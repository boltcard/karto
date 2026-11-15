package store

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"
)

// The per-tap refund links of this server's own cards.

func TestRefundLinkCard(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	now := clock(s)
	activeCard(t, s, refundCard)
	if err := s.NewRefundLink(ctx, "tok1", refundCard, "k1-a", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	c, err := s.RefundLinkCard(ctx, "tok1")
	if err != nil || c.ID != refundCard {
		t.Fatalf("%+v %v", c, err)
	}
	if _, err := s.RefundLinkCard(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown: %v", err)
	}
	*now = now.Add(2 * time.Hour)
	if _, err := s.RefundLinkCard(ctx, "tok1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired: %v", err)
	}
}

func TestClaimK1ClaimsRefundLink(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	now := clock(s)
	activeCard(t, s, refundCard)
	if err := s.IssueK1(ctx, "k1-a", refundCard, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := s.NewRefundLink(ctx, "tok1", refundCard, "k1-a", now.Add(400*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimK1(ctx, "k1-a"); err != nil {
		t.Fatal(err)
	}
	var claimed int64
	if err := s.db.QueryRow(`SELECT COALESCE(claimed_at, 0) FROM refund_links WHERE token = 'tok1'`).Scan(&claimed); err != nil || claimed != now.Unix() {
		t.Fatalf("claimed_at %d %v", claimed, err)
	}
}

func TestPruneRefundLinks(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	now := clock(s)
	activeCard(t, s, refundCard)
	for _, l := range []struct {
		token string
		life  time.Duration
	}{{"unclaimed", 400 * 24 * time.Hour}, {"claimed", 400 * 24 * time.Hour}, {"expired", 2 * time.Hour}} {
		if err := s.NewRefundLink(ctx, l.token, refundCard, "k1-"+l.token, now.Add(l.life)); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.IssueK1(ctx, "k1-claimed", refundCard, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimK1(ctx, "k1-claimed"); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(25 * time.Hour)
	n, err := s.PruneRefundLinks(ctx, *now)
	if err != nil || n != 2 {
		t.Fatalf("pruned %d %v", n, err)
	}
	if _, err := s.RefundLinkCard(ctx, "claimed"); err != nil {
		t.Fatalf("the claimed one went: %v", err)
	}
}

// Other shops hold these links for 400 days: a backup keeps them.
func TestSnapshotKeepsRefundLinks(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	now := clock(s)
	activeCard(t, s, refundCard)
	if err := s.NewRefundLink(ctx, "tok1", refundCard, "k1-a", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	path, _ := snapshot(t, s)
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if n := count(t, db, "refund_links"); n != 1 {
		t.Fatalf("the snapshot has %d refund links", n)
	}
}
