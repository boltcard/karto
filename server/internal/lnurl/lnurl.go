// Package lnurl is cardd's public Lightning side: top-up
// addresses (LNURL-pay, credited through phoenixd's webhook and a sweep) and
// spending at a terminal (LNURL-withdraw). Nothing here needs device auth;
// the card's SUN, the one-use k1 and phoenixd's HMAC are the checks.
package lnurl

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/boltcard/karto/server/internal/cards"
	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/lnaddr"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/ratelimit"
	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/sun"
)

// Invoices is the part of phoenixd top-ups use.
type Invoices interface {
	CreateInvoice(ctx context.Context, amountSat int64, descriptionHash, externalID string, expiry time.Duration) (string, string, error)
	IncomingPayment(ctx context.Context, paymentHash string) (phoenixd.Incoming, bool, error)
	ListIncoming(ctx context.Context, fromMs int64, limit, offset int) ([]phoenixd.Incoming, error)
	// Room and FeeCreditSat tell what a payment brought in.
	Room(ctx context.Context) (phoenixd.Room, error)
	FeeCreditSat(ctx context.Context) (int64, error)
}

const (
	// maxWithdrawableMsat is what every tap offers: 1 BTC, above any real
	// limit, as the Bolt Card spec asks ("higher than the actual maximum
	// amount"). A reader learns nothing about the card's balance or limits,
	// and a skimmed tap doesn't say how much to ask for; the limits and the
	// balance are checked when the invoice arrives.
	maxWithdrawableMsat = 100_000_000_000
	k1Lifetime          = 5 * time.Minute
	invoiceExpiry       = 10 * time.Minute
	// invoiceTimeout bounds a callback's wait for phoenixd's invoice, which
	// goes on if the client hangs up (makeInvoice).
	invoiceTimeout = 30 * time.Second
	maxTopupMsat   = 2_000_000_000 // 2,000,000 sat
	cardNamePrefix = 10            // hex characters of the card id in its address

	// A payer's note (LUD-12's comment): commentAllowed, in
	// characters (code points here); a longer one is cut, not refused. Only a
	// raw comment over maxCommentBytes (LUD-12's figure for a whole URL) is
	// refused. Unpaid notes are pruned after a good sweep: older than the
	// window, then all but the newest topupNoteKeep.
	maxPayerNote    = 140
	maxCommentBytes = 2048
	topupNoteWindow = time.Hour
	topupNoteKeep   = 5000
)

// RefusalReason is why a card's tap was refused, as an alert says it.
type RefusalReason string

const (
	RefusedPaused   RefusalReason = "paused"   // spending is paused on the server
	RefusedOff      RefusalReason = "off"      // the card is frozen, reset, not active or needs its owner's check after a restore
	RefusedRepeated RefusalReason = "repeated" // a counter already used, other than a terminal's retry
	RefusedPerTap   RefusalReason = "per-tap"  // over the card's limit per payment
	RefusedDaily    RefusalReason = "daily"    // over the card's 24-hour limit
	RefusedFunds    RefusalReason = "funds"    // not enough money on the card
	RefusedInvoice  RefusalReason = "invoice"  // the terminal's invoice can't be paid
)

// Refusal is one refused tap of a known card. AmountMsat is the invoice's,
// 0 when the refusal came before one was read.
type Refusal struct {
	CardID     string
	Reason     RefusalReason
	AmountMsat int64
	At         time.Time
}

// retryWindow is how long after its counter was used a card's repeat of that
// counter is taken for a terminal's retry, not alerted.
const retryWindow = 2 * time.Minute

func (s *Server) refuse(cardID string, reason RefusalReason, amountMsat int64) {
	if s.Refused != nil {
		s.Refused(Refusal{CardID: cardID, Reason: reason, AmountMsat: amountMsat, At: s.Now()})
	}
}

// refusedTap tells of a tap Spend refused, if its reason is one of the rules.
func (s *Server) refusedTap(ctx context.Context, tap cards.Tap, err error) {
	switch {
	case errors.Is(err, cards.ErrFrozen), errors.Is(err, cards.ErrCardReset), errors.Is(err, cards.ErrNotActive), errors.Is(err, cards.ErrNeedsCheck):
		s.refuse(tap.Card.ID, RefusedOff, 0)
	case errors.Is(err, store.ErrReplayed):
		// Tap.Card was read before the counter moved, so of two taps with one
		// counter the loser's copy is stale: read the card again.
		card, gerr := s.Store.GetCard(ctx, tap.Card.ID)
		if gerr != nil {
			return
		}
		if int64(tap.Counter) == card.LastCounter && s.Now().Sub(card.UpdatedAt) < retryWindow {
			return // a terminal's retry of the tap just used
		}
		s.refuse(card.ID, RefusedRepeated, 0)
	}
}

