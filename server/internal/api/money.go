package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/boltcard/karto/server/internal/alerts"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/lnaddr"
	"github.com/boltcard/karto/server/internal/lnurl"
	"github.com/boltcard/karto/server/internal/namecheck"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/rates"
	"github.com/boltcard/karto/server/internal/renew"
	"github.com/boltcard/karto/server/internal/sendto"
	"github.com/boltcard/karto/server/internal/store"
)

// Money is what the money endpoints need.
type Money struct {
	Store     *store.Store
	Ledger    *ledger.Ledger
	Liquidity func(ctx context.Context) (phoenixd.Liquidity, error)
	// Invoices makes a sale's invoice; nil: no sales.
	Invoices SaleInvoices
	// SaleGap is the least time between a PoS phone's new sales (a second in
	// cardd; 0: no limit).
	SaleGap time.Duration
	// Bell rings a held read: of a sale at its payment, of an account's
	// history and of the wallet when the books change (nil: such a read only
	// looks again each HeldRecheck). HeldRecheck is a second
	// in cardd (0); tests change it.
	Bell        *Bell
	HeldRecheck time.Duration
	// Prices is cardd's last rate of a bitcoin (rates.Source.Last), which the
	// phones read as fiat and a sale in a currency is converted at; nil: none.
	Prices    func() (rates.Prices, bool)
	Addresses *lnaddr.Resolver
	// Lookup is Send out's lookup: offers, BIP353 names and LNURL.
	// Required: POST /send/lookup and a send to an offer use it, and a nil
	// one would panic there.
	Lookup *sendto.Looker
	Host   string
	// Names says whether Host's A record points at this VM, for
	// GET /api/v1/server; nil: the status says nothing of it.
	Names *namecheck.Checker
	// Push sends the owner phones' alerts and the test alert; its
	// NtfyPublic is the server's own ntfy. nil: no push routes.
	Push *alerts.Sender
	// Sweep credits top-ups whose webhook was missed; setting the books runs
	// it first (nil: no sweep).
	Sweep func(ctx context.Context) error
	// SendWait is POST /send's one deadline, from the handler's start, before
	// it answers "pending": 25 s, under the server's 30 s write timeout.
	// ResolveWait is the part resolving an address or LNURL-pay URL may take
	// (10 s). Tests shorten both.
	SendWait, ResolveWait time.Duration
	Log                   *log.Logger
	// Hosting keeps the VM paid; nil: no hosting routes.
	Hosting *renew.Renewer
}

// logf logs to Log, or to the standard logger when none is set.
func (m *Money) logf(format string, args ...any) {
	if m.Log != nil {
		m.Log.Printf(format, args...)
		return
	}
	log.Printf(format, args...)
}

func (a *api) moneyRoutes(v1 *http.ServeMux) {
	v1.HandleFunc("GET /api/v1/wallet", a.wallet)
	if a.money.Push != nil {
		v1.HandleFunc("GET /api/v1/push", a.pushGet)
		v1.HandleFunc("PUT /api/v1/push", a.pushPut)
		v1.HandleFunc("DELETE /api/v1/push", a.pushDelete)
		v1.HandleFunc("POST /api/v1/push/test", a.pushTest)
	}
	v1.HandleFunc("GET /api/v1/accounts/{account}/history", a.history)
	v1.HandleFunc("GET /api/v1/accounts/{account}/transactions/{id}", a.transaction)
	v1.HandleFunc("PATCH /api/v1/accounts/{account}/transactions/{id}", a.setNote)
	v1.HandleFunc("POST /api/v1/move", a.moveMoney)
	v1.HandleFunc("POST /api/v1/send", a.send)
	v1.HandleFunc("POST /api/v1/send/lookup", a.lookup)
	v1.HandleFunc("GET /api/v1/send/recent", a.recentSends)
	v1.HandleFunc("DELETE /api/v1/send/recent", a.removeRecent)
	v1.HandleFunc("GET /api/v1/send/{id}", a.sendState)
	v1.HandleFunc("POST /api/v1/sales/{id}/refund", a.refundSale)
	v1.HandleFunc("POST /api/v1/cards/{id}/freeze", func(w http.ResponseWriter, r *http.Request) { a.cardStep(w, r, a.cards.Freeze) })
	v1.HandleFunc("POST /api/v1/cards/{id}/unfreeze", func(w http.ResponseWriter, r *http.Request) { a.cardStep(w, r, a.cards.Unfreeze) })
	v1.HandleFunc("PATCH /api/v1/cards/{id}/limits", a.limits)
	v1.HandleFunc("POST /api/v1/ledger/reconcile", a.reconcile)
	v1.HandleFunc("POST /api/v1/ledger/restore-books", a.restoreBooks)
	a.posRoutes(v1)
	a.shopRoutes(v1)
	a.fiatRoutes(v1)
	if a.money.Hosting != nil {
		a.hostingRoutes(v1)
	}
}

