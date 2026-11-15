package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
)

// SnapshotTo writes a consistent copy of the database to path, which must not
// exist, for a backup: VACUUM INTO, made while cardd runs.
// In the copy (never the live database) it empties the five transient
// tables, the replay check, one-time tap codes, stored answers to money
// requests, a PoS phone's pairing code (it lasts 10 minutes and must not
// reach a backup) and the payers' notes of unpaid invoices (a
// stranger's words, for invoices that expire in 10 minutes), and compacts
// it again, so a copy of unchanged content is
// byte-identical to the last one. It holds the store's one connection while
// it runs, so ctx should carry a time limit.
func (s *Store) SnapshotTo(ctx context.Context, path string) error {
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("store: snapshot: %s already exists", path)
	}
	if _, err := s.db.ExecContext(ctx, `VACUUM INTO ?`, path); err != nil {
		return err
	}
	cp, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		return err
	}
	defer cp.Close()
	_, err = cp.ExecContext(ctx, `DELETE FROM seen_signatures; DELETE FROM k1s; DELETE FROM requests; DELETE FROM pos_codes; DELETE FROM topup_notes; VACUUM`)
	return err
}