type Server struct {
	Cards    *cards.Service
	Store    *store.Store
	Ledger   *ledger.Ledger
	Invoices Invoices
	Host     string
	Log      *log.Logger
	Now      func() time.Time
	// Wait and Poll are how long a credit waits for phoenixd's fee credit to
	// rise and how often it looks (5 s and 250 ms when zero; tests shorten them).
	Wait, Poll time.Duration
	// Paid is told a payment's hash when phoenixd's webhook reports it,
	// before the credit, and when a sale's credit is recorded, whoever
	// brought it: a held read of a sale answers on it (nil: no one is told).
	Paid func(paymentHash string)
	// Refused is told of a tap of a known card refused by its rules, for the
	// owner's alert. Never
	// for an unknown card, a bad MAC or k1, or an error that is not a rule
	// (nil: no one is told). The terminal's answers do not depend on it.
	Refused func(Refusal)
	// QuickLook is how often RunSweep asks phoenixd for the last minutes'
	// payments, to find one whose webhook never came: 2 seconds in cardd (0:
	// never, and such a payment waits for the 5-minute sweep).
	QuickLook time.Duration
	// Limit holds back the invoices the public callbacks make (top-ups and
	// refund links, one limit for both): each is a row in phoenixd's
	// database, asked for by anyone (nil: no limit). See InvoiceLimit.
	Limit *ratelimit.Limiter
	// Unpaid caps the invoices those callbacks make that nobody pays, one
	// cap for both (nil: no cap). See InvoiceUnpaidCap.
	Unpaid *UnpaidCap
	// Capped is told, for the owner's alert, when the unpaid cap turns a
	// payer away: own false for the strangers' places or the known clients'
	// full as a whole (each on its own schedule: at once, then after an hour,
	// six hours, and once a day while it goes on), own true for a known
	// client over its own share (a wallet's servers many payers share; at
	// most once a day). A stranger over its own share isn't told of: it may
	// be the flood itself. It answers whether the alert was queued; one that
	// wasn't is tried again at the next refusal (nil: no one is told).
	Capped func(own bool) bool

	crediting sync.Mutex // one credit at a time: see credit

	limitLog    sync.Mutex
	limitSaid   time.Time // when the log last said invoices were refused
	limitSince  int       // invoices refused since then
	cappedSaid  time.Time // the same for the unpaid cap
	cappedSince int
	whole       cappedGate // the strangers' places full
	knownWhole  cappedGate // the known clients' places full
	ownTold     time.Time  // when Capped was last told of a known client's share
}

// cappedGaps are the waits between the whole cap's alerts while a flood goes
// on: an hour, six, then a day.
var cappedGaps = [...]time.Duration{time.Hour, 6 * time.Hour, 24 * time.Hour}

// cappedGate is when a lane full as a whole was last told of and refused,
// and the gap (cappedGaps) before it is told again.
type cappedGate struct {
	told, last time.Time
	step       int
}

// next records a refusal at now and says whether to tell of it (only when
// telling is possible), with how to undo that if the alert isn't queued: at
// once, then after cappedGaps while refusals go on; a refusal more than an
// hour after the last starts afresh. Called under limitLog.
func (g *cappedGate) next(now time.Time, can bool) (bool, func()) {
	fresh := g.last.IsZero() || now.Sub(g.last) > time.Hour
	if fresh {
		g.step = 0
	}
	g.last = now
	if !can || !(fresh || g.told.IsZero() || now.Sub(g.told) >= cappedGaps[g.step]) {
		return false, nil
	}
	told, step := g.told, g.step
	if !fresh && !g.told.IsZero() {
		g.step = min(g.step+1, len(cappedGaps)-1)
	}
	g.told = now
	return true, func() { g.told, g.step = told, step }
}

// InvoiceLimit is cardd's limit on the invoices the public callbacks make,
// per client and overall. The overall bucket is what bounds phoenixd: 60 at
// once covers payers at several addresses together (a shop's refunds, a
// crowd topping up cards), and one a second after that is still far beyond a
// personal server's real traffic, while a flood makes phoenixd at most
// 86,400 invoices a day instead of as many as it can. Per client, 20 at once
// and then one every 10 s: a wallet asks once per payment, and again on a
// retry or a changed amount, and a group behind one address (a custodial
// wallet's servers, a venue's Wi-Fi, carrier NAT) shares a bucket.
// At most 4,096 clients are kept (well under a megabyte): more at once
// than that is a flood the overall limit already holds.
func InvoiceLimit(now func() time.Time) *ratelimit.Limiter {
	return ratelimit.New(ratelimit.Rate{Burst: 20, Every: 10 * time.Second}, ratelimit.Rate{Burst: 60, Every: time.Second}, 4096, now)
}

// Routes adds the public endpoints to mux.
func (s *Server) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /ln", s.withdrawRequest)
	mux.HandleFunc("GET /ln/cb", s.withdrawCallback)
	mux.HandleFunc("GET /.well-known/lnurlp/{name}", s.payRequest)
	mux.HandleFunc("GET /lnurlp/{name}/cb", s.payCallback)
	mux.HandleFunc("GET /refund/{token}", s.backRequest)
	mux.HandleFunc("GET /refund/{token}/cb", s.backCallback)
}

func writeJSON(w http.ResponseWriter, v any) {
	writeJSONStatus(w, http.StatusOK, v)
}

