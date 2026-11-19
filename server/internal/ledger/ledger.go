// Package ledger pays invoices out of the person's accounts:
// it holds the amount plus a fee budget, pays with phoenixd, and settles or
// releases the hold exactly once, including for payments a restart cut off.
// It also keeps the reconciliation check that pauses spending, and sets the
// books after a restore.
package ledger

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/boltcard/karto/server/internal/lnaddr"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/store"
)

// Payer is the part of phoenixd the ledger pays with.
type Payer interface {
	DecodeInvoice(ctx context.Context, bolt11 string) (phoenixd.Invoice, error)
	PayInvoice(ctx context.Context, bolt11 string, amountSat int64) (phoenixd.PayResult, error)
	PayOffer(ctx context.Context, offer string, amountSat int64) (phoenixd.PayResult, error)
	OutgoingByID(ctx context.Context, paymentID string) (phoenixd.Outgoing, error)
	OutgoingByHash(ctx context.Context, paymentHash string) (phoenixd.Outgoing, error)
	ListOutgoing(ctx context.Context, fromMs, toMs int64, limit, offset int) ([]phoenixd.OutgoingRecord, error)
	BalanceSat(ctx context.Context) (int64, error)
}

var (
	ErrPaused     = errors.New("ledger: spending is paused until the books add up again")
	ErrBadInvoice = errors.New("ledger: the invoice can't be paid")
	// ErrRestorePending: Correct after a restore, before its books are set.
	ErrRestorePending = errors.New("ledger: after a restore the books are set to phoenixd's balance once its channel is back")
	// ErrNotNoChannel: SetBooksAfterRestore unless no channel came back.
	ErrNotNoChannel = errors.New("ledger: the books are set by hand after a restore only when no channel came back")
	// ErrChannelNotUp: SetBooksAfterRestore while phoenixd has a channel
	// that isn't Normal yet: its money would be missing from the balance.
	ErrChannelNotUp = errors.New("ledger: phoenixd has a channel that isn't up yet: wait for it")
)

// The reconcile after a restore, in meta restore.reconcile, before it is
// done (store.SetRestoreBooks writes "done").
const (
	restorePending   = "pending"
	restoreNoChannel = "no_channel"
	restoreDone      = "done"
	// store.SetRestoreBooks' from for the second setting, when a channel
	// came back after the person set the books with none.
	restoreChannelLater = "channel_later"
)

// FeeBudgetMsat is what a hold sets aside for routing: 0.5% rounded up, plus
// 5 sat, above phoenixd v0.9.2's trampoline fee (4 sat + 0.4%, conf/Lsp.kt,
// with a little over that seen on real payments); payinvoice takes no cap,
// and a fee above it is still paid (SettleHold).
func FeeBudgetMsat(amountMsat int64) int64 { return (amountMsat*5+999)/1000 + 5_000 }

// Outcome is a payment's result as far as it is known.
type Outcome struct {
	Hold    store.Hold
	Pending bool // phoenixd hasn't said yet; the hold stays open
}

// Ledger pays from accounts and watches the books.
type Ledger struct {
	store *store.Store
	payer Payer
	Now   func() time.Time // tests move the clock
	log   *log.Logger

	// Liquidity tells a restore's reconcile whether phoenixd's channel is up
	// (nil: the books are never set on their own). Sweep, if not nil, credits
	// top-ups whose webhook was missed before a restore's books are set, as
	// Correct's sweep does. RestoreWait is how long a restore waits for a
	// channel (30 minutes; the stack test shortens it).
	Liquidity   func(ctx context.Context) (phoenixd.Liquidity, error)
	Sweep       func(ctx context.Context) error
	RestoreWait time.Duration
	// BooksSet, if not nil, is told when the books have been set to
	// phoenixd's balance or found to agree with it (Correct, whenever it has
	// run its course; a restore's reconcile): whoever keeps count of
	// phoenixd's fee credit takes phoenixd's figure then. So Set the books
	// is always the person's way to have that figure taken afresh.
	BooksSet func(ctx context.Context)
	mu       sync.Mutex
	// inFlight is the holds a goroutine of ours is paying right now, by
	// inFlightKey: Resolve leaves them to it. Keyed by hold, as an offer's
	// hold has no payment hash until phoenixd answers.
	inFlight map[string]bool
	// gaveUp is when a payment of ours gave up waiting, by hold id, kept here
	// as well as in the books: if the write is lost, the grace still counts
	// from it until Resolve settles or releases the hold.
	gaveUp  map[int64]time.Time
	paused  bool // the last reconciliation failed or couldn't run
	filling bool // a FillProofs run is under way (fillLater)
	reason  string
	// fillFails counts, by hold id, the runs in which phoenixd failed on a
	// hold's question while answering others, with any preimage it
	// gave in one; fillKnown is the last hash a fill-in question was answered
	// for; fillStopped is the error the last stopped fillLater run logged, ""
	// after one that didn't stop.
	fillFails   map[int64]fillTry
	fillKnown   string
	fillStopped string

	checked     chan struct{} // closed once Run's first check has run
	checkedOnce sync.Once
}

func inFlightKey(id int64) string { return "hold:" + strconv.FormatInt(id, 10) }

func New(st *store.Store, payer Payer, logger *log.Logger) *Ledger {
	return &Ledger{store: st, payer: payer, Now: time.Now, log: logger, RestoreWait: 30 * time.Minute,
		inFlight: map[string]bool{}, gaveUp: map[int64]time.Time{}, fillFails: map[int64]fillTry{}, paused: true, reason: "not checked yet", checked: make(chan struct{})}
}

// Checked is closed once Run's first check (resolve and reconcile) has run,
// whether or not the books added up: the renewal job starts after it.
func (l *Ledger) Checked() <-chan struct{} { return l.checked }

// Paused reports whether spending and sending are stopped, and why.
func (l *Ledger) Paused() (bool, string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.paused, l.reason
}