// reconcile sets the books to phoenixd's balance, the way out of a pause
// caused by books that disagree with it; the difference is
// recorded in pool.
func (a *api) reconcile(w http.ResponseWriter, r *http.Request) {
	diff, err := a.money.Ledger.Correct(r.Context(), a.money.Sweep)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bookedMsat": diff})
}

// restoreBooks sets the books to phoenixd's balance, both ways, when no
// channel came back after a restore: the person's choice, behind the screen
// lock.
func (a *api) restoreBooks(w http.ResponseWriter, r *http.Request) {
	diff, err := a.money.Ledger.SetBooksAfterRestore(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bookedMsat": diff})
}

var cardIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// accountFor reads an account name in a path or body: pool, hosting, shop, or a card's id.
func accountFor(name string) (store.Account, error) {
	switch {
	case name == "pool":
		return store.Pool, nil
	case name == "hosting":
		return store.Hosting, nil
	case name == "shop":
		return store.Shop, nil
	case cardIDPattern.MatchString(name):
		return store.CardAccount(name), nil
	}
	return "", fmt.Errorf("%w: unknown account %q", errBadRequest, name)
}

// accountName is accountFor's reverse: an account as the API names it.
func accountName(a store.Account) string {
	if id, isCard := a.CardID(); isCard {
		return id
	}
	return string(a)
}

var errBadRequest = errors.New("api: bad request")

// errBadNote: a note on a line over 200 characters.
var errBadNote = errors.New("a note is 200 characters at most")

type accountJSON struct {
	BalanceMsat int64  `json:"balanceMsat"`
	HeldMsat    int64  `json:"heldMsat"`
	Address     string `json:"address"`
}

// poolJSON is Pool's account, with the most a Send out can take now
// (ledger.SendableMsat): an older cardd has no sendableMsat.
type poolJSON struct {
	accountJSON
	SendableMsat int64 `json:"sendableMsat"`
}

type walletCardJSON struct {
	ID           string      `json:"id"`
	Name         string      `json:"name"`
	State        string      `json:"state"`
	Version      uint32      `json:"version"`
	BalanceMsat  int64       `json:"balanceMsat"`
	HeldMsat     int64       `json:"heldMsat"`
	Spent24hMsat int64       `json:"spent24hMsat"`
	PerTapSat    int64       `json:"perTapSat"`
	DailySat     int64       `json:"dailySat"`
	Limits       *limitsJSON `json:"limits,omitempty"` // in a currency
	Address      string      `json:"address"`
}

// revShape is a rev as Bell.Rev gives it; one the app gives back is never longer than maxRev.
var revShape = regexp.MustCompile(`^[0-9a-f]{8}-[0-9]+$`)

const maxRev = 64

// wallet is the balances, the cards and what phoenixd has of room. A read
// can be held (?since=<rev>&wait=seconds): answered at once when the books
// have changed since the rev it gives, otherwise when they do or when the
// wait is over. The Wallet page asks this way, to show money as it arrives.
func (a *api) wallet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	m := a.money
	q := r.URL.Query()
	since, wait, ok := q.Get("since"), time.Duration(0), true
	if q.Has("since") {
		ok = len(since) <= maxRev && revShape.MatchString(since)
	}
	if ok && q.Has("wait") {
		wait, ok = heldWait(q.Get("wait"))
		ok = ok && q.Has("since")
	}
	if !ok {
		writeError(w, fmt.Errorf("%w: since is a rev the wallet answered with and wait whole seconds, and a wait needs a since", errBadRequest))
		return
	}
	if wait > 0 {
		// Listening before the first look: a ring between the two isn't lost.
		// The look each second only compares the rev again: a net under the ring.
		heard, stop := m.Bell.listen(anyKey)
		defer stop()
		moved := func() (bool, error) { return m.Bell.Rev() != since, nil }
		there, _ := moved()
		if gone, _ := m.hold(ctx, wait, heard, there, moved); gone {
			return
		}
	}
	// Read before the balances: a change that commits between the two makes
	// the next ask, which gives this rev, answer at once. Told at least once.
	rev := m.Bell.Rev()
	// phoenixd's figures are asked for beside the books, not before them:
	// the answer takes the longer of the two, not their sum.
	liquidity := make(chan *phoenixd.Liquidity, 1)
	go func() {
		if l, err := m.Liquidity(ctx); err == nil {
			liquidity <- &l
			return
		}
		liquidity <- nil
	}()
	acct := func(acct store.Account) (accountJSON, error) {
		b, err := m.Store.Balance(ctx, acct)
		return accountJSON{BalanceMsat: b.EntriesMsat, HeldMsat: b.HeldMsat, Address: lnurl.Address(m.Host, acct)}, err
	}
	list, err := a.cards.List(ctx)
	if err != nil {
		writeError(w, err)
		return
	}
	cards := []walletCardJSON{}
	for _, c := range list {
		if c.State == store.StateReset {
			continue
		}
		ca := store.CardAccount(c.ID)
		b, err := m.Store.Balance(ctx, ca)
		if err != nil {
			writeError(w, err)
			return
		}
		spent, err := m.Store.SpentLast24hMsat(ctx, ca)
		if err != nil {
			writeError(w, err)
			return
		}
		perTap, daily := a.cards.LimitsSat(c)
		cards = append(cards, walletCardJSON{ID: c.ID, Name: c.Name, State: string(c.State), Version: c.Version,
			BalanceMsat: b.EntriesMsat, HeldMsat: b.HeldMsat, Spent24hMsat: spent, PerTapSat: perTap, DailySat: daily, Limits: limitsOf(c),
			Address: lnurl.Address(m.Host, ca)})
	}
	poolAcct, err := acct(store.Pool)
	if err != nil {
		writeError(w, err)
		return
	}
	pool := poolJSON{accountJSON: poolAcct, SendableMsat: ledger.SendableMsat(poolAcct.BalanceMsat - poolAcct.HeldMsat)}
	hosting, err := acct(store.Hosting)
	if err != nil {
		writeError(w, err)
		return
	}
	// Shop: what sales brought in, with no address, and how
	// many PoS phones and paid sales there are, which is how the app knows
	// there is a shop to show.
	shop, err := acct(store.Shop)
	if err != nil {
		writeError(w, err)
		return
	}
	phones, sales, err := m.Store.ShopCounts(ctx)
	if err != nil {
		writeError(w, err)
		return
	}
	restore, err := m.Ledger.Restore(ctx)
	if err != nil {
		writeError(w, err)
		return
	}
	paused, reason := m.Ledger.Paused()
	fiat, err := m.fiat(ctx)
	if err != nil {
		writeError(w, err)
		return
	}
	name, err := m.Store.WalletName(ctx)
	if err != nil {
		writeError(w, err)
		return
	}
	out := map[string]any{"cards": cards, "pool": pool, "hosting": hosting, "paused": paused, "pausedReason": reason, "liquidity": nil, "restore": nil,
		"fiat": fiat, "name": name,
		"shop": map[string]any{"balanceMsat": shop.BalanceMsat, "heldMsat": shop.HeldMsat, "address": shop.Address, "phones": phones, "sales": sales}}
	if restore != nil {
		rj := map[string]any{"state": restore.State, "from": restore.From}
		if restore.State == "done" {
			rj["reconciledMsat"], rj["reconciledAt"] = restore.ReconciledMsat, restore.ReconciledAt
		}
		if restore.Final {
			rj["final"] = true
		}
		out["restore"] = rj
	}
	if rev != "" {
		out["rev"] = rev
	}
	if l := <-liquidity; l != nil {
		out["liquidity"] = map[string]any{"channel": l.Channel, "usable": l.Usable, "inboundSat": l.InboundSat,
			"feeCreditSat": l.FeeCreditSat, "firstChannelFeeSat": l.FirstChannelFeeSat}
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *api) history(w http.ResponseWriter, r *http.Request) {
	acct, err := accountFor(r.PathValue("account"))
	if err != nil {
		writeError(w, err)
		return
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	// A held read (?after=<id>&wait=seconds): answered once the account has a
	// transaction newer than after, or when the wait is over. A phone that is
	// a card asks this way, to say Paid as its payment settles.
	q := r.URL.Query()
	after, wait, ok := int64(0), time.Duration(0), true
	if q.Has("after") {
		var err error
		after, err = strconv.ParseInt(q.Get("after"), 10, 64)
		ok = err == nil && after >= 0
	}
	if ok && q.Has("wait") {
		wait, ok = heldWait(q.Get("wait"))
		ok = ok && q.Has("after")
	}
	if !ok {
		writeError(w, fmt.Errorf("%w: after is a transaction's id and wait whole seconds, and a wait needs an after", errBadRequest))
		return
	}
	ctx := r.Context()
	newer := func() (bool, error) {
		top, err := a.money.Store.History(ctx, acct, 0, 1)
		return len(top) > 0 && top[0].ID > after, err
	}
	if wait > 0 {
		// Listening before the first look: a ring between the two isn't lost.
		heard, stop := a.money.Bell.listen(movedKey(acct))
		defer stop()
		there, err := newer()
		if err != nil {
			writeError(w, err)
			return
		}
		gone, err := a.money.hold(ctx, wait, heard, there, newer)
		if gone {
			return
		}
		if err != nil {
			writeError(w, err)
			return
		}
	}
	txs, err := a.money.Store.History(ctx, acct, before, limit)
	if err != nil {
		writeError(w, err)
		return
	}
	out := []txJSON{}
	for _, t := range txs {
		out = append(out, a.txOut(r.Context(), t))
	}
	writeJSON(w, http.StatusOK, map[string]any{"transactions": out})
}

// maxNote is the most characters a note on a line holds.
const maxNote = 200

// noteText is a person's note as cardd keeps it: cleaned as outside text is
// (control and format characters as spaces, runs of space as one, trimmed),
// at most maxNote characters, else errBadNote.
func noteText(s string) (string, error) {
	n := lnaddr.Clean(s, 4*maxNote) // anything this long is refused below anyway
	if utf8.RuneCountInString(n) > maxNote {
		return "", errBadNote
	}
	return n, nil
}

type txSaleJSON struct {
	ID        string     `json:"id"`
	Method    string     `json:"method"`
	Device    string     `json:"device"`
	PriceMsat int64      `json:"priceMsat"`
	Price     *priceJSON `json:"price,omitempty"` // rung up in a currency
	// When the sale was paid, its refund (null for none) and where a refund
	// would go (6).
	PaidAt        int64              `json:"paidAt,omitempty"`
	Refund        *refundJSON        `json:"refund"`
	ReturnAddress *returnAddressJSON `json:"returnAddress,omitempty"`
}

type txJSON struct {
	ID      int64  `json:"id"`
	Kind    string `json:"kind"`
	Note    string `json:"note"`
	Comment string `json:"comment"`
	// A top-up's payer's note (LUD-12): the payer's words, cleaned and
	// cut to 140 by cardd; absent for none. The person's PATCH never sets it.
	PayerNote string `json:"payerNote,omitempty"`
	// How a top-up's money came when more than a top-up: "refund", through
	// one of this server's refund links. Absent otherwise.
	Via        string `json:"via,omitempty"`
	AmountMsat int64  `json:"amountMsat"`
	FeeMsat    int64  `json:"feeMsat"`
	Created    int64  `json:"created"`
	// A move's or a refund's other account of this wallet, as the API names
	// accounts (a refund paid over Lightning has none); a sale's phone, way
	// of paying and price. Absent for other kinds.
	Other string      `json:"other,omitempty"`
	Sale  *txSaleJSON `json:"sale,omitempty"`
}

// paymentJSON is a Lightning payment's facts on its line; preimage
// is "" when phoenixd didn't know it and absent while not yet asked.
type paymentJSON struct {
	Hash        string  `json:"hash,omitempty"`
	Preimage    *string `json:"preimage,omitempty"`
	Invoice     string  `json:"invoice,omitempty"`
	Offer       string  `json:"offer,omitempty"`
	Description string  `json:"description,omitempty"`
	Destination string  `json:"destination,omitempty"`
}

type lineJSON struct {
	txJSON
	Payment *paymentJSON `json:"payment,omitempty"`
}

func (a *api) txOut(ctx context.Context, t store.Tx) txJSON {
	j := txJSON{ID: t.ID, Kind: string(t.Kind), Note: t.Note, Comment: t.Comment, PayerNote: t.PayerNote, Via: t.Via, AmountMsat: t.AmountMsat, FeeMsat: t.FeeMsat, Created: t.CreatedAt.Unix(), Other: accountName(t.Other)}
	if t.Sale != nil {
		s := t.Sale
		j.Sale = &txSaleJSON{ID: s.ID, Method: s.Method, Device: s.Device, PriceMsat: s.PriceMsat,
			Refund: refundOut(s.RefundTxID, s.RefundPending, s.RefundAt, s.RefundMsat, s.RefundFrom), ReturnAddress: a.returnAddress(ctx, s.ReturnLink)}
		if s.PriceCurrency != "" {
			j.Sale.Price = &priceJSON{Currency: s.PriceCurrency, Minor: s.PriceMinor}
		}
		if !s.PaidAt.IsZero() {
			j.Sale.PaidAt = s.PaidAt.Unix()
		}
	}
	return j
}

func (a *api) lineOut(ctx context.Context, l store.Line) lineJSON {
	out := lineJSON{txJSON: a.txOut(ctx, l.Tx)}
	if p := l.Payment; p != nil {
		out.Payment = &paymentJSON{Hash: p.Hash, Invoice: p.Invoice, Offer: p.Offer, Description: p.Description, Destination: p.Destination}
		if p.PreimageAsked {
			pre := p.Preimage
			out.Payment.Preimage = &pre
		}
	}
	return out
}

// lineFor reads the path's account and line id.
func lineFor(r *http.Request) (store.Account, int64, error) {
	acct, err := accountFor(r.PathValue("account"))
	if err != nil {
		return "", 0, err
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		return "", 0, fmt.Errorf("%w: a line's id is a whole number", errBadRequest)
	}
	return acct, id, nil
}

// transaction answers one line as the account sees it.
func (a *api) transaction(w http.ResponseWriter, r *http.Request) {
	acct, id, err := lineFor(r)
	if err != nil {
		writeError(w, err)
		return
	}
	l, err := a.money.Store.Line(r.Context(), acct, id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.lineOut(r.Context(), l))
}

// setNote sets the person's note on a line ("" removes it). The same note
// twice gives the same answer, so it needs no request id; the signature's
// replay check covers a replay. It moves no money: no held read is rung.
// It never touches a top-up's payer's note, which is the payer's.
func (a *api) setNote(w http.ResponseWriter, r *http.Request) {
	acct, id, err := lineFor(r)
	if err != nil {
		writeError(w, err)
		return
	}
	var req struct {
		Comment *string `json:"comment"`
	}
	if _, ok := readBody(w, r, &req); !ok {
		return
	}
	// No comment (or null) is a body that doesn't say what the note is, not
	// a removal: "" removes it.
	if req.Comment == nil {
		writeError(w, fmt.Errorf("%w: comment is required", errBadRequest))
		return
	}
	note, err := noteText(*req.Comment)
	if err != nil {
		writeError(w, err)
		return
	}
	l, err := a.money.Store.SetComment(r.Context(), acct, id, note)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.lineOut(r.Context(), l))
}

// once runs a money request a single time per request id:
// the same id again gets the first answer, without acting again.
func (a *api) once(w http.ResponseWriter, r *http.Request, id string, body []byte, handle func() (int, any)) {
	ctx := r.Context()
	if id == "" || len(id) > 64 {
		writeError(w, fmt.Errorf("%w: a request id is required", errBadRequest))
		return
	}
	sum := sha256.Sum256(body)
	prev, err := a.money.Store.BeginRequest(ctx, id, hex.EncodeToString(sum[:]))
	if err != nil {
		writeError(w, err)
		return
	}
	if prev != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(prev.Status)
		io.WriteString(w, prev.Body)
		return
	}
	status, v := handle()
	if r.Context().Err() != nil {
		// The phone gave up: its id is freed so a retry runs again at once.
		// The ref on a move or a send keeps that retry from acting twice.
		a.money.Store.ForgetRequest(context.Background(), id)
		return
	}
	var buf bytes.Buffer
	json.NewEncoder(&buf).Encode(v)
	// The answer is kept with a context of its own: the request may already be gone.
	if err := a.money.Store.FinishRequest(context.Background(), id, status, buf.String()); err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(buf.Bytes())
}