func writeJSONStatus(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*") // LUD-01: web wallets call these
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// fail answers LNURL's error shape. Terminals and wallets show the reason.
func fail(w http.ResponseWriter, reason string) {
	writeJSON(w, map[string]string{"status": "ERROR", "reason": reason})
}

// mayInvoice takes one of the invoices the public callbacks may make, for
// the client asking; false after the refusal is answered: LNURL's error,
// with HTTP 429 and when to try again.
func (s *Server) mayInvoice(w http.ResponseWriter, r *http.Request) bool {
	if s.Limit == nil {
		return true
	}
	ok, retry := s.Limit.Take(ratelimit.ClientKey(r))
	if ok {
		return true
	}
	s.sayLimited()
	w.Header().Set("Retry-After", strconv.FormatInt(int64((retry+time.Second-1)/time.Second), 10))
	writeJSONStatus(w, http.StatusTooManyRequests, map[string]string{"status": "ERROR",
		"reason": "This server is asked for too many invoices just now. Try again shortly."})
	return false
}

// makeInvoice has phoenixd make an invoice for a public callback, under the
// unpaid cap (a place for the client asking, given back if no invoice comes
// of it); ok false after a refusal is answered: LNURL's error, with HTTP 429
// and when a place should be free. The invoice is made on a context the
// client can't cancel: a client that hangs up once phoenixd has been asked
// must not get its place back for an invoice phoenixd may have made. Its
// error is then the caller's to answer.
func (s *Server) makeInvoice(w http.ResponseWriter, r *http.Request, amountSat int64, descriptionHash, externalID string) (bolt11, hash string, ok bool, err error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), invoiceTimeout)
	defer cancel()
	if s.Unpaid == nil {
		bolt11, hash, err = s.Invoices.CreateInvoice(ctx, amountSat, descriptionHash, externalID, invoiceExpiry)
		return bolt11, hash, true, err
	}
	client := ratelimit.ClientKey(r)
	lane, free, refusal := s.Unpaid.Reserve(client)
	if !free {
		s.sayCapped(refusal)
		w.Header().Set("Retry-After", strconv.FormatInt(int64((refusal.Retry+time.Second-1)/time.Second), 10))
		writeJSONStatus(w, http.StatusTooManyRequests, map[string]string{"status": "ERROR",
			"reason": "This server has too many unpaid invoices just now. Try again later."})
		return "", "", false, nil
	}
	// The place is given back unless an invoice is recorded in it, whatever happens (a panic too).
	defer func() {
		if hash == "" {
			s.Unpaid.Release(client, lane)
		}
	}()
	bolt11, hash, err = s.Invoices.CreateInvoice(ctx, amountSat, descriptionHash, externalID, invoiceExpiry)
	if hash != "" {
		s.Unpaid.Made(client, lane, hash)
	}
	return bolt11, hash, true, err
}

// sayCapped logs that the unpaid cap refused an invoice, as sayLimited does,
// and tells Capped as its doc says. The gates are decided and closed under
// the lock, so a flood's refusals at once tell it once, and opened again if
// the alert wasn't queued.
func (s *Server) sayCapped(r CapRefusal) {
	s.limitLog.Lock()
	s.cappedSince++
	now := s.Now()
	if now.Sub(s.cappedSaid) >= time.Minute {
		s.Log.Printf("lnurl: invoices refused by the unpaid cap: %d since the last such line", s.cappedSince)
		s.cappedSaid, s.cappedSince = now, 0
	}
	var tell, own bool
	var undo func()
	switch {
	case r.Overall && r.Known:
		tell, undo = s.knownWhole.next(now, s.Capped != nil)
	case r.Overall:
		tell, undo = s.whole.next(now, s.Capped != nil)
	case r.Known:
		if s.Capped != nil && (s.ownTold.IsZero() || now.Sub(s.ownTold) >= 24*time.Hour) {
			told := s.ownTold
			undo = func() { s.ownTold = told }
			s.ownTold, tell, own = now, true, true
		}
	}
	s.limitLog.Unlock()
	if tell && !s.Capped(own) {
		s.limitLog.Lock()
		undo()
		s.limitLog.Unlock()
	}
}

// sayLimited logs that the limit refused an invoice: the first at once, then
// at most a line a minute with how many since, so a flood doesn't fill the
// log. The client's address is never logged.
func (s *Server) sayLimited() {
	s.limitLog.Lock()
	defer s.limitLog.Unlock()
	s.limitSince++
	if now := s.Now(); now.Sub(s.limitSaid) >= time.Minute {
		s.Log.Printf("lnurl: invoices refused by the limit: %d since the last such line", s.limitSince)
		s.limitSaid, s.limitSince = now, 0
	}
}

// Address is an account's Lightning address: pool@, hosting@, or c<10 hex>@
// for a card. Shop has none: only sales fill it.
func Address(host string, acct store.Account) string {
	if id, isCard := acct.CardID(); isCard {
		return "c" + id[:cardNamePrefix] + "@" + host
	}
	if acct == store.Shop {
		return ""
	}
	return string(acct) + "@" + host
}

var cardName = regexp.MustCompile(`^c[0-9a-f]{10}$`)

// account resolves an address's name to its account, and what to call it in
// the payment's description.
func (s *Server) account(ctx context.Context, name string) (store.Account, string, error) {
	switch name {
	case "pool":
		return store.Pool, "pool", nil
	case "hosting":
		return store.Hosting, "hosting", nil
	}
	if !cardName.MatchString(name) {
		return "", "", store.ErrNotFound
	}
	c, err := s.Store.CardByPrefix(ctx, name[1:])
	if err != nil {
		return "", "", err
	}
	if c.State != store.StateActive && c.State != store.StateFrozen {
		return "", "", store.ErrCannotReceive
	}
	label := c.Name
	if label == "" {
		label = "card " + name
	}
	return store.CardAccount(c.ID), label, nil
}

func (s *Server) metadata(name, label string) string {
	m, _ := json.Marshal([][2]string{{"text/plain", "Top up " + label}, {"text/identifier", name + "@" + s.Host}})
	return string(m)
}

// payRequest is LNURL-pay's first answer (LUD-06). It offers a payer's note
// of up to maxPayerNote characters (LUD-12,
// https://github.com/lnurl/luds/blob/luds/12.md), which the callback keeps
// with the invoice and the credit puts on the line.
func (s *Server) payRequest(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	_, label, err := s.account(r.Context(), name)
	if err != nil {
		fail(w, "No such address here, or it can't take top-ups now.")
		return
	}
	writeJSON(w, map[string]any{
		"tag": "payRequest", "callback": "https://" + s.Host + "/lnurlp/" + name + "/cb",
		"minSendable": 1000, "maxSendable": maxTopupMsat, "metadata": s.metadata(name, label), "commentAllowed": maxPayerNote,
	})
}

