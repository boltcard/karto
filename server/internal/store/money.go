package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/boltcard/karto/server/internal/rates"
)

// Account names a ledger account: "pool", "hosting", "shop", "fees", "world"
// or "card:<id>". The person's money is on the cards, pool, hosting and shop;
// fees counts what the network took and world is the other side of every
// top-up and payment, so every transaction sums to zero.
// Only sales fill shop: it has no address and nothing
// moves into it.
type Account string

const (
	Pool    Account = "pool"
	Hosting Account = "hosting"
	Shop    Account = "shop"
	Fees    Account = "fees"
	World   Account = "world"
)

func CardAccount(id string) Account { return Account("card:" + id) }

// CardID returns the card's id for a card account.
func (a Account) CardID() (string, bool) { return strings.CutPrefix(string(a), "card:") }

// Kind is what a ledger transaction was.
type Kind string

const (
	KindTopup     Kind = "topup"
	KindSpend     Kind = "spend"
	KindMove      Kind = "move"
	KindSend      Kind = "send"
	KindWipe      Kind = "wipe"
	KindFeeAdjust Kind = "fee-adjust"
	KindAdjust    Kind = "adjust" // `cardd ledger reconcile`: the books set to phoenixd's balance
	KindRenew     Kind = "renew"  // hosting pays the VM's LNVPS Lightning address
	KindSale      Kind = "sale"   // a PoS phone's sale, paid into shop
	KindRefund    Kind = "refund" // a till sale given back, from shop or pool
)

var (
	ErrInsufficient      = errors.New("store: not enough money available")
	ErrOverPerTap        = errors.New("store: over the card's per-tap limit")
	ErrOverDaily         = errors.New("store: over the card's 24-hour limit")
	ErrPaymentInProgress = errors.New("store: a payment is already in progress")
	// ErrAlreadyRefunded: the sale is refunded, or a refund of it is on its way.
	ErrAlreadyRefunded = errors.New("store: the sale is refunded, or a refund of it is on its way")
	// ErrNotPaid: a refund of a sale that isn't paid.
	ErrNotPaid          = errors.New("store: the sale isn't paid")
	ErrCannotReceive    = errors.New("store: this account can't receive money")
	ErrDuplicatePayment = errors.New("store: this invoice was already paid or is being paid")
)

// Balance is an account's ledger total and what open holds reserve of it.
type Balance struct {
	EntriesMsat int64
	HeldMsat    int64
}

// AvailableMsat is what the account can spend or move now.
func (b Balance) AvailableMsat() int64 { return b.EntriesMsat - b.HeldMsat }

// Entry is one leg of a transaction.
type Entry struct {
	Account    Account
	AmountMsat int64
}

// Tx is a ledger transaction as an account's history shows it.
type Tx struct {
	ID         int64
	Kind       Kind
	Note       string
	Comment    string // the person's own note on the line; "" for none
	PayerNote  string // a top-up's payer's note (LUD-12); "" for none
	Via        string // how a top-up's money came, when more than a top-up: "refund"; "" otherwise
	AmountMsat int64  // this account's leg
	FeeMsat    int64  // the transaction's fees leg, if any: a routing fee, or a top-up's channel fee
	CreatedAt  time.Time
	Other      Account // a move's other account; "" for any other kind
	Sale       *TxSale // a sale's own facts; nil for any other kind, and for a sale with no record
}

// TxSale is what a sale's history entry says of the sale.
type TxSale struct {
	ID        string
	Method    string // "card" or "qr", as the sale's phone said
	Device    string // that phone's name now
	PriceMsat int64  // the price; the entry's own amount is what Shop was credited
	// PriceCurrency and PriceMinor: the price it was rung up at in a
	// currency, "" and 0 for a sale typed in sat
	// ("priced £2.50" for good).
	PriceCurrency string
	PriceMinor    int64
	PaidAt        time.Time // when the sale was paid
	// The sale's refund: its ledger transaction once paid (0: none),
	// whether one is on its way (an open hold for the sale), when it was
	// booked, what reached the customer, and the account it came from.
	RefundTxID    int64
	RefundPending bool
	RefundAt      time.Time
	RefundMsat    int64
	RefundFrom    Account
	// ReturnLink is the card's link its till read at the tap ("" for none).
	ReturnLink string
}

// HoldState is where a hold is in its life.
type HoldState string

const (
	HoldOpen     HoldState = "open"
	HoldSettled  HoldState = "settled"
	HoldReleased HoldState = "released"
)

// Hold reserves an amount plus a fee budget against one account while
// phoenixd pays an invoice. It resolves exactly once.
type Hold struct {
	ID            int64
	Account       Account
	Kind          Kind // KindSpend, KindSend or KindRenew
	AmountMsat    int64
	FeeBudgetMsat int64
	PaymentHash   string
	Invoice       string
	State         HoldState
	FeeMsat       int64 // the real fee, once settled
	CreatedAt     time.Time
	About         HoldAbout
	// Preimage is the payment's proof once phoenixd gave it; PreimageAsked
	// says phoenixd was asked (a Preimage of "" then means it didn't know).
	Preimage      string
	PreimageAsked bool
	TxID          int64 // the ledger transaction it was booked as, once settled; 0 before
	// Offer is the BOLT12 offer paid ("" for an invoice); its hold has no
	// PaymentHash until phoenixd says it.
	Offer string
	// PaymentID is phoenixd's id for the payment, once known.
	PaymentID string
	// GaveUpAt is when cardd last stopped waiting on phoenixd for it (zero:
	// never): Resolve's grace counts from the later of this and CreatedAt.
	GaveUpAt time.Time
	// Reason is why it wasn't sent, in the person's words, when phoenixd said.
	Reason string
}

