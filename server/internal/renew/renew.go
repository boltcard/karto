// Package renew keeps the VM paid. cardd can't ask LNVPS
// for the VM's expiry (it doesn't hold the Nostr key), so it keeps an
// estimate: the app syncs it from LNVPS, and each renewal moves it to the
// date LNVPS wrote into its invoice. From that estimate cardd renews the VM
// itself, from hosting, through the VM's LNVPS Lightning address.
package renew

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/lnaddr"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/store"
)

var (
	ErrBadSync   = errors.New("renew: the sync's values are out of range")
	ErrNotSynced = errors.New("renew: the app hasn't synced the VM's expiry from LNVPS yet")
	ErrVAT       = errors.New("renew: LNVPS's VAT doesn't match this account's country")
	ErrBadDays   = errors.New("renew: days must be a whole number from 1 to 365")
	ErrNotLNVPS  = errors.New("renew: LNVPS's answer isn't for this VM")
)

// The meta keys of the estimate (in every backup, with the rest of meta).
const (
	keyExpires    = "hosting.expires_est"  // unix seconds
	keyMsatPerDay = "hosting.msat_per_day" // an integer
	keyVatOK      = "hosting.vat_ok"       // "true" or "false"
	keySyncedAt   = "hosting.synced_at"    // unix seconds
	keyProblem    = "hosting.problem"      // the last renewal problem, "" when the last renewal went through
	keyProblemAt  = "hosting.problem_at"   // unix seconds
	keyCounted    = "hosting.counted_hold" // the id of the last renewal hold counted in the estimate
	// keyAwaiting: the expiry (unix seconds) LNVPS's invoice promised for the
	// last renewal counted by its date, and keyAwaitingAt when it was counted;
	// 0 once a sync shows LNVPS has it. keyUnapplied: "true" while a sync
	// shows LNVPS hasn't applied it, which stops the job.
	keyAwaiting   = "hosting.awaiting_expires"
	keyAwaitingAt = "hosting.awaiting_at"
	keyUnapplied  = "hosting.unapplied"
	keyVMID       = "vm.id"
)

const (
	day = 24 * time.Hour
	// MinSat is LNVPS's smallest renewal through the Lightning address.
	MinSat = 100
)

// Decoder reads an invoice; a settled renewal's has expired by the time it is
// counted, so this is phoenixd itself, not the ledger's checked Decode.
type Decoder interface {
	DecodeInvoice(ctx context.Context, bolt11 string) (phoenixd.Invoice, error)
}

// Renewer keeps the estimate and renews the VM.
type Renewer struct {
	Store    *store.Store
	Ledger   *ledger.Ledger
	Resolver *lnaddr.Resolver // pinned to LNVPS's host for every renewal
	Decoder  Decoder
	LNVPS    string // "https://api.lnvps.net"; tests use a fake's http URL
	Now      func() time.Time
	Log      *log.Logger
	Alerts   Alerter // hosting's low-funding alert; nil sends none

	mu sync.Mutex // one Count at a time
}

// Sync is what the app read from LNVPS: the VM's expiry (unix seconds), the
// price of a day from the renewal quote (VAT included), and whether LNVPS's
// VAT is the declared country's or none (the app's vatGuard);
// and the phone's offset from UTC in minutes, for hosting's alert (nil from an
// older app: the last one stays).
type Sync struct {
	Expires      int64
	SatPerDay    float64
	VatOK        bool
	UTCOffsetMin *int
}

// Status is the estimate as GET /api/v1/hosting returns it.
type Status struct {
	Synced      bool    `json:"synced"`
	Expires     int64   `json:"expires"`  // unix seconds; 0 before the first sync
	SyncedAt    int64   `json:"syncedAt"` // unix seconds
	DaysLeft    float64 `json:"daysLeft"`
	MsatPerDay  int64   `json:"msatPerDay"`
	FundingDays float64 `json:"fundingDays"` // the days hosting's available balance pays for
	VatOK       bool    `json:"vatOk"`
	// WillRenew: cardd will renew the VM when it is due: synced, VAT ok,
	// spending not paused, no renewal problem, and hosting can pay at least
	// MinSat with its fee budget. A problem of hosting having too little is
	// over (and not reported) once hosting can pay.
	WillRenew bool   `json:"willRenew"`
	Problem   string `json:"problem"`
	ProblemAt int64  `json:"problemAt"`
}

// estimate is what meta holds.
type estimate struct {
	synced     bool
	expires    time.Time
	msatPerDay int64
	vatOK      bool
	syncedAt   time.Time
	problem    string
	problemAt  int64
	counted    int64
	awaiting   int64 // see keyAwaiting
	awaitingAt int64
	unapplied  bool
	vmID       string
	offsetMin  int    // the phone's offset from UTC (0 before a sync gave one)
	alertDay   string // the local day hosting's last alert was queued
}