// Reconcile checks that phoenixd holds at least what the ledger owes the
// person (cards, pool, hosting), less what open holds reserve: phoenixd's
// balance already leaves out a payment on its way. Spending stops while it
// fails or can't run, and starts again when it passes. phoenixd reports whole
// sats, so up to 1 sat of rounding is allowed. After a restore, spending
// waits until the books have been set (CheckRestore).
func (l *Ledger) Reconcile(ctx context.Context) error {
	state, err := l.restoreState(ctx)
	switch {
	case err != nil:
	case state == restorePending:
		err = errors.New("waiting for the channel to come back after a restore")
	case state == restoreNoChannel:
		err = errors.New("no channel came back after the restore: the books wait to be set to phoenixd's balance")
	default:
		var owed, bal int64
		if owed, err = l.store.OwedMsat(ctx); err == nil {
			bal, err = l.payer.BalanceSat(ctx)
			if err == nil && owed > bal*1000+1000 {
				err = fmt.Errorf("the books say %d msat, phoenixd holds %d sat", owed, bal)
			}
		}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err != nil {
		if !l.paused {
			l.log.Printf("ledger: spending paused: %v", err)
		}
		l.paused, l.reason = true, err.Error()
		return err
	}
	if l.paused {
		l.log.Printf("ledger: books add up; spending allowed")
	}
	l.paused, l.reason = false, ""
	return nil
}

// Correct sets the books to what phoenixd holds, for `cardd ledger
// reconcile` and the app when spending is paused because they don't add up:
// the difference goes to pool as an adjust (pool may go negative), then the
// check runs again. It refuses while a payment is in progress, sweeps first
// (sweep, if not nil: top-ups whose webhook was missed, which would otherwise
// be booked to pool and then credited again), and leaves books that add up
// alone. It returns the difference it booked. After a restore it refuses
// until the restore's books are set (ErrRestorePending): it only ever books a
// shortfall, and used while the channel is coming back it would write the
// person's money off.
func (l *Ledger) Correct(ctx context.Context, sweep func(context.Context) error) (int64, error) {
	if state, err := l.restoreState(ctx); err != nil {
		return 0, err
	} else if state == restorePending || state == restoreNoChannel {
		return 0, ErrRestorePending
	}
	if holds, err := l.store.OpenHolds(ctx); err != nil || len(holds) > 0 {
		if err == nil {
			err = store.ErrPaymentInProgress
		}
		return 0, err
	}
	if sweep != nil {
		if err := sweep(ctx); err != nil {
			return 0, err
		}
	}
	if l.Reconcile(ctx) == nil {
		if l.BooksSet != nil {
			l.BooksSet(ctx)
		}
		return 0, nil
	}
	owed, err := l.store.OwedMsat(ctx)
	if err != nil {
		return 0, err
	}
	bal, err := l.payer.BalanceSat(ctx)
	if err != nil {
		return 0, err
	}
	diff := bal*1000 - owed
	if diff != 0 {
		note := fmt.Sprintf("books set to phoenixd's balance: %d sat, the books said %d msat", bal, owed)
		if err := l.store.AdjustPool(ctx, diff, note); err != nil {
			return 0, err
		}
		l.log.Printf("ledger: %s", note)
	}
	if l.BooksSet != nil {
		l.BooksSet(ctx)
	}
	return diff, l.Reconcile(ctx)
}

// RestoreState is where the reconcile after a restore is.
type RestoreState struct {
	State          string // pending, no_channel or done
	From           string // meta restore.from: the backup restored, or "phrase"
	ReconciledMsat int64  // once done: what was booked to pool (either sign)
	ReconciledAt   int64  // once done: when, in unix seconds
	// Final: the backup was the old server's final snapshot (meta
	// restore.final, from cardd restore -final): nothing done there is missing.
	Final bool
}

// restoreState is meta restore.reconcile, "" when nothing was restored.
func (l *Ledger) restoreState(ctx context.Context) (string, error) {
	v, err := l.store.GetMeta(ctx, "restore.reconcile")
	if errors.Is(err, store.ErrNotFound) {
		return "", nil
	}
	return v, err
}

// Restore reports the reconcile after a restore, nil when nothing was restored.
func (l *Ledger) Restore(ctx context.Context) (*RestoreState, error) {
	state, err := l.restoreState(ctx)
	if err != nil || state == "" {
		return nil, err
	}
	r := &RestoreState{State: state}
	if r.From, err = l.store.GetMeta(ctx, "restore.from"); err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	switch _, err := l.store.GetMeta(ctx, "restore.final"); {
	case err == nil:
		r.Final = true
	case !errors.Is(err, store.ErrNotFound):
		return nil, err
	}
	v, err := l.store.GetMeta(ctx, "restore.reconciled")
	switch {
	case err == nil:
		fmt.Sscan(v, &r.ReconciledMsat, &r.ReconciledAt)
	case !errors.Is(err, store.ErrNotFound):
		return nil, err
	}
	return r, nil
}

// CheckRestore is one step of the reconcile after a restore, which Run
// takes every minute while it is pending. Once phoenixd's
// channel is back in its normal state (ACINQ's copy adopted) and no hold is
// open (Resolve releases the snapshot's after their grace), the books are
// set to phoenixd's balance both ways. With no channel RestoreWait after
// phoenixd first answered, it stops at no_channel for the person to decide.
// phoenixd says nothing of its connection to ACINQ, so the wait counts from
// the first step at which it answers, kept in meta restore.waiting_since so
// that a restart doesn't start it again. A channel that comes back after
// no_channel sets the books then, once, as if it had come in time.
func (l *Ledger) CheckRestore(ctx context.Context) error {
	if l.Liquidity == nil {
		return nil
	}
	state, err := l.restoreState(ctx)
	if err != nil {
		return err
	}
	if state == restoreDone {
		// Books set by hand with no channel: one that comes back is booked then.
		if _, err := l.store.GetMeta(ctx, "restore.channel_later"); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return nil
			}
			return err
		}
		liq, err := l.Liquidity(ctx)
		if err != nil || !liq.Usable {
			return err
		}
		if holds, err := l.store.OpenHolds(ctx); err != nil || len(holds) > 0 {
			return err
		}
		l.log.Printf("ledger: restore: a channel came back after the books were set; setting them again")
		_, err = l.setRestoreBooks(ctx, restoreChannelLater, false)
		return err
	}
	if state != restorePending && state != restoreNoChannel {
		return nil
	}
	liq, err := l.Liquidity(ctx)
	if err != nil {
		return err
	}
	if state == restoreNoChannel {
		return l.booksOnceUsable(ctx, liq, restoreNoChannel)
	}
	now := l.Now()
	since := now.Unix()
	v, err := l.store.GetMeta(ctx, "restore.waiting_since")
	switch {
	case errors.Is(err, store.ErrNotFound):
		if err := l.store.SetMeta(ctx, "restore.waiting_since", strconv.FormatInt(since, 10)); err != nil {
			return err
		}
		l.log.Printf("ledger: restore: phoenixd answers; waiting for its channel")
	case err != nil:
		return err
	default:
		if since, err = strconv.ParseInt(v, 10, 64); err != nil {
			return fmt.Errorf("restore.waiting_since %q: %w", v, err)
		}
	}
	if liq.Usable {
		return l.booksOnceUsable(ctx, liq, restorePending)
	}
	if !liq.Channel {
		// Books that owe nothing, with no hold open, have nothing a missing
		// channel could hold: set them now, and book a channel that comes
		// back later (money received after the backup) then.
		owed, err := l.store.OwedMsat(ctx)
		if err != nil {
			return err
		}
		holds, err := l.store.OpenHolds(ctx)
		if err != nil {
			return err
		}
		if owed <= 0 && len(holds) == 0 {
			l.log.Printf("ledger: restore: the backup owes nothing and phoenixd has no channel; setting the books now")
			_, err := l.setRestoreBooks(ctx, restorePending, true)
			return err
		}
	}
	if now.Before(time.Unix(since, 0).Add(l.RestoreWait)) {
		return nil
	}
	l.log.Printf("ledger: restore: no channel after %s; the books wait for the person", l.RestoreWait)
	if err := l.store.SetMeta(ctx, "restore.reconcile", restoreNoChannel); err != nil {
		return err
	}
	l.Reconcile(ctx)
	return nil
}

