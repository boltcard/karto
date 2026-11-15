package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/rates"
	"github.com/boltcard/karto/server/internal/store"
)

// The routes a PoS phone may call: everything under
// deviceauth.PosPrefix, which the auth middleware keeps it to. An owner may
// call them too, but for the PoS-only ones.
func (a *api) posRoutes(v1 *http.ServeMux) {
	v1.HandleFunc("GET /api/v1/pos/me", a.posMe)
	v1.HandleFunc("DELETE /api/v1/pos/me", posOnly(a.posUnpair))
	v1.HandleFunc("POST /api/v1/pos/sales", posOnly(a.newSale))
	v1.HandleFunc("GET /api/v1/pos/sales", a.paidSales)
	v1.HandleFunc("GET /api/v1/pos/sales/days", a.saleDays)
	v1.HandleFunc("GET /api/v1/pos/sales/{id}", a.sale)
	v1.HandleFunc("POST /api/v1/pos/sales/{id}/card", posOnly(a.saleCard))
	v1.HandleFunc("POST /api/v1/pos/sales/{id}/cancel", posOnly(func(w http.ResponseWriter, r *http.Request) { a.saleStep(w, r, a.money.Store.CancelSale) }))
}

// posOnly refuses an owner: Karto Wallet has no till, and doesn't unpair
// itself this way.
func posOnly(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deviceauth.RoleOf(r.Context()) != deviceauth.Pos {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "not_allowed", "message": "only a PoS phone does this"})
			return
		}
		h(w, r)
	}
}

// posMe is what the calling device is to this server, and the wallet's name:
// a till reads both each time it reads the shop's currency.
func (a *api) posMe(w http.ResponseWriter, r *http.Request) {
	d, err := a.money.Store.GetDevice(r.Context(), deviceauth.DeviceID(r.Context()))
	if err != nil {
		writeError(w, err)
		return
	}
	wallet, err := a.money.Store.WalletName(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"keyId": d.KeyID, "name": d.Name, "role": string(d.Role), "wallet": wallet})
}