// HoldAbout is what a payment was, kept with its hold: the address or LNURL-pay link the
// phone sent ("" for an invoice, a spend at a terminal and a renewal), what
// the invoice or the link says it is for, and the person's own note from
// Send's Check step. The caller cleans them (lnaddr.Clean).
type HoldAbout struct {
	Destination string
	Description string
	Comment     string
	// SaleID is the till sale a refund's hold gives back; "" for any
	// other payment. OpenHold allows one refund per sale.
	SaleID string
}

// inTx runs fn in one transaction. Open's _txlock=immediate makes it take
// the write lock at once, so its reads and writes can't interleave with
// another transaction's.
func (s *Store) inTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	defer s.took(tx)
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	accounts, posted := s.took(tx)
	if len(accounts) > 0 && s.Changed != nil {
		s.Changed(accounts)
	}
	if len(posted) > 0 && s.Posted != nil {
		s.Posted(posted)
	}
	return nil
}

// touch notes that the transaction changes these accounts' books; inTx
// tells Changed of them once it has committed.
func (s *Store) touch(tx *sql.Tx, accounts ...Account) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.touched == nil {
		s.touched = map[*sql.Tx][]Account{}
	}
	for _, a := range accounts {
		if a != World && a != Fees && !slices.Contains(s.touched[tx], a) {
			s.touched[tx] = append(s.touched[tx], a)
		}
	}
}

// took is what a transaction touched and the ledger transactions it
// inserted, which are then forgotten.
func (s *Store) took(tx *sql.Tx) ([]Account, []int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	accounts, posted := s.touched[tx], s.posted[tx]
	delete(s.touched, tx)
	delete(s.posted, tx)
	return accounts, posted
}

// post writes one transaction. The entries must sum to zero. ref, if not
// empty, makes it happen once: a second post with the same ref is a no-op
// that returns false.
func (s *Store) post(ctx context.Context, tx *sql.Tx, now int64, kind Kind, ref, note string, entries ...Entry) (bool, error) {
	_, done, err := s.postID(ctx, tx, now, kind, ref, note, entries...)
	return done, err
}

// postID is post that also says the transaction's id, for a caller that
// writes more of it (a leg of nothing, which post leaves out).
func (s *Store) postID(ctx context.Context, tx *sql.Tx, now int64, kind Kind, ref, note string, entries ...Entry) (id int64, done bool, err error) {
	var sum int64
	for _, e := range entries {
		sum += e.AmountMsat
	}
	if sum != 0 {
		return 0, false, fmt.Errorf("store: %s transaction sums to %d msat", kind, sum)
	}
	var refArg any
	if ref != "" {
		refArg = ref
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO ledger_tx (kind, ref, note, created_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (ref) DO NOTHING`, kind, refArg, note, now)
	if err != nil {
		return 0, false, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return 0, false, nil
	}
	txID, err := res.LastInsertId()
	if err != nil {
		return 0, false, err
	}
	s.mu.Lock()
	if s.posted == nil {
		s.posted = map[*sql.Tx][]int64{}
	}
	s.posted[tx] = append(s.posted[tx], txID)
	s.mu.Unlock()
	for _, e := range entries {
		// Touched whatever its amount: a caller that gives a leg of nothing
		// its line by hand (a sale, a top-up) has changed that account too.
		s.touch(tx, e.Account)
		if e.AmountMsat == 0 {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO ledger_entry (tx_id, account, amount_msat) VALUES (?, ?, ?)`,
			txID, e.Account, e.AmountMsat); err != nil {
			return 0, false, err
		}
	}
	return txID, true, nil
}

func balance(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, acct Account) (Balance, error) {
	var b Balance
	err := q.QueryRowContext(ctx, `SELECT
		(SELECT COALESCE(SUM(amount_msat), 0) FROM ledger_entry WHERE account = ?),
		(SELECT COALESCE(SUM(amount_msat + fee_budget_msat), 0) FROM holds WHERE account = ? AND state = 'open')`,
		acct, acct).Scan(&b.EntriesMsat, &b.HeldMsat)
	return b, err
}

// Balance returns an account's total and what its open holds reserve.
func (s *Store) Balance(ctx context.Context, acct Account) (Balance, error) {
	return balance(ctx, s.db, acct)
}

// canReceive reports whether money may be credited or moved to acct: pool,
// hosting, and active or frozen cards.
func canReceive(ctx context.Context, tx *sql.Tx, acct Account) (bool, error) {
	id, isCard := acct.CardID()
	if !isCard {
		return acct == Pool || acct == Hosting, nil
	}
	var state CardState
	err := tx.QueryRowContext(ctx, `SELECT state FROM cards WHERE id = ?`, id).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return state == StateActive || state == StateFrozen, err
}

// Credit records a top-up of msat received for acct, once per ref (the
// payment hash). Money for an account that can no longer receive (a card
// wiped since the invoice was made) goes to pool. It reports whether this
// call recorded it.
func (s *Store) Credit(ctx context.Context, acct Account, msat int64, ref, note string) (bool, error) {
	return s.CreditMoving(ctx, acct, msat, 0, ref, note, FeeCreditMove{})
}

