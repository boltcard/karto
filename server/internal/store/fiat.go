package store

import (
	"context"
	"errors"

	"github.com/boltcard/karto/server/internal/rates"
)

// ErrBadCurrency means a server's currency is neither none nor one of
// mempool.space's seven (rates.Currencies).
var ErrBadCurrency = errors.New("store: a currency is none or one of USD, EUR, GBP, CAD, CHF, AUD, JPY")

// Currency is the server's currency,
// meta's "currency": "none" or a code, and set false while the wallet
// has never set one. It is in meta, so in every backup: it changes rarely,
// and a backup is made only when the database changes (the rate, which
// changes every 5 minutes, is kept outside it: internal/rates).
func (s *Store) Currency(ctx context.Context) (code string, set bool, err error) {
	code, err = s.GetMeta(ctx, "currency")
	if errors.Is(err, ErrNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return code, true, nil
}

// SetCurrency sets the server's currency: "none" or one of rates.Currencies.
func (s *Store) SetCurrency(ctx context.Context, code string) error {
	if code != "none" && !rates.Known(code) {
		return ErrBadCurrency
	}
	return s.SetMeta(ctx, "currency", code)
}

// maxLimitMsat is the most a limit in a currency comes to at a tap: the
// 2,000,000 sat that limits in sat may be (cards.SetLimits).
const maxLimitMsat = 2_000_000_000

// LimitsMsat is what a card's limits come to at a tap, in msat: sat limits
// as they are; limits in a currency converted at the Rate hook's price
// (cardd's last rate, the middle of its sources), half up to the whole sat
// as a sale is, so a sale at a limit always fits it, and capped at
// 2,000,000 sat.
// ok is false for limits in a currency with no rate: a tap is then refused.
// It logs nothing: OpenHold logs the rate a tap was checked at.
func (s *Store) LimitsMsat(c Card) (perTapMsat, dailyMsat int64, ok bool) {
	perTapMsat, dailyMsat, _, ok = s.limitsAt(c)
	return
}

// limitsAt is LimitsMsat and the rate it used: p is the whole rate for a
// card with limits in a currency, and zero for one with limits in sat.
func (s *Store) limitsAt(c Card) (perTapMsat, dailyMsat int64, p rates.Prices, ok bool) {
	if c.LimitCurrency == "" {
		return c.PerTapSat * 1000, c.DailySat * 1000, rates.Prices{}, true
	}
	if s.Rate == nil {
		return 0, 0, rates.Prices{}, false
	}
	p, ok = s.Rate()
	price := p.Per[c.LimitCurrency]
	if !ok || price < 1 {
		return 0, 0, rates.Prices{}, false
	}
	// Capped in sat before the msat multiply: a huge limit at a tiny price
	// would overflow int64.
	msat := func(minor int64) int64 {
		return min(rates.SatForMinor(minor, price, c.LimitCurrency), maxLimitMsat/1000) * 1000
	}
	return msat(c.PerTapMinor), msat(c.DailyMinor), p, true
}
