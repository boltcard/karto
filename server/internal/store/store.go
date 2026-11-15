// Package store is cardd's SQLite database.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/boltcard/karto/server/internal/rates"
	_ "modernc.org/sqlite"
)

var (
	ErrNotFound = errors.New("store: not found")
	ErrConflict = errors.New("store: conflicting state")
	ErrReplayed = errors.New("store: counter not above last seen")
)

// migrations[i] moves the schema from user_version i to i+1. Append only.
var migrations = []string{
	`CREATE TABLE cards (
		id           TEXT PRIMARY KEY,
		version      INTEGER NOT NULL,
		state        TEXT NOT NULL,
		last_counter INTEGER NOT NULL,
		name         TEXT NOT NULL DEFAULT '',
		created_at   INTEGER NOT NULL,
		updated_at   INTEGER NOT NULL
	);
	CREATE TABLE devices (
		key_id     TEXT PRIMARY KEY,
		public_key TEXT NOT NULL UNIQUE,
		name       TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		revoked_at INTEGER
	);`,
	`CREATE TABLE meta (
		key        TEXT PRIMARY KEY,
		value      TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);`,
	// Money and replay-proof device auth.
	`ALTER TABLE cards ADD COLUMN per_tap_sat INTEGER NOT NULL DEFAULT 20000;
	ALTER TABLE cards ADD COLUMN daily_sat INTEGER NOT NULL DEFAULT 50000;
	CREATE TABLE ledger_tx (
		id         INTEGER PRIMARY KEY,
		kind       TEXT NOT NULL,
		ref        TEXT UNIQUE,
		note       TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL
	);
	CREATE TABLE ledger_entry (
		tx_id       INTEGER NOT NULL REFERENCES ledger_tx (id),
		account     TEXT NOT NULL,
		amount_msat INTEGER NOT NULL
	);
	CREATE INDEX ledger_entry_account ON ledger_entry (account, tx_id);
	CREATE TABLE holds (
		id              INTEGER PRIMARY KEY,
		account         TEXT NOT NULL,
		kind            TEXT NOT NULL,
		amount_msat     INTEGER NOT NULL,
		fee_budget_msat INTEGER NOT NULL,
		payment_hash    TEXT NOT NULL,
		invoice         TEXT NOT NULL,
		state           TEXT NOT NULL,
		fee_msat        INTEGER,
		created_at      INTEGER NOT NULL,
		resolved_at     INTEGER,
		ref             TEXT UNIQUE
	);
	CREATE INDEX holds_account ON holds (account, state);
	CREATE INDEX holds_payment_hash ON holds (payment_hash);
	CREATE TABLE k1s (
		k1         TEXT PRIMARY KEY,
		card_id    TEXT NOT NULL,
		expires_at INTEGER NOT NULL,
		used_at    INTEGER
	);
	CREATE TABLE seen_signatures (
		hash       TEXT PRIMARY KEY,
		expires_at INTEGER NOT NULL
	);
	CREATE TABLE requests (
		id         TEXT PRIMARY KEY,
		body_hash  TEXT NOT NULL,
		status     INTEGER,
		response   TEXT,
		created_at INTEGER NOT NULL
	);`,
	// The host each card's URL points at. An older
	// database's cards point at its own vm.host; a fresh one has no cards.
	`ALTER TABLE cards ADD COLUMN host TEXT NOT NULL DEFAULT '';
	UPDATE cards SET host = COALESCE((SELECT value FROM meta WHERE key = 'vm.host'), '');`,
	// Each card's photo, a 428×270 JPEG thumbnail,
	// in a table of its own so a tap and the card list never
	// read the pictures.
	`CREATE TABLE card_photos (
		card_id    TEXT PRIMARY KEY REFERENCES cards (id),
		jpeg       BLOB NOT NULL,
		sha256     TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);`,
	// The point of sale. A device is an owner (a
	// phone running Karto Wallet) or a PoS phone, which may only sell; a
	// pairing code lets one phone register as a PoS phone, once; a sale is an
	// invoice a PoS phone asked for, and what became of it.
	`ALTER TABLE devices ADD COLUMN role TEXT NOT NULL DEFAULT 'owner';
	CREATE TABLE pos_codes (
		code_hash  TEXT PRIMARY KEY,
		name       TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	);
	CREATE TABLE sales (
		id            TEXT PRIMARY KEY,
		device        TEXT NOT NULL REFERENCES devices (key_id),
		amount_msat   INTEGER NOT NULL,
		state         TEXT NOT NULL,
		payment_hash  TEXT NOT NULL UNIQUE,
		invoice       TEXT NOT NULL,
		created_at    INTEGER NOT NULL,
		expires_at    INTEGER NOT NULL,
		card_at       INTEGER,
		paid_at       INTEGER,
		received_msat INTEGER,
		tx_id         INTEGER REFERENCES ledger_tx (id)
	);
	CREATE INDEX sales_device_state ON sales (device, state);
	CREATE INDEX sales_paid ON sales (paid_at);`,
	// Migration 7: a top-up that bought room before cardd booked its fee
	// says it only in its note,
	// " after N msat of channel fees". Each such
	// top-up with no fees leg gets one, and world's leg grows by N (a top-up
	// credited 0 has none: it gets one). The set is taken first, so the steps
	// after it see the same top-ups; a CAST of something that isn't a number
	// is 0, so N must be more than 0.
	`CREATE TEMP TABLE migration7 AS
		SELECT t.id AS tx_id,
			CAST(substr(t.note, instr(t.note, ' after ') + 7,
				instr(t.note, ' msat of channel fees') - instr(t.note, ' after ') - 7) AS INTEGER) AS fee
		FROM ledger_tx t
		WHERE t.kind = 'topup'
			AND instr(t.note, ' after ') > 0
			AND instr(t.note, ' msat of channel fees') > instr(t.note, ' after ')
			AND NOT EXISTS (SELECT 1 FROM ledger_entry e WHERE e.tx_id = t.id AND e.account = 'fees');
	DELETE FROM migration7 WHERE fee IS NULL OR fee <= 0;
	UPDATE ledger_entry SET amount_msat = amount_msat - (SELECT m.fee FROM migration7 m WHERE m.tx_id = ledger_entry.tx_id)
		WHERE account = 'world' AND tx_id IN (SELECT tx_id FROM migration7);
	INSERT INTO ledger_entry (tx_id, account, amount_msat)
		SELECT m.tx_id, 'world', -m.fee FROM migration7 m
		WHERE NOT EXISTS (SELECT 1 FROM ledger_entry e WHERE e.tx_id = m.tx_id AND e.account = 'world');
	INSERT INTO ledger_entry (tx_id, account, amount_msat) SELECT tx_id, 'fees', fee FROM migration7;
	DROP TABLE migration7;`,
	// Migration 8: what a payment was, kept with its hold (the address or
	// link paid, what it was for, the
	// person's note, its proof once phoenixd gives it, and the transaction it
	// was booked as), and the person's note on any line. preimage NULL: not
	// asked of phoenixd yet; '': phoenixd didn't know it. Old settled holds
	// are linked by the note SettleHold writes and their kind.
	`ALTER TABLE holds ADD COLUMN preimage TEXT;
	ALTER TABLE holds ADD COLUMN destination TEXT NOT NULL DEFAULT '';
	ALTER TABLE holds ADD COLUMN description TEXT NOT NULL DEFAULT '';
	ALTER TABLE holds ADD COLUMN comment TEXT NOT NULL DEFAULT '';
	ALTER TABLE holds ADD COLUMN tx_id INTEGER REFERENCES ledger_tx (id);
	ALTER TABLE ledger_tx ADD COLUMN comment TEXT NOT NULL DEFAULT '';
	UPDATE holds SET tx_id = (SELECT t.id FROM ledger_tx t WHERE t.kind = holds.kind AND t.note = 'paid ' || holds.payment_hash ORDER BY t.id LIMIT 1)
		WHERE state = 'settled';`,
	// Migration 9: a sale a till rang up in the server's
	// currency keeps that price (its sats are amount_msat, as for any sale); a
	// card's limits may be kept in a currency, in its minor units, per_tap_sat
	// and daily_sat then unused. NULL, for everything before: a sale typed in
	// sat, limits in sat.
	`ALTER TABLE sales ADD COLUMN price_currency TEXT;
	ALTER TABLE sales ADD COLUMN price_minor INTEGER;
	ALTER TABLE cards ADD COLUMN limit_currency TEXT;
	ALTER TABLE cards ADD COLUMN per_tap_minor INTEGER;
	ALTER TABLE cards ADD COLUMN daily_minor INTEGER;`,
	// Migration 10: a hold for a BOLT12 offer opens with no payment
	// hash (phoenixd says it only in its answer) and keeps the offer;
	// phoenixd's payment id once known; when cardd last gave up waiting on
	// phoenixd for it (the grace counts from there, across a restart); and
	// why a payment wasn't sent, in words.
	`ALTER TABLE holds ADD COLUMN offer TEXT NOT NULL DEFAULT '';
	ALTER TABLE holds ADD COLUMN payment_id TEXT NOT NULL DEFAULT '';
	ALTER TABLE holds ADD COLUMN gave_up_at INTEGER;
	ALTER TABLE holds ADD COLUMN reason TEXT NOT NULL DEFAULT '';
	CREATE INDEX holds_payment_id ON holds (payment_id);`,
	// Migration 11: a payer's note (LUD-12's comment) kept by its invoice's
	// payment hash
	// until the payment is credited, then on its line. '' for none, and for
	// every line before.
	`CREATE TABLE topup_notes (
		payment_hash TEXT PRIMARY KEY,
		note         TEXT NOT NULL,
		created_at   INTEGER NOT NULL
	);
	ALTER TABLE ledger_tx ADD COLUMN payer_note TEXT NOT NULL DEFAULT '';`,
	// Migration 12: where an owner phone's alerts are pushed, one endpoint
	// per device (its Web Push subscription, with transport "unifiedpush" or
	// "fcm"), with the last delivery and the run of failures.
	`CREATE TABLE push_endpoints (
		key_id TEXT PRIMARY KEY REFERENCES devices(key_id),
		endpoint TEXT NOT NULL,
		p256dh TEXT NOT NULL,
		auth TEXT NOT NULL,
		transport TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		delivered_at INTEGER,
		failed_at INTEGER,
		failure TEXT NOT NULL DEFAULT '',
		failures INTEGER NOT NULL DEFAULT 0
	);`,
	// Migration 13: an address the person took off Send out's Recent
	// list, by lower() of what the list gave as its to, and when. It stays
	// off while removed_at is at or after its last payment's resolved_at.
	`CREATE TABLE recent_removed (
		target     TEXT PRIMARY KEY,
		removed_at INTEGER NOT NULL
	);`,
	// Migration 14, refunds of till sales: a sale keeps the return link its till read from the
	// card's tap (LUD-19's payLink) and the refund's ledger transaction once
	// paid; a refund's hold names its sale, so one refund at a time per sale
	// is checked inside OpenHold; and refund_links are the per-tap links this
	// server's own cards give, each paying back only its card. They outlive
	// a restore: other shops keep them for 400 days.
	`ALTER TABLE sales ADD COLUMN return_link TEXT NOT NULL DEFAULT '';
	ALTER TABLE sales ADD COLUMN refund_tx_id INTEGER;
	ALTER TABLE holds ADD COLUMN sale_id TEXT;
	CREATE INDEX holds_sale ON holds(sale_id) WHERE sale_id IS NOT NULL;
	CREATE INDEX sales_refund ON sales(refund_tx_id) WHERE refund_tx_id IS NOT NULL;
	CREATE TABLE refund_links (
		token      TEXT PRIMARY KEY,
		card_id    TEXT NOT NULL,
		k1         TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		claimed_at INTEGER,
		expires_at INTEGER NOT NULL
	);
	CREATE INDEX refund_links_k1 ON refund_links(k1);`,
	// Migration 15: a line keeps how its money came when that is more than a
	// top-up ("refund":
	// paid through one of this server's refund links), and a sale is found by
	// the line that paid it through its own index, as by its refund's; a
	// line's legs are found by the line (a move's or refund's other account,
	// a refund's amount), not by scanning every account's.
	`ALTER TABLE ledger_tx ADD COLUMN via TEXT NOT NULL DEFAULT '';
	CREATE INDEX sales_tx ON sales(tx_id) WHERE tx_id IS NOT NULL;
	CREATE INDEX ledger_entry_tx ON ledger_entry(tx_id);`,
}

