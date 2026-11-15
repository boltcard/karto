package store

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

// A payer's note on a top-up: kept by payment hash until the payment is credited, then on its
// line.

func topupNotes(t *testing.T, s *Store) int {
	t.Helper()
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM topup_notes`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func newestLine(t *testing.T, s *Store, acct Account) Tx {
	t.Helper()
	h, err := s.History(context.Background(), acct, 0, 1)
	if err != nil || len(h) == 0 {
		t.Fatalf("history of %s: %v %v", acct, h, err)
	}
	return h[0]
}

func TestMigration11AddsPayerNotes(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migrations[:10] {
		if _, err := db.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`PRAGMA user_version = 10;
		INSERT INTO ledger_tx (id, kind, ref, note, created_at) VALUES (1, 'topup', 'aa', 'received 5 sat', 1);
		INSERT INTO ledger_entry (tx_id, account, amount_msat) VALUES (1, 'pool', 5000), (1, 'world', -5000)`); err != nil {
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
	if l := newestLine(t, s, Pool); l.Note != "received 5 sat" || l.PayerNote != "" {
		t.Fatalf("old line: %+v", l)
	}
}

func TestACreditTakesItsPayerNote(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if err := s.SaveTopupNote(ctx, "h1", "refund, order 1043"); err != nil {
		t.Fatal(err)
	}
	if done, err := s.CreditMoving(ctx, Pool, 5_000_000, 0, "h1", "received 5000 sat", FeeCreditMove{}); !done || err != nil {
		t.Fatalf("credit: %v %v", done, err)
	}
	l := newestLine(t, s, Pool)
	if l.PayerNote != "refund, order 1043" || l.Note != "received 5000 sat" {
		t.Fatalf("line: %+v", l)
	}
	if n := topupNotes(t, s); n != 0 {
		t.Fatalf("%d notes left after the credit", n)
	}
	if got, err := s.PayerNoteOf(ctx, "h1"); got != "refund, order 1043" || err != nil {
		t.Fatalf("PayerNoteOf: %q %v", got, err)
	}
	// The same payment again changes nothing.
	if done, err := s.CreditMoving(ctx, Pool, 5_000_000, 0, "h1", "received 5000 sat", FeeCreditMove{}); done || err != nil {
		t.Fatalf("again: %v %v", done, err)
	}
	if l := newestLine(t, s, Pool); l.PayerNote != "refund, order 1043" {
		t.Fatalf("after again: %+v", l)
	}
}

func TestACreditForACardThatCantReceiveKeepsThePayerNote(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	gone := CardAccount("ffffffffffffffffffffffffffffffff") // no such card: its money goes to pool
	s.SaveTopupNote(ctx, "h2", "thanks for the talk")
	if done, err := s.CreditMoving(ctx, gone, 2_000_000, 0, "h2", "received 2000 sat", FeeCreditMove{}); !done || err != nil {
		t.Fatalf("credit: %v %v", done, err)
	}
	if l := newestLine(t, s, Pool); l.PayerNote != "thanks for the talk" {
		t.Fatalf("pool's line: %+v", l)
	}
}

func TestACreditWithoutANoteHasNone(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.CreditMoving(ctx, Pool, 1_000_000, 0, "h3", "received 1000 sat", FeeCreditMove{})
	if l := newestLine(t, s, Pool); l.PayerNote != "" {
		t.Fatalf("line: %+v", l)
	}
	if got, err := s.PayerNoteOf(ctx, "h3"); got != "" || err != nil {
		t.Fatalf("PayerNoteOf: %q %v", got, err)
	}
	if got, err := s.PayerNoteOf(ctx, "no such ref"); got != "" || err != nil {
		t.Fatalf("PayerNoteOf of nothing: %q %v", got, err)
	}
}

func TestASaleIgnoresTopupNotes(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.SaveTopupNote(ctx, "h4", "not a top-up")
	if done, err := s.CreditSaleMoving(ctx, "nosuchsale", 3_000_000, "h4", "received 3000 sat", FeeCreditMove{}); !done || err != nil {
		t.Fatalf("sale: %v %v", done, err)
	}
	if l := newestLine(t, s, Shop); l.PayerNote != "" {
		t.Fatalf("sale's line: %+v", l)
	}
	if n := topupNotes(t, s); n != 1 {
		t.Fatalf("%d notes, want the one still there", n)
	}
}

func TestSaveTopupNoteTwiceKeepsTheLast(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.SaveTopupNote(ctx, "h5", "first")
	if err := s.SaveTopupNote(ctx, "h5", "second"); err != nil {
		t.Fatal(err)
	}
	s.CreditMoving(ctx, Pool, 1_000_000, 0, "h5", "", FeeCreditMove{})
	if l := newestLine(t, s, Pool); l.PayerNote != "second" {
		t.Fatalf("line: %+v", l)
	}
}

func TestPruneTopupNotes(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	at := time.Unix(1_790_000_000, 0)
	s.now = func() time.Time { return at.Add(-61 * time.Minute) }
	s.SaveTopupNote(ctx, "old", "x")
	s.now = func() time.Time { return at.Add(-59 * time.Minute) }
	s.SaveTopupNote(ctx, "new", "y")
	s.now = func() time.Time { return at }
	if n, err := s.PruneTopupNotes(ctx, at.Add(-time.Hour), 5000); n != 1 || err != nil {
		t.Fatalf("prune by age: %d %v", n, err)
	}
	s.CreditMoving(ctx, Pool, 1_000_000, 0, "new", "", FeeCreditMove{})
	if l := newestLine(t, s, Pool); l.PayerNote != "y" {
		t.Fatalf("the newer note: %+v", l)
	}

	// By count: of five within the hour, the three newest stay.
	for i := 0; i < 5; i++ {
		s.now = func() time.Time { return at.Add(time.Duration(i) * time.Minute) }
		s.SaveTopupNote(ctx, fmt.Sprintf("c%d", i), fmt.Sprintf("note %d", i))
	}
	if n, err := s.PruneTopupNotes(ctx, at.Add(-time.Hour), 3); n != 2 || err != nil {
		t.Fatalf("prune by count: %d %v", n, err)
	}
	var left []string
	rows, _ := s.db.Query(`SELECT payment_hash FROM topup_notes ORDER BY payment_hash`)
	for rows.Next() {
		var h string
		rows.Scan(&h)
		left = append(left, h)
	}
	rows.Close()
	if fmt.Sprint(left) != "[c2 c3 c4]" {
		t.Fatalf("left: %v", left)
	}
}

func TestASnapshotLeavesOutUnpaidNotes(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.SaveTopupNote(ctx, "paid", "kept on its line")
	s.CreditMoving(ctx, Pool, 1_000_000, 0, "paid", "", FeeCreditMove{})
	s.SaveTopupNote(ctx, "unpaid", "a stranger's words")
	path, _ := snapshot(t, s)
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if n := count(t, db, "topup_notes"); n != 0 {
		t.Fatalf("topup_notes: %d rows in the snapshot", n)
	}
	var note string
	if err := db.QueryRow(`SELECT payer_note FROM ledger_tx WHERE ref = 'paid'`).Scan(&note); err != nil || note != "kept on its line" {
		t.Fatalf("the line's payer note in the snapshot: %q %v", note, err)
	}
}

func TestPrepareRestoredEmptiesUnpaidNotes(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.SaveTopupNote(ctx, "unpaid", "x")
	if err := s.PrepareRestored(ctx, "phrase", "", newVM); err != nil {
		t.Fatal(err)
	}
	if n := topupNotes(t, s); n != 0 {
		t.Fatalf("%d notes after PrepareRestored", n)
	}
}