// CreditMoving is Credit that also moves the kept fee credit, in the same
// transaction and only when
// this call recorded the payment. feeMsat is the fee phoenixd took for the
// room the payment bought (its `fees`: the room's whole fee, part of which
// earlier fee credit may have paid), booked to fees; 0 for none.
func (s *Store) CreditMoving(ctx context.Context, acct Account, msat, feeMsat int64, ref, note string, move FeeCreditMove) (bool, error) {
	return s.CreditMovingVia(ctx, acct, msat, feeMsat, ref, note, "", move)
}

// CreditVia is Credit for money that came by way of via ("refund": through
// one of this server's refund links), kept on the line.
func (s *Store) CreditVia(ctx context.Context, acct Account, msat int64, ref, note, via string) (bool, error) {
	return s.CreditMovingVia(ctx, acct, msat, 0, ref, note, via, FeeCreditMove{})
}

// CreditMovingVia is CreditMoving that keeps via on the line.
func (s *Store) CreditMovingVia(ctx context.Context, acct Account, msat, feeMsat int64, ref, note, via string, move FeeCreditMove) (bool, error) {
	if msat < 0 {
		return false, fmt.Errorf("store: negative credit %d", msat)
	}
	if feeMsat < 0 {
		return false, fmt.Errorf("store: negative fee %d", feeMsat)
	}
	var done bool
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		ok, err := canReceive(ctx, tx, acct)
		if err != nil {
			return err
		}
		to := acct
		if !ok {
			to, note = Pool, strings.TrimSpace(note+" (for "+string(acct)+", which can't receive)")
		}
		var txID int64
		if txID, done, err = s.postID(ctx, tx, s.now().Unix(), KindTopup, ref, note, Entry{World, -(msat + feeMsat)}, Entry{to, msat}, Entry{Fees, feeMsat}); err != nil || !done {
			return err
		}
		if via != "" {
			if _, err := tx.ExecContext(ctx, `UPDATE ledger_tx SET via = ? WHERE id = ?`, via, txID); err != nil {
				return err
			}
		}
		if msat == 0 {
			// post leaves out a leg of nothing, and an account's history is its
			// legs: a top-up that brought nothing (all of it went to phoenixd's
			// fee credit) still has its line there, as such a sale has in Shop's.
			if _, err := tx.ExecContext(ctx, `INSERT INTO ledger_entry (tx_id, account, amount_msat) VALUES (?, ?, 0)`, txID, to); err != nil {
				return err
			}
		}
		// The payer's note kept with the invoice moves onto the line.
		if ref != "" {
			if _, err := tx.ExecContext(ctx, `UPDATE ledger_tx SET payer_note = COALESCE((SELECT note FROM topup_notes WHERE payment_hash = ?), '') WHERE id = ?`, ref, txID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM topup_notes WHERE payment_hash = ?`, ref); err != nil {
				return err
			}
		}
		return moveFeeCredit(ctx, tx, s.now().Unix(), move)
	})
	return done, err
}

// SaveTopupNote keeps a payer's note (LUD-12's comment, cleaned by the
// caller) for the invoice whose payment hash it is, until CreditMoving puts
// it on the payment's line. The same hash again replaces the note.
func (s *Store) SaveTopupNote(ctx context.Context, paymentHash, note string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO topup_notes (payment_hash, note, created_at) VALUES (?, ?, ?)
		ON CONFLICT (payment_hash) DO UPDATE SET note = excluded.note, created_at = excluded.created_at`, paymentHash, note, s.now().Unix())
	return err
}

// PruneTopupNotes deletes the notes kept since before `before`, then all but
// the newest keep, and says how many went: unpaid invoices' notes, bounded
// in age and in number however often the free callback is called.
func (s *Store) PruneTopupNotes(ctx context.Context, before time.Time, keep int) (int64, error) {
	var gone int64
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM topup_notes WHERE created_at < ?`, before.Unix())
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		res, err = tx.ExecContext(ctx, `DELETE FROM topup_notes WHERE payment_hash NOT IN
			(SELECT payment_hash FROM topup_notes ORDER BY created_at DESC, payment_hash DESC LIMIT ?)`, keep)
		if err != nil {
			return err
		}
		m, _ := res.RowsAffected()
		gone = n + m
		return nil
	})
	return gone, err
}

// PayerNoteOf is the payer's note on the line whose ref is ref (a top-up's
// payment hash); "" for none, and for no such line.
func (s *Store) PayerNoteOf(ctx context.Context, ref string) (string, error) {
	var note string
	err := s.db.QueryRowContext(ctx, `SELECT payer_note FROM ledger_tx WHERE ref = ?`, ref).Scan(&note)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return note, err
}

// Move moves msat between two of the person's accounts. It never moves more
// than is available, and a card that is being wiped or is reset can't receive.
func (s *Store) Move(ctx context.Context, from, to Account, msat int64, note string) error {
	return s.MoveOnce(ctx, "", from, to, msat, note)
}

// MoveOnce is Move made once per ref (a request id): a second call with the
// same ref does nothing and succeeds, even if the first answer was lost.
func (s *Store) MoveOnce(ctx context.Context, ref string, from, to Account, msat int64, note string) error {
	if msat <= 0 || from == to || !personal(from) || !personal(to) {
		return fmt.Errorf("%w: bad move", ErrConflict)
	}
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if ref != "" {
			var n int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM ledger_tx WHERE ref = ?`, ref).Scan(&n); err != nil || n > 0 {
				return err
			}
		}
		b, err := balance(ctx, tx, from)
		if err != nil {
			return err
		}
		if b.AvailableMsat() < msat {
			return ErrInsufficient
		}
		ok, err := canReceive(ctx, tx, to)
		if err != nil {
			return err
		}
		if !ok {
			return ErrCannotReceive
		}
		_, err = s.post(ctx, tx, s.now().Unix(), KindMove, ref, note, Entry{from, -msat}, Entry{to, msat})
		return err
	})
}

