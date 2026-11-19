// Package alerts tells the owner's phones, with the app closed, of money
// received, a card spent and a card's tap refused: it builds what happened as a
// small JSON payload, folds a card's refusals, encrypts it for
// each owner phone's Web Push endpoint and sends it. The phone
// composes the words.
package alerts

import (
	"context"
	"errors"
	"math/big"
	"time"

	"github.com/boltcard/karto/server/internal/rates"
	"github.com/boltcard/karto/server/internal/store"
)

// Urgency is RFC 8030's Urgency header: high for spends and refusals,
// normal for money in.
type Urgency string

const (
	UrgencyHigh   Urgency = "high"
	UrgencyNormal Urgency = "normal"
)

// RefusalReason is why a card's tap was refused: the same strings as
// lnurl.RefusalReason, which this package doesn't import.
type RefusalReason string

const (
	RefusedPaused   RefusalReason = "paused"   // spending is paused on the server
	RefusedOff      RefusalReason = "off"      // the card is frozen, reset, not active or needs its owner's check after a restore
	RefusedRepeated RefusalReason = "repeated" // a counter already used, other than a terminal's retry
	RefusedPerTap   RefusalReason = "per-tap"  // over the card's limit per payment ("per-payment limit" in the words)
	RefusedDaily    RefusalReason = "daily"    // over the card's 24-hour limit
	RefusedFunds    RefusalReason = "funds"    // not enough money on the card
	RefusedInvoice  RefusalReason = "invoice"  // the terminal's invoice can't be paid
)

// Refusal is one refused tap of a known card, as lnurl.Refusal. AmountMsat
// is the invoice's, 0 when the refusal came before one was read.
type Refusal struct {
	CardID     string
	Reason     RefusalReason
	AmountMsat int64
	At         time.Time
}

// Fiat is an alert's amount in the server's currency, in its minor units.
// Priced: a sale's own price, rung up in the currency, not today's rate.
type Fiat struct {
	Currency string `json:"currency"`
	Minor    int64  `json:"minor"`
	Priced   bool   `json:"priced"`
}

// Payload is what an alert carries, version 1. Account is
// "card:<id>", "pool", "hosting" or "shop" ("" for a test); Name is the
// card's or the till's (at most maxName runes), "" for none. Sat is Msat in
// whole sats, to the nearest. Reason and Count are a refusal's (Count is
// also hosting's whole days of funding, and 0 for any other kind), Tx the
// ledger transaction's id, Card the card's id. Tag, a refusal's (and
// hosting's "hosting-low"), is the phone's notification tag: one per card's 60 s
// window ("refused-<card>-<window start>"), so its refusals update one
// notification, and one per hour's summary ("refused-<card>-hour-<hour
// end>"). Update marks a later count of a window's notification: the phone
// updates it silently.
type Payload struct {
	V       int            `json:"v"`
	Kind    string         `json:"kind"` // received, spent, refused, test or hosting
	Account string         `json:"account"`
	Name    string         `json:"name"`
	Sat     int64          `json:"sat"`
	Msat    int64          `json:"msat"`
	Fiat    *Fiat          `json:"fiat"`
	Reason  *RefusalReason `json:"reason"`
	Count   int            `json:"count"`
	Tx      *int64         `json:"tx"`
	Card    *string        `json:"card"`
	At      int64          `json:"at"`
	Tag     string         `json:"tag,omitempty"`
	Update  bool           `json:"update,omitempty"`
}

// maxName is the most runes of a card's or till's name an alert carries.
const maxName = 64

func capName(s string) string {
	if r := []rune(s); len(r) > maxName {
		return string(r[:maxName])
	}
	return s
}

const (
	// staleAfter: a transaction older than this when the sender reads it is
	// not alerted (the reconcile pass settles old spends).
	staleAfter = 5 * time.Minute
	// rateFresh: an alert gives the currency only with a rate younger than
	// this.
	rateFresh = 15 * time.Minute
)

// Reader is the slice of the store an alert is built from.
type Reader interface {
	PostedLine(ctx context.Context, id int64) (store.Line, store.Account, error)
	GetCard(ctx context.Context, id string) (store.Card, error)
	Currency(ctx context.Context) (code string, set bool, err error)
}

// Source is where Build reads a transaction and the rate: Prices is cardd's
// last rate (rates.Source.Last), false with none.
type Source struct {
	Store  Reader
	Prices func() (rates.Prices, bool)
}

