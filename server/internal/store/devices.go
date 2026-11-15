package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Role is what a paired device may do: an owner is a phone
// running Karto Wallet, which may do everything; a PoS phone may only sell.
// A device's role never changes.
type Role string

const (
	RoleOwner Role = "owner"
	RolePos   Role = "pos"
)

type Device struct {
	KeyID     string
	PublicKey string // hex, uncompressed P-256 point (65 bytes)
	Name      string
	Role      Role // RoleOwner if empty when added
	CreatedAt time.Time
	RevokedAt *time.Time
}

func (s *Store) AddDevice(ctx context.Context, d Device) error {
	role := d.Role
	if role == "" {
		role = RoleOwner
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO devices (key_id, public_key, name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
		d.KeyID, d.PublicKey, d.Name, role, s.now().Unix())
	return err
}

func (s *Store) GetDevice(ctx context.Context, keyID string) (Device, error) {
	return scanDevice(s.db.QueryRowContext(ctx, `SELECT key_id, public_key, name, role, created_at, revoked_at FROM devices WHERE key_id = ?`, keyID))
}

func (s *Store) ListDevices(ctx context.Context) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key_id, public_key, name, role, created_at, revoked_at FROM devices ORDER BY created_at, key_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// RevokeDevice revokes a device and forgets its push endpoint.
func (s *Store) RevokeDevice(ctx context.Context, keyID string) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL`, s.now().Unix(), keyID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM push_endpoints WHERE key_id = ?`, keyID)
		return err
	})
}

func scanDevice(r scanner) (Device, error) {
	var d Device
	var created int64
	var revoked sql.NullInt64
	err := r.Scan(&d.KeyID, &d.PublicKey, &d.Name, &d.Role, &created, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, ErrNotFound
	}
	d.CreatedAt = time.Unix(created, 0)
	if revoked.Valid {
		t := time.Unix(revoked.Int64, 0)
		d.RevokedAt = &t
	}
	return d, err
}

// RevokeOthers revokes every active owner but keep, for a restore onto a new
// phone, and reports how many it revoked. keep must
// be a known, active owner: anything else would lock this phone out too. PoS
// phones stay paired.
func (s *Store) RevokeOthers(ctx context.Context, keep string) (int, error) {
	var n int64
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var revoked sql.NullInt64
		var role Role
		err := tx.QueryRowContext(ctx, `SELECT revoked_at, role FROM devices WHERE key_id = ?`, keep).Scan(&revoked, &role)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: device %q", ErrNotFound, keep)
		}
		if err != nil {
			return err
		}
		if revoked.Valid {
			return fmt.Errorf("%w: device %s is revoked", ErrConflict, keep)
		}
		if role != RoleOwner {
			return fmt.Errorf("%w: device %s is a PoS phone", ErrConflict, keep)
		}
		res, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at = ? WHERE key_id != ? AND revoked_at IS NULL AND role = 'owner'`, s.now().Unix(), keep)
		if err != nil {
			return err
		}
		n, err = res.RowsAffected()
		if err != nil {
			return err
		}
		// The revoked phones' alerts stop with them.
		_, err = tx.ExecContext(ctx, `DELETE FROM push_endpoints WHERE key_id != ?
			AND key_id IN (SELECT key_id FROM devices WHERE role = 'owner')`, keep)
		return err
	})
	return int(n), err
}
