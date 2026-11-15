package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// The point of sale: PoS phones and how they are paired.

var (
	ErrBadPhoneName = errors.New("store: a PoS phone's name is 1 to 24 characters")
	ErrNameTaken    = errors.New("store: a PoS phone already has this name")
	ErrBadCode      = errors.New("store: this pairing code is unknown, used or run out")
	ErrKeyKnown     = errors.New("store: this key is already a device of this server")
)

// ShopCounts is what the wallet shows of the shop beside its balance:
// the PoS phones that aren't revoked, and the paid sales ever.
func (s *Store) ShopCounts(ctx context.Context) (phones, sales int, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM devices WHERE role = 'pos' AND revoked_at IS NULL),
		(SELECT COUNT(*) FROM sales WHERE state = 'paid')`).Scan(&phones, &sales)
	return phones, sales, err
}

// phoneName trims a PoS phone's name and checks it: 1 to 24 characters, none
// of them a control character.
func phoneName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if n := utf8.RuneCountInString(name); n < 1 || n > 24 || strings.ContainsFunc(name, unicode.IsControl) {
		return "", ErrBadPhoneName
	}
	return name, nil
}

// nameFree fails with ErrNameTaken if a PoS phone that isn't revoked, other
// than except, has this name.
func nameFree(ctx context.Context, tx *sql.Tx, name, except string) error {
	var n int
	err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM devices WHERE role = 'pos' AND revoked_at IS NULL AND name = ? AND key_id != ?`,
		name, except).Scan(&n)
	if err == nil && n > 0 {
		err = ErrNameTaken
	}
	return err
}

// NewPosCode opens a pairing code, kept only as codeHash, for a PoS phone to
// be called name, until expires. It replaces every earlier code: one is open
// at a time.
func (s *Store) NewPosCode(ctx context.Context, codeHash, name string, expires time.Time) error {
	name, err := phoneName(name)
	if err != nil {
		return err
	}
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if err := nameFree(ctx, tx, name, ""); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM pos_codes`); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO pos_codes (code_hash, name, created_at, expires_at) VALUES (?, ?, ?, ?)`,
			codeHash, name, s.now().Unix(), expires.Unix())
		return err
	})
}

// DropPosCodes closes the open pairing code, if there is one.
func (s *Store) DropPosCodes(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM pos_codes`)
	return err
}

// PairPos registers a key as a PoS phone under the name of the code whose
// hash is codeHash, and uses the code up. The code must be open and
// unexpired (ErrBadCode otherwise, whatever is wrong with it). A key the
// server doesn't know is added; a revoked PoS phone's is made active again
// under the code's name, its sales and its first pairing's date kept; an
// owner's key, revoked or not, and a paired PoS phone's are refused with
// ErrKeyKnown, and the code stays open: a device's role never changes. So
// does it stay open when another PoS phone has taken its name meanwhile
// (ErrNameTaken).
func (s *Store) PairPos(ctx context.Context, codeHash, keyID, publicKeyHex string) (Device, error) {
	var d Device
	// This is the one call anyone can make: a code that isn't open is turned
	// away by a plain read, before a transaction takes the write lock.
	var open int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pos_codes WHERE code_hash = ? AND expires_at >= ?`, codeHash, s.now().Unix()).Scan(&open); err != nil {
		return d, err
	}
	if open == 0 {
		return d, ErrBadCode
	}
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		now := s.now().Unix()
		var name string
		err := tx.QueryRowContext(ctx, `SELECT name FROM pos_codes WHERE code_hash = ? AND expires_at >= ?`, codeHash, now).Scan(&name)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrBadCode
		}
		if err != nil {
			return err
		}
		// The name was free when the code was made; a phone renamed to it
		// since then keeps it, and the code stays open for another name's.
		if err := nameFree(ctx, tx, name, keyID); err != nil {
			return err
		}
		var role Role
		var revoked sql.NullInt64
		err = tx.QueryRowContext(ctx, `SELECT role, revoked_at FROM devices WHERE key_id = ? OR public_key = ?`, keyID, publicKeyHex).Scan(&role, &revoked)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			if _, err := tx.ExecContext(ctx, `INSERT INTO devices (key_id, public_key, name, role, created_at) VALUES (?, ?, ?, 'pos', ?)`,
				keyID, publicKeyHex, name, now); err != nil {
				return err
			}
		case err != nil:
			return err
		case role == RolePos && revoked.Valid:
			if _, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at = NULL, name = ? WHERE key_id = ?`, name, keyID); err != nil {
				return err
			}
		default:
			return ErrKeyKnown
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM pos_codes WHERE code_hash = ?`, codeHash); err != nil {
			return err
		}
		d, err = scanDevice(tx.QueryRowContext(ctx, `SELECT key_id, public_key, name, role, created_at, revoked_at FROM devices WHERE key_id = ?`, keyID))
		return err
	})
	return d, err
}

