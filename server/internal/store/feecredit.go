package store

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"
)

// keptFeeCreditKey is where cardd keeps the fee credit of phoenixd's it has
// accounted for. phoenixd
// reports a payment it set aside as fee credit exactly like one that reached
// the balance; the rise of its fee credit over this figure is what tells
// them apart.
const keptFeeCreditKey = "phoenixd.fee_credit_sat"

// FeeCreditMove is how a credit moves the kept fee credit, in the credit's
// own transaction and only if the credit is made: up by the share of a
// payment that was set aside, or set outright to phoenixd's figure by a
// payment that bought room. The zero value moves nothing.
type FeeCreditMove struct {
	AddSat int64
	Set    bool
	ToSat  int64
}

func keptFeeCredit(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}) (sat int64, known bool, err error) {
	var v string
	err = q.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, keptFeeCreditKey).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	sat, err = strconv.ParseInt(v, 10, 64)
	return sat, err == nil, err
}

// KeptFeeCredit is the fee credit cardd has accounted for, and whether it
// has a figure yet: a server has none until its first is taken from phoenixd.
func (s *Store) KeptFeeCredit(ctx context.Context) (sat int64, known bool, err error) {
	return keptFeeCredit(ctx, s.db)
}

// SetKeptFeeCredit sets the kept fee credit outright.
func (s *Store) SetKeptFeeCredit(ctx context.Context, sat int64) error {
	return s.SetMeta(ctx, keptFeeCreditKey, strconv.FormatInt(sat, 10))
}

// ForgetKeptFeeCredit drops the kept fee credit: cardd has no figure again
// until its next first one is taken from phoenixd, and credits a payment
// whole meanwhile.
func (s *Store) ForgetKeptFeeCredit(ctx context.Context) error {
	return s.DeleteMeta(ctx, keptFeeCreditKey)
}

// moveFeeCredit applies m in tx. A share added to a figure not yet known
// counts from nothing.
func moveFeeCredit(ctx context.Context, tx *sql.Tx, now int64, m FeeCreditMove) error {
	if !m.Set && m.AddSat == 0 {
		return nil
	}
	to := m.ToSat
	if !m.Set {
		kept, _, err := keptFeeCredit(ctx, tx)
		if err != nil {
			return err
		}
		to = kept + m.AddSat
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, keptFeeCreditKey, strconv.FormatInt(to, 10), now)
	return err
}

// Credited reports whether the payment with this hash is in the books
// already: a top-up's or a sale's transaction carries it as its ref.
func (s *Store) Credited(ctx context.Context, paymentHash string) (bool, error) {
	if paymentHash == "" {
		return false, nil
	}
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM ledger_tx WHERE ref = ?`, paymentHash).Scan(&n)
	return n > 0, err
}

// PaidOutSince is the most msat cardd's own payments can have freed in the
// channel since then: a payment going out makes room, so room seen now
// doesn't prove there was room a moment ago, beyond what is left without
// them. Each counts for its amount and its whole fee budget: one begun or
// ended since then, and one still under way, which may end at any moment.
func (s *Store) PaidOutSince(ctx context.Context, since time.Time) (int64, error) {
	var msat int64
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(amount_msat + fee_budget_msat), 0) FROM holds
		WHERE state = 'open' OR created_at >= ? OR resolved_at >= ?`, since.Unix(), since.Unix()).Scan(&msat)
	return msat, err
}