// booksOnceUsable sets the books from state once the channel is Normal and
// no hold is open (Resolve releases the snapshot's after their grace).
func (l *Ledger) booksOnceUsable(ctx context.Context, liq phoenixd.Liquidity, from string) error {
	if !liq.Usable {
		return nil
	}
	if holds, err := l.store.OpenHolds(ctx); err != nil || len(holds) > 0 {
		return err
	}
	_, err := l.setRestoreBooks(ctx, from, false)
	return err
}

// SetBooksAfterRestore is the person's choice when no channel came back after
// a restore (the money may be on-chain in phoenixd's wallet, or was spent
// after the backup): the books are set to phoenixd's balance both ways and
// spending starts again. It refuses in any other state (ErrNotNoChannel),
// while phoenixd has a channel that isn't up yet (ErrChannelNotUp: its money
// isn't in the balance yet, and CheckRestore books it once it is), and while
// a payment is in progress. It returns the difference it booked.
func (l *Ledger) SetBooksAfterRestore(ctx context.Context) (int64, error) {
	if state, err := l.restoreState(ctx); err != nil {
		return 0, err
	} else if state != restoreNoChannel {
		return 0, ErrNotNoChannel
	}
	channelLater := false
	if l.Liquidity != nil {
		liq, err := l.Liquidity(ctx)
		if err != nil {
			return 0, err
		}
		if liq.Channel && !liq.Usable {
			return 0, ErrChannelNotUp
		}
		channelLater = !liq.Channel
	}
	return l.setRestoreBooks(ctx, restoreNoChannel, channelLater)
}

// setRestoreBooks sets the books both ways, unlike Correct: phoenixd's
// balance less what the books owe goes to pool in either direction (pool may
// go below zero), a difference under 1 sat (phoenixd's rounding) is left, and
// the restore is done. The split between accounts stays the backup's.
func (l *Ledger) setRestoreBooks(ctx context.Context, from string, channelLater bool) (int64, error) {
	if l.Sweep != nil {
		if err := l.Sweep(ctx); err != nil {
			return 0, err
		}
	}
	owed, err := l.store.OwedMsat(ctx)
	if err != nil {
		return 0, err
	}
	bal, err := l.payer.BalanceSat(ctx)
	if err != nil {
		return 0, err
	}
	diff := bal*1000 - owed
	if diff > -1000 && diff < 1000 {
		diff = 0
	}
	note := fmt.Sprintf("restore: the books set to phoenixd's balance: %d sat, the books said %d msat", bal, owed)
	if err := l.store.SetRestoreBooks(ctx, from, diff, note, l.Now(), channelLater); err != nil {
		return 0, err
	}
	if l.BooksSet != nil {
		l.BooksSet(ctx)
	}
	l.log.Printf("ledger: %s (%+d msat to pool)", note, diff)
	return diff, l.Reconcile(ctx)
}

// Decode reads an invoice and checks it can be paid: mainnet, an amount, not expired.
func (l *Ledger) Decode(ctx context.Context, bolt11 string) (phoenixd.Invoice, error) {
	return l.DecodeFor(ctx, bolt11, 0)
}

// AmountError is DecodeFor's answer for an invoice whose own amount isn't the
// one given: a bad invoice to everything (errors.Is ErrBadInvoice), and the
// two amounts for a refund's other_amount.
type AmountError struct{ InvoiceMsat, GivenMsat int64 }

func (e *AmountError) Error() string {
	return fmt.Sprintf("%v: it is for %d msat, not %d", ErrBadInvoice, e.InvoiceMsat, e.GivenMsat)
}

func (e *AmountError) Unwrap() error { return ErrBadInvoice }

// DecodeFor is Decode for a payer who may give the amount (0: none given).
// An invoice without an amount takes it, in whole sats (phoenixd's payinvoice
// takes amountSat), and is then paid for it; an invoice with an amount must
// agree with the amount given.
func (l *Ledger) DecodeFor(ctx context.Context, bolt11 string, amountMsat int64) (phoenixd.Invoice, error) {
	inv, err := l.payer.DecodeInvoice(ctx, bolt11)
	switch {
	case errors.Is(err, phoenixd.ErrUnreachable):
		return phoenixd.Invoice{}, err
	case err != nil:
		return phoenixd.Invoice{}, fmt.Errorf("%w: it can't be read", ErrBadInvoice)
	case inv.Chain != "mainnet":
		return phoenixd.Invoice{}, fmt.Errorf("%w: it is for %s", ErrBadInvoice, inv.Chain)
	case inv.AmountMsat <= 0 && amountMsat <= 0:
		return phoenixd.Invoice{}, fmt.Errorf("%w: it has no amount", ErrBadInvoice)
	case inv.AmountMsat <= 0 && amountMsat%1000 != 0:
		return phoenixd.Invoice{}, fmt.Errorf("%w: an amount for it must be whole sats", ErrBadInvoice)
	case inv.AmountMsat > 0 && amountMsat > 0 && inv.AmountMsat != amountMsat:
		return phoenixd.Invoice{}, &AmountError{InvoiceMsat: inv.AmountMsat, GivenMsat: amountMsat}
	case !inv.ExpiresAt().After(l.Now()):
		return phoenixd.Invoice{}, fmt.Errorf("%w: it has expired", ErrBadInvoice)
	}
	if inv.AmountMsat <= 0 {
		inv.AmountMsat, inv.AmountGiven = amountMsat, true
	}
	return inv, nil
}