// Build is the alert for a committed ledger transaction, and its urgency.
// False for a kind that stays quiet (send, move, wipe,
// fee-adjust, adjust, renew), for a transaction
// more than 5 minutes old at now, and for one with no leg to show.
func Build(ctx context.Context, src Source, txID int64, now time.Time) (Payload, Urgency, bool, error) {
	l, acct, err := src.Store.PostedLine(ctx, txID)
	if errors.Is(err, store.ErrNotFound) {
		return Payload{}, "", false, nil
	}
	if err != nil {
		return Payload{}, "", false, err
	}
	if now.Sub(l.CreatedAt) > staleAfter {
		return Payload{}, "", false, nil
	}
	cardID, isCard := acct.CardID()
	var kind string
	urg := UrgencyNormal
	switch {
	case l.Kind == store.KindTopup && (isCard || acct == store.Pool || acct == store.Hosting):
		kind = "received"
	case l.Kind == store.KindSale && acct == store.Shop:
		kind = "received"
	case l.Kind == store.KindSpend && isCard:
		kind, urg = "spent", UrgencyHigh
	default:
		return Payload{}, "", false, nil
	}
	msat := abs(l.AmountMsat)
	if kind == "spent" {
		// The payment without its routing fee, as the app's pages show a spend
		// (app/src/money/format.ts lineAmount): the
		// card's leg is the payment and the fee, the fees leg the fee.
		msat = abs(l.AmountMsat + l.FeeMsat)
	}
	tx := l.ID
	p := Payload{V: 1, Kind: kind, Account: string(acct), Sat: satOf(msat), Msat: msat, Tx: &tx, At: l.CreatedAt.Unix()}
	if isCard {
		p.Card = &cardID
		card, err := src.Store.GetCard(ctx, cardID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return Payload{}, "", false, err
		}
		p.Name = capName(card.Name)
	}
	if l.Sale != nil {
		p.Name = capName(l.Sale.Device)
		if l.Sale.PriceCurrency != "" {
			// A sale rung up in a currency shows its own price for good
			// (the fiat design's 3.3).
			p.Fiat = &Fiat{Currency: l.Sale.PriceCurrency, Minor: l.Sale.PriceMinor, Priced: true}
			return p, urg, true, nil
		}
	}
	if p.Fiat, err = fiatOf(ctx, src, msat, now); err != nil {
		return Payload{}, "", false, err
	}
	return p, urg, true, nil
}

// fiatOf is msat in the server's currency at a rate under 15 minutes old;
// nil with no currency, no such rate, or an amount under one minor unit (a
// notification has no room to say "under £0.01").
func fiatOf(ctx context.Context, src Source, msat int64, now time.Time) (*Fiat, error) {
	code, set, err := src.Store.Currency(ctx)
	if err != nil || !set || src.Prices == nil {
		return nil, err
	}
	prices, ok := src.Prices()
	if !ok || now.Sub(time.Unix(prices.Time, 0)) >= rateFresh {
		return nil, nil
	}
	minor := minorOf(msat, prices.Per[code], code)
	if minor < 1 {
		return nil, nil
	}
	return &Fiat{Currency: code, Minor: minor}, nil
}

// minorOf is msat (0 or more) in minor units of a currency at pricePerBTC,
// half up: the phones' fiatMinor (app/src/money/fiat.ts). 0 for a price
// under 1.
func minorOf(msat, pricePerBTC int64, currency string) int64 {
	if pricePerBTC < 1 {
		return 0
	}
	scale := int64(100)
	if rates.Decimals(currency) == 0 {
		scale = 1
	}
	num := new(big.Int).Mul(big.NewInt(msat), big.NewInt(pricePerBTC))
	num.Mul(num, big.NewInt(scale))
	num.Lsh(num, 1)
	den := big.NewInt(100_000_000_000)
	num.Add(num, den)
	num.Quo(num, den.Lsh(den, 1))
	if !num.IsInt64() {
		return 0
	}
	return num.Int64()
}

// refusalPayload is the alert for a card's refusals as taken from its fold;
// name is the card's.
func refusalPayload(t taken, name string) Payload {
	reason, card := t.last.Reason, t.last.CardID
	return Payload{V: 1, Kind: "refused", Account: string(store.CardAccount(card)), Name: capName(name),
		Sat: satOf(t.last.AmountMsat), Msat: t.last.AmountMsat, Reason: &reason, Count: t.count, Card: &card,
		At: t.last.At.Unix(), Tag: t.tag, Update: t.update}
}

// HostingLow is the daily alert while hosting covers fewer than 7 days:
// hosting's available balance and the whole days it pays for (Count).
// Its tag makes each day's replace the last on the phone.
func HostingLow(availableMsat int64, days int, now time.Time) Payload {
	return Payload{V: 1, Kind: "hosting", Account: string(store.Hosting), Sat: satOf(availableMsat), Msat: availableMsat,
		Count: days, At: now.Unix(), Tag: "hosting-low"}
}

// testPayload is the alert Settings' test sends ("Alerts work").
func testPayload(now time.Time) Payload {
	return Payload{V: 1, Kind: "test", At: now.Unix()}
}

// satOf is msat (0 or more) in whole sats, to the nearest.
func satOf(msat int64) int64 { return (msat + 500) / 1000 }

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}