func (r *Renewer) load(ctx context.Context) (estimate, error) {
	m, err := r.Store.ListMeta(ctx)
	if err != nil {
		return estimate{}, err
	}
	num := func(k string) int64 {
		n, _ := strconv.ParseInt(m[k], 10, 64)
		return n
	}
	e := estimate{expires: time.Unix(num(keyExpires), 0), msatPerDay: num(keyMsatPerDay), vatOK: m[keyVatOK] == "true",
		syncedAt: time.Unix(num(keySyncedAt), 0), problem: m[keyProblem], problemAt: num(keyProblemAt),
		counted: num(keyCounted), vmID: m[keyVMID], awaiting: num(keyAwaiting), awaitingAt: num(keyAwaitingAt), unapplied: m[keyUnapplied] == "true",
		offsetMin: int(num(keyOffset)), alertDay: m[keyAlertDay]}
	e.synced = m[keyExpires] != "" && e.msatPerDay > 0
	return e, nil
}

// unappliedAfter is how long LNVPS has to apply a renewal before a sync that
// still doesn't show it counts as LNVPS not having applied it.
const unappliedAfter = 10 * time.Minute

// Sync overwrites the estimate with what LNVPS says, after checking it: a
// buggy sync must not make cardd think the VM is paid for months. Renewals
// settled before it count as counted: LNVPS's expiry has them, or, if LNVPS
// hadn't applied one yet, the estimate is behind (the safe side) until the
// next sync or renewal. With RenewBelow or more left, nothing is due, so an
// old renewal problem is cleared.
func (r *Renewer) Sync(ctx context.Context, s Sync) error {
	now := r.Now()
	switch {
	case math.IsNaN(s.SatPerDay) || math.IsInf(s.SatPerDay, 0) || s.SatPerDay < 20 || s.SatPerDay > 20_000:
		return fmt.Errorf("%w: %v sat a day (20 to 20,000)", ErrBadSync, s.SatPerDay)
	case s.Expires < now.Add(-365*day).Unix() || s.Expires > now.Add(730*day).Unix():
		return fmt.Errorf("%w: expires %s (a year ago to two years ahead)", ErrBadSync, time.Unix(s.Expires, 0).UTC().Format(time.RFC3339))
	case s.UTCOffsetMin != nil && !offsetOK(*s.UTCOffsetMin):
		return fmt.Errorf("%w: %d minutes from UTC (-720 to 840)", ErrBadSync, *s.UTCOffsetMin)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	kv := map[string]string{keyExpires: strconv.FormatInt(s.Expires, 10), keyMsatPerDay: strconv.FormatInt(int64(math.Round(s.SatPerDay*1000)), 10),
		keyVatOK: strconv.FormatBool(s.VatOK), keySyncedAt: strconv.FormatInt(now.Unix(), 10)}
	if s.UTCOffsetMin != nil {
		kv[keyOffset] = formatOffset(*s.UTCOffsetMin)
	}
	if s.Expires >= now.Add(RenewBelow).Unix() {
		kv[keyProblem], kv[keyProblemAt] = "", "0"
	}
	e, err := r.load(ctx)
	if err != nil {
		return err
	}
	switch {
	case e.awaiting == 0:
	case s.Expires >= e.awaiting:
		// LNVPS has the last renewal: nothing to watch for.
		kv[keyAwaiting], kv[keyUnapplied] = "0", "false"
		if e.unapplied {
			kv[keyProblem], kv[keyProblemAt] = "", "0"
		}
	case now.Unix()-e.awaitingAt >= int64(unappliedAfter/time.Second):
		// Paid, counted, and still not at LNVPS: without this, the estimate set
		// back by this sync would make the job pay again every day.
		kv[keyUnapplied] = "true"
		kv[keyProblem] = fmt.Sprintf("LNVPS hasn't applied the last renewal: it should run to %s, but LNVPS says %s. Automatic renewal is stopped until it does: ask LNVPS, or pay with Pay LNVPS from any wallet.",
			time.Unix(e.awaiting, 0).UTC().Format(time.DateTime), time.Unix(s.Expires, 0).UTC().Format(time.DateTime))
		kv[keyProblemAt] = strconv.FormatInt(now.Unix(), 10)
		r.Log.Printf("renew: %s", kv[keyProblem])
	}
	settled, err := r.Store.SettledHolds(ctx, store.Hosting, store.KindRenew, 0)
	if err != nil {
		return err
	}
	if len(settled) > 0 {
		kv[keyCounted] = strconv.FormatInt(settled[len(settled)-1].ID, 10)
	}
	return r.Store.SetMetas(ctx, kv)
}

// Status is the estimate with what follows from it now.
func (r *Renewer) Status(ctx context.Context) (Status, error) {
	e, err := r.load(ctx)
	if err != nil {
		return Status{}, err
	}
	s := Status{Problem: e.problem, ProblemAt: e.problemAt}
	if !e.synced {
		return s, nil
	}
	b, err := r.Store.Balance(ctx, store.Hosting)
	if err != nil {
		return Status{}, err
	}
	paused, _ := r.Ledger.Paused()
	affordable := affordableSat(b.AvailableMsat()) >= MinSat
	if affordable && strings.Contains(e.problem, tooLittle) {
		// Topped up since: the job renews at its next run, which clears it.
		s.Problem, s.ProblemAt = "", 0
	}
	s.Synced, s.Expires, s.SyncedAt, s.MsatPerDay, s.VatOK = true, e.expires.Unix(), e.syncedAt.Unix(), e.msatPerDay, e.vatOK
	s.DaysLeft = e.expires.Sub(r.Now()).Hours() / 24
	s.FundingDays = float64(b.AvailableMsat()) / float64(e.msatPerDay)
	s.WillRenew = e.vatOK && !paused && s.Problem == "" && affordable
	return s, nil
}

// affordableSat is the most whole sats hosting can pay with its fee budget
// (ledger.FeeBudgetMsat) out of availableMsat.
func affordableSat(availableMsat int64) int64 {
	sat := (availableMsat - 5_000) / 1005 // 1000 msat + its 0.5% budget, plus 5 sat
	for sat > 0 && sat*1000+ledger.FeeBudgetMsat(sat*1000) > availableMsat {
		sat--
	}
	return max(sat, 0)
}

// memoDate reads LNVPS's renewal invoice description, "VM renewal 1009 to
// 2026-11-09 14:22:33.123456 UTC" (chrono's format), for this VM.
var memoDate = regexp.MustCompile(`^VM renewal ([0-9]+) to ([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2})(\.[0-9]+)? UTC$`)

func memoExpiry(description, vmID string) (time.Time, bool) {
	m := memoDate.FindStringSubmatch(description)
	if m == nil || m[1] != vmID {
		return time.Time{}, false
	}
	t, err := time.Parse(time.DateTime, m[2])
	return t, err == nil
}

// Count moves the estimate for each settled renewal not yet counted, oldest
// first, once each (also after a restart): to the later of the estimate and
// the date in LNVPS's invoice, or, without one, on by the amount paid ÷ the
// price of a day × 0.95.
func (r *Renewer) Count(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, err := r.load(ctx)
	if err != nil {
		return err
	}
	holds, err := r.Store.SettledHolds(ctx, store.Hosting, store.KindRenew, e.counted)
	if err != nil {
		return err
	}
	for _, h := range holds {
		inv, err := r.Decoder.DecodeInvoice(ctx, h.Invoice)
		if errors.Is(err, phoenixd.ErrUnreachable) {
			return err // counted at the next run
		} else if err != nil {
			// phoenixd can't read it any more: the fallback, rather than never counting it.
			r.Log.Printf("renew: hold %d: its invoice can't be read (%v); counting it by its amount", h.ID, err)
		}
		exp := e.expires
		kv := map[string]string{keyCounted: strconv.FormatInt(h.ID, 10)}
		if until, ok := memoExpiry(inv.Description, e.vmID); ok {
			if until.After(exp) {
				exp = until
			}
			kv[keyAwaiting], kv[keyAwaitingAt] = strconv.FormatInt(until.Unix(), 10), strconv.FormatInt(r.Now().Unix(), 10)
		} else if e.msatPerDay > 0 {
			exp = exp.Add(time.Duration(h.AmountMsat*86_400*95/(e.msatPerDay*100)) * time.Second)
		}
		kv[keyExpires] = strconv.FormatInt(exp.Unix(), 10)
		if err := r.Store.SetMetas(ctx, kv); err != nil {
			return err
		}
		r.Log.Printf("renew: hold %d counted: the VM is paid until about %s", h.ID, exp.UTC().Format(time.DateTime))
		e.expires = exp
	}
	if len(holds) > 0 && e.problem != "" && !e.unapplied {
		// A renewal went through: the last problem is behind it (unless it is
		// LNVPS not applying one, which only a sync can clear).
		return r.Store.SetMetas(ctx, map[string]string{keyProblem: "", keyProblemAt: "0"})
	}
	return nil
}