func (s *Server) payCallback(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	acct, label, err := s.account(r.Context(), name)
	if err != nil {
		fail(w, "No such address here, or it can't take top-ups now.")
		return
	}
	msat, ok := topupAmount(w, r)
	if !ok {
		return
	}
	note, ok := payerNote(w, r)
	if !ok {
		return
	}
	if !s.mayInvoice(w, r) {
		return
	}
	// The invoice's description hash stays sha256(metadata): the note isn't
	// part of the invoice, so cardd keeps it by the payment hash.
	sum := sha256.Sum256([]byte(s.metadata(name, label)))
	bolt11, hash, ok, err := s.makeInvoice(w, r, msat/1000, hex.EncodeToString(sum[:]), string(acct))
	if !ok {
		return
	}
	if err != nil {
		s.Log.Printf("lnurl: invoice for %s: %v", name, err)
		fail(w, "The server can't make an invoice right now.")
		return
	}
	if !s.keepNote(w, r, hash, note, name) {
		return
	}
	writeJSON(w, map[string]any{"pr": bolt11, "routes": []any{}})
}

// payerNote reads a pay callback's payer's note (LUD-12): a stranger's words,
// cleaned (control and format characters to spaces, invalid UTF-8 replaced)
// and cut to maxPayerNote; only a comment no wallet would send is refused,
// before any work; false after the refusal is answered.
func payerNote(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw := r.URL.Query().Get("comment")
	if len(raw) > maxCommentBytes {
		fail(w, "The note is too long.")
		return "", false
	}
	return lnaddr.Clean(raw, maxPayerNote), true
}

// keepNote keeps a payer's note by its invoice's payment hash, for the credit
// to put on the line. An invoice whose note couldn't be kept is never handed
// out: false after the refusal is answered. what names the callback in the log.
func (s *Server) keepNote(w http.ResponseWriter, r *http.Request, hash, note, what string) bool {
	if note == "" {
		return true
	}
	if err := s.Store.SaveTopupNote(r.Context(), hash, note); err != nil {
		s.Log.Printf("lnurl: payer's note for %s: %v", what, err)
		fail(w, "The server can't make an invoice right now.")
		return false
	}
	return true
}

// topupAmount reads a pay callback's amount: whole sats, 1 to the most a
// top-up may be; false after the refusal is answered.
func topupAmount(w http.ResponseWriter, r *http.Request) (int64, bool) {
	msat, err := strconv.ParseInt(r.URL.Query().Get("amount"), 10, 64)
	switch {
	case err != nil || msat < 1000 || msat > maxTopupMsat:
		fail(w, "The amount must be between 1 and 2,000,000 sat.")
		return 0, false
	case msat%1000 != 0:
		fail(w, "The amount must be a whole number of sats.")
		return 0, false
	}
	return msat, true
}

// parseAccount reads the account an invoice's externalId names.
func parseAccount(externalID string) (store.Account, bool) {
	switch acct := store.Account(externalID); {
	case acct == store.Pool || acct == store.Hosting:
		return acct, true
	default:
		id, isCard := acct.CardID()
		return acct, isCard && len(id) == 32
	}
}

// Credit records a received payment once, asking phoenixd for what it
// actually received (never trusting a webhook's body for the amount).
func (s *Server) Credit(ctx context.Context, paymentHash string) error {
	if yes, err := s.Store.Credited(ctx, paymentHash); err != nil || yes {
		return err // a webhook sent twice: phoenixd isn't asked again
	}
	p, found, err := s.Invoices.IncomingPayment(ctx, paymentHash)
	if err != nil || !found || !p.IsPaid {
		return err
	}
	return s.credit(ctx, p)
}

// saleOf reads the sale an invoice's externalId names: "sale:<id>".
func saleOf(externalID string) (id string, ok bool) {
	id, ok = strings.CutPrefix(externalID, "sale:")
	return id, ok && id != ""
}

// refundOf reads a refund link's invoice's externalId, "refund:<account>":
// the account it tops up and via "refund". Any other externalId is
// answered as it is, with no via.
func refundOf(externalID string) (account, via string) {
	if a, ok := strings.CutPrefix(externalID, "refund:"); ok {
		return a, "refund"
	}
	return externalID, ""
}

// credit records one received payment: a top-up of an account, or a sale's
// payment into shop. One runs at a time, from its first question to
// phoenixd to its commit (the webhook's requests, the sweep and Set the
// books' sweep all come here), because what a payment brought in is worked
// out from phoenixd's fee credit, which two credits must not read as the
// same rise.
func (s *Server) credit(ctx context.Context, p phoenixd.Incoming) error {
	saleID, isSale := saleOf(p.ExternalID)
	external, via := refundOf(p.ExternalID)
	acct, ok := parseAccount(external)
	if !ok && !isSale {
		return nil // not one of cardd's invoices
	}
	if s.Unpaid != nil {
		s.Unpaid.Paid(p.PaymentHash, p.ReceivedSat)
	}
	s.crediting.Lock()
	defer s.crediting.Unlock()
	// A payment already in the books (the sweep lists the last day's again
	// every 5 minutes) is recognised before phoenixd is asked anything.
	if yes, err := s.Store.Credited(ctx, p.PaymentHash); err != nil || yes {
		return err
	}
	msat, note, move, err := s.brought(ctx, p)
	if err != nil {
		return err
	}
	if isSale {
		// A sale's money goes to shop and the sale is paid, whatever part of
		// it reached the balance: the customer paid.
		done, err := s.Store.CreditSaleMoving(ctx, saleID, msat, p.PaymentHash, note, move)
		if done {
			s.Log.Printf("lnurl: sale %s paid (%s): %s%s", saleID, p.PaymentHash, note, booked(p))
			// The webhook rang this before the credit; a sweep that found the
			// payment rings it here, so a till's held read answers either way.
			if s.Paid != nil {
				s.Paid(p.PaymentHash)
			}
		}
		return err
	}
	// phoenixd's fee for the room this payment bought (0 for none, and for a
	// payment that went to fee credit) is booked with it.
	done, err := s.Store.CreditMovingVia(ctx, acct, msat, p.FeesMsat, p.PaymentHash, note, via, move)
	if done {
		s.Log.Printf("lnurl: top-up %s for %s: %s%s%s", p.PaymentHash, acct, note, booked(p), s.payerNoteLength(ctx, p.PaymentHash))
	}
	return err
}