// PosPhone is a PoS phone as Karto Wallet lists it.
type PosPhone struct {
	KeyID     string
	Name      string
	CreatedAt time.Time  // its first pairing
	Sales     int        // its paid sales
	LastSale  *time.Time // when the last of them was paid
}

// PosPhones lists the PoS phones that aren't revoked, oldest first.
func (s *Store) PosPhones(ctx context.Context) ([]PosPhone, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT d.key_id, d.name, d.created_at,
		(SELECT COUNT(*) FROM sales WHERE device = d.key_id AND state = 'paid'),
		(SELECT MAX(paid_at) FROM sales WHERE device = d.key_id AND state = 'paid')
		FROM devices d WHERE d.role = 'pos' AND d.revoked_at IS NULL ORDER BY d.created_at, d.key_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PosPhone{}
	for rows.Next() {
		var p PosPhone
		var created int64
		var last sql.NullInt64
		if err := rows.Scan(&p.KeyID, &p.Name, &created, &p.Sales, &last); err != nil {
			return nil, err
		}
		p.CreatedAt = time.Unix(created, 0)
		if last.Valid {
			t := time.Unix(last.Int64, 0)
			p.LastSale = &t
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// RenamePosPhone renames a PoS phone that isn't revoked (ErrNotFound for any
// other device, an owner among them). Its own name is allowed.
func (s *Store) RenamePosPhone(ctx context.Context, keyID, name string) error {
	name, err := phoneName(name)
	if err != nil {
		return err
	}
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if err := nameFree(ctx, tx, name, keyID); err != nil {
			return err
		}
		return changed(tx.ExecContext(ctx, `UPDATE devices SET name = ? WHERE key_id = ? AND role = 'pos' AND revoked_at IS NULL`, name, keyID))
	})
}

// RevokePosPhone removes a PoS phone (ErrNotFound for any other device, an
// owner among them, and for one already removed).
func (s *Store) RevokePosPhone(ctx context.Context, keyID string) error {
	return changed(s.db.ExecContext(ctx, `UPDATE devices SET revoked_at = ? WHERE key_id = ? AND role = 'pos' AND revoked_at IS NULL`,
		s.now().Unix(), keyID))
}

// changed turns an UPDATE that touched no row into ErrNotFound.
func changed(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// RestoredAt is when this server was last restored from a backup or the
// phrase (meta restore.from's last write), and whether it ever was.
func (s *Store) RestoredAt(ctx context.Context) (time.Time, bool, error) {
	var at int64
	err := s.db.QueryRowContext(ctx, `SELECT updated_at FROM meta WHERE key = 'restore.from'`).Scan(&at)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, fmt.Errorf("store: restore.from: %w", err)
	}
	return time.Unix(at, 0), true, nil
}

// SaleState is where a sale is in its life: open until it is paid, runs out
// or is cancelled; and one that ran out or was cancelled is paid all the
// same if the money arrives (phoenixd can't withdraw an invoice). Paid is final.
type SaleState string

const (
	SaleOpen      SaleState = "open"
	SalePaid      SaleState = "paid"
	SaleExpired   SaleState = "expired"
	SaleCancelled SaleState = "cancelled"
)

var (
	ErrSaleExists  = errors.New("store: this sale id is already another sale")
	ErrNotYourSale = errors.New("store: this sale is another phone's")
)

// Sale is an invoice a PoS phone asked for, and what became of it.
type Sale struct {
	ID          string // the PoS phone's own, a UUID
	Device      string // the phone that made it
	DeviceName  string // that phone's name now
	AmountMsat  int64  // the price
	State       SaleState
	PaymentHash string
	Invoice     string
	CreatedAt   time.Time
	ExpiresAt   time.Time
	CardAt      *time.Time // when its phone said a card's server took the invoice
	PaidAt      *time.Time
	// ReceivedMsat is what Shop was credited once paid: the price less
	// whatever phoenixd kept toward more room.
	ReceivedMsat int64
	TxID         int64 // its ledger transaction once paid
	// PriceCurrency and PriceMinor are the price a till rang the sale up at
	// in the server's currency:
	// "" and 0 for a sale typed in sat. AmountMsat is the sats cardd
	// made of it at its rate then; no rate is kept.
	PriceCurrency string
	PriceMinor    int64
	// ReturnLink is the card's link (LUD-19's payLink, as https) its till
	// read at the tap, for a refund; "" for none.
	ReturnLink string
	// The refund: its ledger transaction once paid (0: none), whether
	// one is on its way, when it was booked and what reached the customer.
	RefundTxID    int64
	RefundPending bool
	RefundAt      *time.Time
	RefundMsat    int64
	RefundFrom    Account
}

// saleRefundColumns are a sale's refund columns, for a query whose sale is
// s: the refund's tx (0 for none), a refund's hold still open, the refund's
// time, what reached the customer (the refund's positive leg other than
// fees: world's, or the card's for a refund booked inside the server), the
// account it came from, and the till's return link.
const saleRefundColumns = `COALESCE(s.refund_tx_id, 0),
	EXISTS(SELECT 1 FROM holds h WHERE h.sale_id = s.id AND h.state = 'open'),
	COALESCE((SELECT r.created_at FROM ledger_tx r WHERE r.id = s.refund_tx_id), 0),
	COALESCE((SELECT SUM(re.amount_msat) FROM ledger_entry re WHERE re.tx_id = s.refund_tx_id AND re.amount_msat > 0 AND re.account != 'fees'), 0),
	COALESCE((SELECT re.account FROM ledger_entry re WHERE re.tx_id = s.refund_tx_id AND re.amount_msat < 0 LIMIT 1), ''),
	COALESCE(s.return_link, '')`

// saleRefund is what saleRefundColumns read.
type saleRefund struct {
	txID     int64
	pending  bool
	at, msat int64
	from     string
}

// Method is how a paid sale was paid, as far as its phone said: "card" when
// a card's server took the invoice, "qr" otherwise; "" until it is paid. It
// is the phone's word, not proof.
func (s Sale) Method() string {
	switch {
	case s.State != SalePaid:
		return ""
	case s.CardAt != nil:
		return "card"
	}
	return "qr"
}

const saleColumns = `s.id, s.device, d.name, s.amount_msat, s.state, s.payment_hash, s.invoice, s.created_at, s.expires_at,
	s.card_at, s.paid_at, COALESCE(s.received_msat, 0), COALESCE(s.tx_id, 0), COALESCE(s.price_currency, ''), COALESCE(s.price_minor, 0), ` + saleRefundColumns

func scanSale(r scanner) (Sale, error) {
	var s Sale
	var created, expires int64
	var card, paid sql.NullInt64
	var rf saleRefund
	err := r.Scan(&s.ID, &s.Device, &s.DeviceName, &s.AmountMsat, &s.State, &s.PaymentHash, &s.Invoice, &created, &expires, &card, &paid, &s.ReceivedMsat, &s.TxID, &s.PriceCurrency, &s.PriceMinor,
		&rf.txID, &rf.pending, &rf.at, &rf.msat, &rf.from, &s.ReturnLink)
	if errors.Is(err, sql.ErrNoRows) {
		return Sale{}, ErrNotFound
	}
	s.RefundTxID, s.RefundPending, s.RefundMsat, s.RefundFrom = rf.txID, rf.pending, rf.msat, Account(rf.from)
	if rf.at > 0 {
		t := time.Unix(rf.at, 0)
		s.RefundAt = &t
	}
	s.CreatedAt, s.ExpiresAt = time.Unix(created, 0), time.Unix(expires, 0)
	if card.Valid {
		t := time.Unix(card.Int64, 0)
		s.CardAt = &t
	}
	if paid.Valid {
		t := time.Unix(paid.Int64, 0)
		s.PaidAt = &t
	}
	return s, err
}

// readSale reads a sale in tx, first making an open one past its time expired.
func (s *Store) readSale(ctx context.Context, tx *sql.Tx, id string) (Sale, error) {
	if _, err := tx.ExecContext(ctx, `UPDATE sales SET state = 'expired' WHERE id = ? AND state = 'open' AND expires_at < ?`, id, s.now().Unix()); err != nil {
		return Sale{}, err
	}
	return scanSale(tx.QueryRowContext(ctx, `SELECT `+saleColumns+` FROM sales s JOIN devices d ON d.key_id = s.device WHERE s.id = ?`, id))
}

// SaleByID reads a sale. An open sale past its time reads as expired, and is
// from then on: so every read is a (nearly always empty) write, which a till
// asking each second takes the write lock for. The store has one connection
// anyway; a sweep that expired old sales would let a read be a plain read.
func (s *Store) SaleByID(ctx context.Context, id string) (Sale, error) {
	var out Sale
	err := s.inTx(ctx, func(tx *sql.Tx) (err error) {
		out, err = s.readSale(ctx, tx, id)
		return err
	})
	return out, err
}

// sameSale reports whether a sale is the one a request asks for again: the
// same phone and the same price.
// A sale rung up in a currency is matched by its price in it, whatever
// its sats came to at the rate then; one typed in sat by its sats.
func sameSale(existing, asked Sale) bool {
	if existing.Device != asked.Device || existing.PriceCurrency != asked.PriceCurrency {
		return false
	}
	if asked.PriceCurrency != "" {
		return existing.PriceMinor == asked.PriceMinor
	}
	return existing.AmountMsat == asked.AmountMsat
}

// SaleAgain finds the sale a repeated request is for: the one with this id,
// when it is this device's and for this amount, typed in sat. An id that is
// another device's sale, for another amount or rung up in a currency, is
// ErrSaleExists; found is false when there is no such sale yet.
func (s *Store) SaleAgain(ctx context.Context, id, device string, amountMsat int64) (sale Sale, found bool, err error) {
	return s.saleAgain(ctx, Sale{ID: id, Device: device, AmountMsat: amountMsat})
}

// SaleAgainPriced is SaleAgain for a sale rung up in a currency: found by
// its price, before cardd converts anything, so a till's retry after the
// rate moved gets the first sale with its first sats.
func (s *Store) SaleAgainPriced(ctx context.Context, id, device, currency string, minor int64) (sale Sale, found bool, err error) {
	return s.saleAgain(ctx, Sale{ID: id, Device: device, PriceCurrency: currency, PriceMinor: minor})
}

func (s *Store) saleAgain(ctx context.Context, asked Sale) (sale Sale, found bool, err error) {
	sale, err = s.SaleByID(ctx, asked.ID)
	switch {
	case errors.Is(err, ErrNotFound):
		return Sale{}, false, nil
	case err != nil:
		return Sale{}, false, err
	case !sameSale(sale, asked):
		return Sale{}, false, ErrSaleExists
	}
	return sale, true, nil
}

// NewSale stores an open sale (its ID, Device, AmountMsat, PriceCurrency and PriceMinor, PaymentHash,
// Invoice and ExpiresAt), cancelling the device's other open sale: a PoS
// phone has one open at a time. If the id is already a sale, it answers as
// SaleAgain does, storing nothing.
func (s *Store) NewSale(ctx context.Context, n Sale) (Sale, error) {
	var out Sale
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		existing, err := s.readSale(ctx, tx, n.ID)
		switch {
		case err == nil && !sameSale(existing, n):
			return ErrSaleExists
		case err == nil:
			out = existing
			return nil
		case !errors.Is(err, ErrNotFound):
			return err
		}
		now := s.now().Unix()
		if _, err := tx.ExecContext(ctx, `UPDATE sales SET state = 'expired' WHERE device = ? AND state = 'open' AND expires_at < ?`, n.Device, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE sales SET state = 'cancelled' WHERE device = ? AND state = 'open'`, n.Device); err != nil {
			return err
		}
		var priceCurrency, priceMinor any // NULL: typed in sat
		if n.PriceCurrency != "" {
			priceCurrency, priceMinor = n.PriceCurrency, n.PriceMinor
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO sales (id, device, amount_msat, state, payment_hash, invoice, created_at, expires_at, price_currency, price_minor)
			VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`, n.ID, n.Device, n.AmountMsat, n.PaymentHash, n.Invoice, now, n.ExpiresAt.Unix(), priceCurrency, priceMinor); err != nil {
			return err
		}
		out, err = s.readSale(ctx, tx, n.ID)
		return err
	})
	return out, err
}