// errorAnswer is writeError's status and body, for once.
func errorAnswer(err error) (int, any) {
	for _, e := range errorCodes {
		if errors.Is(err, e.err) {
			return e.status, map[string]string{"error": e.code, "message": err.Error()}
		}
	}
	return http.StatusInternalServerError, map[string]string{"error": "internal", "message": err.Error()}
}

func readBody(w http.ResponseWriter, r *http.Request, v any) ([]byte, bool) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, err)
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed", "message": err.Error()})
		return nil, false
	}
	return body, true
}

func (a *api) moveMoney(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID         string `json:"id"`
		From       string `json:"from"`
		To         string `json:"to"`
		AmountMsat int64  `json:"amountMsat"`
	}
	body, ok := readBody(w, r, &req)
	if !ok {
		return
	}
	a.once(w, r, req.ID, body, func() (int, any) {
		from, err := accountFor(req.From)
		if err != nil {
			return errorAnswer(err)
		}
		to, err := accountFor(req.To)
		if err != nil {
			return errorAnswer(err)
		}
		if req.AmountMsat <= 0 || from == to {
			return errorAnswer(fmt.Errorf("%w: a move needs an amount and two different accounts", errBadRequest))
		}
		// The request id is the move's ref: if cardd stops after moving but
		// before answering, the retry finds the move made and doesn't repeat it.
		if err := a.money.Store.MoveOnce(r.Context(), "request:"+req.ID, from, to, req.AmountMsat, "moved by the phone"); err != nil {
			return errorAnswer(err)
		}
		return http.StatusOK, map[string]any{"status": "moved"}
	})
}

