package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

type CardState string

const (
	StateProgramming CardState = "programming"
	StateActive      CardState = "active"
	StateFrozen      CardState = "frozen"
	StateWiping      CardState = "wiping"
	StateReset       CardState = "reset"
)

type Card struct {
	ID          string // hex of PRF(IssuerKey, '2d003f7b' || UID)
	Version     uint32
	State       CardState
	LastCounter int64 // -1 until the first tap is seen
	Name        string
	PerTapSat   int64 // spending limits
	DailySat    int64
	// LimitCurrency, if not "", is the currency the limits are kept in, and
	// PerTapMinor and DailyMinor are they, in its minor units; PerTapSat and DailySat
	// are then unused. "": the limits are in sat.
	LimitCurrency string
	PerTapMinor   int64
	DailyMinor    int64
	Host          string // the host its URL points at
	// NeedsCheck: restored from a backup (PrepareRestored), the card can't
	// pay until its owner's phone has checked a tap of it (CheckCounter),
	// which moves the counter to the card's own.
	NeedsCheck bool
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

const cardCols = `id, version, state, last_counter, name, per_tap_sat, daily_sat, host, created_at, updated_at,
	COALESCE(limit_currency, ''), COALESCE(per_tap_minor, 0), COALESCE(daily_minor, 0), needs_check`

type scanner interface{ Scan(...any) error }

func scanCard(r scanner) (Card, error) {
	var c Card
	var created, updated int64
	err := r.Scan(&c.ID, &c.Version, &c.State, &c.LastCounter, &c.Name, &c.PerTapSat, &c.DailySat, &c.Host, &created, &updated,
		&c.LimitCurrency, &c.PerTapMinor, &c.DailyMinor, &c.NeedsCheck)
	if errors.Is(err, sql.ErrNoRows) {
		return Card{}, ErrNotFound
	}
	c.CreatedAt, c.UpdatedAt = time.Unix(created, 0), time.Unix(updated, 0)
	return c, err
}

func (s *Store) GetCard(ctx context.Context, id string) (Card, error) {
	return scanCard(s.db.QueryRowContext(ctx, `SELECT `+cardCols+` FROM cards WHERE id = ?`, id))
}

// ReserveCard picks the version to program a card at, and names it (an empty name keeps the stored one):
// 0 for an unknown card, the same version again while it is still
// programming, and version+1 for a card that was wiped (reset).
// Any other state is ErrConflict. host is the one the card's URL will point at.
func (s *Store) ReserveCard(ctx context.Context, id, name, host string) (Card, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Card{}, err
	}
	defer tx.Rollback()
	now := s.now().Unix()
	c, err := scanCard(tx.QueryRowContext(ctx, `SELECT `+cardCols+` FROM cards WHERE id = ?`, id))
	switch {
	case errors.Is(err, ErrNotFound):
		_, err = tx.ExecContext(ctx, `INSERT INTO cards (id, version, state, last_counter, name, host, created_at, updated_at)
			VALUES (?, 0, ?, -1, ?, ?, ?, ?)`, id, StateProgramming, name, host, now, now)
	case err != nil:
		return Card{}, err
	case c.State == StateProgramming:
		if (name == "" || name == c.Name) && host == c.Host {
			return c, nil
		}
		_, err = tx.ExecContext(ctx, `UPDATE cards SET name = CASE WHEN ? = '' THEN name ELSE ? END, host = ?, updated_at = ?
			WHERE id = ?`, name, name, host, now, id)
	case c.State == StateReset:
		// New keys: the taps recorded before are another version's, so no check is needed.
		_, err = tx.ExecContext(ctx, `UPDATE cards SET version = version + 1, state = ?, last_counter = -1, needs_check = 0,
			name = CASE WHEN ? = '' THEN name ELSE ? END, host = ?, updated_at = ? WHERE id = ?`,
			StateProgramming, name, name, host, now, id)
	default:
		return Card{}, ErrConflict
	}
	if err != nil {
		return Card{}, err
	}
	c, err = scanCard(tx.QueryRowContext(ctx, `SELECT `+cardCols+` FROM cards WHERE id = ?`, id))
	if err != nil {
		return Card{}, err
	}
	return c, tx.Commit()
}

