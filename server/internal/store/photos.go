package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
)

// PhotoTag names a photo in the card list: the first 16 hex digits of its
// JPEG's SHA-256, so the phone fetches a photo again only when it changed.
func PhotoTag(jpeg []byte) string {
	sum := sha256.Sum256(jpeg)
	return hex.EncodeToString(sum[:])[:16]
}

// SetPhoto keeps jpeg as the card's photo, replacing any it had, and answers
// its tag. The card's updated_at moves too: a snapshot's summary dates its
// last write by it; the same photo again changes nothing, the date included.
// ErrNotFound for an unknown card; ErrConflict for a wiped
// (reset) one, which keeps the photo it has.
func (s *Store) SetPhoto(ctx context.Context, id string, jpeg []byte) (string, error) {
	sum := sha256.Sum256(jpeg)
	full := hex.EncodeToString(sum[:])
	now := s.now().Unix()
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := photoChangeable(ctx, tx, id); err != nil {
			return err
		}
		var have string
		err := tx.QueryRowContext(ctx, `SELECT sha256 FROM card_photos WHERE card_id = ?`, id).Scan(&have)
		if err == nil && have == full {
			return nil
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO card_photos (card_id, jpeg, sha256, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (card_id) DO UPDATE SET jpeg = excluded.jpeg, sha256 = excluded.sha256, updated_at = excluded.updated_at`,
			id, jpeg, full, now); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE cards SET updated_at = ? WHERE id = ?`, now, id)
		return err
	})
	if err != nil {
		return "", err
	}
	return full[:16], nil
}

// RemovePhoto removes the card's photo; a card with none is fine and isn't
// changed. ErrNotFound and ErrConflict as SetPhoto.
func (s *Store) RemovePhoto(ctx context.Context, id string) error {
	now := s.now().Unix()
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if err := photoChangeable(ctx, tx, id); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `DELETE FROM card_photos WHERE card_id = ?`, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil
		}
		_, err = tx.ExecContext(ctx, `UPDATE cards SET updated_at = ? WHERE id = ?`, now, id)
		return err
	})
}

// photoChangeable looks the card up in the write's own transaction, so an
// unknown card is ErrNotFound rather than a foreign-key error.
func photoChangeable(ctx context.Context, tx *sql.Tx, id string) error {
	var state CardState
	err := tx.QueryRowContext(ctx, `SELECT state FROM cards WHERE id = ?`, id).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if state == StateReset {
		return fmt.Errorf("%w: card is %s", ErrConflict, state)
	}
	return nil
}

// GetPhoto returns the card's photo and its tag; ErrNotFound for a card
// without one, or an unknown card.
func (s *Store) GetPhoto(ctx context.Context, id string) ([]byte, string, error) {
	var jpeg []byte
	var full string
	err := s.db.QueryRowContext(ctx, `SELECT jpeg, sha256 FROM card_photos WHERE card_id = ?`, id).Scan(&jpeg, &full)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	return jpeg, full[:16], nil
}

// PhotoTags returns each card's photo tag, by card id, for the cards that
// have one.
func (s *Store) PhotoTags(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT card_id, substr(sha256, 1, 16) FROM card_photos`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, tag string
		if err := rows.Scan(&id, &tag); err != nil {
			return nil, err
		}
		out[id] = tag
	}
	return out, rows.Err()
}