// Pay holds the money for an invoice already decoded, then pays it in the
// background. done, if not nil, receives the outcome once (Pending when
// phoenixd gave no answer). The hold's checks (limits, balance, one payment
// at a time) are store.OpenHold's.
func (l *Ledger) Pay(ctx context.Context, acct store.Account, kind store.Kind, bolt11 string, inv phoenixd.Invoice, done chan<- Outcome) (store.Hold, error) {
	return l.PayOnce(ctx, "", acct, kind, bolt11, inv, store.HoldAbout{}, done)
}

// PayOnce is Pay with the hold made once per ref (a send's request id): a
// second payment for the same ref is store.ErrDuplicatePayment. about is
// what the payment was; its description is the invoice's, and the
// caller's (an LNURL pay request's text/plain) only when the invoice carries
// none (a hash-only invoice, LUD-06), or one that cleans to nothing.
// Destination and description are cleaned here.
func (l *Ledger) PayOnce(ctx context.Context, ref string, acct store.Account, kind store.Kind, bolt11 string, inv phoenixd.Invoice, about store.HoldAbout, done chan<- Outcome) (store.Hold, error) {
	if own := ownDescription(inv); own != "" {
		about.Description = own
	} else {
		about.Description = lnaddr.Clean(about.Description, lnaddr.MaxText)
	}
	about.Destination = lnaddr.Clean(about.Destination, lnaddr.MaxLink)
	if paused, _ := l.Paused(); paused {
		return store.Hold{}, ErrPaused
	}
	// Marked as the hold appears: OpenHold runs under l.mu, and Resolve reads
	// inFlight under l.mu, so no Resolve can see this hold before it is
	// marked. (A retried invoice whose earlier hold was released has a failed
	// record at phoenixd: a Resolve between the two would release this hold
	// while its payment leaves.)
	l.mu.Lock()
	h, err := l.store.OpenHold(ctx, store.HoldRequest{Account: acct, Kind: kind, AmountMsat: inv.AmountMsat,
		FeeBudgetMsat: FeeBudgetMsat(inv.AmountMsat), PaymentHash: inv.PaymentHash, Invoice: bolt11, Ref: ref, About: about})
	if err == nil {
		l.inFlight[inFlightKey(h.ID)] = true
	}
	l.mu.Unlock()
	if err != nil {
		return store.Hold{}, err
	}
	held := time.Now() // on the real clock: what the log's times count from
	go func() {
		var amountSat int64
		if inv.AmountGiven {
			amountSat = inv.AmountMsat / 1000
		}
		out := l.pay(h, amountSat, held)
		l.mu.Lock()
		delete(l.inFlight, inFlightKey(h.ID))
		l.mu.Unlock()
		if done != nil {
			done <- out
		}
	}()
	return h, nil
}

// PayOfferOnce holds the money for a BOLT12 offer already checked (the
// lookup's, sendto.CheckOffer) and pays it in the background, once per ref,
// as PayOnce pays an invoice. The hold has no payment
// hash until phoenixd answers; done receives the outcome once (Pending when
// phoenixd gave none: Resolve finds the payment in phoenixd's list later).
// amountMsat is whole sats: payoffer takes amountSat.
func (l *Ledger) PayOfferOnce(ctx context.Context, ref string, acct store.Account, kind store.Kind, offer string, amountMsat int64, about store.HoldAbout, done chan<- Outcome) (store.Hold, error) {
	about.Description = lnaddr.Clean(about.Description, lnaddr.MaxText)
	about.Destination = lnaddr.Clean(about.Destination, lnaddr.MaxLink)
	if amountMsat <= 0 || amountMsat%1000 != 0 {
		return store.Hold{}, fmt.Errorf("%w: an offer is paid in whole sats", ErrBadInvoice)
	}
	if paused, _ := l.Paused(); paused {
		return store.Hold{}, ErrPaused
	}
	// Marked as the hold appears, under l.mu, as PayOnce does.
	l.mu.Lock()
	h, err := l.store.OpenHold(ctx, store.HoldRequest{Account: acct, Kind: kind, AmountMsat: amountMsat,
		FeeBudgetMsat: FeeBudgetMsat(amountMsat), Offer: offer, Ref: ref, About: about})
	if err == nil {
		l.inFlight[inFlightKey(h.ID)] = true
	}
	l.mu.Unlock()
	if err != nil {
		return store.Hold{}, err
	}
	held := time.Now()
	go func() {
		out := l.payOffer(h, held)
		l.mu.Lock()
		delete(l.inFlight, inFlightKey(h.ID))
		l.mu.Unlock()
		if done != nil {
			done <- out
		}
	}()
	return h, nil
}