// ActivateCard moves a programming card to active and records the counter
// from its confirming tap. Like AdvanceCounter, the counter must be strictly
// above the last one seen (ErrReplayed otherwise).
func (s *Store) ActivateCard(ctx context.Context, id string, counter uint32) (Card, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE cards SET state = ?, last_counter = ?, updated_at = ?
		WHERE id = ? AND state = ? AND last_counter < ?`, StateActive, counter, s.now().Unix(), id, StateProgramming, counter)
	if err != nil {
		return Card{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		c, err := s.GetCard(ctx, id)
		if err != nil {
			return Card{}, err
		}
		if c.State == StateProgramming {
			return Card{}, ErrReplayed
		}
		return Card{}, ErrConflict
	}
	return s.GetCard(ctx, id)
}

// AdoptCard adds a card found again by a tap after a phrase-only rebuild:
// active at the version its tap was checked with, the tap's
// counter seen. A card already known is ErrConflict.
func (s *Store) AdoptCard(ctx context.Context, id string, version uint32, name string, counter uint32, host string) (Card, error) {
	now := s.now().Unix()
	res, err := s.db.ExecContext(ctx, `INSERT INTO cards (id, version, state, last_counter, name, host, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`, id, version, StateActive, counter, name, host, now, now)
	if err != nil {
		return Card{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Card{}, fmt.Errorf("%w: the card is already known", ErrConflict)
	}
	return s.GetCard(ctx, id)
}

// AdvanceCounter records a tap's counter. It fails with ErrReplayed unless
// counter is strictly above the last one seen, so of two racing requests
// with the same counter exactly one succeeds.
func (s *Store) AdvanceCounter(ctx context.Context, id string, counter uint32) error {
	res, err := s.db.ExecContext(ctx, `UPDATE cards SET last_counter = ?, updated_at = ?
		WHERE id = ? AND last_counter < ?`, counter, s.now().Unix(), id, counter)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if _, err := s.GetCard(ctx, id); err != nil {
			return err
		}
		return ErrReplayed
	}
	return nil
}

// CheckCounter records the counter of a tap the owner's phone checked
// (cards.Service.Check) and clears NeedsCheck: like AdvanceCounter, only a
// counter strictly above the last one seen (ErrReplayed otherwise, the mark
// kept).
func (s *Store) CheckCounter(ctx context.Context, id string, counter uint32) error {
	res, err := s.db.ExecContext(ctx, `UPDATE cards SET last_counter = ?, needs_check = 0, updated_at = ?
		WHERE id = ? AND last_counter < ?`, counter, s.now().Unix(), id, counter)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if _, err := s.GetCard(ctx, id); err != nil {
			return err
		}
		return ErrReplayed
	}
	return nil
}

// ListCards returns every card, oldest first.
func (s *Store) ListCards(ctx context.Context) ([]Card, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+cardCols+` FROM cards ORDER BY created_at, rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Card{}
	for rows.Next() {
		c, err := scanCard(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// RenameCard sets a card's name. A wiped (reset) card is not renamed.
func (s *Store) RenameCard(ctx context.Context, id, name string) (Card, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE cards SET name = ?, updated_at = ? WHERE id = ? AND state != ?`,
		name, s.now().Unix(), id, StateReset)
	if err != nil {
		return Card{}, err
	}
	return s.afterUpdate(ctx, res, id)
}

// SetCardHost records the host a card's URL points at after a re-point. A
// wiped (reset) card has no URL.
func (s *Store) SetCardHost(ctx context.Context, id, host string) (Card, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE cards SET host = ?, updated_at = ? WHERE id = ? AND state != ?`,
		host, s.now().Unix(), id, StateReset)
	if err != nil {
		return Card{}, err
	}
	return s.afterUpdate(ctx, res, id)
}

// StartWipe moves a card to wiping, which blocks spending, and in the same
// transaction moves its balance to pool. A card with a payment in progress
// can't start a wipe. Repeating it is fine.
func (s *Store) StartWipe(ctx context.Context, id string) (Card, error) {
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		c, err := scanCard(tx.QueryRowContext(ctx, `SELECT `+cardCols+` FROM cards WHERE id = ?`, id))
		if err != nil {
			return err
		}
		switch c.State {
		case StateActive, StateFrozen, StateProgramming, StateWiping:
		default:
			return fmt.Errorf("%w: card is %s", ErrConflict, c.State)
		}
		acct := CardAccount(id)
		b, err := balance(ctx, tx, acct)
		if err != nil {
			return err
		}
		if b.HeldMsat > 0 {
			return fmt.Errorf("%w: a payment is in progress on this card", ErrConflict)
		}
		now := s.now().Unix()
		if b.EntriesMsat != 0 {
			if _, err := s.post(ctx, tx, now, KindWipe, "", "card wiped: its balance moved to pool",
				Entry{acct, -b.EntriesMsat}, Entry{Pool, b.EntriesMsat}); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `UPDATE cards SET state = ?, updated_at = ? WHERE id = ?`, StateWiping, now, id)
		return err
	})
	if err != nil {
		return Card{}, err
	}
	return s.GetCard(ctx, id)
}

// FreezeCard stops a card spending; it keeps its balance and still takes top-ups.
func (s *Store) FreezeCard(ctx context.Context, id string) (Card, error) {
	return s.move(ctx, id, StateFrozen, StateActive, StateFrozen)
}

// UnfreezeCard lets a frozen card spend again.
func (s *Store) UnfreezeCard(ctx context.Context, id string) (Card, error) {
	return s.move(ctx, id, StateActive, StateFrozen, StateActive)
}

// SetLimits sets a card's per-tap and 24-hour spending limits, in sat, and
// drops any limits it had in a currency.
func (s *Store) SetLimits(ctx context.Context, id string, perTapSat, dailySat int64) (Card, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE cards SET per_tap_sat = ?, daily_sat = ?,
		limit_currency = NULL, per_tap_minor = NULL, daily_minor = NULL, updated_at = ? WHERE id = ? AND state != ?`,
		perTapSat, dailySat, s.now().Unix(), id, StateReset)
	if err != nil {
		return Card{}, err
	}
	return s.afterUpdate(ctx, res, id)
}

// SetLimitsMinor sets a card's per-tap and 24-hour limits in a currency, in
// its minor units, kept in
// it whatever the server's currency becomes. per_tap_sat and daily_sat stay
// as they were, unused while it is set. The caller checks the figures
// (cards.Service.SetLimitsMinor). A wiped (reset) card is not changed.
func (s *Store) SetLimitsMinor(ctx context.Context, id, currency string, perTapMinor, dailyMinor int64) (Card, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE cards SET limit_currency = ?, per_tap_minor = ?, daily_minor = ?, updated_at = ?
		WHERE id = ? AND state != ?`, currency, perTapMinor, dailyMinor, s.now().Unix(), id, StateReset)
	if err != nil {
		return Card{}, err
	}
	return s.afterUpdate(ctx, res, id)
}