// SchemaVersion is the user_version this cardd migrates a database to; a
// backup with a higher one is from a newer cardd and can't be restored.
func SchemaVersion() int { return len(migrations) }

type Store struct {
	db  *sql.DB
	now func() time.Time

	// Changed, if not nil, is told the accounts whose books a transaction
	// changed, once it has committed: those of a ledger transaction's legs
	// (a leg of nothing too; not world, not fees) and a hold's that was
	// opened, settled or released. Once for a transaction, never for a write
	// that did nothing or a transaction that failed. A held read answers on
	// it. It is
	// called where the write was made, under whatever lock its caller holds:
	// it may ring a bell, and must not use the store or take those locks.
	// Set before the store is used.
	Changed func(accounts []Account)
	// Posted, if not nil, is told the ids of the ledger transactions a
	// transaction newly wrote, once it has committed: every ledger_tx row it
	// inserted, in one call (a settle with a fee-adjust gives both). Never for
	// a ref that was a no-op, nor for a transaction that failed. It is called
	// after Changed and under the same rule: where the write was made, under
	// whatever lock its caller holds, so it must not use the store or take
	// those locks. The alerts' sender reads it. Set before the store is
	// used.
	Posted func(txIDs []int64)
	// Rate, if not nil, is cardd's last rate whole (rates.Source.Last): a
	// bitcoin's price in each currency, whole units, and where it came from;
	// false with none. A tap's checks read it inside their transaction for a
	// card whose limits are in a currency, and log the rate they
	// used; it must not
	// use the store. Set before the store is used.
	Rate func() (rates.Prices, bool)
	// Log, if not nil, is where a tap against limits in a currency writes
	// the rate it was checked at. Set before the store is used.
	Log *log.Logger
	// touched is what the transactions under way have changed so far, each
	// its own: a second caller can be inside inTx waiting for the connection.
	mu      sync.Mutex
	touched map[*sql.Tx][]Account
	// posted is the ledger transactions the ones under way have inserted.
	posted map[*sql.Tx][]int64
}

