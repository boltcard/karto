package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/boltcard/karto/server/internal/rates"
	"github.com/boltcard/karto/server/internal/store"
)

// fiatJSON is what both apps read of the server's currency: currency null
// until the wallet first sets one, then "none" or a code; price, whole units
// of it a bitcoin, and time, the Unix seconds of that price (when cardd took
// it from its sources), only when the currency is a code and cardd has a
// rate.
type fiatJSON struct {
	Currency *string `json:"currency"`
	Price    int64   `json:"price,omitempty"`
	Time     int64   `json:"time,omitempty"`
}

// fiatRoutes: the wallet sets the server's currency; a till reads it, with
// the rate, under the one prefix a PoS phone may reach (deviceauth.PosPrefix).
func (a *api) fiatRoutes(v1 *http.ServeMux) {
	v1.HandleFunc("PUT /api/v1/currency", a.setCurrency)
	v1.HandleFunc("PUT /api/v1/wallet/name", a.setWalletName)
	v1.HandleFunc("GET /api/v1/pos/fiat", a.posFiat)
}

// price is cardd's last rate, read once, and its price of a bitcoin in
// currency; ok is false with none.
func (m *Money) price(currency string) (p rates.Prices, price int64, ok bool) {
	if m.Prices == nil {
		return rates.Prices{}, 0, false
	}
	p, have := m.Prices()
	if !have || p.Per[currency] < 1 {
		return rates.Prices{}, 0, false
	}
	return p, p.Per[currency], true
}

// fiat is the server's currency and, for a code, cardd's last rate of it.
func (m *Money) fiat(ctx context.Context) (fiatJSON, error) {
	code, set, err := m.Store.Currency(ctx)
	if err != nil || !set {
		return fiatJSON{}, err
	}
	out := fiatJSON{Currency: &code}
	if p, price, ok := m.price(code); ok {
		out.Price, out.Time = price, p.Time
	}
	return out, nil
}

// setCurrency sets the server's currency (the wallet's Settings,
// or its region's on a server that never had one). A held Wallet read is
// released only when the bell's rev moves: Changed(nil) counts a change and
// rings, so every wallet phone hears of it at once.
func (a *api) setCurrency(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Currency string `json:"currency"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if err := a.money.Store.SetCurrency(r.Context(), req.Currency); err != nil {
		writeError(w, err)
		return
	}
	a.money.Bell.Changed(nil)
	f, err := a.money.fiat(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"fiat": f})
}

// posFiat is the server's currency and rate for a till (both roles may
// read it): asked when the till opens and every 5 minutes while it is in
// front, never on the way to a charge (7).
func (a *api) posFiat(w http.ResponseWriter, r *http.Request) {
	f, err := a.money.fiat(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"fiat": f})
}

// priceJSON is a price in a currency's minor units: a till's sale,
// and a sale's own JSON once it has one.
type priceJSON struct {
	Currency string `json:"currency"`
	Minor    int64  `json:"minor"`
}

// errWrongCurrency: a till's price is in a currency that isn't the server's
// (it changed since the till read it).
var errWrongCurrency = errors.New("api: the till's currency isn't the server's")

// saidError is a refusal in the phone's own words: its message is the
// sentence alone, and errors.Is finds its kind, by which errorCodes answers it.
type saidError struct {
	kind     error
	sentence string
}

func (e saidError) Error() string        { return e.sentence }
func (e saidError) Is(target error) bool { return target == e.kind }

func said(kind error, sentence string) error { return saidError{kind, sentence} }

// priced is a till's price as a sale's msat: the price must be in
// the server's currency (wrong_currency otherwise) and cardd must have a rate
// for it (no_rate); its sats, rounded half up, are 1 to 2,000,000, as a sale
// typed in sat. Only arithmetic on a rate in memory: nothing on a charge's
// way waits for a rate source. The rate it used comes back, read
// once, so the caller logs the one the sats came from.
func (m *Money) priced(ctx context.Context, p priceJSON) (msat int64, rate rates.Prices, err error) {
	code, _, err := m.Store.Currency(ctx)
	if err != nil {
		return 0, rates.Prices{}, err
	}
	if code != p.Currency {
		return 0, rates.Prices{}, said(errWrongCurrency, "The shop's currency changed: start the sale again.")
	}
	rate, price, ok := m.price(p.Currency)
	if !ok {
		return 0, rates.Prices{}, rates.NoRate(p.Currency, "type the price in sat.")
	}
	sat := rates.SatForMinor(p.Minor, price, p.Currency)
	switch {
	case sat < 1:
		return 0, rates.Prices{}, said(errBadRequest, fmt.Sprintf("A sale is at least 1 sat: %s is under it at today's rate.", rates.MinorText(p.Minor, p.Currency)))
	case sat > maxSaleSat:
		return 0, rates.Prices{}, said(errBadRequest, fmt.Sprintf("Over the 2,000,000 sat a sale can be (%s).",
			rates.MinorText(rates.MinorForSat(maxSaleSat, price, p.Currency), p.Currency)))
	}
	return sat * 1000, rate, nil
}

// limitsJSON is a card's limits in a currency, as kept.
type limitsJSON struct {
	Currency    string `json:"currency"`
	PerTapMinor int64  `json:"perTapMinor"`
	DailyMinor  int64  `json:"dailyMinor"`
}

// limitsOf is a card's limits in a currency, or nil for limits in sat.
func limitsOf(c store.Card) *limitsJSON {
	if c.LimitCurrency == "" {
		return nil
	}
	return &limitsJSON{Currency: c.LimitCurrency, PerTapMinor: c.PerTapMinor, DailyMinor: c.DailyMinor}
}
