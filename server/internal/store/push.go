package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/boltcard/karto/server/internal/webpush"
)

// PushEndpoint is where one owner phone's alerts are pushed: a Web Push subscription
// (Endpoint, P256dh and Auth, the last two base64url), by Transport
// "unifiedpush" (ntfy's, say) or "fcm". DeliveredAt and FailedAt are nil
// until the first; Failures counts the failures since the last delivery.
type PushEndpoint struct {
	KeyID, Endpoint, P256dh, Auth, Transport string
	CreatedAt                                time.Time
	DeliveredAt, FailedAt                    *time.Time
	Failure                                  string
	Failures                                 int
}

const pushCols = `key_id, endpoint, p256dh, auth, transport, created_at, delivered_at, failed_at, failure, failures`

func scanPush(r scanner) (PushEndpoint, error) {
	var e PushEndpoint
	var created int64
	var delivered, failed sql.NullInt64
	err := r.Scan(&e.KeyID, &e.Endpoint, &e.P256dh, &e.Auth, &e.Transport, &created, &delivered, &failed, &e.Failure, &e.Failures)
	if errors.Is(err, sql.ErrNoRows) {
		return PushEndpoint{}, ErrNotFound
	}
	e.CreatedAt = time.Unix(created, 0)
	if delivered.Valid {
		t := time.Unix(delivered.Int64, 0)
		e.DeliveredAt = &t
	}
	if failed.Valid {
		t := time.Unix(failed.Int64, 0)
		e.FailedAt = &t
	}
	return e, err
}

// SetPushEndpoint saves a device's endpoint, replacing its old one (and
// starting its record of deliveries again). A device that is unknown or
// revoked is ErrNotFound. CreatedAt is now, whatever e says.
func (s *Store) SetPushEndpoint(ctx context.Context, e PushEndpoint) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		var revoked sql.NullInt64
		err := tx.QueryRowContext(ctx, `SELECT revoked_at FROM devices WHERE key_id = ?`, e.KeyID).Scan(&revoked)
		if errors.Is(err, sql.ErrNoRows) || err == nil && revoked.Valid {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO push_endpoints (key_id, endpoint, p256dh, auth, transport, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (key_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh,
				auth = excluded.auth, transport = excluded.transport, created_at = excluded.created_at,
				delivered_at = NULL, failed_at = NULL, failure = '', failures = 0`,
			e.KeyID, e.Endpoint, e.P256dh, e.Auth, e.Transport, s.now().Unix())
		return err
	})
}

// PushEndpointOf is a device's endpoint, ErrNotFound for none.
func (s *Store) PushEndpointOf(ctx context.Context, keyID string) (PushEndpoint, error) {
	return scanPush(s.db.QueryRowContext(ctx, `SELECT `+pushCols+` FROM push_endpoints WHERE key_id = ?`, keyID))
}

// OwnerPushEndpoints are the endpoints of the owner phones not revoked, the
// ones an alert goes to.
func (s *Store) OwnerPushEndpoints(ctx context.Context) ([]PushEndpoint, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+pushCols+` FROM push_endpoints
		WHERE key_id IN (SELECT key_id FROM devices WHERE role = 'owner' AND revoked_at IS NULL)
		ORDER BY created_at, key_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PushEndpoint
	for rows.Next() {
		e, err := scanPush(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// DeletePushEndpoint forgets a device's endpoint; none is not an error.
func (s *Store) DeletePushEndpoint(ctx context.Context, keyID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM push_endpoints WHERE key_id = ?`, keyID)
	return err
}

// PushDelivered notes a delivery: the run of failures ends.
func (s *Store) PushDelivered(ctx context.Context, keyID string, at time.Time) error {
	return changed(s.db.ExecContext(ctx, `UPDATE push_endpoints SET delivered_at = ?, failures = 0, failure = '' WHERE key_id = ?`,
		at.Unix(), keyID))
}

// PushFailed notes a failed delivery and why.
func (s *Store) PushFailed(ctx context.Context, keyID string, at time.Time, why string) error {
	return changed(s.db.ExecContext(ctx, `UPDATE push_endpoints SET failed_at = ?, failure = ?, failures = failures + 1 WHERE key_id = ?`,
		at.Unix(), why, keyID))
}

const vapidMeta = "push.vapid"

// VAPIDKey is the server's VAPID key (webpush.VAPID.Marshal), made and saved
// on the first call. Two first calls at once end with the same key: each
// inserts unless a key is there, then reads what is.
func (s *Store) VAPIDKey(ctx context.Context) (string, error) {
	if v, err := s.GetMeta(ctx, vapidMeta); err == nil {
		return v, nil
	} else if !errors.Is(err, ErrNotFound) {
		return "", err
	}
	k, err := webpush.NewVAPID()
	if err != nil {
		return "", fmt.Errorf("store: making the VAPID key: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO NOTHING`, vapidMeta, k.Marshal(), s.now().Unix()); err != nil {
		return "", err
	}
	return s.GetMeta(ctx, vapidMeta)
}

// PostedLine reads a transaction Posted named, as the account it is for sees
// it: its one leg that is not World or Fees (a fee-adjust's is the card's, a
// move's the one that received). ErrNotFound for no such id, and for one with
// no such leg (a sale of nothing has none).
func (s *Store) PostedLine(ctx context.Context, id int64) (Line, Account, error) {
	var acct Account
	err := s.db.QueryRowContext(ctx, `SELECT account FROM ledger_entry
		WHERE tx_id = ? AND account NOT IN (?, ?)
		ORDER BY account LIKE 'card:%' DESC, amount_msat DESC, rowid LIMIT 1`, id, World, Fees).Scan(&acct)
	if errors.Is(err, sql.ErrNoRows) {
		return Line{}, "", ErrNotFound
	}
	if err != nil {
		return Line{}, "", err
	}
	l, err := s.Line(ctx, acct, id)
	return l, acct, err
}