// personal reports whether acct holds the person's money.
func personal(acct Account) bool {
	_, isCard := acct.CardID()
	return isCard || acct == Pool || acct == Hosting || acct == Shop
}

// HoldRequest asks to reserve money for one payment.
type HoldRequest struct {
	Account       Account
	Kind          Kind // KindSpend (a card at a terminal), KindSend (pool, send out) or KindRenew (hosting)
	AmountMsat    int64
	FeeBudgetMsat int64
	PaymentHash   string
	Invoice       string
	// Offer, instead of PaymentHash and Invoice: a BOLT12 offer's payment,
	// whose hash phoenixd gives only once it has fetched the invoice.
	Offer string
	// Ref, if not empty, is a send's request id: one hold per ref, ever, so
	// a retry after a restart finds this payment instead of making another.
	Ref   string
	About HoldAbout
}

// maxRoundingSpends bounds the 24-hour allowance for rounding, 500 msat a
// spend: it is there for exact-priced sales at a limit, each rounded to a
// whole sat, and bounded so that tiny taps cannot stretch the limit (at most
// 5 sat a day).
const maxRoundingSpends = 10

// OpenHold reserves the amount plus the fee budget, in one transaction with
// every check: one payment at a time per account; for a card, that it is
// active and the per-tap and rolling 24-hour limits; and that the money is
// available.
func (s *Store) OpenHold(ctx context.Context, r HoldRequest) (Hold, error) {
	// An invoice has its hash; an offer has none yet. Never both, never neither.
	if r.AmountMsat <= 0 || r.FeeBudgetMsat < 0 || (r.PaymentHash == "") == (r.Offer == "") {
		return Hold{}, fmt.Errorf("%w: bad hold", ErrConflict)
	}
	var h Hold
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		now := s.now()
		// A refund first: a sale refunded, or with a refund on its way
		// from any account, says so before the account's own one-at-a-time.
		if r.About.SaleID != "" {
			if err := refundable(ctx, tx, r.About.SaleID); err != nil {
				return err
			}
		}
		var open int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM holds WHERE account = ? AND state = 'open'`, r.Account).Scan(&open); err != nil {
			return err
		}
		if open > 0 {
			return ErrPaymentInProgress
		}
		if r.Offer != "" {
			// One hold with no hash on the whole server: after a lost answer
			// its payment is found in phoenixd's list by amount and time,
			// which must leave no doubt whose it is.
			var unhashed int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM holds WHERE state = 'open' AND payment_hash = ''`).Scan(&unhashed); err != nil {
				return err
			}
			if unhashed > 0 {
				return ErrPaymentInProgress
			}
		}
		var seen int
		if r.PaymentHash != "" {
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM holds WHERE payment_hash = ? AND state != 'released'`, r.PaymentHash).Scan(&seen); err != nil {
				return err
			}
			if seen > 0 {
				return ErrDuplicatePayment
			}
		}
		if r.Ref != "" {
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM holds WHERE ref = ?`, r.Ref).Scan(&seen); err != nil {
				return err
			}
			if seen > 0 {
				return ErrDuplicatePayment
			}
		}
		if id, isCard := r.Account.CardID(); isCard {
			c, err := scanCard(tx.QueryRowContext(ctx, `SELECT `+cardCols+` FROM cards WHERE id = ?`, id))
			if err != nil {
				return err // ErrNotFound for a card the server doesn't know
			}
			if c.State != StateActive {
				return fmt.Errorf("%w: card is %s", ErrConflict, c.State)
			}
			// Limits in a currency at the last rate, read inside this
			// transaction; with no rate nothing passes.
			perTap, daily, p, rated := s.limitsAt(c)
			// A tap against limits in a currency says what rate it was
			// checked at, refused or not.
			// inTx does not retry, so it is once per call.
			if rated && c.LimitCurrency != "" && s.Log != nil {
				cur := c.LimitCurrency
				price := p.Per[cur]
				s.Log.Printf("store: card %s's limits (%s a tap, %s a day) = %s sat a tap, %s sat a day at %s%s a bitcoin, %s",
					c.ID, rates.MinorText(c.PerTapMinor, cur), rates.MinorText(c.DailyMinor, cur),
					rates.Thousands(perTap/1000), rates.Thousands(daily/1000),
					rates.Symbol(cur), rates.Thousands(price), rates.Words(p))
			}
			if !rated || r.AmountMsat > perTap {
				return ErrOverPerTap
			}
			var used, spends int64
			if err := tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(amount_msat), 0), COUNT(*) FROM holds
				WHERE account = ? AND kind = 'spend' AND (state = 'open' OR (state = 'settled' AND created_at > ?))`,
				r.Account, now.Add(-24*time.Hour).Unix()).Scan(&used, &spends); err != nil {
				return err
			}
			// A card with limits in a currency has its day's limit rounded to
			// a whole sat and each sale's sats rounded too, so it may run
			// half a sat over for each spend in the window, this one included,
			// up to maxRoundingSpends of them.
			allowance := int64(0)
			if c.LimitCurrency != "" {
				allowance = 500 * min(spends+1, maxRoundingSpends)
			}
			if used+r.AmountMsat > daily+allowance {
				return ErrOverDaily
			}
		}
		b, err := balance(ctx, tx, r.Account)
		if err != nil {
			return err
		}
		if b.AvailableMsat() < r.AmountMsat+r.FeeBudgetMsat {
			return ErrInsufficient
		}
		var ref any
		if r.Ref != "" {
			ref = r.Ref
		}
		var saleID any
		if r.About.SaleID != "" {
			saleID = r.About.SaleID
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO holds (account, kind, amount_msat, fee_budget_msat, payment_hash, invoice, state, created_at, ref, destination, description, comment, offer, sale_id)
			VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`, r.Account, r.Kind, r.AmountMsat, r.FeeBudgetMsat, r.PaymentHash, r.Invoice, now.Unix(), ref,
			r.About.Destination, r.About.Description, r.About.Comment, r.Offer, saleID)
		if err != nil {
			return err
		}
		id, err := res.LastInsertId()
		s.touch(tx, r.Account)
		h = Hold{ID: id, Account: r.Account, Kind: r.Kind, AmountMsat: r.AmountMsat, FeeBudgetMsat: r.FeeBudgetMsat,
			PaymentHash: r.PaymentHash, Invoice: r.Invoice, Offer: r.Offer, State: HoldOpen, CreatedAt: time.Unix(now.Unix(), 0), About: r.About}
		return err
	})
	return h, err
}