// Open opens or creates the database at path and applies migrations.
func Open(path string) (*Store, error) {
	// _txlock=immediate: every transaction takes the write lock when it
	// begins, so a second process (cardd-ctl next to cardd serve) waits on
	// busy_timeout instead of failing with SQLITE_BUSY mid-transaction.
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_txlock=immediate")
	if err != nil {
		return nil, err
	}
	// One connection serialises every write, so the read-check-write
	// sequences below cannot interleave.
	db.SetMaxOpenConns(1)
	s := &Store{db: db, now: time.Now}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	if err := s.checkOwnMigrations(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// ownTables are the tables (or, for a migration that makes none, an index)
// this cardd's latest migrations make, by number.
var ownTables = []struct {
	migration int
	table     string
	kind      string // "table" or "index"
}{{12, "push_endpoints", "table"}, {13, "recent_removed", "table"}, {14, "refund_links", "table"}, {15, "sales_tx", "index"}}

// checkOwnMigrations refuses a database whose latest migrations are another
// cardd's: one migrated by a branch that numbered a different change 12 (or
// 13) would open without push_endpoints (or recent_removed), and revoke,
// restore or Send out's Recent list would then fail on it. Loudly here
// instead.
func (s *Store) checkOwnMigrations() error {
	for _, o := range ownTables {
		var n int
		if err := s.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = ? AND name = ?`, o.kind, o.table).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("the database's migration %d is not this cardd's: it has no %s %s", o.migration, o.table, o.kind)
		}
	}
	return nil
}

func (s *Store) Close() error { return s.db.Close() }

// UserVersion reads the database's schema version.
func (s *Store) UserVersion(ctx context.Context) (int, error) {
	var v int
	err := s.db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&v)
	return v, err
}

// migrate applies pending migrations. While a second process is creating
// the same new database, SQLite can report SQLITE_BUSY without waiting on
// busy_timeout (switching it to WAL needs an exclusive lock), so a busy
// error is retried for up to 5 seconds.
func (s *Store) migrate() error {
	deadline := time.Now().Add(5 * time.Second)
	for {
		done, err := s.migrateOne()
		switch {
		case err == nil && done:
			return nil
		case err == nil:
		case isBusy(err) && time.Now().Before(deadline):
			time.Sleep(10 * time.Millisecond)
		default:
			return err
		}
	}
}

// isBusy reports whether err is SQLITE_BUSY or one of its extended codes.
func isBusy(err error) bool {
	var coder interface{ Code() int }
	return errors.As(err, &coder) && coder.Code()&0xff == 5
}

// migrateOne applies the next migration, if any. It reads user_version inside
// the (immediate) transaction, so two processes opening a new database at the
// same moment apply each migration exactly once.
func (s *Store) migrateOne() (done bool, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var v int
	if err := tx.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return false, err
	}
	if v >= len(migrations) {
		return true, nil
	}
	if _, err := tx.Exec(migrations[v]); err != nil {
		return false, fmt.Errorf("migration %d: %w", v+1, err)
	}
	if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, v+1)); err != nil {
		return false, err
	}
	return false, tx.Commit()
}