// booked is, for the log, how long after phoenixd had a payment (its
// record's completedAt) the books had it, on the real clock: a credit that
// waited (behind another, or for the fee credit to rise) or that the sweep
// found shows here. Nothing for a payment without that time.
func booked(p phoenixd.Incoming) string {
	if p.CompletedAt <= 0 {
		return ""
	}
	return fmt.Sprintf("; in the books %d ms after phoenixd had it", time.Since(time.UnixMilli(p.CompletedAt)).Milliseconds())
}

const (
	// feeCreditWait is how long a credit waits for phoenixd's fee credit to
	// show a payment that may have been set aside; feeCreditPoll how often it
	// looks. phoenixd's figure rises only when ACINQ has confirmed it, a
	// round trip after phoenixd reported the payment.
	feeCreditWait = 5 * time.Second
	feeCreditPoll = 250 * time.Millisecond
	// recentHold: a payment cardd began or ended this recently may have made the room
	// that is seen now.
	recentHold = 10 * time.Second
	// webhookCredit is how long a webhook's credit may take, whatever
	// becomes of the request that brought it: the wait, with room to spare.
	webhookCredit = 20 * time.Second
)

// brought works out what a payment brought in: the msat
// to credit, the transaction's note, and how the fee credit cardd has
// accounted for moves with it. phoenixd takes every payment, and the money
// either reaches its balance, or buys more room at once, or is set aside as
// fee credit toward it; a set-aside payment is reported with its whole
// amount and no fee, the same as one that reached the balance, so the two
// are told apart by phoenixd's fee credit.
func (s *Server) brought(ctx context.Context, p phoenixd.Incoming) (msat int64, note string, move store.FeeCreditMove, err error) {
	msat = p.CreditMsat() // already less what the balance paid toward room
	note = fmt.Sprintf("received %d sat", p.ReceivedSat)
	room, err := s.Invoices.Room(ctx)
	if err != nil {
		return 0, "", move, err
	}
	if p.FeesMsat > 0 {
		// It bought room. ACINQ took the fee credit it used when the purchase
		// was signed, before the payment arrived, so phoenixd's figure is
		// current: once phoenixd has heard from ACINQ. A purchase the sweep
		// finds at start, before phoenixd has reconnected, would read the 0
		// phoenixd reports until then; the figure is then left, and the
		// 5-minute check lowers it once a channel is Normal.
		note += fmt.Sprintf(" after %d msat of channel fees", p.FeesMsat)
		if !room.Normal {
			return msat, note, move, nil
		}
		fc, err := s.Invoices.FeeCreditSat(ctx)
		if err != nil {
			return 0, "", move, err
		}
		return msat, note, store.FeeCreditMove{Set: true, ToSat: fc}, nil
	}
	if !room.Channel {
		// With no channel, a payment with no fee went to
		// fee credit. It pays toward the first channel and can't be spent, so
		// it is on no account. The kept figure moves by the whole amount
		// (phoenixd's own may not have risen yet), or what the first purchase
		// leaves of the fee credit would be taken from the payment after it.
		return 0, fmt.Sprintf("%d sat went to phoenixd's fee credit (not spendable; it pays toward the first channel)", p.ReceivedSat),
			store.FeeCreditMove{AddSat: p.ReceivedSat}, nil
	}
	kept, known, err := s.Store.KeptFeeCredit(ctx)
	if err != nil {
		return 0, "", move, err
	}
	if !known {
		return msat, note, move, nil // no first figure yet: whole
	}
	if room.InboundSat >= p.ReceivedSat {
		// phoenixd sets aside only what didn't fit: with room for it still
		// there, none of it was, unless cardd itself has just made that room
		// by paying something out. So the room counts without the most its
		// own recent payments can have freed: a card of this server paying
		// this server's sale is such a payment every time, and with room to
		// spare it is no reason to wait.
		// Counted from the payment's own arrival when that is longer ago (a
		// credit queued behind others that waited, the sweep's for a payment
		// that came while cardd was down), a second earlier for the clocks.
		since := s.Now().Add(-recentHold)
		if arrived := time.UnixMilli(p.CompletedAt).Add(-time.Second); p.CompletedAt > 0 && arrived.Before(since) {
			since = arrived
		}
		freedMsat, err := s.Store.PaidOutSince(ctx, since)
		if err != nil {
			return 0, "", move, err
		}
		if room.InboundSat-(freedMsat+999)/1000 >= p.ReceivedSat {
			return msat, note, move, nil
		}
	}
	rise, err := s.riseOver(ctx, kept)
	if err != nil {
		return 0, "", move, err
	}
	share := min(rise, p.ReceivedSat)
	if share <= 0 {
		// No rise by the end of the wait: whole. If it was set aside after
		// all, the invariant pauses spending and Set the books ends that.
		return msat, note, move, nil
	}
	return msat - share*1000, fmt.Sprintf("received %d sat: %d sat went to phoenixd's fee credit (toward more receiving room)", p.ReceivedSat, share),
		store.FeeCreditMove{AddSat: share}, nil
}

