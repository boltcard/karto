// Package api is cardd's HTTP API for the app.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/boltcard/karto/server/internal/backup"
	"github.com/boltcard/karto/server/internal/cards"
	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/lnaddr"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/rates"
	"github.com/boltcard/karto/server/internal/renew"
	"github.com/boltcard/karto/server/internal/sendto"
	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/sun"
)

// Meta reads deployment facts written at install (store.Store implements it).
type Meta interface {
	GetMeta(ctx context.Context, key string) (string, error)
}

type api struct {
	cards   *cards.Service
	meta    Meta
	version string
	money   *Money
	backups *backup.Snapshotter
	tills   saleGate
}

// New returns cardd's public handler. Everything under /api/v1/ needs device
// auth; money, if not nil, adds the money endpoints, the shop's and a PoS
// phone's (with its public pairing call), and /health's alert;
// backups, if not nil, the snapshots. The caller adds the LNURL routes
// (package lnurl) to the same mux.
func New(svc *cards.Service, auth *deviceauth.Verifier, version string, meta Meta, money *Money, backups *backup.Snapshotter) *http.ServeMux {
	a := &api{cards: svc, meta: meta, version: version, money: money, backups: backups}
	v1 := http.NewServeMux()
	v1.HandleFunc("GET /api/v1/server", a.server)
	v1.HandleFunc("POST /api/v1/cards", a.reserve)
	v1.HandleFunc("POST /api/v1/cards/check", a.check)
	v1.HandleFunc("POST /api/v1/cards/{id}/confirm", a.confirm)
	v1.HandleFunc("POST /api/v1/cards/adopt", a.adopt)
	v1.HandleFunc("PUT /api/v1/cards/{id}/host", a.setHost)
	v1.HandleFunc("GET /api/v1/cards", a.list)
	v1.HandleFunc("PATCH /api/v1/cards/{id}", a.rename)
	v1.HandleFunc("POST /api/v1/cards/{id}/wipe", a.wipe)
	v1.HandleFunc("POST /api/v1/cards/{id}/wiped", a.wiped)
	v1.HandleFunc("PUT /api/v1/cards/{id}/photo", a.setPhoto)
	v1.HandleFunc("DELETE /api/v1/cards/{id}/photo", a.removePhoto)
	v1.HandleFunc("GET /api/v1/cards/{id}/photo", a.photo)
	if money != nil {
		a.moneyRoutes(v1)
	}
	if backups != nil {
		a.backupRoutes(v1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", a.health)
	if money != nil {
		// A phone pairing as a PoS phone has no device key registered yet.
		mux.HandleFunc("POST /pos/pair", a.posPair)
	}
	mux.Handle("/api/v1/", auth.Middleware(v1))
	return mux
}

type cardJSON struct {
	ID      string `json:"id"`
	Version uint32 `json:"version"`
	State   string `json:"state"`
	Counter int64  `json:"counter"`
	Name    string `json:"name"`
	Host    string `json:"host"`
	// NeedsCheck: restored from a backup, the card can't pay until it is held
	// to the owner's phone, whose tap check (POST /cards/check) clears it.
	NeedsCheck bool  `json:"needsCheck,omitempty"`
	PerTapSat  int64 `json:"perTapSat"`
	DailySat   int64 `json:"dailySat"`
	// Limits: the card's limits in a currency, when they are; perTapSat and
	// dailySat are then what a tap would take at the last rate.
	Limits  *limitsJSON `json:"limits,omitempty"`
	Created int64       `json:"created"`
	Updated int64       `json:"updated"`
	LNURLW  string      `json:"lnurlw,omitempty"`
}

// toJSON is a card as the API shows it: its limits in sat as a tap would
// take them now, and in their currency when they are kept in one.
func (a *api) toJSON(c store.Card) cardJSON {
	perTap, daily := a.cards.LimitsSat(c)
	return cardJSON{ID: c.ID, Version: c.Version, State: string(c.State), Counter: c.LastCounter, Name: c.Name, Host: c.Host, NeedsCheck: c.NeedsCheck,
		PerTapSat: perTap, DailySat: daily, Limits: limitsOf(c), Created: c.CreatedAt.Unix(), Updated: c.UpdatedAt.Unix()}
}

// health is public: it names no amounts, only that spending is paused.
func (a *api) health(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"ok": true, "version": a.version}
	if a.money != nil {
		if paused, _ := a.money.Ledger.Paused(); paused {
			out["alert"] = "spending paused"
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// server reports cardd's version and the hash of the deploy bundle the app
// last installed (meta bundle.sha256), so the app can offer "Update server",
// and the database's schema version, which a backup restored here can't exceed.
func (a *api) server(w http.ResponseWriter, r *http.Request) {
	bundle, err := a.meta.GetMeta(r.Context(), "bundle.sha256")
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeError(w, err)
		return
	}
	out := map[string]any{"version": a.version, "bundle": bundle, "schema": store.SchemaVersion()}
	// Whether the server's name has an IPv4 address pointing here: the wallet says so plainly when it hasn't.
	if a.money != nil && a.money.Names != nil {
		if res, ok := a.money.Names.Result(r.Context()); ok {
			dns := map[string]any{"ipv4": res.IPv4}
			if res.IPv4 == "other" {
				dns["got"] = res.Got
			}
			out["dns"] = dns
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *api) reserve(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	card, err := a.cards.Reserve(r.Context(), req.ID, req.Name)
	if err != nil {
		writeError(w, err)
		return
	}
	out := a.toJSON(card)
	out.LNURLW = a.cards.LNURLW()
	writeJSON(w, http.StatusOK, out)
}

// listCardJSON is a card in the list: with its photo's tag, or "".
type listCardJSON struct {
	cardJSON
	Photo string `json:"photo"`
}

func (a *api) list(w http.ResponseWriter, r *http.Request) {
	cards, err := a.cards.List(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	tags, err := a.cards.PhotoTags(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]listCardJSON, 0, len(cards))
	for _, c := range cards {
		out = append(out, listCardJSON{cardJSON: a.toJSON(c), Photo: tags[c.ID]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"cards": out})
}

func (a *api) rename(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	card, err := a.cards.Rename(r.Context(), r.PathValue("id"), req.Name)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.toJSON(card))
}

// wipe and wiped take no body: the card's id is in the path.
func (a *api) wipe(w http.ResponseWriter, r *http.Request) {
	a.cardStep(w, r, a.cards.Wipe)
}

func (a *api) wiped(w http.ResponseWriter, r *http.Request) {
	a.cardStep(w, r, a.cards.Wiped)
}

func (a *api) cardStep(w http.ResponseWriter, r *http.Request, step func(context.Context, string) (store.Card, error)) {
	card, err := step(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.toJSON(card))
}

type tapRequest struct {
	P string `json:"p"`
	C string `json:"c"`
}

func (a *api) confirm(w http.ResponseWriter, r *http.Request) {
	var req tapRequest
	if !readJSON(w, r, &req) {
		return
	}
	card, err := a.cards.Confirm(r.Context(), r.PathValue("id"), req.P, req.C)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.toJSON(card))
}

func (a *api) adopt(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Version uint32 `json:"version"`
		Name    string `json:"name"`
		P       string `json:"p"`
		C       string `json:"c"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	card, err := a.cards.Adopt(r.Context(), req.Version, req.Name, req.P, req.C)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.toJSON(card))
}

func (a *api) setHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Host string `json:"host"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	card, err := a.cards.SetHost(r.Context(), r.PathValue("id"), req.Host)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.toJSON(card))
}

func (a *api) check(w http.ResponseWriter, r *http.Request) {
	var req struct {
		tapRequest
		// Proved: the wallet had the card prove its key 0 in the read this
		// tap came from (or the tap is its own phone's card's): only such a
		// check lets a card restored from a backup pay again. A wallet from
		// before it never sends it, and gets needs_check for such a card.
		Proved bool `json:"proved"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	tap, err := a.cards.Check(r.Context(), req.P, req.C, req.Proved)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.toJSON(tap.Card))
}

// errorCodes maps errors to a status and a stable code the app switches on.
var errorCodes = []struct {
	err    error
	status int
	code   string
}{
	{sun.ErrMalformed, http.StatusBadRequest, "malformed"},
	{cards.ErrBadID, http.StatusBadRequest, "malformed"},
	{cards.ErrBadName, http.StatusBadRequest, "bad_name"},
	{cards.ErrBadHost, http.StatusBadRequest, "bad_host"},
	{cards.ErrBadPhoto, http.StatusBadRequest, "bad_photo"},
	{sun.ErrNotOurs, http.StatusUnprocessableEntity, "not_ours"},
	{sun.ErrBadMAC, http.StatusUnprocessableEntity, "bad_mac"},
	{cards.ErrIDMismatch, http.StatusUnprocessableEntity, "id_mismatch"},
	{cards.ErrCardReset, http.StatusUnprocessableEntity, "card_reset"},
	{cards.ErrUnknownCard, http.StatusNotFound, "unknown_card"},
	{store.ErrNotFound, http.StatusNotFound, "not_found"},
	{store.ErrReplayed, http.StatusConflict, "replayed"},
	{store.ErrConflict, http.StatusConflict, "conflict"},
	{cards.ErrNotActive, http.StatusConflict, "not_active"},
	{cards.ErrFrozen, http.StatusConflict, "frozen"},
	{cards.ErrNeedsCheck, http.StatusConflict, "needs_check"},
	{cards.ErrBadLimits, http.StatusBadRequest, "bad_limits"},
	{errBadNote, http.StatusBadRequest, "bad_note"},
	{errBadRequest, http.StatusBadRequest, "malformed"},
	{store.ErrInsufficient, http.StatusConflict, "insufficient"},
	{store.ErrCannotReceive, http.StatusConflict, "cannot_receive"},
	{store.ErrPaymentInProgress, http.StatusConflict, "payment_in_progress"},
	{store.ErrAlreadyRefunded, http.StatusConflict, "already_refunded"},
	{store.ErrNotPaid, http.StatusConflict, "not_paid"},
	{errBadReturnLink, http.StatusConflict, "bad_return_link"},
	{store.ErrDuplicatePayment, http.StatusConflict, "duplicate_payment"},
	{store.ErrRequestInProgress, http.StatusConflict, "request_in_progress"},
	{store.ErrRequestMismatch, http.StatusConflict, "request_mismatch"},
	{store.ErrBadPhoneName, http.StatusBadRequest, "bad_name"},
	{store.ErrBadWalletName, http.StatusBadRequest, "bad_name"},
	{store.ErrNameTaken, http.StatusConflict, "name_taken"},
	{store.ErrBadCode, http.StatusForbidden, "bad_code"},
	{store.ErrKeyKnown, http.StatusConflict, "key_known"},
	{store.ErrSaleExists, http.StatusConflict, "sale_exists"},
	{store.ErrBadCurrency, http.StatusBadRequest, "malformed"},
	{errWrongCurrency, http.StatusConflict, "wrong_currency"},
	{rates.ErrNoRate, http.StatusConflict, "no_rate"},
	{store.ErrNotYourSale, http.StatusForbidden, "not_allowed"},
	{errTooFast, http.StatusTooManyRequests, "slow_down"},
	{errNoInvoice, http.StatusServiceUnavailable, "no_invoice"},
	{ledger.ErrPaused, http.StatusServiceUnavailable, "paused"},
	{ledger.ErrBadInvoice, http.StatusBadRequest, "bad_invoice"},
	{ledger.ErrRestorePending, http.StatusConflict, "restore_pending"},
	{ledger.ErrNotNoChannel, http.StatusConflict, "not_no_channel"},
	{ledger.ErrChannelNotUp, http.StatusConflict, "channel_not_up"},
	{lnaddr.ErrBadAddress, http.StatusBadRequest, "bad_address"},
	{sendto.ErrRefused, http.StatusBadRequest, "bad_destination"},
	{phoenixd.ErrUnreachable, http.StatusServiceUnavailable, "phoenixd_unreachable"},
	{renew.ErrBadSync, http.StatusBadRequest, "bad_sync"},
	{renew.ErrBadDays, http.StatusBadRequest, "bad_days"},
	{renew.ErrNotSynced, http.StatusConflict, "not_synced"},
	{renew.ErrVAT, http.StatusConflict, "vat"},
	{renew.ErrNotLNVPS, http.StatusBadGateway, "not_lnvps"},
	{backup.ErrNoSnapshot, http.StatusNotFound, "no_snapshot"},
}

func writeError(w http.ResponseWriter, err error) {
	for _, e := range errorCodes {
		if errors.Is(err, e.err) {
			writeJSON(w, e.status, map[string]string{"error": e.code, "message": err.Error()})
			return
		}
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal", "message": err.Error()})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed", "message": err.Error()})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