const holdCols = `id, account, kind, amount_msat, fee_budget_msat, payment_hash, invoice, state, COALESCE(fee_msat, 0), created_at,
	destination, description, comment, preimage IS NOT NULL, COALESCE(preimage, ''), COALESCE(tx_id, 0),
	offer, payment_id, COALESCE(gave_up_at, 0), reason, COALESCE(sale_id, '')`

func scanHold(r scanner) (Hold, error) {
	var h Hold
	var created, gaveUp int64
	err := r.Scan(&h.ID, &h.Account, &h.Kind, &h.AmountMsat, &h.FeeBudgetMsat, &h.PaymentHash, &h.Invoice, &h.State, &h.FeeMsat, &created,
		&h.About.Destination, &h.About.Description, &h.About.Comment, &h.PreimageAsked, &h.Preimage, &h.TxID,
		&h.Offer, &h.PaymentID, &gaveUp, &h.Reason, &h.About.SaleID)
	if errors.Is(err, sql.ErrNoRows) {
		return Hold{}, ErrNotFound
	}
	h.CreatedAt = time.Unix(created, 0)
	if gaveUp > 0 {
		h.GaveUpAt = time.Unix(gaveUp, 0)
	}
	return h, err
}

func (s *Store) GetHold(ctx context.Context, id int64) (Hold, error) {
	return scanHold(s.db.QueryRowContext(ctx, `SELECT `+holdCols+` FROM holds WHERE id = ?`, id))
}

// HoldByRef finds the hold a send's request id made, or ErrNotFound.
func (s *Store) HoldByRef(ctx context.Context, ref string) (Hold, error) {
	return scanHold(s.db.QueryRowContext(ctx, `SELECT `+holdCols+` FROM holds WHERE ref = ?`, ref))
}

// SettledHolds lists the settled holds of one kind on one account with an id
// above afterID, oldest first: the renewals not yet counted in the hosting
// estimate.
func (s *Store) SettledHolds(ctx context.Context, acct Account, kind Kind, afterID int64) ([]Hold, error) {
	return s.holds(ctx, `SELECT `+holdCols+` FROM holds WHERE account = ? AND kind = ? AND state = 'settled' AND id > ? ORDER BY id`, acct, kind, afterID)
}

// OpenHolds lists the holds still waiting for an outcome, oldest first.
func (s *Store) OpenHolds(ctx context.Context) ([]Hold, error) {
	return s.holds(ctx, `SELECT `+holdCols+` FROM holds WHERE state = 'open' ORDER BY id`)
}

// HoldsToAsk lists up to limit settled holds after afterID whose proof
// phoenixd hasn't been asked for, oldest first (the fill-in pass, which
// walks on past a hold it skips).
func (s *Store) HoldsToAsk(ctx context.Context, afterID int64, limit int) ([]Hold, error) {
	return s.holds(ctx, `SELECT `+holdCols+` FROM holds WHERE state = 'settled' AND preimage IS NULL AND id > ? ORDER BY id LIMIT ?`, afterID, limit)
}

// KnownPaidHash is the payment hash of the newest settled hold with a proof,
// "" when there is none: a payment phoenixd has answered for, for the fill-in
// pass to check that phoenixd is answering. An offer's hold settled
// with no hash has none to ask with, so it is passed over.
func (s *Store) KnownPaidHash(ctx context.Context) (string, error) {
	var hash string
	err := s.db.QueryRowContext(ctx, `SELECT payment_hash FROM holds WHERE state = 'settled' AND preimage != '' AND payment_hash != '' ORDER BY id DESC LIMIT 1`).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return hash, err
}

