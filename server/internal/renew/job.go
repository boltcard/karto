package renew

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/store"
)

const (
	// RenewBelow and RenewTo: the job renews when fewer than 7 days are
	// estimated left, back to 7: about a day's worth a day, the rest staying
	// in hosting, where it can be moved back.
	RenewBelow = 7 * day
	RenewTo    = 7 * day
	// MaxJobSat is the most one run of the job pays.
	MaxJobSat = 8_000
	// MaxDays is the most Renew now pays for at once.
	MaxDays = 365
	// tooLittle is in the problem the job keeps when hosting can't pay a
	// renewal (the app looks for these words too: wallet/accountView.ts).
	tooLittle = "not enough for a renewal"
)

// Run is the renewal job: once the ledger's first check has run (checked
// closes), then every hour, until ctx ends.
func (r *Renewer) Run(ctx context.Context, checked <-chan struct{}) {
	select {
	case <-ctx.Done():
		return
	case <-checked:
	}
	r.RunOnce(ctx)
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.RunOnce(ctx)
		}
	}
}

// RunOnce is one run of the job. It counts settled renewals, then renews if
// a sync has happened, vat_ok is true, spending isn't paused, LNVPS has
// applied the last renewal (as far as a sync has shown), and fewer than
// 7 days are estimated left: enough to reach 7 days, at least MinSat (LNVPS's
// smallest renewal, more than a few hours' worth), at most MaxJobSat and what
// hosting can pay with its fee budget. In that order:
// the amount (too little is a problem, recorded, and LNVPS is not asked),
// then the UTC day's ref (a renewal paid or tried today: done), and only then
// LNVPS, which rate-limits these routes. It returns once the payment has an
// outcome (or ctx ends). Then, whatever the renewal did, hosting's
// low-funding alert (alert.go), on what hosting has after the payment.
func (r *Renewer) RunOnce(ctx context.Context) {
	r.renewDue(ctx)
	r.lowFundingAlert(ctx)
}