// send pays out of pool to a bolt11 invoice, a Lightning address or an
// LNURL-pay URL. One deadline, SendWait from the start, covers resolving (at
// most ResolveWait), reading the invoice, the hold and the wait for an
// outcome; the payment itself runs on its own context and is never cut short.
func (a *api) send(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID         string `json:"id"`
		To         string `json:"to"`
		AmountMsat int64  `json:"amountMsat"`
		Comment    string `json:"comment"`
		Name       string `json:"name"` // the ₿ name an offer came from
	}
	body, ok := readBody(w, r, &req)
	if !ok {
		return
	}
	a.once(w, r, req.ID, body, func() (int, any) {
		note, err := noteText(req.Comment)
		if err != nil {
			return errorAnswer(err)
		}
		ctx, cancel := context.WithTimeout(r.Context(), a.money.SendWait)
		defer cancel()
		return a.payOut(ctx, "request:"+req.ID, store.Pool, store.KindSend, req.To, req.Name, req.AmountMsat, store.HoldAbout{Comment: note}, nil)
	})
}

// payOut pays out of acct, as kind, to a bolt11 invoice, a Lightning address,
// an LNURL-pay URL or an offer (name: the ₿ name it came from), once per ref:
// send's payment, and a refund's. ctx is the request's deadline.
func (a *api) payOut(ctx context.Context, ref string, acct store.Account, kind store.Kind, to, name string, amountMsat int64, about store.HoldAbout, words func(limit int) string) (int, any) {
	m := a.money
	{
		// cardd stopped during this send, or the phone gave up on it, and the
		// request id was forgotten: answer from the payment it made rather
		// than pay again (a Lightning address would give a new invoice).
		if h, err := m.Store.HoldByRef(ctx, ref); err == nil {
			return sendAnswer(holdOutcome(h))
		} else if !errors.Is(err, store.ErrNotFound) {
			return errorAnswer(err)
		}
		to := strings.TrimSpace(to)
		if name != "" && !sendto.IsOffer(to) {
			return errorAnswer(fmt.Errorf("%w: a name goes with an offer", errBadRequest))
		}
		if sendto.IsOffer(to) {
			return a.sendOffer(ctx, ref, acct, kind, to, name, amountMsat, about)
		}
		bolt11, metadata := to, ""
		// How long the recipient's server took over its invoice goes to the
		// log, without the address: it is time a send spends before any money
		// is held, which the ledger's line for the payment can't show.
		resolved := time.Duration(-1)
		if lnaddr.IsAddress(bolt11) || lnaddr.IsPayURL(bolt11) {
			if amountMsat <= 0 {
				return errorAnswer(fmt.Errorf("%w: an amount is needed for a Lightning address or LNURL-pay link", errBadRequest))
			}
			asked := time.Now()
			rctx, rcancel := context.WithTimeout(ctx, m.ResolveWait)
			res, err := m.Addresses.ResolveWithComment(rctx, bolt11, amountMsat, words)
			rcancel()
			resolved = time.Since(asked)
			if err != nil {
				m.logf("api: send: the address gave no invoice after %d ms", resolved.Milliseconds())
				return errorAnswer(err)
			}
			bolt11, metadata = res.PR, res.Metadata
			about.Destination, about.Description = to, lnaddr.PlainText(res.Metadata)
		}
		inv, err := m.Ledger.DecodeFor(ctx, bolt11, amountMsat)
		var other *ledger.AmountError
		if kind == store.KindRefund && resolved < 0 && errors.As(err, &other) {
			// The customer's own invoice is for another amount than the
			// refund. One an address or link's server gave is
			// that server's fault: a bad invoice, as for a send.
			return otherAmount(other.InvoiceMsat, "invoice")
		}
		if err != nil {
			return errorAnswer(err)
		}
		if resolved >= 0 {
			m.logf("api: send %s: the address gave its invoice after %d ms", inv.PaymentHash, resolved.Milliseconds())
		}
		if sum := sha256.Sum256([]byte(metadata)); metadata != "" && inv.DescriptionHash != "" && inv.DescriptionHash != hex.EncodeToString(sum[:]) {
			// Current LUD-06 asks wallets to check the amount only, and
			// phoenixd checks no more: noted, not refused.
			m.logf("api: send %s: the invoice's description hash doesn't match the pay request's metadata", inv.PaymentHash)
		}
		done := make(chan ledger.Outcome, 1)
		h, err := m.Ledger.PayOnce(ctx, ref, acct, kind, bolt11, inv, about, done)
		if err != nil {
			return errorAnswer(err)
		}
		select {
		case o := <-done:
			return sendAnswer(o)
		case <-ctx.Done():
			return sendAnswer(ledger.Outcome{Hold: h, Pending: true})
		}
	}
}