// payOffer runs one offer's payment to its outcome, as pay does an invoice's.
// Any answer that isn't "sent" releases the hold: some of phoenixd's early
// failures leave no record to wait for.
func (l *Ledger) payOffer(h store.Hold, held time.Time) Outcome {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	r, err := l.payer.PayOffer(ctx, h.Offer, h.AmountMsat/1000)
	answered := time.Now()
	if errors.Is(err, phoenixd.ErrRefused) {
		r, err = phoenixd.PayResult{Reason: err.Error()}, nil
	}
	if err != nil {
		l.log.Printf("ledger: hold %d: no answer from phoenixd for the offer, resolving later: %v", h.ID, err)
		l.giveUp(h.ID)
		return Outcome{Hold: h, Pending: true}
	}
	if r.PaymentHash != "" || r.PaymentID != "" {
		known, err := l.store.SetHoldPayment(ctx, h.ID, r.PaymentHash, r.PaymentID)
		if err != nil {
			l.log.Printf("ledger: hold %d: keeping its payment: %v", h.ID, err)
			return Outcome{Hold: h, Pending: true}
		}
		h = known
	}
	if !r.Sent {
		l.log.Printf("ledger: hold %d failed (%s) %d ms after the money was held: %s", h.ID, named(h), answered.Sub(held).Milliseconds(), r.Reason)
		released, err := l.store.ReleaseHoldBecause(ctx, h.ID, OfferReason(r.Reason))
		if err != nil {
			l.log.Printf("ledger: hold %d: release: %v", h.ID, err)
			return Outcome{Hold: h, Pending: true}
		}
		return Outcome{Hold: released}
	}
	if r.RecipientSat*1000 != h.AmountMsat {
		// Logged loudly; the hold's amount is what is booked. phoenixd refuses
		// an invoice whose amount differs, so this is a sign of something deeper.
		l.log.Printf("ledger: hold %d: phoenixd paid the offer %d sat, the hold is for %d msat", h.ID, r.RecipientSat, h.AmountMsat)
	}
	o, err := l.sent(ctx, h, r.PaymentID)
	if err != nil || o.Status != phoenixd.OutgoingPaid {
		l.log.Printf("ledger: hold %d: sent, but no exact fee yet (%v); resolving later", h.ID, err)
		return Outcome{Hold: h, Pending: true}
	}
	settled, err := l.store.SettleHoldWithProof(ctx, h.ID, o.FeesMsat, proof(o.Preimage))
	if err != nil {
		l.log.Printf("ledger: hold %d: settle: %v", h.ID, err)
		return Outcome{Hold: h, Pending: true}
	}
	l.log.Printf("ledger: hold %d paid (%s): payoffer fetch+pay %d ms, in the books %d ms later%s",
		h.ID, named(settled), answered.Sub(held).Milliseconds(), time.Since(answered).Milliseconds(), recordTook(o))
	return Outcome{Hold: settled}
}

// OfferReason is why phoenixd didn't pay an offer, in the person's words:
// lightning-kmp's fixed texts (payment/OfferManager.kt:37-40),
// matched as they appear in payoffer's reason. Any other reason has none:
// the app says plain "Not sent". phoenixd's own text goes to the log.
func OfferReason(reason string) string {
	switch {
	case strings.Contains(reason, "no response to the invoice request"):
		return "The receiving wallet didn't answer: it may be offline. Try again later."
	case strings.Contains(reason, "recipient responded to the invoice request with an error"):
		return "The receiving wallet refused the payment."
	case strings.Contains(reason, "recipient returned an invalid response to the invoice request"),
		strings.Contains(reason, "recipient returned an invoice that does not match the request"):
		return "The receiving wallet answered with an invoice that doesn't match the offer."
	}
	return ""
}

// pay runs one payment to its outcome, with a context of its own: the
// request that started it may already have been answered. However it ends
// it says so in the log once, with how long it took from held, when the
// money was held: a payment that was slow can be explained from the log.
func (l *Ledger) pay(h store.Hold, amountSat int64, held time.Time) Outcome {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	r, err := l.payer.PayInvoice(ctx, h.Invoice, amountSat)
	answered := time.Now()
	if errors.Is(err, phoenixd.ErrRefused) {
		// phoenixd refused the request before paying: nothing left.
		r, err = phoenixd.PayResult{Reason: err.Error()}, nil
	}
	if err != nil {
		l.log.Printf("ledger: hold %d: no answer from phoenixd, resolving later: %v", h.ID, err)
		l.giveUp(h.ID)
		return Outcome{Hold: h, Pending: true}
	}
	if !r.Sent {
		l.log.Printf("ledger: hold %d failed (%s) %d ms after the money was held: %s", h.ID, named(h), answered.Sub(held).Milliseconds(), r.Reason)
		released, err := l.store.ReleaseHold(ctx, h.ID)
		if err != nil {
			l.log.Printf("ledger: hold %d: release: %v", h.ID, err)
			return Outcome{Hold: h, Pending: true}
		}
		return Outcome{Hold: released}
	}
	if r.PaymentID != "" {
		// phoenixd's id is kept on an invoice's hold too. Failing to
		// keep it is only said: the hash already names the payment.
		if kept, err := l.store.SetHoldPayment(ctx, h.ID, "", r.PaymentID); err != nil {
			l.log.Printf("ledger: hold %d: keeping its payment id: %v", h.ID, err)
		} else {
			h = kept
		}
	}
	o, err := l.sent(ctx, h, r.PaymentID)
	if err != nil || o.Status != phoenixd.OutgoingPaid {
		l.log.Printf("ledger: hold %d: sent, but no exact fee yet (%v); resolving later", h.ID, err)
		return Outcome{Hold: h, Pending: true}
	}
	settled, err := l.store.SettleHoldWithProof(ctx, h.ID, o.FeesMsat, proof(o.Preimage))
	if err != nil {
		l.log.Printf("ledger: hold %d: settle: %v", h.ID, err)
		return Outcome{Hold: h, Pending: true}
	}
	l.log.Printf("ledger: hold %d paid (%s): phoenixd answered %d ms after the money was held, in the books %d ms later%s",
		h.ID, named(h), answered.Sub(held).Milliseconds(), time.Since(answered).Milliseconds(), recordTook(o))
	return Outcome{Hold: settled}
}

// giveUp keeps when cardd gave up waiting on a payment, in memory first and
// then in the books (tried twice), on a context of its own: the payment's may
// be what ran out. A write that fails must not shorten the grace.
func (l *Ledger) giveUp(id int64) {
	at := l.Now()
	l.mu.Lock()
	l.gaveUp[id] = at
	l.mu.Unlock()
	for try := 0; try < 2; try++ {
		keep, stop := context.WithTimeout(context.Background(), 10*time.Second)
		err := l.store.SetHoldGaveUp(keep, id, at)
		stop()
		if err == nil {
			return
		}
		l.log.Printf("ledger: hold %d: keeping when cardd gave up: %v", id, err)
	}
}