// renewDue is RunOnce's renewal.
func (r *Renewer) renewDue(ctx context.Context) {
	if err := r.Count(ctx); err != nil {
		r.Log.Printf("renew: counting settled renewals: %v", err)
	}
	e, err := r.load(ctx)
	if err != nil {
		r.Log.Printf("renew: %v", err)
		return
	}
	now := r.Now()
	left := e.expires.Sub(now)
	if paused, _ := r.Ledger.Paused(); !e.synced || !e.vatOK || paused || e.unapplied || left >= RenewBelow {
		return
	}
	b, err := r.Store.Balance(ctx, store.Hosting)
	if err != nil {
		r.Log.Printf("renew: %v", err)
		return
	}
	needSec := int64((RenewTo - left) / time.Second)
	need := ((needSec*e.msatPerDay+86_399)/86_400 + 999) / 1000
	sat := min(max(need, MinSat), MaxJobSat, affordableSat(b.AvailableMsat()))
	if sat < MinSat {
		r.problem(fmt.Sprintf("Hosting has %d sat available: "+tooLittle+" (at least %d sat and its routing fee budget).",
			b.AvailableMsat()/1000, MinSat))
		return
	}
	ref := "renew:" + now.UTC().Format(time.DateOnly)
	if _, err := r.Store.HoldByRef(ctx, ref); !errors.Is(err, store.ErrNotFound) {
		if err != nil {
			r.Log.Printf("renew: %v", err)
		}
		return
	}
	_, done, err := r.pay(ctx, ref, sat)
	if err != nil {
		return
	}
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// RenewNow pays for days of the VM now (1 to MaxDays), once per ref (the
// request id), with the job's checks, all before LNVPS is asked: a sync has
// happened, no VAT, spending not paused, and the amount (days × the price of
// a day, rounded up) with its fee budget fits what hosting has available.
// The channel receives the outcome once.
func (r *Renewer) RenewNow(ctx context.Context, ref string, days int) (store.Hold, <-chan ledger.Outcome, error) {
	if days < 1 || days > MaxDays {
		return store.Hold{}, nil, ErrBadDays
	}
	e, err := r.load(ctx)
	switch {
	case err != nil:
		return store.Hold{}, nil, err
	case !e.synced:
		return store.Hold{}, nil, ErrNotSynced
	case !e.vatOK:
		return store.Hold{}, nil, ErrVAT
	}
	if paused, _ := r.Ledger.Paused(); paused {
		return store.Hold{}, nil, ledger.ErrPaused
	}
	sat := (int64(days)*e.msatPerDay + 999) / 1000
	b, err := r.Store.Balance(ctx, store.Hosting)
	if err != nil {
		return store.Hold{}, nil, err
	}
	if sat*1000+ledger.FeeBudgetMsat(sat*1000) > b.AvailableMsat() {
		return store.Hold{}, nil, fmt.Errorf("%w: %d days is %d sat, with up to %d sat in routing fees", store.ErrInsufficient, days, sat, ledger.FeeBudgetMsat(sat*1000)/1000)
	}
	return r.pay(ctx, ref, sat)
}

// pay renews for sat, recording any problem before the payment: another
// payment from hosting in progress (Renew now and the job), and spending
// paused (which the app shows on its own), are not renewal problems.
func (r *Renewer) pay(ctx context.Context, ref string, sat int64) (store.Hold, <-chan ledger.Outcome, error) {
	h, done, err := r.tryPay(ctx, ref, sat)
	if err != nil && ctx.Err() == nil && !errors.Is(err, store.ErrPaymentInProgress) && !errors.Is(err, store.ErrDuplicatePayment) &&
		!errors.Is(err, ledger.ErrPaused) {
		r.problem(fmt.Sprintf("Couldn't renew: %v", err))
	}
	return h, done, err
}

// tryPay asks LNVPS, through the VM's Lightning address on LNVPS's host
// alone, for an invoice of sat, checks that every part of the answer is for
// this VM (the pay request's text exactly "Extend VM <id>", the invoice's
// amount, its description "VM renewal <id> to …"), and pays it from hosting.
func (r *Renewer) tryPay(ctx context.Context, ref string, sat int64) (store.Hold, <-chan ledger.Outcome, error) {
	vmID, err := r.Store.GetMeta(ctx, keyVMID)
	if err != nil || vmID == "" {
		return store.Hold{}, nil, fmt.Errorf("%w: the VM's id isn't known (meta vm.id)", ErrNotLNVPS)
	}
	base, err := url.Parse(r.LNVPS)
	if err != nil {
		return store.Hold{}, nil, err
	}
	res, err := r.Resolver.Pinned(base.Host).Resolve(ctx, r.LNVPS+"/.well-known/lnurlp/"+vmID, sat*1000)
	if err != nil {
		return store.Hold{}, nil, err
	}
	if !describes(res.Metadata, "Extend VM "+vmID) {
		return store.Hold{}, nil, fmt.Errorf("%w: its pay request is not for VM %s", ErrNotLNVPS, vmID)
	}
	inv, err := r.Ledger.DecodeFor(ctx, res.PR, sat*1000)
	if err != nil {
		return store.Hold{}, nil, err
	}
	if !strings.HasPrefix(inv.Description, "VM renewal "+vmID+" to ") {
		return store.Hold{}, nil, fmt.Errorf("%w: its invoice is not for VM %s", ErrNotLNVPS, vmID)
	}
	inner := make(chan ledger.Outcome, 1)
	h, err := r.Ledger.PayOnce(ctx, ref, store.Hosting, store.KindRenew, res.PR, inv, store.HoldAbout{}, inner)
	if err != nil {
		return store.Hold{}, nil, err
	}
	r.Log.Printf("renew: hold %d: paying LNVPS %d sat for VM %s", h.ID, sat, vmID)
	out := make(chan ledger.Outcome, 1)
	go func() {
		o := <-inner
		r.finish(o)
		out <- o
	}()
	return h, out, nil
}

// describes reports whether LNURL-pay metadata's text/plain is exactly text.
func describes(metadata, text string) bool {
	var entries [][]any
	if json.Unmarshal([]byte(metadata), &entries) != nil {
		return false
	}
	for _, e := range entries {
		if len(e) == 2 && e[0] == "text/plain" {
			return e[1] == text
		}
	}
	return false
}

// finish records a renewal's outcome: settled, it is counted (which clears
// the problem); failed, it is the problem. One left pending is resolved by
// the ledger and counted by the next run.
func (r *Renewer) finish(o ledger.Outcome) {
	switch {
	case o.Pending:
		r.Log.Printf("renew: hold %d: no answer from phoenixd yet", o.Hold.ID)
	case o.Hold.State == store.HoldSettled:
		if err := r.Count(context.Background()); err != nil {
			r.Log.Printf("renew: counting hold %d: %v", o.Hold.ID, err)
		}
	default:
		r.problem(fmt.Sprintf("The renewal payment of %d sat failed.", o.Hold.AmountMsat/1000))
	}
}

// problem logs a renewal problem and keeps it, with its time, for the app.
func (r *Renewer) problem(text string) {
	r.Log.Printf("renew: %s", text)
	err := r.Store.SetMetas(context.Background(), map[string]string{keyProblem: text, keyProblemAt: strconv.FormatInt(r.Now().Unix(), 10)})
	if err != nil {
		r.Log.Printf("renew: keeping the problem: %v", err)
	}
}