// ownSale reads a sale for a change only its own phone may make.
func (s *Store) ownSale(ctx context.Context, tx *sql.Tx, id, device string) (Sale, error) {
	sale, err := s.readSale(ctx, tx, id)
	if err == nil && sale.Device != device {
		err = ErrNotYourSale
	}
	return sale, err
}

// cardStepLate is how long after a sale is paid its till's card step is
// still taken (the race): a Karto card's server answers the
// till at once and pays in the background, so the sale can be paid before
// the step arrives.
const cardStepLate = 60 * time.Second

// SaleCard records, once, that the sale's phone says a card's server took
// the invoice, and the return link the till read from the card's tap ("" for
// none; the caller has checked it). It is taken while the sale is open, or
// paid less than cardStepLate ago; any other sale is left as it is.
func (s *Store) SaleCard(ctx context.Context, id, device, returnLink string) (Sale, error) {
	var out Sale
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if _, err := s.ownSale(ctx, tx, id, device); err != nil {
			return err
		}
		now := s.now()
		if _, err := tx.ExecContext(ctx, `UPDATE sales SET card_at = ?, return_link = ? WHERE id = ? AND card_at IS NULL
			AND (state = 'open' OR (state = 'paid' AND paid_at >= ?))`, now.Unix(), returnLink, id, now.Add(-cardStepLate).Unix()); err != nil {
			return err
		}
		var err error
		out, err = s.readSale(ctx, tx, id)
		return err
	})
	return out, err
}

