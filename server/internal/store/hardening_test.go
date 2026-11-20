package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// damaged makes a database of several pages and writes over one of its
// b-tree pages, as a bad disk or a bug might.
func damaged(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "damaged.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE t (v TEXT); CREATE INDEX t_v ON t (v)`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 200; i++ {
		if _, err := db.Exec(`INSERT INTO t VALUES (?)`, strings.Repeat("x", 100)+string(rune('a'+i%26))); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Page 3 (pages are 4096 bytes): past the header, into the cells.
	if _, err := f.WriteAt([]byte(strings.Repeat("\xff", 200)), 2*4096+8); err != nil {
		t.Fatal(err)
	}
	f.Close()
	return path
}

// A snapshot copy that isn't whole is refused before it is encrypted.
func TestCheckWholeFindsADamagedCopy(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+damaged(t))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := checkWhole(ctx, db); err == nil || !strings.Contains(err.Error(), "the copy isn't whole") {
		t.Fatalf("a damaged copy passed: %v", err)
	}
	// A whole one passes.
	path, _ := snapshot(t, open(t))
	ok, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer ok.Close()
	if err := checkWhole(ctx, ok); err != nil {
		t.Fatal(err)
	}
}

// Checkpoint fails when a reader keeps it from emptying the write-ahead log,
// so a restore never moves a database whose log still holds pages.
func TestCheckpointFailsWhenItCantFinish(t *testing.T) {
	if testing.Short() {
		t.Skip("waits out the 5 s busy timeout")
	}
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "cardd.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.SetMeta(ctx, "a", "1"); err != nil {
		t.Fatal(err)
	}
	reader, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	tx, err := reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := tx.QueryRow(`SELECT count(*) FROM meta`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMeta(ctx, "b", "2"); err != nil {
		t.Fatal(err)
	}
	if err := s.Checkpoint(ctx); err == nil {
		t.Fatal("a checkpoint a reader held back said it finished")
	}
	tx.Rollback()
	if err := s.Checkpoint(ctx); err != nil {
		t.Fatal(err)
	}
}

// A new database, and its write-ahead log and shared memory, are its
// owner's alone; an older one is brought to the same.
func TestTheDatabaseIsTheOwnersAlone(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cardd.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetMeta(context.Background(), "a", "1"); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("%s: %v", filepath.Base(p), fi.Mode().Perm())
		}
	}
	s.Close()

	old := filepath.Join(dir, "old.db")
	db, err := sql.Open("sqlite", "file:"+old)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE x (v)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if err := os.Chmod(old, 0o644); err != nil {
		t.Fatal(err)
	}
	s, err = Open(old)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if fi, _ := os.Stat(old); fi.Mode().Perm() != 0o600 {
		t.Errorf("an older database stayed %v", fi.Mode().Perm())
	}
}
