package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// RestoredVM is the new VM a restored database is for, as meta vm.id,
// vm.host and vm.ipv4 name it.
type RestoredVM struct{ ID, Host, IPv4 string }

// PrepareRestored readies a database restored onto a new server
// (cardd restore), in one transaction. It replaces the old VM with vm, so
// the database is complete before cardd first starts and its first snapshot
// names the new VM (the install's meta step writes the same values later),
// and forgets the old VM's hosting state, but keeps the last renewal hold
// counted so it isn't counted again; it marks the restore, described by
// from, pending reconcile and clears the last restore's state; and it
// re-activates the restoring phone's key (hex, as AddDevice stores it) if the
// backup has it revoked. The other phones are left for revoke-others. A vm
// not named in full is refused, changing nothing.
//
// The point of sale: the PoS phones stay as the backup has
// them (a removed one is never brought back, whatever key is given); a sale
// still open is expired; and the fee credit cardd had accounted for is
// forgotten, since the rebuilt server's phoenixd may be a new node with
// none (its first figure is taken again once a channel is up).
func (s *Store) PrepareRestored(ctx context.Context, from, devicePubHex string, vm RestoredVM) error {
	if vm.ID == "" || vm.Host == "" || vm.IPv4 == "" {
		return fmt.Errorf("the new VM isn't named in full: %+v", vm)
	}
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM meta WHERE key IN ('vm.id', 'vm.host', 'vm.ipv4', ?)
			OR (key GLOB 'hosting.*' AND key != 'hosting.counted_hold') OR key GLOB 'restore.*'`, keptFeeCreditKey); err != nil {
			return err
		}
		// A sale still open in the backup can't be paid: its invoice was the
		// old server's phoenixd's, whose database isn't restored.
		if _, err := tx.ExecContext(ctx, `UPDATE sales SET state = 'expired' WHERE state = 'open'`); err != nil {
			return err
		}
		// Nor can a top-up's that was waiting with a payer's note.
		if _, err := tx.ExecContext(ctx, `DELETE FROM topup_notes`); err != nil {
			return err
		}
		// Every endpoint was a phone's for the old server; each phone sets its
		// own again. The VAPID key stays in meta: it names the server's sender
		// and the restored phones' subscriptions are made to it.
		if _, err := tx.ExecContext(ctx, `DELETE FROM push_endpoints`); err != nil {
			return err
		}
		now := s.now().Unix()
		if _, err := tx.ExecContext(ctx, `INSERT INTO meta (key, value, updated_at)
			VALUES ('vm.id', ?, ?), ('vm.host', ?, ?), ('vm.ipv4', ?, ?)`, vm.ID, now, vm.Host, now, vm.IPv4, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO meta (key, value, updated_at)
			VALUES ('restore.from', ?, ?), ('restore.reconcile', 'pending', ?)`, from, now, now); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at = NULL WHERE public_key = ? AND role = 'owner'`, devicePubHex)
		return err
	})
}

// Checkpoint moves everything in the write-ahead log into the database file
// and empties the log, so the file alone holds it: cardd restore then moves
// that one file into place.
func (s *Store) Checkpoint(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`)
	return err
}

// SetRestoreBooks books msat (either sign, 0 for nothing) to pool against
// world after a restore and records it in the same transaction:
// restore.reconciled is "<msat> <unix at>" and restore.reconcile is done. It
// runs only from the state the ledger saw (from: pending or no_channel; else
// ErrConflict), so the books are set once, and like AdjustPool never with a
// payment in progress. channelLater remembers (meta restore.channel_later)
// that phoenixd had no channel when the books were set, so that one coming
// back is booked once more: from "channel_later" is that second setting, and
// needs the restore done with that key present (else ErrConflict); it deletes
// the key.
func (s *Store) SetRestoreBooks(ctx context.Context, from string, msat int64, note string, at time.Time, channelLater bool) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		var state string
		err := tx.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = 'restore.reconcile'`).Scan(&state)
		want := from
		if from == "channel_later" {
			want = "done"
		}
		if errors.Is(err, sql.ErrNoRows) || err == nil && state != want {
			return fmt.Errorf("%w: the restore is %q, not %q", ErrConflict, state, from)
		}
		if err != nil {
			return err
		}
		if from == "channel_later" {
			var one string
			if err := tx.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = 'restore.channel_later'`).Scan(&one); errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("%w: no channel is awaited", ErrConflict)
			} else if err != nil {
				return err
			}
		}
		var open int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM holds WHERE state = 'open'`).Scan(&open); err != nil {
			return err
		}
		if open > 0 {
			return ErrPaymentInProgress
		}
		now := s.now().Unix()
		if msat != 0 {
			if _, err := s.post(ctx, tx, now, KindAdjust, "", note, Entry{Pool, msat}, Entry{World, -msat}); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM meta WHERE key IN ('restore.waiting_since', 'restore.channel_later')`); err != nil {
			return err
		}
		if channelLater {
			if _, err := tx.ExecContext(ctx, `INSERT INTO meta (key, value, updated_at) VALUES ('restore.channel_later', '1', ?)`, now); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO meta (key, value, updated_at) VALUES ('restore.reconciled', ?, ?), ('restore.reconcile', 'done', ?)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			fmt.Sprintf("%d %d", msat, at.Unix()), now, now)
		return err
	})
}