// FinishWipe moves a wiping card to reset. The version is kept, so the next
// add programs version+1. Repeating it is fine.
func (s *Store) FinishWipe(ctx context.Context, id string) (Card, error) {
	return s.move(ctx, id, StateReset, StateWiping, StateReset)
}

// move sets a card's state if it is in one of from; ErrConflict (naming the
// state it is in) otherwise, ErrNotFound for an unknown card.
func (s *Store) move(ctx context.Context, id string, to CardState, from ...CardState) (Card, error) {
	args := []any{to, s.now().Unix(), id}
	for _, f := range from {
		args = append(args, f)
	}
	res, err := s.db.ExecContext(ctx, `UPDATE cards SET state = ?, updated_at = ? WHERE id = ? AND state IN (?`+
		strings.Repeat(", ?", len(from)-1)+`)`, args...)
	if err != nil {
		return Card{}, err
	}
	return s.afterUpdate(ctx, res, id)
}

// afterUpdate returns the card an UPDATE changed, or why it changed nothing.
func (s *Store) afterUpdate(ctx context.Context, res sql.Result, id string) (Card, error) {
	if n, _ := res.RowsAffected(); n == 0 {
		c, err := s.GetCard(ctx, id)
		if err != nil {
			return Card{}, err
		}
		return Card{}, fmt.Errorf("%w: card is %s", ErrConflict, c.State)
	}
	return s.GetCard(ctx, id)
}

// CardByPrefix finds the one card whose id starts with prefix (a top-up
// address carries the first 10 hex characters).
func (s *Store) CardByPrefix(ctx context.Context, prefix string) (Card, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+cardCols+` FROM cards WHERE substr(id, 1, ?) = ? LIMIT 2`, len(prefix), prefix)
	if err != nil {
		return Card{}, err
	}
	defer rows.Close()
	var found []Card
	for rows.Next() {
		c, err := scanCard(rows)
		if err != nil {
			return Card{}, err
		}
		found = append(found, c)
	}
	if err := rows.Err(); err != nil {
		return Card{}, err
	}
	if len(found) != 1 {
		return Card{}, ErrNotFound
	}
	return found[0], nil
}
