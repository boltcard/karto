package store

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
)

// ErrBadMetaKey means a meta key is not lower-case letters, digits, '.' or '_'.
var ErrBadMetaKey = errors.New("store: meta key must match [a-z0-9._]+")

var metaKey = regexp.MustCompile(`^[a-z0-9._]+$`)

// SetMeta stores a deployment fact (VM id, hostname, mail.tm address, ...).
// The meta table is in every backup, so restore can read these back.
func (s *Store) SetMeta(ctx context.Context, key, value string) error {
	if !metaKey.MatchString(key) {
		return ErrBadMetaKey
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key, value, s.now().Unix())
	return err
}

func (s *Store) GetMeta(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return v, err
}

func (s *Store) ListMeta(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key, value FROM meta ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// SetMetas stores several facts in one transaction: all of them, or none if
// a key is bad.
func (s *Store) SetMetas(ctx context.Context, kv map[string]string) error {
	for k := range kv {
		if !metaKey.MatchString(k) {
			return ErrBadMetaKey
		}
	}
	return s.inTx(ctx, func(tx *sql.Tx) error {
		for k, v := range kv {
			if _, err := tx.ExecContext(ctx, `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
				ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, k, v, s.now().Unix()); err != nil {
				return err
			}
		}
		return nil
	})
}

// DeleteMeta removes facts; a key that isn't there is fine.
func (s *Store) DeleteMeta(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	args := make([]any, len(keys))
	for i, k := range keys {
		if !metaKey.MatchString(k) {
			return ErrBadMetaKey
		}
		args[i] = k
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM meta WHERE key IN (?`+strings.Repeat(", ?", len(keys)-1)+`)`, args...)
	return err
}