// riseOver waits for phoenixd's fee credit to be above kept, and returns by
// how much; 0 when it isn't by the end of the wait.
func (s *Server) riseOver(ctx context.Context, kept int64) (int64, error) {
	// The wait is a real one, on the real clock (s.Now is for what a test dates).
	wait, poll := s.Wait, s.Poll
	if wait <= 0 {
		wait = feeCreditWait
	}
	if poll <= 0 {
		poll = feeCreditPoll
	}
	deadline := time.Now().Add(wait)
	for {
		fc, err := s.Invoices.FeeCreditSat(ctx)
		if err != nil {
			return 0, err
		}
		if fc > kept {
			return fc - kept, nil
		}
		if !time.Now().Before(deadline) {
			return 0, nil
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(poll):
		}
	}
}

// SettleFeeCredit is the 5-minute check of the kept fee credit: it takes
// phoenixd's figure as the first one, and when phoenixd's is lower (a
// purchase of room used some that cardd didn't see). A higher one is left:
// it is a payment not credited yet, whose credit shares it out. Only while a
// channel is Normal: after any restart phoenixd reports no fee credit until
// it has reconnected to ACINQ, and a figure taken down to that 0 would be
// taken from the next payments.
func (s *Server) SettleFeeCredit(ctx context.Context) error {
	_, err := s.settle(ctx, false)
	return err
}

// ResetFeeCredit sets the kept fee credit to phoenixd's outright, after the
// books were set to phoenixd's balance (Set the books, a restore's
// reconcile). With a channel that isn't Normal, phoenixd's figure can't be
// trusted (it reads 0 until phoenixd has reconnected), and the kept one
// isn't left either, since the 5-minute check only ever lowers a figure it
// knows: it is forgotten, so the first check with a
// channel up takes phoenixd's, whichever way it differs, and until then a
// payment is credited whole, where a mistake shows as a pause and never as
// a quiet shortfall. It reports false then, so the person is told. With no
// channel at all it takes phoenixd's (the figure isn't read again before the
// payment that opens one sets it).
func (s *Server) ResetFeeCredit(ctx context.Context) (reset bool, err error) {
	return s.settle(ctx, true)
}

// settle reports whether phoenixd's figure could be trusted, and so was looked at.
func (s *Server) settle(ctx context.Context, outright bool) (bool, error) {
	s.crediting.Lock()
	defer s.crediting.Unlock()
	room, err := s.Invoices.Room(ctx)
	if err != nil {
		return false, err
	}
	if !room.Normal && !outright {
		return false, nil
	}
	if !room.Normal && room.Channel {
		return false, s.Store.ForgetKeptFeeCredit(ctx)
	}
	fc, err := s.Invoices.FeeCreditSat(ctx)
	if err != nil {
		return false, err
	}
	kept, known, err := s.Store.KeptFeeCredit(ctx)
	if err != nil {
		return false, err
	}
	if outright || !known || fc < kept {
		return true, s.Store.SetKeptFeeCredit(ctx, fc)
	}
	return true, nil
}