// SetHoldProof keeps what phoenixd said of a settled hold: its preimage (""
// when it didn't know it) and, when the hold has none, a description. Once:
// a hold already asked is left as it is.
func (s *Store) SetHoldProof(ctx context.Context, id int64, preimage, description string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE holds SET preimage = ?,
		description = CASE WHEN description = '' THEN ? ELSE description END
		WHERE id = ? AND preimage IS NULL`, preimage, description, id)
	return err
}

// SetHoldPayment keeps phoenixd's payment hash and id on a hold (an offer's,
// once phoenixd has said them; an invoice's id). The same values again are
// fine; a hash other than the one kept is a conflict. A hold whose state
// changes rings nothing: no money moves.
func (s *Store) SetHoldPayment(ctx context.Context, id int64, paymentHash, paymentID string) (Hold, error) {
	var h Hold
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var err error
		h, err = scanHold(tx.QueryRowContext(ctx, `SELECT `+holdCols+` FROM holds WHERE id = ?`, id))
		if err != nil {
			return err
		}
		if paymentHash != "" && h.PaymentHash != "" && h.PaymentHash != paymentHash {
			return fmt.Errorf("%w: hold %d is for payment %s", ErrConflict, id, h.PaymentHash)
		}
		if paymentHash != "" {
			h.PaymentHash = paymentHash
		}
		if paymentID != "" {
			h.PaymentID = paymentID
		}
		_, err = tx.ExecContext(ctx, `UPDATE holds SET payment_hash = ?, payment_id = ? WHERE id = ?`, h.PaymentHash, h.PaymentID, id)
		return err
	})
	return h, err
}

// SetHoldGaveUp keeps when cardd stopped waiting on phoenixd for a hold.
func (s *Store) SetHoldGaveUp(ctx context.Context, id int64, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE holds SET gave_up_at = ? WHERE id = ?`, at.Unix(), id)
	return err
}

// HoldPaymentKnown reports whether any hold, in any state, has this payment
// id or hash: such a payment in phoenixd's list is that hold's, not an
// unhashed hold's. Empty values match nothing.
func (s *Store) HoldPaymentKnown(ctx context.Context, paymentID, paymentHash string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM holds WHERE (? != '' AND payment_id = ?) OR (? != '' AND payment_hash = ?)`,
		paymentID, paymentID, paymentHash, paymentHash).Scan(&n)
	return n > 0, err
}

func (s *Store) holds(ctx context.Context, query string, args ...any) ([]Hold, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Hold
	for rows.Next() {
		h, err := scanHold(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// SettleHold is SettleHoldWithProof without a proof (the fill-in pass asks
// phoenixd for it later).
func (s *Store) SettleHold(ctx context.Context, id, feeMsat int64) (Hold, error) {
	return s.SettleHoldWithProof(ctx, id, feeMsat, "")
}

// SettleHoldWithProof is SettleHoldWithProofAt with the line dated now.
func (s *Store) SettleHoldWithProof(ctx context.Context, id, feeMsat int64, preimage string) (Hold, error) {
	return s.SettleHoldWithProofAt(ctx, id, feeMsat, preimage, time.Time{})
}

// SettleHoldWithProofAt records a payment that succeeded with feeMsat in fees
// and preimage as its proof ("" when phoenixd's record had none: left for the
// fill-in pass). The account pays the amount and the fee. A fee above the
// budget is charged to the account up to its balance and the rest comes from
// pool as a fee-adjust, so a card never goes negative. The line booked
// carries the hold's note, and the hold is linked to it. Settling a
// settled hold is a no-op; a released one is a conflict.
//
// paidAt dates the lines: when phoenixd paid it (its completedAt), so a
// payment found after a restart shows when it was paid, not when cardd found
// it. It is kept within the hold's life: zero, or later than now,
// is now; before the hold was opened is when it was opened. The hold's
// resolved_at is always now.
func (s *Store) SettleHoldWithProofAt(ctx context.Context, id, feeMsat int64, preimage string, paidAt time.Time) (Hold, error) {
	var h Hold
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var err error
		h, err = scanHold(tx.QueryRowContext(ctx, `SELECT `+holdCols+` FROM holds WHERE id = ?`, id))
		if err != nil {
			return err
		}
		switch h.State {
		case HoldSettled:
			return nil
		case HoldReleased:
			return fmt.Errorf("%w: hold %d was released", ErrConflict, id)
		}
		now := s.now().Unix()
		if _, err := tx.ExecContext(ctx, `UPDATE holds SET state = 'settled', fee_msat = ?, resolved_at = ? WHERE id = ?`, feeMsat, now, id); err != nil {
			return err
		}
		at := now
		if !paidAt.IsZero() && paidAt.Unix() < now {
			at = max(paidAt.Unix(), h.CreatedAt.Unix())
		}
		s.touch(tx, h.Account)
		total := h.AmountMsat + feeMsat
		b, err := balance(ctx, tx, h.Account) // this hold no longer counts
		if err != nil {
			return err
		}
		if short := total - b.AvailableMsat(); short > 0 && h.Account != Pool {
			note := fmt.Sprintf("routing fee %d msat was above the %d msat budget", feeMsat, h.FeeBudgetMsat)
			if _, err := s.post(ctx, tx, at, KindFeeAdjust, "", note, Entry{Pool, -short}, Entry{h.Account, short}); err != nil {
				return err
			}
		}
		note := fmt.Sprintf("paid %s", h.PaymentHash)
		if h.About.SaleID != "" {
			note = fmt.Sprintf("refund of sale %s, paid %s", h.About.SaleID, h.PaymentHash)
		}
		txID, _, err := s.postID(ctx, tx, at, h.Kind, "", note, Entry{h.Account, -total}, Entry{World, h.AmountMsat}, Entry{Fees, feeMsat})
		if err != nil {
			return err
		}
		// A refund's sale points at it from now on, in this transaction,
		// whether it settles here or through Resolve after a restart.
		if h.About.SaleID != "" {
			if _, err := tx.ExecContext(ctx, `UPDATE sales SET refund_tx_id = ? WHERE id = ? AND refund_tx_id IS NULL`, txID, h.About.SaleID); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE holds SET preimage = NULLIF(?, ''), tx_id = ? WHERE id = ?`, preimage, txID, id); err != nil {
			return err
		}
		if h.About.Comment != "" {
			if _, err := tx.ExecContext(ctx, `UPDATE ledger_tx SET comment = ? WHERE id = ?`, h.About.Comment, txID); err != nil {
				return err
			}
		}
		h.State, h.FeeMsat, h.TxID = HoldSettled, feeMsat, txID
		h.Preimage, h.PreimageAsked = preimage, preimage != ""
		return nil
	})
	return h, err
}

