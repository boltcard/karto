package store

import (
	"context"
	"time"
)

// refundLinkUnclaimed is how long a tap's refund link lives when no terminal
// ever sent its invoice for the tap's k1: such a tap paid nothing, so nobody
// will want to refund it.
const refundLinkUnclaimed = 24 * time.Hour

// NewRefundLink keeps a per-tap refund link of one of this server's cards:
// token pays back cardID only, until expires; k1 is the tap's,
// whose claim marks the link as one a terminal took the invoice for.
func (s *Store) NewRefundLink(ctx context.Context, token, cardID, k1 string, expires time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO refund_links (token, card_id, k1, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		token, cardID, k1, s.now().Unix(), expires.Unix())
	return err
}

// RefundLinkCard is the card a refund link pays into, whatever its state
// (the caller says whether it can receive): ErrNotFound for a token unknown
// or expired.
func (s *Store) RefundLinkCard(ctx context.Context, token string) (Card, error) {
	return scanCard(s.db.QueryRowContext(ctx, `SELECT `+cardCols+` FROM cards WHERE id =
		(SELECT card_id FROM refund_links WHERE token = ? AND expires_at >= ?)`, token, s.now().Unix()))
}

// PruneRefundLinks deletes the links past their time, and those of taps no
// terminal claimed within refundLinkUnclaimed.
func (s *Store) PruneRefundLinks(ctx context.Context, now time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM refund_links WHERE expires_at < ? OR (claimed_at IS NULL AND created_at < ?)`,
		now.Unix(), now.Add(-refundLinkUnclaimed).Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