// Webhook is phoenixd's payment_received, on cardd's internal port only.
func (s *Server) Webhook(secret string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		if err != nil || !phoenixd.VerifyWebhook(secret, body, r.Header.Get("X-Phoenix-Signature")) {
			http.Error(w, "bad signature", http.StatusUnauthorized)
			return
		}
		var ev struct {
			Type        string `json:"type"`
			PaymentHash string `json:"paymentHash"`
		}
		if err := json.Unmarshal(body, &ev); err != nil || ev.Type != "payment_received" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if s.Paid != nil {
			s.Paid(ev.PaymentHash)
		}
		// phoenixd sends its webhooks one at a time and never sends one
		// again (the sweep is the retry); how long it waits for an answer
		// isn't checked (its source sets no such wait). A credit that is
		// waiting for the fee credit to rise isn't dropped if phoenixd
		// stops waiting for the answer.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), webhookCredit)
		defer cancel()
		if err := s.Credit(ctx, ev.PaymentHash); err != nil {
			s.Log.Printf("lnurl: webhook %s: %v", ev.PaymentHash, err)
			http.Error(w, "try again", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

// Sweep credits every received payment completed since fromMs that isn't
// credited yet (a webhook missed while cardd was down).
func (s *Server) Sweep(ctx context.Context, fromMs int64) error {
	for offset := 0; ; offset += 100 {
		ps, err := s.Invoices.ListIncoming(ctx, fromMs, 100, offset)
		if err != nil {
			return err
		}
		for _, p := range ps {
			if !p.IsPaid {
				continue
			}
			// Asked before credit's lock, as the webhook's path asks: a sweep
			// over payments long credited never queues behind a credit that
			// holds the lock (one waiting for the fee credit to rise).
			if yes, err := s.Store.Credited(ctx, p.PaymentHash); err != nil {
				return err
			} else if yes {
				continue
			}
			if err := s.credit(ctx, p); err != nil {
				return err
			}
		}
		if len(ps) < 100 {
			return nil
		}
	}
}

// payerNoteLength is, for the log, the length of a credited line's payer's
// note: its words are a stranger's and never go in the log.
func (s *Server) payerNoteLength(ctx context.Context, paymentHash string) string {
	note, err := s.Store.PayerNoteOf(ctx, paymentHash)
	if err != nil || note == "" {
		return ""
	}
	return fmt.Sprintf(", payer's note %d chars", utf8.RuneCountInString(note))
}

// pruneNotes deletes the notes of invoices not paid within the window, then
// all but the newest topupNoteKeep. RunSweep calls it only
// after a sweep that worked, by when every paid invoice older than the
// window is credited and its note on its line.
func (s *Server) pruneNotes(ctx context.Context) {
	s.pruneRefundLinks(ctx)
	n, err := s.Store.PruneTopupNotes(ctx, s.Now().Add(-topupNoteWindow), topupNoteKeep)
	switch {
	case err != nil:
		s.Log.Printf("lnurl: pruning payers' notes: %v", err)
	case n > 0:
		// A number only, never the words: many at once is a flood's sign.
		s.Log.Printf("lnurl: pruned %d payers' notes of invoices not paid", n)
	}
}

// pruneRefundLinks deletes the refund links past their time and those of
// taps that paid nothing, with the notes' prune.
func (s *Server) pruneRefundLinks(ctx context.Context) {
	n, err := s.Store.PruneRefundLinks(ctx, s.Now())
	switch {
	case err != nil:
		s.Log.Printf("lnurl: pruning refund links: %v", err)
	case n > 0:
		s.Log.Printf("lnurl: pruned %d refund links", n)
	}
}

// RunSweep sweeps everything at start, then the last day every 5 minutes,
// each time followed by the check of the kept fee credit, and, after a sweep
// that worked, the prune of unpaid invoices' notes (never after the quick
// look, whose window is shorter than the notes').
func (s *Server) RunSweep(ctx context.Context) {
	settle := func() {
		if err := s.SettleFeeCredit(ctx); err != nil {
			s.Log.Printf("lnurl: fee credit: %v", err)
		}
	}
	if err := s.Sweep(ctx, 0); err != nil {
		s.Log.Printf("lnurl: sweep: %v", err)
	} else {
		s.pruneNotes(ctx)
	}
	settle()
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	// The quick look, in this same loop so that it and the sweep never run
	// at once: phoenixd sends a webhook once and never again, and a payment
	// whose webhook was missed should not wait 5 minutes to show. Its own
	// failures are said when they start and when they end, not each time.
	var quick <-chan time.Time // nil, which never fires, with no QuickLook
	if s.QuickLook > 0 {
		q := time.NewTicker(s.QuickLook)
		defer q.Stop()
		quick = q.C
	}
	failing := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.Sweep(ctx, s.Now().Add(-24*time.Hour).UnixMilli()); err != nil {
				s.Log.Printf("lnurl: sweep: %v", err)
			} else {
				s.pruneNotes(ctx)
			}
			settle()
		case <-quick:
			err := s.Sweep(ctx, s.Now().Add(-quickWindow).UnixMilli())
			if ctx.Err() != nil {
				return
			}
			switch {
			case err != nil && !failing:
				s.Log.Printf("lnurl: the quick look for missed webhooks is failing: %v", err)
			case err == nil && failing:
				s.Log.Printf("lnurl: the quick look for missed webhooks works again")
			}
			failing = err != nil
		}
	}
}

// quickWindow is how far back the quick look asks phoenixd: payments
// completed in the last 10 minutes, by phoenixd's clock for the payment and
// cardd's for the window, which are one machine's. One the look could not
// ask about for longer than that (phoenixd not answering) is the 5-minute
// sweep's, which goes back a day.
const quickWindow = 10 * time.Minute

// reason turns a refusal into words a terminal can show.
func reason(err error) string {
	switch {
	case errors.Is(err, sun.ErrNotOurs), errors.Is(err, sun.ErrBadMAC), errors.Is(err, sun.ErrMalformed), errors.Is(err, cards.ErrUnknownCard):
		return "This card isn't registered on this server."
	case errors.Is(err, store.ErrReplayed):
		return "This tap was already used. Tap the card again."
	case errors.Is(err, cards.ErrFrozen):
		return "This card is frozen."
	case errors.Is(err, cards.ErrNeedsCheck):
		return "This card must be held to its owner's phone once before it can pay again."
	case errors.Is(err, cards.ErrNotActive), errors.Is(err, cards.ErrCardReset), errors.Is(err, store.ErrConflict):
		return "This card isn't active."
	case errors.Is(err, ledger.ErrPaused):
		return "Spending is paused on this card's server."
	case errors.Is(err, store.ErrOverPerTap):
		return "That is over this card's limit per payment."
	case errors.Is(err, store.ErrOverDaily):
		return "That is over this card's 24-hour limit."
	case errors.Is(err, store.ErrInsufficient):
		return "There isn't enough money on this card."
	case errors.Is(err, store.ErrPaymentInProgress):
		return "Another payment from this card is still in progress."
	case errors.Is(err, store.ErrDuplicatePayment):
		return "This invoice is already paid or being paid."
	case errors.Is(err, store.ErrBadK1):
		return "This payment request has expired or was used. Tap the card again."
	case errors.Is(err, ledger.ErrBadInvoice):
		// Decode's reasons are short and fixed: expired, no amount, the chain.
		_, why, _ := strings.Cut(err.Error(), ledger.ErrBadInvoice.Error()+": ")
		return "The terminal's invoice can't be paid: " + why + "."
	}
	return "The card's server couldn't take this payment."
}

// withdrawRequest is the tap: check it, then answer a withdrawRequest with a
// one-use k1 bound to the card.
func (s *Server) withdrawRequest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if paused, _ := s.Ledger.Paused(); paused {
		// The card is read for the alert only; the counter stays where it is.
		if s.Refused != nil {
			if tap, err := s.Cards.Peek(ctx, r.URL.Query().Get("p"), r.URL.Query().Get("c")); err == nil {
				s.refuse(tap.Card.ID, RefusedPaused, 0)
			}
		}
		fail(w, reason(ledger.ErrPaused))
		return
	}
	tap, err := s.Cards.Spend(ctx, r.URL.Query().Get("p"), r.URL.Query().Get("c"))
	if err != nil {
		s.Log.Printf("lnurl: tap refused: %v", err)
		s.refusedTap(ctx, tap, err)
		fail(w, reason(err))
		return
	}
	b := make([]byte, 32)
	rand.Read(b)
	k1 := hex.EncodeToString(b)
	if err := s.Store.IssueK1(ctx, k1, tap.Card.ID, s.Now().Add(k1Lifetime)); err != nil {
		fail(w, reason(err))
		return
	}
	answer := map[string]any{
		"tag": "withdrawRequest", "callback": "https://" + s.Host + "/ln/cb", "k1": k1,
		"minWithdrawable": 1000, "maxWithdrawable": maxWithdrawableMsat, "defaultDescription": "Bolt Card",
	}
	// A new refund link for this tap (LUD-19's payLink, a raw
	// URL as LUD-17 writes it): the shop can give the money back to this card
	// without learning anything that stays the same between taps. A link that
	// couldn't be kept is left out; the tap itself still works.
	t := make([]byte, 16)
	rand.Read(t)
	token := hex.EncodeToString(t)
	if err := s.Store.NewRefundLink(ctx, token, tap.Card.ID, k1, s.Now().Add(RefundLinkLife)); err != nil {
		s.Log.Printf("lnurl: refund link: %v", err)
	} else {
		answer["payLink"] = "lnurlp://" + s.Host + "/refund/" + token
	}
	writeJSON(w, answer)
}