// sent reads a payment payinvoice said was sent from phoenixd's own record
// of it, which has the exact fee (payinvoice's answer rounds it to whole
// sats) and phoenixd's times: by the id payinvoice answered with (the API's
// "Get outgoing payment"), or by its hash when there was no id or phoenixd
// has no answer for it.
func (l *Ledger) sent(ctx context.Context, h store.Hold, paymentID string) (phoenixd.Outgoing, error) {
	if paymentID != "" {
		if o, err := l.payer.OutgoingByID(ctx, paymentID); err == nil && o.Status != phoenixd.OutgoingNone {
			return o, nil
		}
	}
	return l.payer.OutgoingByHash(ctx, h.PaymentHash)
}

// named is a hold as the log names it: what kind of payment, out of which
// account, and its payment hash, which phoenixd's log has too; an offer's
// hold before its hash is known, by "offer" and its id. No amount, no invoice.
func named(h store.Hold) string {
	if h.PaymentHash == "" {
		return fmt.Sprintf("%s out of %s, offer, hold %d", h.Kind, h.Account, h.ID)
	}
	return fmt.Sprintf("%s out of %s, %s", h.Kind, h.Account, h.PaymentHash)
}

// recordTook is how long phoenixd's record says a payment took, for the
// log: nothing for a record without both of its times.
func recordTook(o phoenixd.Outgoing) string {
	if o.CreatedAt.IsZero() || o.CompletedAt.IsZero() {
		return ""
	}
	return fmt.Sprintf("; phoenixd's record: %d ms", o.CompletedAt.Sub(o.CreatedAt).Milliseconds())
}

// proof is a preimage from phoenixd as the books keep it: 64 hex characters,
// or "" for anything else (not known). The store trusts its caller with it.
func proof(preimage string) string {
	if _, err := hex.DecodeString(preimage); err != nil || len(preimage) != 64 {
		return ""
	}
	return preimage
}

// ownDescription is an invoice's plain description, cleaned: none
// for one that carries a description hash instead (BOLT 11 has an invoice
// carry one or the other), whatever text phoenixd's decode puts beside it.
func ownDescription(inv phoenixd.Invoice) string {
	if inv.DescriptionHash != "" {
		return ""
	}
	return lnaddr.Clean(inv.Description, lnaddr.MaxText)
}

// unsentGrace is how old a hold must be before "phoenixd has no record of
// it" means it was never sent: a payinvoice that reached phoenixd just
// before cardd stopped may not be recorded yet.
const unsentGrace = 2 * time.Minute

// matchWindow is how long before an unhashed hold was made Resolve looks for
// its payment in phoenixd's list: the hold's time is whole seconds. cardd and
// phoenixd read one clock (the containers share the VM's kernel).
const matchWindow = 10 * time.Second

// listPage is how many payments one call to phoenixd's list asks for.
const listPage = 100

