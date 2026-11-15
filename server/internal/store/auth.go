package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

var (
	ErrRequestInProgress = errors.New("store: a request with this id is still being handled")
	ErrRequestMismatch   = errors.New("store: this request id was used with a different body")
)

// SeeSignature records an accepted signature's hash until expires and
// reports whether it was new. Hashes past their expiry are forgotten.
func (s *Store) SeeSignature(ctx context.Context, hash string, expires time.Time) (bool, error) {
	var fresh bool
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		now := s.now().Unix()
		if _, err := tx.ExecContext(ctx, `DELETE FROM seen_signatures WHERE expires_at < ?`, now); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO seen_signatures (hash, expires_at) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING`,
			hash, expires.Unix())
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		fresh = n == 1
		return nil
	})
	return fresh, err
}

// StoredResponse is the answer a request id got the first time.
type StoredResponse struct {
	Status int
	Body   string
}

// BeginRequest claims a request id for a body. A new id returns nil; an id
// already answered for the same body returns that answer; an id still being
// handled is ErrRequestInProgress; an id used with another body is
// ErrRequestMismatch.
func (s *Store) BeginRequest(ctx context.Context, id, bodyHash string) (*StoredResponse, error) {
	var out *StoredResponse
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var hash string
		var status sql.NullInt64
		var body sql.NullString
		err := tx.QueryRowContext(ctx, `SELECT body_hash, status, response FROM requests WHERE id = ?`, id).Scan(&hash, &status, &body)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			_, err = tx.ExecContext(ctx, `INSERT INTO requests (id, body_hash, created_at) VALUES (?, ?, ?)`, id, bodyHash, s.now().Unix())
			return err
		case err != nil:
			return err
		case hash != bodyHash:
			return ErrRequestMismatch
		case !status.Valid:
			return ErrRequestInProgress
		}
		out = &StoredResponse{Status: int(status.Int64), Body: body.String}
		return nil
	})
	return out, err
}

// FinishRequest stores the answer to a request id.
func (s *Store) FinishRequest(ctx context.Context, id string, status int, body string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE requests SET status = ?, response = ? WHERE id = ?`, status, body, id)
	return err
}

// ForgetRequest drops a request id that has no answer yet (the phone gave up
// on it), so a retry runs again; an answered id is kept.
func (s *Store) ForgetRequest(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM requests WHERE id = ? AND status IS NULL`, id)
	return err
}

// TidyAtStart runs before cardd serves. It forgets request ids that were
// never answered (cardd stopped while handling them), so a retry runs again;
// the ref a move's transaction or a send's hold carries keeps that retry from
// moving or paying twice. It also drops answers
// older than 7 days and k1s that have expired.
func (s *Store) TidyAtStart(ctx context.Context) error {
	now := s.now()
	if _, err := s.db.ExecContext(ctx, `DELETE FROM requests WHERE status IS NULL OR created_at < ?`, now.Add(-7*24*time.Hour).Unix()); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM k1s WHERE expires_at < ?`, now.Unix())
	return err
}

// IssueK1 records a one-use k1 for a card's withdraw, valid until expires.
func (s *Store) IssueK1(ctx context.Context, k1, cardID string, expires time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO k1s (k1, card_id, expires_at) VALUES (?, ?, ?)`, k1, cardID, expires.Unix())
	return err
}

// ErrBadK1: the k1 is unknown, used or expired.
var ErrBadK1 = errors.New("store: k1 is unknown, used or expired")

// LookupK1 returns the card of a k1 that is unused and unexpired, without
// using it.
func (s *Store) LookupK1(ctx context.Context, k1 string) (string, error) {
	var cardID string
	err := s.db.QueryRowContext(ctx, `SELECT card_id FROM k1s WHERE k1 = ? AND used_at IS NULL AND expires_at >= ?`, k1, s.now().Unix()).Scan(&cardID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrBadK1
	}
	return cardID, err
}

// ClaimK1 uses a k1 once and returns its card's id.
func (s *Store) ClaimK1(ctx context.Context, k1 string) (string, error) {
	var cardID string
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		now := s.now().Unix()
		err := tx.QueryRowContext(ctx, `SELECT card_id FROM k1s WHERE k1 = ? AND used_at IS NULL AND expires_at >= ?`, k1, now).Scan(&cardID)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrBadK1
		}
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE k1s SET used_at = ? WHERE k1 = ?`, now, k1); err != nil {
			return err
		}
		// The tap's refund link is one a terminal took the invoice for:
		// it lives its full time from now on.
		_, err = tx.ExecContext(ctx, `UPDATE refund_links SET claimed_at = ? WHERE k1 = ? AND claimed_at IS NULL`, now, k1)
		return err
	})
	return cardID, err
}