// CancelSale cancels an open sale for its phone. Any other state is left as
// it is, so a sale paid a moment before reads paid.
func (s *Store) CancelSale(ctx context.Context, id, device string) (Sale, error) {
	var out Sale
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if _, err := s.ownSale(ctx, tx, id, device); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE sales SET state = 'cancelled' WHERE id = ? AND state = 'open'`, id); err != nil {
			return err
		}
		var err error
		out, err = s.readSale(ctx, tx, id)
		return err
	})
	return out, err
}

// CreditSale records the payment of a sale: msat, what the payment brought
// in (it may be less than the price, or nothing, when phoenixd kept money
// toward more room), goes to shop, once per payment hash, and the sale is
// paid from then on, whatever it was: a customer who scanned before a cancel
// can still pay, and phoenixd can't withdraw an invoice. Money for a sale
// there is no record of (or whose record is for another invoice) reaches
// shop all the same, with a note saying so. It reports whether this call
// recorded it.
func (s *Store) CreditSale(ctx context.Context, saleID string, msat int64, paymentHash, note string) (bool, error) {
	return s.CreditSaleMoving(ctx, saleID, msat, paymentHash, note, FeeCreditMove{})
}

// CreditSaleMoving is CreditSale that also moves the kept fee credit, in the
// same transaction and only when this call recorded the payment.
func (s *Store) CreditSaleMoving(ctx context.Context, saleID string, msat int64, paymentHash, note string, move FeeCreditMove) (bool, error) {
	if msat < 0 {
		return false, fmt.Errorf("store: negative credit %d", msat)
	}
	var done bool
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		now := s.now().Unix()
		var known int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM sales WHERE id = ? AND payment_hash = ?`, saleID, paymentHash).Scan(&known); err != nil {
			return err
		}
		if known == 0 {
			note = strings.TrimSpace(note + " (no record of this sale)")
		}
		var err error
		if done, err = s.post(ctx, tx, now, KindSale, paymentHash, note, Entry{World, -msat}, Entry{Shop, msat}); err != nil || !done {
			return err
		}
		var txID int64
		if err := tx.QueryRowContext(ctx, `SELECT id FROM ledger_tx WHERE ref = ?`, paymentHash).Scan(&txID); err != nil {
			return err
		}
		if msat == 0 {
			// post leaves out a leg of nothing, and an account's history is its
			// legs: a sale that brought Shop nothing still has its line there.
			if _, err := tx.ExecContext(ctx, `INSERT INTO ledger_entry (tx_id, account, amount_msat) VALUES (?, 'shop', 0)`, txID); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE sales SET state = 'paid', paid_at = ?, received_msat = ?, tx_id = ? WHERE id = ? AND payment_hash = ?`,
			now, msat, txID, saleID, paymentHash); err != nil {
			return err
		}
		return moveFeeCredit(ctx, tx, now, move)
	})
	return done, err
}

// PaidSales lists the paid sales of one phone (device, its key id) or of
// every phone (device ""), newest first, before the ledger transaction
// before (0 for the newest).
func (s *Store) PaidSales(ctx context.Context, device string, before int64, limit int) ([]Sale, error) {
	if before <= 0 {
		before = 1<<63 - 1
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+saleColumns+` FROM sales s JOIN devices d ON d.key_id = s.device
		WHERE s.state = 'paid' AND s.tx_id < ? AND (? = '' OR s.device = ?) ORDER BY s.tx_id DESC LIMIT ?`, before, device, device, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Sale{}
	for rows.Next() {
		sale, err := scanSale(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sale)
	}
	return out, rows.Err()
}

// SaleDay is one local day's paid sales.
type SaleDay struct {
	Day       int64 // the day's first second, unix time
	Count     int
	TotalMsat int64 // the prices: what a till counts, not what Shop received
}

// SaleDays counts the paid sales of one phone (device, its key id) or of
// every phone (device "") by local day, newest first, for a phone offsetMin
// minutes east of UTC. One offset serves every day, so around a clock change
// a past day's edge sits an hour out.
func (s *Store) SaleDays(ctx context.Context, device string, offsetMin, limit int) ([]SaleDay, error) {
	off := int64(offsetMin) * 60
	rows, err := s.db.QueryContext(ctx, `SELECT (paid_at + ?) / 86400 AS day, COUNT(*), SUM(amount_msat) FROM sales
		WHERE state = 'paid' AND refund_tx_id IS NULL AND (? = '' OR device = ?) GROUP BY day ORDER BY day DESC LIMIT ?`, off, device, device, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SaleDay{}
	for rows.Next() {
		var d SaleDay
		if err := rows.Scan(&d.Day, &d.Count, &d.TotalMsat); err != nil {
			return nil, err
		}
		d.Day = d.Day*86400 - off
		out = append(out, d)
	}
	return out, rows.Err()
}

// refundable checks, inside tx, that a sale may be refunded now:
// it is paid, has no refund booked and none on its way.
// Being in the caller's transaction is the point: two phones can't both pass.
func refundable(ctx context.Context, tx *sql.Tx, saleID string) error {
	var state SaleState
	var refunded, pending bool
	err := tx.QueryRowContext(ctx, `SELECT state, refund_tx_id IS NOT NULL,
		EXISTS(SELECT 1 FROM holds WHERE sale_id = sales.id AND state = 'open') FROM sales WHERE id = ?`, saleID).Scan(&state, &refunded, &pending)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return ErrNotFound
	case err != nil:
		return err
	case state != SalePaid:
		return ErrNotPaid
	case refunded || pending:
		return ErrAlreadyRefunded
	}
	return nil
}

// RefundToCard refunds a sale to a card of this server:
// from Shop or Pool to the card, no Lightning payment
// and no fee, in one transaction with the checks. ref is the request's (a
// second call with it answers the first's transaction and books nothing);
// the sale must be refundable, the card able to receive, from holding msat
// with no payment of its own on its way.
func (s *Store) RefundToCard(ctx context.Context, ref, saleID string, from Account, cardID string, msat int64) (int64, error) {
	if msat <= 0 || ref == "" {
		return 0, fmt.Errorf("%w: bad refund", ErrConflict)
	}
	var id int64
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		// The replay first: postID gives no id for a ref already used.
		switch err := tx.QueryRowContext(ctx, `SELECT id FROM ledger_tx WHERE ref = ?`, ref).Scan(&id); {
		case err == nil:
			return nil
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
		if err := refundable(ctx, tx, saleID); err != nil {
			return err
		}
		card := CardAccount(cardID)
		if ok, err := canReceive(ctx, tx, card); err != nil {
			return err
		} else if !ok {
			return ErrCannotReceive
		}
		var open int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM holds WHERE account = ? AND state = 'open'`, from).Scan(&open); err != nil {
			return err
		}
		if open > 0 {
			return ErrPaymentInProgress
		}
		b, err := balance(ctx, tx, from)
		if err != nil {
			return err
		}
		if b.AvailableMsat() < msat {
			return ErrInsufficient
		}
		id, _, err = s.postID(ctx, tx, s.now().Unix(), KindRefund, ref, "refund of sale "+saleID, Entry{from, -msat}, Entry{card, msat})
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE sales SET refund_tx_id = ? WHERE id = ?`, id, saleID)
		return err
	})
	return id, err
}