// Resolve asks phoenixd about every open hold that no payment of ours is
// working on (after a restart, or a payinvoice or payoffer that gave no
// answer): paid → settle; failed → release; no record for unsentGrace (from
// the hold's creation, or from when a payment of ours gave up waiting) →
// release (never sent); still pending → leave it. An offer's hold with no
// hash yet is first found in phoenixd's list (resolveUnhashed).
func (l *Ledger) Resolve(ctx context.Context) error {
	holds, err := l.store.OpenHolds(ctx)
	if err != nil {
		return err
	}
	for _, h := range holds {
		l.mu.Lock()
		busy := l.inFlight[inFlightKey(h.ID)]
		gaveUp := l.gaveUp[h.ID]
		l.mu.Unlock()
		if busy {
			continue
		}
		since := h.CreatedAt
		if h.GaveUpAt.After(since) {
			since = h.GaveUpAt
		}
		if gaveUp.After(since) {
			since = gaveUp
		}
		if h.PaymentHash == "" {
			err = l.resolveUnhashed(ctx, h, since)
		} else {
			var o phoenixd.Outgoing
			if o, err = l.payer.OutgoingByHash(ctx, h.PaymentHash); err == nil {
				err = l.settleFrom(ctx, h, o, since)
			}
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// settleFrom ends a hold as phoenixd's record of its payment says: paid →
// settle; failed → release; no record for unsentGrace since `since` →
// release (never sent); still pending → leave it. A hold it ends is
// forgotten from gaveUp.
func (l *Ledger) settleFrom(ctx context.Context, h store.Hold, o phoenixd.Outgoing, since time.Time) error {
	resolved, how := true, ""
	var err error
	switch o.Status {
	case phoenixd.OutgoingPaid:
		// Dated when phoenixd paid it, not when cardd found it.
		_, err = l.store.SettleHoldWithProofAt(ctx, h.ID, o.FeesMsat, proof(o.Preimage), o.CompletedAt)
		how = "paid"
	case phoenixd.OutgoingFailed:
		_, err = l.store.ReleaseHold(ctx, h.ID)
		how = "failed"
	case phoenixd.OutgoingNone:
		if resolved = since.Before(l.Now().Add(-unsentGrace)); resolved {
			_, err = l.store.ReleaseHold(ctx, h.ID)
			how = "never sent"
		}
	default:
		resolved = false
	}
	if err != nil {
		return err
	}
	if resolved {
		l.mu.Lock()
		delete(l.gaveUp, h.ID)
		l.mu.Unlock()
		// The one line a payment that ended without an answer gets.
		l.log.Printf("ledger: hold %d %s (%s), found %d s after the money was held%s",
			h.ID, how, named(h), int64(l.Now().Sub(h.CreatedAt).Seconds()), recordTook(o))
	}
	return nil
}

// resolveUnhashed finds an offer's payment whose answer was lost:
// in phoenixd's list from matchWindow before the hold, a Lightning payment no
// hold has by id or hash, for the hold's amount in phoenixd's units. One:
// it is this hold's. None: released after the grace, as phoenixd records an
// offer's payment within its 30 s invoice fetch. More: left held, said.
func (l *Ledger) resolveUnhashed(ctx context.Context, h store.Hold, since time.Time) error {
	if h.PaymentID != "" {
		// phoenixd's id is known (it answered without a hash, or cardd stopped
		// after keeping the id): read the payment by it. Matching would rule
		// it out, as its id is this hold's own.
		o, err := l.payer.OutgoingByID(ctx, h.PaymentID)
		if err != nil {
			return err
		}
		return l.settleFrom(ctx, h, o, since)
	}
	from := h.CreatedAt.Add(-matchWindow).UnixMilli()
	to := later(l.Now(), time.Now()).Add(time.Minute).UnixMilli()
	var match []phoenixd.OutgoingRecord
	// Paging by offset relies on phoenixd listing in a stable order between
	// pages. Its query has no ORDER BY, but its outgoing table is
	// append-only, its rows updated in place, so its scan is stable and no
	// record is skipped today (ListOutgoing). A record listed twice is still
	// counted once (seen): a duplicate must not make a second match.
	seen := map[string]bool{}
	for offset := 0; ; offset += listPage {
		page, err := l.payer.ListOutgoing(ctx, from, to, listPage, offset)
		if err != nil {
			return err
		}
		for _, r := range page {
			// A failed record is never taken as the hold's: it may be a payment
			// made from this phoenixd outside cardd, and keeping its hash would
			// book the hold by it, releasing it (within the grace) while its
			// own payment may still go out. The hold's own payment, failed,
			// leaves the hold to the grace instead, as no record does. A
			// record with no id is never counted: it can't be told from
			// another id-less one, nor attached to the hold.
			if r.SubType != "lightning" || r.Status == phoenixd.OutgoingFailed || !paysAmount(r, h.AmountMsat) || r.ID == "" || seen[r.ID] {
				continue
			}
			seen[r.ID] = true
			known, err := l.store.HoldPaymentKnown(ctx, r.ID, r.Hash)
			if err != nil {
				return err
			}
			if !known {
				match = append(match, r)
			}
		}
		if len(page) < listPage {
			break
		}
	}
	switch len(match) {
	case 0:
		return l.settleFrom(ctx, h, phoenixd.Outgoing{Status: phoenixd.OutgoingNone}, since)
	case 1:
	default:
		l.log.Printf("ledger: resolve: hold %d matches %d payments; left held", h.ID, len(match))
		return nil
	}
	r := match[0]
	if r.CreatedAt.Before(h.CreatedAt) {
		l.log.Printf("ledger: resolve: hold %d took payment %s made %d ms before the hold: it may be an older, released hold's",
			h.ID, r.Hash, h.CreatedAt.Sub(r.CreatedAt).Milliseconds())
	}
	known, err := l.store.SetHoldPayment(ctx, h.ID, r.Hash, r.ID)
	if err != nil {
		return err
	}
	l.log.Printf("ledger: resolve: hold %d is payment %s", h.ID, r.Hash)
	return l.settleFrom(ctx, known, r.Outgoing, since)
}

// paysAmount is whether a payment in phoenixd's list is for amountMsat, in
// phoenixd's units: sent is whole sats of amount + fee, rounded down; fees
// msat, 0 until paid.
func paysAmount(r phoenixd.OutgoingRecord, amountMsat int64) bool {
	total := amountMsat + r.FeesMsat
	return r.SentSat*1000 <= total && total < (r.SentSat+1)*1000
}

// later is the later of two times.
func later(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// fillBatch is how many holds one round of FillProofs reads at a time.
const fillBatch = 100

// fillTry is a hold phoenixd failed on: in how many runs, and a preimage it
// gave in one of them (only its decode failed).
type fillTry struct {
	tries    int
	preimage string
}

// fillTries is how many runs a hold phoenixd fails on (HTTP 5xx while it
// answers otherwise) is asked in before it is kept as asked.
const fillTries = 3

// FillProofs asks phoenixd, once per hold, for the proof of every settled
// payment cardd has none for: sends from before migration
// 8, and any whose record had no preimage when it settled. A record with a
// preimage keeps it; anything else is kept empty, asked and not known
// (phoenixd doesn't know it: a restored server's phoenixd knows nothing from
// before the restore). A hold with no description gets its invoice's, from
// phoenixd's raw decode: Decode refuses an expired invoice, and every old one
// is. A 400 from phoenixd is a question it will never answer, so it counts as
// not known.
//
// A 5xx is phoenixd failing on that hold's question, if it still answers a
// payment question it answered before: the hold is skipped (skipped
// counts it) and the walk goes on; at its fillTries-th such run it is kept as
// asked, with any proof phoenixd gave in one of them. The check is a payment
// question, not the balance: phoenixd answers its balance from memory and
// payments from its database, which is what fails while locked. With no
// payment phoenixd is known to answer yet, a failing hold is skipped without
// being counted. A 5xx with the check failing too, or any other error (no
// answer, a 401 or 429), is phoenixd as a whole: it stops the run with nothing
// more marked or counted, and the next call goes on from there.
func (l *Ledger) FillProofs(ctx context.Context) (found, unknown, skipped int, err error) {
	var after int64
	for {
		holds, err := l.store.HoldsToAsk(ctx, after, fillBatch)
		if err != nil || len(holds) == 0 {
			return found, unknown, skipped, err
		}
		for _, h := range holds {
			after = h.ID
			preimage, desc, answered, err := l.askProof(ctx, h)
			if err != nil {
				var failed *phoenixd.ServerError
				if !errors.As(err, &failed) {
					return found, unknown, skipped, err
				}
				// Only the decode failed: phoenixd has just answered this
				// hold's payment question, so it is answering.
				up := answered
				if !up {
					var perr error
					if up, perr = l.answering(ctx, h.PaymentHash); perr != nil {
						return found, unknown, skipped, perr // the check's own error: phoenixd's, or the store's
					}
				}
				if !up {
					skipped++
					continue
				}
				tries, seen := l.failedOn(h.ID, preimage)
				if tries < fillTries {
					if tries == 1 {
						l.log.Printf("ledger: proofs: hold %d: phoenixd failed (%v), asked again next minute", h.ID, err)
					}
					skipped++
					continue
				}
				preimage = seen
				kept := "kept as not known"
				if preimage != "" {
					kept = "kept with its proof, no description"
				}
				l.log.Printf("ledger: proofs: hold %d: phoenixd failed %d times, %s: %v", h.ID, fillTries, kept, err)
				desc = ""
			}
			if err := l.store.SetHoldProof(ctx, h.ID, preimage, desc); err != nil {
				return found, unknown, skipped, err
			}
			l.mu.Lock()
			delete(l.fillFails, h.ID)
			l.mu.Unlock()
			if preimage != "" {
				found++
			} else {
				unknown++
			}
		}
	}
}

// askProof asks phoenixd for a hold's preimage and, when the hold has no
// description, its invoice's. A 400 is an answer: not known, or no
// description. answered is phoenixd having answered the payment question: an
// error from the decode comes with it and the preimage read. A hash phoenixd
// answers for is kept as the one answering checks with. An offer's hold
// settled with no hash (phoenixd gave only its id) is asked by its
// id; with neither there is nothing to ask, and it is not known.
func (l *Ledger) askProof(ctx context.Context, h store.Hold) (preimage, desc string, answered bool, err error) {
	var o phoenixd.Outgoing
	switch {
	case h.PaymentHash != "":
		o, err = l.payer.OutgoingByHash(ctx, h.PaymentHash)
	case h.PaymentID != "":
		o, err = l.payer.OutgoingByID(ctx, h.PaymentID)
	default:
		o = phoenixd.Outgoing{Status: phoenixd.OutgoingNone}
	}
	if neverAnswered(err) {
		o, err = phoenixd.Outgoing{Status: phoenixd.OutgoingNone}, nil
	}
	if err != nil {
		return "", "", false, err
	}
	if h.PaymentHash != "" {
		l.mu.Lock()
		l.fillKnown = h.PaymentHash
		l.mu.Unlock()
	}
	preimage = proof(o.Preimage)
	if h.About.Description == "" && h.Invoice != "" {
		inv, err := l.payer.DecodeInvoice(ctx, h.Invoice)
		if err == nil {
			desc = ownDescription(inv)
		} else if !neverAnswered(err) {
			return preimage, "", true, err
		}
	}
	return preimage, desc, true, nil
}

// answering checks that phoenixd still answers payment questions, with one
// it answered before: the last hash a fill-in question was answered for, else
// the newest payment cardd has a proof for. It reports false, nil when there
// is none to ask with (other than failing, this hold's own), and an error
// when phoenixd fails on that one too.
func (l *Ledger) answering(ctx context.Context, failing string) (bool, error) {
	l.mu.Lock()
	known := l.fillKnown
	l.mu.Unlock()
	if known == "" || known == failing {
		var err error
		if known, err = l.store.KnownPaidHash(ctx); err != nil {
			return false, err
		}
	}
	if known == "" || known == failing {
		return false, nil
	}
	if _, err := l.payer.OutgoingByHash(ctx, known); err != nil && !neverAnswered(err) {
		return false, err
	}
	return true, nil
}

// failedOn counts one more run in which phoenixd failed on a hold's question
// while answering others, keeping any preimage it gave in one of them, and
// returns the count and that preimage. Counts are in memory: a restart asks
// afresh.
func (l *Ledger) failedOn(id int64, preimage string) (int, string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	f := l.fillFails[id]
	f.tries++
	if preimage != "" {
		f.preimage = preimage
	}
	l.fillFails[id] = f
	return f.tries, f.preimage
}

// neverAnswered is phoenixd refusing a question with HTTP 400: it won't
// answer it later either. Other refusals (a wrong password, too many
// requests) may pass.
func neverAnswered(err error) bool {
	var r *phoenixd.RefusedError
	return errors.As(err, &r) && r.Status == http.StatusBadRequest
}

// fillLater runs FillProofs on a goroutine of its own when there is
// something to fill, no run is under way and spending isn't paused (the
// books or phoenixd aren't right yet): so neither the first check nor the
// minute's tick waits on phoenixd for it (each call can take its client's
// 15 s). Called after the first check and at every tick, it goes on until
// nothing is left, phoenixd down at start included.
func (l *Ledger) fillLater(ctx context.Context) {
	l.mu.Lock()
	if l.filling || l.paused {
		l.mu.Unlock()
		return
	}
	l.filling = true
	l.mu.Unlock()
	go func() {
		defer func() {
			l.mu.Lock()
			l.filling = false
			l.mu.Unlock()
		}()
		left, err := l.store.HoldsToAsk(ctx, 0, 1)
		if err != nil {
			if ctx.Err() == nil && l.newStop(err) {
				l.log.Printf("ledger: proofs: %v", err)
			}
			return
		}
		if len(left) == 0 {
			return
		}
		found, unknown, skipped, err := l.FillProofs(ctx)
		if err != nil && ctx.Err() != nil {
			return // cardd is stopping: nothing to say
		}
		if err != nil {
			// Once while the error stays the same: phoenixd down for an hour is one line, not sixty.
			if l.newStop(err) || found+unknown > 0 {
				l.log.Printf("ledger: proofs: %d found, %d phoenixd didn't know, then stopped: %v", found, unknown, err)
			}
			return
		}
		l.mu.Lock()
		l.fillStopped = ""
		l.mu.Unlock()
		if found+unknown > 0 {
			again := ""
			if skipped > 0 {
				again = fmt.Sprintf(", %d to ask again", skipped)
			}
			l.log.Printf("ledger: proofs: %d found, %d phoenixd didn't know%s", found, unknown, again)
		}
	}()
}

// newStop reports whether err differs from the last stopped run's, and
// keeps it as the last.
func (l *Ledger) newStop(err error) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.fillStopped == err.Error() {
		return false
	}
	l.fillStopped = err.Error()
	return true
}

// Run reconciles and resolves at start, then reconciles every 5 minutes and
// resolves every minute, until ctx ends; a restore's reconcile takes a step
// each time it resolves. Old payments' proofs are filled in the background
// (fillLater) after the first check and at each tick until none is left.
func (l *Ledger) Run(ctx context.Context) {
	l.tick(ctx, true)
	l.checkedOnce.Do(func() { close(l.checked) })
	l.fillLater(ctx)
	resolve := time.NewTicker(time.Minute)
	defer resolve.Stop()
	for n := 1; ; n++ {
		select {
		case <-ctx.Done():
			return
		case <-resolve.C:
			l.tick(ctx, n%5 == 0)
			l.fillLater(ctx)
		}
	}
}

func (l *Ledger) tick(ctx context.Context, reconcile bool) {
	if err := l.Resolve(ctx); err != nil {
		l.log.Printf("ledger: resolve: %v", err)
	}
	if err := l.CheckRestore(ctx); err != nil {
		l.log.Printf("ledger: restore: %v", err)
	}
	if reconcile || l.isPaused() {
		l.Reconcile(ctx)
	}
}

func (l *Ledger) isPaused() bool {
	p, _ := l.Paused()
	return p
}