// ReleaseHold gives the whole hold back (the payment failed or never left).
func (s *Store) ReleaseHold(ctx context.Context, id int64) (Hold, error) {
	return s.ReleaseHoldBecause(ctx, id, "")
}

// ReleaseHoldBecause is ReleaseHold keeping why, in the person's words (""
// for none). Releasing a released hold is a no-op; a settled one is a conflict.
func (s *Store) ReleaseHoldBecause(ctx context.Context, id int64, reason string) (Hold, error) {
	var h Hold
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var err error
		h, err = scanHold(tx.QueryRowContext(ctx, `SELECT `+holdCols+` FROM holds WHERE id = ?`, id))
		if err != nil {
			return err
		}
		switch h.State {
		case HoldReleased:
			return nil
		case HoldSettled:
			return fmt.Errorf("%w: hold %d was settled", ErrConflict, id)
		}
		_, err = tx.ExecContext(ctx, `UPDATE holds SET state = 'released', resolved_at = ?, reason = ? WHERE id = ?`, s.now().Unix(), reason, id)
		s.touch(tx, h.Account)
		h.State, h.Reason = HoldReleased, reason
		return err
	})
	return h, err
}

// SpentLast24hMsat is what a card has spent or holds for spending in the
// last 24 hours, the amount its daily limit counts.
func (s *Store) SpentLast24hMsat(ctx context.Context, acct Account) (int64, error) {
	var used int64
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(amount_msat), 0) FROM holds
		WHERE account = ? AND kind = 'spend' AND (state = 'open' OR (state = 'settled' AND created_at > ?))`,
		acct, s.now().Add(-24*time.Hour).Unix()).Scan(&used)
	return used, err
}

// LiabilitiesMsat is the total of the person's accounts (cards, pool,
// hosting, shop): what phoenixd must hold at least (open holds are still inside
// these totals until they settle).
func (s *Store) LiabilitiesMsat(ctx context.Context) (int64, error) {
	var sum int64
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(amount_msat), 0) FROM ledger_entry
		WHERE account IN ('pool', 'hosting', 'shop') OR account LIKE 'card:%'`).Scan(&sum)
	return sum, err
}

// OwedMsat is what phoenixd's spendable balance must cover: the person's
// accounts less what open holds reserve. phoenixd counts a payment on its
// way as already gone, so money in flight is on neither side.
func (s *Store) OwedMsat(ctx context.Context) (int64, error) {
	var sum int64
	err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT COALESCE(SUM(amount_msat), 0) FROM ledger_entry WHERE account IN ('pool', 'hosting', 'shop') OR account LIKE 'card:%')
		- (SELECT COALESCE(SUM(amount_msat + fee_budget_msat), 0) FROM holds WHERE state = 'open')`).Scan(&sum)
	return sum, err
}

// AdjustPool books msat (either sign) to pool against world, with no payment
// in progress; `cardd ledger reconcile` uses it to set the books to what
// phoenixd holds. pool may go negative.
func (s *Store) AdjustPool(ctx context.Context, msat int64, note string) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		var open int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM holds WHERE state = 'open'`).Scan(&open); err != nil {
			return err
		}
		if open > 0 {
			return ErrPaymentInProgress
		}
		_, err := s.post(ctx, tx, s.now().Unix(), KindAdjust, "", note, Entry{Pool, msat}, Entry{World, -msat})
		return err
	})
}

// txSelect is one account's view of ledger transactions: its leg's sum, the
// fees leg, a move's or a refund's other account of this wallet (never world
// or fees: a refund paid over Lightning has none), how a top-up came
// and a sale's facts; cond narrows it. The sale is the one the line paid or
// the one it refunded, each found by its own index (sales_tx, sales_refund).
const txSelect = `SELECT t.id, t.kind, t.note, t.comment, t.payer_note, t.via, SUM(e.amount_msat),
	(SELECT COALESCE(SUM(f.amount_msat), 0) FROM ledger_entry f WHERE f.tx_id = t.id AND f.account = 'fees'), t.created_at,
	CASE WHEN t.kind IN ('move', 'refund') THEN COALESCE((SELECT o.account FROM ledger_entry o WHERE o.tx_id = t.id AND o.account != ? AND o.account NOT IN ('world', 'fees') LIMIT 1), '') ELSE '' END,
	COALESCE(s.id, ''), s.card_at IS NOT NULL, COALESCE(d.name, ''), COALESCE(s.amount_msat, 0), COALESCE(t.ref, ''),
	COALESCE(s.price_currency, ''), COALESCE(s.price_minor, 0), COALESCE(s.paid_at, 0), ` + saleRefundColumns + `
	FROM ledger_tx t JOIN ledger_entry e ON e.tx_id = t.id
	LEFT JOIN sales s ON s.id = COALESCE((SELECT sp.id FROM sales sp WHERE sp.tx_id = t.id), (SELECT sr.id FROM sales sr WHERE sr.refund_tx_id = t.id))
	LEFT JOIN devices d ON d.key_id = s.device
	WHERE e.account = ? AND `