// posUnpair revokes the calling PoS phone: Unpair this phone.
func (a *api) posUnpair(w http.ResponseWriter, r *http.Request) {
	if err := a.money.Store.RevokeDevice(r.Context(), deviceauth.DeviceID(r.Context())); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// SaleInvoices is the part of phoenixd a sale needs.
type SaleInvoices interface {
	CreateInvoiceDescribed(ctx context.Context, amountSat int64, description, externalID string, expiry time.Duration) (bolt11, paymentHash string, err error)
	// IncomingPayment is the invoice's own state: whether it is paid.
	IncomingPayment(ctx context.Context, paymentHash string) (phoenixd.Incoming, bool, error)
}

const (
	// saleLifetime is how long a sale's invoice can be paid, as a top-up's.
	saleLifetime = 10 * time.Minute
	// saleDescription is what the payer's wallet shows.
	saleDescription = "Karto PoS"
	maxSaleSat      = 2_000_000 // the top-ups' limit
)

var (
	errTooFast   = errors.New("api: one new sale a second")
	errNoInvoice = errors.New("api: the server can't make an invoice right now")
	// saleIDPattern is a UUID in its usual form: no id can be taken for a
	// word of the routes, as "days" could.
	saleIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// saleGate holds each PoS phone to one new sale per Money.SaleGap. A paired
// phone is trusted beyond that (each sale is a row and a phoenixd invoice);
// the remedy for one that floods is removing it.
type saleGate struct {
	mu   sync.Mutex
	last map[string]time.Time
}

// allow takes the device's turn if its last sale is gap or more ago, and
// returns what the turn replaced, for giveBack.
func (g *saleGate) allow(device string, gap time.Duration, now time.Time) (ok bool, before time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	before = g.last[device]
	if gap > 0 && now.Sub(before) < gap {
		return false, before
	}
	if g.last == nil {
		g.last = map[string]time.Time{}
	}
	g.last[device] = now
	return true, before
}

// giveBack undoes the turn allow took at mine, when no sale came of it
// (phoenixd gave no invoice): an attempt that failed isn't a sale, and its
// retry isn't too fast. Only its own turn: if a later attempt has taken one
// since (this one was slow to fail), that one stands.
func (g *saleGate) giveBack(device string, mine, before time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.last[device].Equal(mine) {
		g.last[device] = before
	}
}

// saleJSON is a sale as the API shows it: its invoice only while it is open,
// and what Shop received for an owner only (a PoS phone sees prices).
func saleJSON(s store.Sale, owner bool) map[string]any {
	j := map[string]any{"id": s.ID, "amountMsat": s.AmountMsat, "state": string(s.State), "method": s.Method(),
		"device": map[string]any{"keyId": s.Device, "name": s.DeviceName}, "created": s.CreatedAt.Unix(), "expires": s.ExpiresAt.Unix()}
	if s.State == store.SaleOpen {
		j["invoice"] = s.Invoice
	}
	if s.PaidAt != nil {
		j["paidAt"] = s.PaidAt.Unix()
	}
	// The books' figures, once the payment is credited (a sale can read paid
	// before that: paidAtPhoenixd): its place in the ledger, which the list's
	// next page is asked before, and what Shop received.
	if s.TxID != 0 {
		j["txId"] = s.TxID
		if owner {
			j["receivedMsat"] = s.ReceivedMsat
		}
	}
	// The price it was rung up at in the server's currency; amountMsat is its sats.
	if s.PriceCurrency != "" {
		j["price"] = priceJSON{Currency: s.PriceCurrency, Minor: s.PriceMinor}
	}
	// Its refund: null for none, so the app tells this cardd from one
	// that has no refunds.
	j["refund"] = saleRefundOut(s)
	return j
}

// saleOut is saleJSON with, for the owner, where a refund would go.
func (a *api) saleOut(ctx context.Context, s store.Sale, owner bool) map[string]any {
	j := saleJSON(s, owner)
	if owner {
		if ra := a.returnAddress(ctx, s.ReturnLink); ra != nil {
			j["returnAddress"] = ra
		}
	}
	return j
}

func (a *api) writeSale(w http.ResponseWriter, r *http.Request, status int, s store.Sale) {
	writeJSON(w, status, map[string]any{"sale": a.saleOut(r.Context(), s, deviceauth.RoleOf(r.Context()) == deviceauth.Owner)})
}

// newSale makes a sale for the calling PoS phone: an invoice of phoenixd's
// for the amount, tied to the sale's id. The amount is typed in sat
// (amountSat) or is a price in the server's currency (price: {currency,
// minor}), which cardd converts at its last rate; exactly one of the two. It is
// never refused for the channel's room: phoenixd takes every payment.
func (a *api) newSale(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID        string     `json:"id"`
		AmountSat int64      `json:"amountSat"`
		Price     *priceJSON `json:"price"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	ctx := r.Context()
	device := deviceauth.DeviceID(ctx)
	if !saleIDPattern.MatchString(req.ID) {
		writeError(w, fmt.Errorf("%w: a sale's id is a UUID", errBadRequest))
		return
	}
	sale := store.Sale{ID: req.ID, Device: device}
	var s store.Sale
	var found bool
	var rate rates.Prices // the rate a priced sale was converted at, read once
	var err error
	if p := req.Price; p == nil {
		if req.AmountSat < 1 || req.AmountSat > maxSaleSat {
			writeError(w, fmt.Errorf("%w: a sale is for 1 to 2,000,000 sat", errBadRequest))
			return
		}
		sale.AmountMsat = req.AmountSat * 1000
		// The same request again finds its sale before anything is asked of phoenixd.
		s, found, err = a.money.Store.SaleAgain(ctx, req.ID, device, sale.AmountMsat)
	} else {
		switch {
		case req.AmountSat != 0:
			err = fmt.Errorf("%w: a sale has an amount in sat or a price, not both", errBadRequest)
		case !rates.Known(p.Currency):
			err = fmt.Errorf("%w: a price's currency is one of USD, EUR, GBP, CAD, CHF, AUD, JPY", errBadRequest)
		case p.Minor < 1 || p.Minor > rates.MaxMinor:
			err = fmt.Errorf("%w: a price is 1 to 10,000,000,000 of its currency's smallest unit", errBadRequest)
		}
		if err == nil {
			// Found again by its price before anything is converted: a retry
			// after the rate moved gets the sats it was first rung up at.
			s, found, err = a.money.Store.SaleAgainPriced(ctx, req.ID, device, p.Currency, p.Minor)
		}
		if err == nil && !found {
			sale.PriceCurrency, sale.PriceMinor = p.Currency, p.Minor
			sale.AmountMsat, rate, err = a.money.priced(ctx, *p)
		}
	}
	if err != nil {
		writeError(w, err)
		return
	}
	if found {
		a.writeSale(w, r, http.StatusOK, s)
		return
	}
	if a.money.Invoices == nil {
		writeError(w, errNoInvoice)
		return
	}
	turn := time.Now()
	ok, before := a.tills.allow(device, a.money.SaleGap, turn)
	if !ok {
		writeError(w, errTooFast)
		return
	}
	bolt11, hash, err := a.money.Invoices.CreateInvoiceDescribed(ctx, sale.AmountMsat/1000, saleDescription, "sale:"+req.ID, saleLifetime)
	if err != nil {
		a.tills.giveBack(device, turn, before)
		a.money.logf("api: sale %s: %v", req.ID, err)
		writeError(w, errNoInvoice)
		return
	}
	sale.PaymentHash, sale.Invoice, sale.ExpiresAt = hash, bolt11, time.Now().Add(saleLifetime)
	s, err = a.money.Store.NewSale(ctx, sale)
	if err != nil {
		a.tills.giveBack(device, turn, before)
		writeError(w, err)
		return
	}
	if p := req.Price; p != nil {
		a.money.logf("api: sale %s priced %s = %s sat at %s a bitcoin, %s", req.ID, rates.MinorText(p.Minor, p.Currency),
			rates.Thousands(sale.AmountMsat/1000), rates.Symbol(p.Currency)+rates.Thousands(rate.Per[p.Currency]), rates.Words(rate))
	}
	a.writeSale(w, r, http.StatusCreated, s)
}

// saleID reads the sale's id from the path: a UUID's shape, or 400, before
// it reaches the store or a log.
func saleID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if !saleIDPattern.MatchString(id) {
		writeError(w, fmt.Errorf("%w: a sale's id is a UUID", errBadRequest))
		return "", false
	}
	return id, true
}

func (a *api) sale(w http.ResponseWriter, r *http.Request) {
	id, ok := saleID(w, r)
	if !ok {
		return
	}
	wait, ok := time.Duration(0), true
	if r.URL.Query().Has("wait") {
		wait, ok = heldWait(r.URL.Query().Get("wait"))
	}
	if !ok {
		writeError(w, fmt.Errorf("%w: wait is whole seconds, 0 or more", errBadRequest))
		return
	}
	ctx := r.Context()
	s, err := a.money.Store.SaleByID(ctx, id)
	if err != nil {
		writeError(w, err)
		return
	}
	// Listening before the first look: a ring between the two isn't lost.
	heard, stop := a.money.Bell.listen(paidKey(s.PaymentHash))
	defer stop()
	s = a.paidAtPhoenixd(ctx, s)
	gone, err := a.money.hold(ctx, wait, heard, s.State == store.SalePaid, func() (bool, error) {
		var err error
		if s, err = a.money.Store.SaleByID(ctx, id); err != nil {
			return false, err
		}
		s = a.paidAtPhoenixd(ctx, s)
		return s.State == store.SalePaid, nil
	})
	if gone {
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	a.writeSale(w, r, http.StatusOK, s)
}

const (
	// maxHeldWait is the longest a read is held: under the server's 30 s
	// write timeout, with room for the answer.
	maxHeldWait = 20 * time.Second
	// heldRecheck is how often a held read looks again: what a ring that
	// never came costs.
	heldRecheck = time.Second
)

// heldWait reads a read's wait: whole seconds, none below 0, and no more
// than maxHeldWait however much was asked.
func heldWait(q string) (time.Duration, bool) {
	n, err := strconv.Atoi(q)
	if err != nil || n < 0 {
		return 0, false
	}
	return min(time.Duration(n)*time.Second, maxHeldWait), true
}

// hold keeps a read waiting for what it asks about: until look says it is
// there (done: it already is), or the wait is over. It looks when the bell
// is heard, every time it is (a ring may bring nothing new: a payment given
// back rings an account's reads too, and the one that goes through rings
// after it), and each HeldRecheck besides. gone: whoever asked has left, and
// there is no one to answer.
func (m *Money) hold(ctx context.Context, wait time.Duration, heard <-chan struct{}, done bool, look func() (bool, error)) (gone bool, err error) {
	if wait <= 0 || done {
		return false, nil
	}
	recheck := m.HeldRecheck
	if recheck <= 0 {
		recheck = heldRecheck
	}
	over, again := time.NewTimer(wait), time.NewTicker(recheck)
	defer over.Stop()
	defer again.Stop()
	for {
		select {
		case <-ctx.Done():
			return true, nil
		case <-over.C:
			return false, nil
		case <-heard:
		case <-again.C:
		}
		if done, err := look(); done || err != nil {
			return false, err
		}
	}
}

// Bell tells held reads that what they wait for has happened: a sale's
// payment has arrived (phoenixd's webhook, on its way to the books), or the
// books have changed (the store, as a transaction commits: an account's
// reads, and those of the books as a whole). It counts the changes to the
// books, and the count is told as a rev, by which a held Wallet read knows
// whether it has anything new to say. A nil bell rings nothing, counts
// nothing and no read hears one: such a read finds out at its next look.
type Bell struct {
	mu      sync.Mutex
	waiting map[string]map[chan struct{}]bool // by what is waited for: paidKey, movedKey, anyKey
	boot    string                            // this start's own 8 hex characters
	changes atomic.Uint64
}

func NewBell() *Bell {
	boot := make([]byte, 4)
	rand.Read(boot)
	return &Bell{waiting: map[string]map[chan struct{}]bool{}, boot: hex.EncodeToString(boot)}
}

// anyKey is what a read of the books as a whole listens for.
const anyKey = "any"

func paidKey(paymentHash string) string  { return "paid:" + paymentHash }
func movedKey(acct store.Account) string { return "acct:" + string(acct) }

// Paid tells the held reads of the sale with this payment hash.
func (b *Bell) Paid(paymentHash string) { b.ring(paidKey(paymentHash)) }

// Changed is what store.Store's Changed is set to: the books of these
// accounts have changed. It counts the change, then tells the held reads of
// each account's history and those of the books as a whole. It only rings:
// the store calls it under its caller's locks.
func (b *Bell) Changed(accounts []store.Account) {
	if b == nil {
		return
	}
	b.changes.Add(1)
	for _, acct := range accounts {
		b.ring(movedKey(acct))
	}
	b.ring(anyKey)
}

// Rev says how many times the books have changed since this start, as the
// app is told it and gives it back: "<boot>-<n>" (revShape). It moves with a
// change to the books, the server's currency or the wallet's name, and a
// restart's revs are all new, so a read asking with an old one is answered at once. "" for no bell.
func (b *Bell) Rev() string {
	if b == nil {
		return ""
	}
	return b.boot + "-" + strconv.FormatUint(b.changes.Load(), 10)
}

// ring tells every read listening for key, once each.
func (b *Bell) ring(key string) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.waiting[key] {
		select {
		case ch <- struct{}{}:
		default: // told already
		}
	}
}

// listen is told of a ring for key until stop, which a listener always calls.
func (b *Bell) listen(key string) (heard <-chan struct{}, stop func()) {
	if b == nil {
		return nil, func() {}
	}
	ch := make(chan struct{}, 1)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.waiting[key] == nil {
		b.waiting[key] = map[chan struct{}]bool{}
	}
	b.waiting[key][ch] = true
	return ch, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		delete(b.waiting[key], ch)
		if len(b.waiting[key]) == 0 {
			delete(b.waiting, key)
		}
	}
}

// paidAtPhoenixd is a sale read with its invoice's own state: one the books
// don't show as paid reads paid once phoenixd says the invoice is, by its
// payment hash, at phoenixd's time for it. The customer has paid from that
// moment, and a till asking each second shouldn't wait for the books, whose
// credit may take seconds to work out what the payment brought in (the fee
// credit's wait) and runs one at a time. The books' figures follow with the
// credit. phoenixd not answering leaves the books' answer.
func (a *api) paidAtPhoenixd(ctx context.Context, s store.Sale) store.Sale {
	if s.State == store.SalePaid || a.money.Invoices == nil {
		return s
	}
	p, found, err := a.money.Invoices.IncomingPayment(ctx, s.PaymentHash)
	if err != nil || !found || !p.IsPaid {
		return s
	}
	at := time.UnixMilli(p.CompletedAt)
	s.State, s.PaidAt = store.SalePaid, &at
	return s
}

// saleStep is a change only the sale's own phone makes: card, cancel.
func (a *api) saleStep(w http.ResponseWriter, r *http.Request, step func(ctx context.Context, id, device string) (store.Sale, error)) {
	id, ok := saleID(w, r)
	if !ok {
		return
	}
	s, err := step(r.Context(), id, deviceauth.DeviceID(r.Context()))
	if err != nil {
		writeError(w, err)
		return
	}
	a.writeSale(w, r, http.StatusOK, s)
}

// salesOf is whose sales a device lists: a PoS phone its own (a till's
// history is the payments it took), the owner every phone's.
func salesOf(r *http.Request) string {
	if deviceauth.RoleOf(r.Context()) == deviceauth.Owner {
		return ""
	}
	return deviceauth.DeviceID(r.Context())
}

// paidSales lists the paid sales, newest first: to a PoS phone the ones it
// took, a till's record of the day without Shop's balance; to the owner every
// phone's, with what Shop received.
func (a *api) paidSales(w http.ResponseWriter, r *http.Request) {
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	list, err := a.money.Store.PaidSales(r.Context(), salesOf(r), before, limit)
	if err != nil {
		writeError(w, err)
		return
	}
	owner := deviceauth.RoleOf(r.Context()) == deviceauth.Owner
	out := []map[string]any{}
	for _, s := range list {
		out = append(out, a.saleOut(r.Context(), s, owner))
	}
	writeJSON(w, http.StatusOK, map[string]any{"sales": out})
}

// saleDays counts the paid sales by the asking phone's local day: offset is
// its minutes east of UTC now. A PoS phone counts the ones it took, the owner
// every phone's.
func (a *api) saleDays(w http.ResponseWriter, r *http.Request) {
	offset, err := strconv.Atoi(r.URL.Query().Get("offset"))
	if err != nil || offset < -840 || offset > 840 {
		writeError(w, fmt.Errorf("%w: offset is the phone's minutes east of UTC, -840 to 840", errBadRequest))
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 90 {
		limit = 30
	}
	days, err := a.money.Store.SaleDays(r.Context(), salesOf(r), offset, limit)
	if err != nil {
		writeError(w, err)
		return
	}
	out := []map[string]any{}
	for _, d := range days {
		out = append(out, map[string]any{"day": d.Day, "count": d.Count, "totalMsat": d.TotalMsat})
	}
	writeJSON(w, http.StatusOK, map[string]any{"days": out})
}
