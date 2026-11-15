package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// snapshot takes a snapshot of s into a new file and returns its path and bytes.
func snapshot(t *testing.T, s *Store) (string, []byte) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "copy.db")
	if err := s.SnapshotTo(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return path, b
}

func count(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A snapshot holds what a restore needs, and not the four transient tables:
// the replay check, one-time tap codes, stored answers to money requests and
// a PoS phone's pairing code.
func TestASnapshotHoldsWhatARestoreNeeds(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	s.Credit(ctx, card, 5_000_000, "h", "")
	s.SetMeta(ctx, "vm.id", "1009")
	s.AddDevice(ctx, Device{KeyID: "b18b86ce1389e46d", PublicKey: "04aa", Name: "Pixel"})
	s.SeeSignature(ctx, "sig", time.Now().Add(time.Minute))
	s.IssueK1(ctx, "k1", id, time.Now().Add(time.Minute))
	s.BeginRequest(ctx, "req", "hash")
	s.NewPosCode(ctx, "code-hash", "Till 1", time.Now().Add(time.Minute))
	path, _ := snapshot(t, s)
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for table, want := range map[string]int{"cards": 1, "ledger_tx": 1, "devices": 1, "meta": 1, "seen_signatures": 0, "k1s": 0, "requests": 0, "pos_codes": 0} {
		if got := count(t, db, table); got != want {
			t.Errorf("%s: %d rows, want %d", table, got, want)
		}
	}
	var vm string
	if err := db.QueryRow(`SELECT value FROM meta WHERE key = 'vm.id'`).Scan(&vm); err != nil || vm != "1009" {
		t.Fatalf("meta vm.id %q %v", vm, err)
	}
	// The live database keeps them.
	if _, err := s.LookupK1(ctx, "k1"); err != nil {
		t.Fatalf("the live k1: %v", err)
	}
}

// Unchanged content gives a byte-identical snapshot, however much the
// transient tables churned; a real change gives a different one.
func TestSnapshotsOfTheSameContentAreIdentical(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.SetMeta(ctx, "vm.id", "1009")
	_, a := snapshot(t, s)
	for i := range 50 {
		s.SeeSignature(ctx, string(rune('a'+i%26))+time.Now().String(), time.Now().Add(time.Minute))
	}
	s.IssueK1(ctx, "k1", id, time.Now().Add(time.Minute))
	_, b := snapshot(t, s)
	if !bytes.Equal(a, b) {
		t.Fatal("transient churn changed the snapshot")
	}
	s.SetMeta(ctx, "vm.host", "vm-1009.lnvps.cloud")
	if _, c := snapshot(t, s); bytes.Equal(a, c) {
		t.Fatal("a change made no difference")
	}
}

func TestASnapshotNeverOverwritesAFile(t *testing.T) {
	s := open(t)
	path := filepath.Join(t.TempDir(), "there.db")
	os.WriteFile(path, []byte("x"), 0o600)
	if err := s.SnapshotTo(context.Background(), path); err == nil {
		t.Fatal("overwrote an existing file")
	}
}

// Restore keeps this phone and revokes every other, and refuses a keep id
// that would lock this phone out too.
func TestRevokeOthers(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	for _, k := range []string{"aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"} {
		s.AddDevice(ctx, Device{KeyID: k, PublicKey: "04" + k, Name: k})
	}
	s.RevokeDevice(ctx, "cccccccccccccccc")
	for keep, want := range map[string]error{"": ErrNotFound, "dddddddddddddddd": ErrNotFound, "cccccccccccccccc": ErrConflict} {
		if _, err := s.RevokeOthers(ctx, keep); !errors.Is(err, want) {
			t.Fatalf("keep %q: %v", keep, err)
		}
	}
	n, err := s.RevokeOthers(ctx, "bbbbbbbbbbbbbbbb")
	if err != nil || n != 1 {
		t.Fatalf("revoked %d: %v", n, err)
	}
	if d, _ := s.GetDevice(ctx, "aaaaaaaaaaaaaaaa"); d.RevokedAt == nil {
		t.Fatal("a still active")
	}
	if d, _ := s.GetDevice(ctx, "bbbbbbbbbbbbbbbb"); d.RevokedAt != nil {
		t.Fatal("kept device revoked")
	}
	if n, _ := s.RevokeOthers(ctx, "bbbbbbbbbbbbbbbb"); n != 0 {
		t.Fatalf("again: %d", n)
	}
}