type txRow struct {
	Tx
	ref string
}

func (s *Store) txs(ctx context.Context, acct Account, cond string, args ...any) ([]txRow, error) {
	rows, err := s.db.QueryContext(ctx, txSelect+cond, append([]any{acct, acct}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []txRow{}
	for rows.Next() {
		var t txRow
		var created int64
		var sale TxSale
		var byCard bool
		var paidAt int64
		var r saleRefund
		if err := rows.Scan(&t.ID, &t.Kind, &t.Note, &t.Comment, &t.PayerNote, &t.Via, &t.AmountMsat, &t.FeeMsat, &created, &t.Other, &sale.ID, &byCard, &sale.Device, &sale.PriceMsat, &t.ref, &sale.PriceCurrency, &sale.PriceMinor,
			&paidAt, &r.txID, &r.pending, &r.at, &r.msat, &r.from, &sale.ReturnLink); err != nil {
			return nil, err
		}
		if paidAt > 0 {
			sale.PaidAt = time.Unix(paidAt, 0)
		}
		sale.RefundTxID, sale.RefundPending, sale.RefundMsat, sale.RefundFrom = r.txID, r.pending, r.msat, Account(r.from)
		if r.at > 0 {
			sale.RefundAt = time.Unix(r.at, 0)
		}
		t.CreatedAt = time.Unix(created, 0)
		if sale.ID != "" {
			sale.Method = "qr"
			if byCard {
				sale.Method = "card"
			}
			t.Sale = &sale
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// History lists an account's transactions, newest first, before the
// transaction id before (0 for the newest). A move names its other account,
// and a sale its own facts.
func (s *Store) History(ctx context.Context, acct Account, before int64, limit int) ([]Tx, error) {
	if before <= 0 {
		before = 1<<63 - 1
	}
	rows, err := s.txs(ctx, acct, `t.id < ? GROUP BY t.id ORDER BY t.id DESC LIMIT ?`, before, limit)
	out := make([]Tx, len(rows))
	for i, r := range rows {
		out[i] = r.Tx
	}
	return out, err
}

// LinePayment is what a Lightning payment's line says of the payment:
// from its hold for a send, a spend or a renewal; the ref
// for a top-up (its payment hash); the sale's row for a sale.
type LinePayment struct {
	Hash, Invoice, Offer, Description, Destination, Preimage string
	PreimageAsked                                            bool
}

// Line is one transaction as an account sees it, with its payment's facts
// when it was a Lightning payment (nil otherwise).
type Line struct {
	Tx
	Payment *LinePayment
}

// Line reads one transaction as acct sees it: ErrNotFound when it has no leg
// on acct (a leg of nothing counts, as History's).
func (s *Store) Line(ctx context.Context, acct Account, id int64) (Line, error) {
	rows, err := s.txs(ctx, acct, `t.id = ? GROUP BY t.id`, id)
	if err != nil {
		return Line{}, err
	}
	if len(rows) == 0 {
		return Line{}, ErrNotFound
	}
	l := Line{Tx: rows[0].Tx}
	switch l.Kind {
	case KindSend, KindSpend, KindRenew, KindRefund:
		var p LinePayment
		err := s.db.QueryRowContext(ctx, `SELECT payment_hash, invoice, offer, description, destination, COALESCE(preimage, ''), preimage IS NOT NULL
			FROM holds WHERE tx_id = ? ORDER BY id LIMIT 1`, id).Scan(&p.Hash, &p.Invoice, &p.Offer, &p.Description, &p.Destination, &p.Preimage, &p.PreimageAsked)
		if err == nil {
			l.Payment = &p
		} else if !errors.Is(err, sql.ErrNoRows) {
			return Line{}, err
		}
	case KindTopup:
		if rows[0].ref != "" {
			l.Payment = &LinePayment{Hash: rows[0].ref}
		}
	case KindSale:
		var p LinePayment
		err := s.db.QueryRowContext(ctx, `SELECT payment_hash, invoice FROM sales WHERE tx_id = ?`, id).Scan(&p.Hash, &p.Invoice)
		if err == nil {
			l.Payment = &p
		} else if !errors.Is(err, sql.ErrNoRows) {
			return Line{}, err
		}
	}
	return l, nil
}

// SetComment sets the person's note on a line acct can see ("" removes it)
// and answers the line as Line reads it. The caller has cleaned the note.
// It moves no money, so it rings no held read.
func (s *Store) SetComment(ctx context.Context, acct Account, id int64, comment string) (Line, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE ledger_tx SET comment = ? WHERE id = ?
		AND EXISTS (SELECT 1 FROM ledger_entry e WHERE e.tx_id = ledger_tx.id AND e.account = ?)`, comment, id, acct)
	if err != nil {
		return Line{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Line{}, ErrNotFound
	}
	return s.Line(ctx, acct, id)
}