// otherAmount is a refund's refusal of the customer's invoice or offer that
// is for another amount than the refund's: its own amount, and which it was.
func otherAmount(msat int64, of string) (int, any) {
	return http.StatusConflict, map[string]any{"error": "other_amount", "message": "the " + of + " is for another amount", "amountMsat": msat, "of": of}
}

// recentListed is how many addresses Send out's Recent list shows.
const recentListed = 5

// recentSends is Send out's Recent list: the addresses Pool's
// settled sends went to, newest first, what the field gets and what the
// row shows.
func (a *api) recentSends(w http.ResponseWriter, r *http.Request) {
	list, err := a.money.Store.RecentSends(r.Context(), a.money.Host, recentListed)
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, e := range list {
		out = append(out, map[string]any{"to": e.To, "shown": e.Shown, "paidAt": e.PaidAt.Unix()})
	}
	writeJSON(w, http.StatusOK, map[string]any{"recent": out})
}

// removeRecent takes an address off the Recent list until it is paid again.
func (a *api) removeRecent(w http.ResponseWriter, r *http.Request) {
	var req struct {
		To string `json:"to"`
	}
	if _, ok := readBody(w, r, &req); !ok {
		return
	}
	to := strings.TrimSpace(req.To)
	if to == "" || len(to) > 2000 {
		writeError(w, fmt.Errorf("%w: to is required, at most 2000 characters", errBadRequest))
		return
	}
	if err := a.money.Store.RemoveRecent(r.Context(), to); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// sendOffer pays an offer: the name's record read again
// when there is one, the offer checked again, then the hold with no hash.
func (a *api) sendOffer(ctx context.Context, ref string, acct store.Account, kind store.Kind, to, name string, amountMsat int64, about store.HoldAbout) (int, any) {
	m := a.money
	rctx, rcancel := context.WithTimeout(ctx, m.ResolveWait)
	ans, err := m.Lookup.OfferToPay(rctx, to, name)
	rcancel()
	if err != nil {
		return errorAnswer(err)
	}
	switch {
	case kind == store.KindRefund && ans.AmountMsat > 0 && amountMsat != 0 && amountMsat != ans.AmountMsat:
		return otherAmount(ans.AmountMsat, "offer")
	case ans.AmountMsat > 0 && amountMsat != 0 && amountMsat != ans.AmountMsat:
		// An offer with an amount: amountMsat absent or equal; a
		// negative one is neither.
		return errorAnswer(fmt.Errorf("%w: the offer is for %d msat, not %d", errBadRequest, ans.AmountMsat, amountMsat))
	case ans.AmountMsat > 0:
		amountMsat = ans.AmountMsat
	case amountMsat <= 0 || amountMsat%1000 != 0:
		return errorAnswer(fmt.Errorf("%w: an offer with no amount needs one, in whole sats", errBadRequest))
	}
	about.Destination, about.Description = offerDestination(ans), ans.Description
	done := make(chan ledger.Outcome, 1)
	h, err := m.Ledger.PayOfferOnce(ctx, ref, acct, kind, ans.Offer, amountMsat, about, done)
	if err != nil {
		return errorAnswer(err)
	}
	select {
	case o := <-done:
		return sendAnswer(o)
	case <-ctx.Done():
		return sendAnswer(ledger.Outcome{Hold: h, Pending: true})
	}
}

// offerDestination is where an offer's payment went, as its history names
// it: the BIP353 name, else the issuer, else the description, else "an offer".
func offerDestination(a sendto.Answer) string {
	switch {
	case a.Name != "":
		return a.Name
	case a.Issuer != "":
		return "an offer from " + a.Issuer
	case a.Description != "":
		return a.Description
	}
	return "an offer"
}

// sendAnswer is a send's outcome, with its payment hash so the app can watch
// one that is still on its way (empty for an offer still pending: phoenixd
// gives it only with the outcome, and GET /send/{id} follows it instead),
// and, for one that failed, why when the hold kept a reason.
func sendAnswer(o ledger.Outcome) (int, any) {
	out := map[string]any{"paymentHash": o.Hold.PaymentHash, "amountMsat": o.Hold.AmountMsat}
	switch {
	case o.Pending:
		out["status"] = "pending"
	case o.Hold.State == store.HoldSettled:
		out["status"], out["feeMsat"] = "sent", o.Hold.FeeMsat
	default:
		out["status"] = "failed"
		if o.Hold.Reason != "" {
			out["reason"] = o.Hold.Reason
		}
	}
	return http.StatusOK, out
}

// lookup says what a destination will pay, for Send out's Check:
// within ResolveWait, no money moves.
func (a *api) lookup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		To string `json:"to"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	m := a.money
	ctx, cancel := context.WithTimeout(r.Context(), m.ResolveWait)
	defer cancel()
	asked := time.Now()
	ans, err := m.Lookup.Lookup(ctx, req.To)
	took := time.Since(asked).Milliseconds()
	if err != nil {
		m.logf("api: lookup refused after %d ms", took)
		writeError(w, err)
		return
	}
	m.logf("api: lookup %s %d ms", ans.Kind, took)
	writeJSON(w, http.StatusOK, lookupJSON(ans))
}

// lookupJSON is a lookup's answer: an offer's amount is null when the person
// chooses it.
func lookupJSON(a sendto.Answer) map[string]any {
	if a.Kind == "payurl" {
		return map[string]any{"kind": a.Kind, "to": a.To, "minMsat": a.MinMsat, "maxMsat": a.MaxMsat, "description": a.Description}
	}
	out := map[string]any{"kind": a.Kind, "offer": a.Offer, "amountMsat": nil, "description": a.Description, "issuer": a.Issuer}
	if a.AmountMsat > 0 {
		out["amountMsat"] = a.AmountMsat
	}
	if a.Name != "" {
		out["name"] = a.Name
	}
	return out
}

// sendState is a send's state now, by its request id: a
// pending offer has no hash for the app to watch, and a repeated POST
// replays its stored "pending". ?wait=s holds the read until the hold ends.
func (a *api) sendState(w http.ResponseWriter, r *http.Request) {
	ctx, m := r.Context(), a.money
	id := r.PathValue("id")
	if id == "" || len(id) > 64 {
		writeError(w, fmt.Errorf("%w: a request id is required", errBadRequest))
		return
	}
	wait := time.Duration(0)
	if q := r.URL.Query(); q.Has("wait") {
		var ok bool
		if wait, ok = heldWait(q.Get("wait")); !ok {
			writeError(w, fmt.Errorf("%w: wait is whole seconds", errBadRequest))
			return
		}
	}
	ref := "request:" + id
	if wait > 0 {
		// Listening before the first look, as wallet does: a ring between
		// the two isn't lost. Settling or releasing the hold touches pool.
		// A refund may come from Shop: the hold's own account rings.
		acct := store.Pool
		if h, err := m.Store.HoldByRef(ctx, ref); err == nil {
			acct = h.Account
		}
		heard, stop := m.Bell.listen(movedKey(acct))
		defer stop()
		ended := func() (bool, error) {
			h, err := m.Store.HoldByRef(ctx, ref)
			return err != nil || h.State != store.HoldOpen, nil
		}
		there, _ := ended()
		if gone, _ := m.hold(ctx, wait, heard, there, ended); gone {
			return
		}
	}
	h, err := m.Store.HoldByRef(ctx, ref)
	if err != nil {
		writeError(w, err)
		return
	}
	status, out := sendAnswer(ledger.Outcome{Hold: h, Pending: h.State == store.HoldOpen})
	writeJSON(w, status, out)
}

// limits sets a card's spending limits: in sat ({perTapSat, dailySat}) or in
// a currency ({currency, perTapMinor, dailyMinor}), not both.
func (a *api) limits(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PerTapSat   int64  `json:"perTapSat"`
		DailySat    int64  `json:"dailySat"`
		Currency    string `json:"currency"`
		PerTapMinor int64  `json:"perTapMinor"`
		DailyMinor  int64  `json:"dailyMinor"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	ctx, id := r.Context(), r.PathValue("id")
	var card store.Card
	var err error
	inSat := req.PerTapSat != 0 || req.DailySat != 0
	inCurrency := req.Currency != "" || req.PerTapMinor != 0 || req.DailyMinor != 0
	switch {
	case inSat && inCurrency:
		err = fmt.Errorf("%w: limits are in sat (perTapSat, dailySat) or in a currency (currency, perTapMinor, dailyMinor), not both", errBadRequest)
	case inCurrency:
		card, err = a.cards.SetLimitsMinor(ctx, id, req.Currency, req.PerTapMinor, req.DailyMinor)
	default:
		card, err = a.cards.SetLimits(ctx, id, req.PerTapSat, req.DailySat)
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, a.toJSON(card))
}