// RefundLinkLife is how long a tap's refund link pays back its card: a refund
// well after the sale.
const RefundLinkLife = 400 * 24 * time.Hour

// refundMetadata is a refund link's LNURL-pay metadata: it names nothing, no
// card and no address, so a shop learns nothing from it.
const refundMetadata = `[["text/plain","Refund"]]`

// backCard is the card a refund link pays into, when it can take money now;
// false after the reason is answered.
func (s *Server) backCard(w http.ResponseWriter, r *http.Request) (store.Account, bool) {
	c, err := s.Store.RefundLinkCard(r.Context(), r.PathValue("token"))
	if err != nil {
		fail(w, "No such refund link here.")
		return "", false
	}
	if c.State != store.StateActive && c.State != store.StateFrozen {
		fail(w, "This card can't take payments any more.")
		return "", false
	}
	return store.CardAccount(c.ID), true
}

// backRequest is a refund link's payRequest (LUD-06): 1 sat to the most a
// top-up may be, no comment, metadata that names nothing.
func (s *Server) backRequest(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.backCard(w, r); !ok {
		return
	}
	writeJSON(w, map[string]any{
		"tag": "payRequest", "callback": "https://" + s.Host + "/refund/" + r.PathValue("token") + "/cb",
		"minSendable": 1000, "maxSendable": maxTopupMsat, "metadata": refundMetadata,
		// The shop's note to the customer (LUD-12), kept as the payer's note.
		"commentAllowed": maxPayerNote,
	})
}

// backCallback makes the invoice that pays back the link's card: credited as
// a top-up of the card marked as a refund (its externalId is "refund:" and
// the card's account), its description hash that of refundMetadata; the
// shop's note, if sent, kept as the line's payer's note.
func (s *Server) backCallback(w http.ResponseWriter, r *http.Request) {
	acct, ok := s.backCard(w, r)
	if !ok {
		return
	}
	msat, ok := topupAmount(w, r)
	if !ok {
		return
	}
	note, ok := payerNote(w, r)
	if !ok {
		return
	}
	if !s.mayInvoice(w, r) {
		return
	}
	sum := sha256.Sum256([]byte(refundMetadata))
	bolt11, hash, ok, err := s.makeInvoice(w, r, msat/1000, hex.EncodeToString(sum[:]), "refund:"+string(acct))
	if !ok {
		return
	}
	if err != nil {
		s.Log.Printf("lnurl: invoice for a refund link: %v", err)
		fail(w, "The server can't make an invoice right now.")
		return
	}
	if !s.keepNote(w, r, hash, note, "a refund link") {
		return
	}
	writeJSON(w, map[string]any{"pr": bolt11, "routes": []any{}})
}

// withdrawCallback takes the terminal's invoice: check the k1, read the
// invoice, use the k1 up, hold the money, answer OK at once and pay in the
// background.
func (s *Server) withdrawCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	k1 := r.URL.Query().Get("k1")
	// Looked up first, so a stranger's call costs no phoenixd request; used
	// up only once the invoice reads, so a phoenixd hiccup leaves the tap usable.
	k1Card, err := s.Store.LookupK1(ctx, k1)
	if err != nil {
		fail(w, reason(err))
		return
	}
	pr := r.URL.Query().Get("pr")
	inv, err := s.Ledger.Decode(ctx, pr)
	if err != nil {
		s.Log.Printf("lnurl: invoice refused: %v", err)
		if errors.Is(err, ledger.ErrBadInvoice) {
			s.refuse(k1Card, RefusedInvoice, 0)
		}
		fail(w, reason(err))
		return
	}
	cardID, err := s.Store.ClaimK1(ctx, k1)
	if err != nil {
		fail(w, reason(err))
		return
	}
	if _, err := s.Ledger.Pay(ctx, store.CardAccount(cardID), store.KindSpend, pr, inv, nil); err != nil {
		s.Log.Printf("lnurl: spend refused: %v", err)
		switch {
		case errors.Is(err, store.ErrOverPerTap):
			s.refuse(cardID, RefusedPerTap, inv.AmountMsat)
		case errors.Is(err, store.ErrOverDaily):
			s.refuse(cardID, RefusedDaily, inv.AmountMsat)
		case errors.Is(err, store.ErrInsufficient):
			s.refuse(cardID, RefusedFunds, inv.AmountMsat)
		}
		fail(w, reason(err))
		return
	}
	writeJSON(w, map[string]string{"status": "OK"})
}
