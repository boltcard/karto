package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/boltcard/karto/server/internal/rates"
	"log"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Migration 9 adds a sale's price in a currency and a card's limits in one: all NULL for
// what cardd wrote before it, so every card and sale reads as it did (a card
// limited in sat, a sale typed in sat).
func TestMigrationNineOnASchemaEightDatabase(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migrations[:8] {
		if _, err := db.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`PRAGMA user_version = 8;
		INSERT INTO devices (key_id, public_key, name, role, created_at) VALUES ('1111111111111111', '04aa', 'Till 1', 'pos', 1);
		INSERT INTO cards (id, version, state, last_counter, name, per_tap_sat, daily_sat, host, created_at, updated_at)
			VALUES ('` + id + `', 1, 'active', 3, 'Daily', 5000, 10000, 'vm-1.lnvps.cloud', 1, 1);
		INSERT INTO sales (id, device, amount_msat, state, payment_hash, invoice, created_at, expires_at)
			VALUES ('` + saleA + `', '1111111111111111', 2500000, 'open', 'hash-a', 'lnbc-a', 1, 9999999999)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, _ := s.UserVersion(ctx); v != SchemaVersion() {
		t.Fatalf("user_version %d, want %d", v, SchemaVersion())
	}
	c, err := s.GetCard(ctx, id)
	if err != nil || c.Name != "Daily" || c.PerTapSat != 5000 || c.DailySat != 10000 || c.Host != "vm-1.lnvps.cloud" {
		t.Fatalf("the card: %+v %v", c, err)
	}
	var currency sql.NullString
	var perTap, daily sql.NullInt64
	if err := s.db.QueryRow(`SELECT limit_currency, per_tap_minor, daily_minor FROM cards WHERE id = ?`, id).Scan(&currency, &perTap, &daily); err != nil {
		t.Fatal(err)
	}
	if currency.Valid || perTap.Valid || daily.Valid {
		t.Fatalf("the card's limits in a currency: %v %v %v, want NULL", currency, perTap, daily)
	}
	sale, err := s.SaleByID(ctx, saleA)
	if err != nil || sale.AmountMsat != 2_500_000 || sale.State != SaleOpen || sale.DeviceName != "Till 1" {
		t.Fatalf("the sale: %+v %v", sale, err)
	}
	var priceCurrency sql.NullString
	var priceMinor sql.NullInt64
	if err := s.db.QueryRow(`SELECT price_currency, price_minor FROM sales WHERE id = ?`, saleA).Scan(&priceCurrency, &priceMinor); err != nil {
		t.Fatal(err)
	}
	if priceCurrency.Valid || priceMinor.Valid {
		t.Fatalf("the sale's price: %v %v, want NULL", priceCurrency, priceMinor)
	}
}

// The server's currency is meta's "currency": absent until the
// wallet first sets it, then "none" or one of mempool.space's seven.
func TestTheServersCurrencyIsKeptInMeta(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if code, set, err := s.Currency(ctx); err != nil || set || code != "" {
		t.Fatalf("never set: %q %v %v", code, set, err)
	}
	for _, c := range []string{"GBP", "JPY", "none"} {
		if err := s.SetCurrency(ctx, c); err != nil {
			t.Fatalf("set %s: %v", c, err)
		}
		if code, set, err := s.Currency(ctx); err != nil || !set || code != c {
			t.Fatalf("after %s: %q %v %v", c, code, set, err)
		}
	}
	for _, bad := range []string{"", "gbp", "XYZ", "None", "BTC"} {
		if err := s.SetCurrency(ctx, bad); !errors.Is(err, ErrBadCurrency) {
			t.Fatalf("set %q: %v, want ErrBadCurrency", bad, err)
		}
	}
	if v, err := s.GetMeta(ctx, "currency"); err != nil || v != "none" {
		t.Fatalf("meta's currency %q %v, want none", v, err)
	}
}

// A card's limits in a currency are kept in it, and a tap checks
// them at the last rate, inside its transaction: converted, rounded down to
// the msat and capped at 2,000,000 sat. A limit keeps its own currency
// whatever the server's; with no rate, a tap is refused as over the limit.
// Sat limits again clear the currency.
func TestLimitsInACurrencyAtATap(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	const id2, id3 = "00000000000000000000000000000002", "00000000000000000000000000000003"
	card, card2, card3 := activeCard(t, s, id), activeCard(t, s, id2), activeCard(t, s, id3)
	for i, c := range []Account{card, card2, card3} {
		if _, err := s.Credit(ctx, c, 3_000_000_000, fmt.Sprint("credit-", i), ""); err != nil {
			t.Fatal(err)
		}
	}
	price := map[string]int64{"GBP": 61352, "EUR": 72070}
	s.Rate = func() (rates.Prices, bool) { return rates.Prices{Per: price}, true }
	n := 0
	hold := func(acct Account, msat int64) (Hold, error) {
		n++
		return s.OpenHold(ctx, HoldRequest{Account: acct, Kind: KindSpend, AmountMsat: msat, PaymentHash: fmt.Sprint("tap-", n), Invoice: "lnbc"})
	}
	// tap is a tap that is given back: it counts toward nothing.
	tap := func(acct Account, msat int64) error {
		h, err := hold(acct, msat)
		if err == nil {
			s.ReleaseHold(ctx, h.ID)
		}
		return err
	}
	c, err := s.SetLimitsMinor(ctx, id, "GBP", 500, 2000) // £5 a tap, £20 a day
	if err != nil || c.LimitCurrency != "GBP" || c.PerTapMinor != 500 || c.DailyMinor != 2000 || c.PerTapSat != 20000 || c.DailySat != 50000 {
		t.Fatalf("set: %+v %v", c, err)
	}
	if perTap, daily, ok := s.LimitsMsat(c); !ok || perTap != 8_150_000 || daily != 32_599_000 {
		t.Fatalf("at £61,352: %d %d %v", perTap, daily, ok)
	}
	if err := tap(card, 8_150_001); !errors.Is(err, ErrOverPerTap) {
		t.Fatalf("a msat over £5: %v", err)
	}
	if err := tap(card, 8_150_000); err != nil {
		t.Fatalf("£5: %v", err)
	}
	// The rate halves: £5 is twice the sats, and £20 a day comes to 65,198,000 msat, four of them.
	price["GBP"] = 30676
	if err := tap(card, 16_299_001); !errors.Is(err, ErrOverPerTap) {
		t.Fatalf("a msat over £5 at £30,676: %v", err)
	}
	for i := 0; i < 4; i++ {
		h, err := hold(card, 16_299_000)
		if err != nil {
			t.Fatalf("£5 #%d at £30,676: %v", i, err)
		}
		if _, err := s.SettleHold(ctx, h.ID, 0); err != nil {
			t.Fatal(err)
		}
	}
	if err := tap(card, 16_299_000); !errors.Is(err, ErrOverDaily) {
		t.Fatalf("a fifth £5 in 24 hours: %v", err)
	}
	// A limit in EUR on a server whose currency is GBP converts at EUR's price.
	if err := s.SetCurrency(ctx, "GBP"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetLimitsMinor(ctx, id2, "EUR", 500, 2000); err != nil {
		t.Fatal(err)
	}
	if err := tap(card2, 6_938_001); !errors.Is(err, ErrOverPerTap) {
		t.Fatalf("a msat over €5: %v", err)
	}
	if err := tap(card2, 6_938_000); err != nil {
		t.Fatalf("€5: %v", err)
	}
	// £2,000 a tap is over 2,000,000 sat at £61,352: a tap is held to 2,000,000 sat.
	price["GBP"] = 61352
	c3, err := s.SetLimitsMinor(ctx, id3, "GBP", 200_000, 200_000)
	if err != nil {
		t.Fatal(err)
	}
	if perTap, daily, ok := s.LimitsMsat(c3); !ok || perTap != 2_000_000_000 || daily != 2_000_000_000 {
		t.Fatalf("capped: %d %d %v", perTap, daily, ok)
	}
	if err := tap(card3, 2_000_000_001); !errors.Is(err, ErrOverPerTap) {
		t.Fatalf("over the cap: %v", err)
	}
	if err := tap(card3, 2_000_000_000); err != nil {
		t.Fatalf("at the cap: %v", err)
	}
	// No rate (a rebuilt server before its first fetch): refused as over the limit, whatever the amount.
	s.Rate = func() (rates.Prices, bool) { return rates.Prices{}, false }
	if err := tap(card2, 1); !errors.Is(err, ErrOverPerTap) {
		t.Fatalf("no rate: %v", err)
	}
	s.Rate = nil
	if err := tap(card2, 1); !errors.Is(err, ErrOverPerTap) {
		t.Fatalf("no rate hook: %v", err)
	}
	c2, _ := s.GetCard(ctx, id2)
	if _, _, ok := s.LimitsMsat(c2); ok {
		t.Fatal("limits in EUR with no rate read as known")
	}
	// Sat limits again: the currency columns are cleared, and the sats apply.
	c2, err = s.SetLimits(ctx, id2, 1000, 2000)
	if err != nil || c2.LimitCurrency != "" || c2.PerTapMinor != 0 || c2.DailyMinor != 0 {
		t.Fatalf("sat limits again: %+v %v", c2, err)
	}
	var cleared bool
	if err := s.db.QueryRow(`SELECT limit_currency IS NULL AND per_tap_minor IS NULL AND daily_minor IS NULL FROM cards WHERE id = ?`, id2).Scan(&cleared); err != nil || !cleared {
		t.Fatalf("the columns after sat limits: %v %v", cleared, err)
	}
	if err := tap(card2, 1_000_001); !errors.Is(err, ErrOverPerTap) {
		t.Fatalf("over 1,000 sat: %v", err)
	}
	if err := tap(card2, 1_000_000); err != nil {
		t.Fatalf("1,000 sat with no rate: %v", err)
	}
}

// A sale is the price in sat rounded half up (rates.SatForMinor) and a limit
// in a currency is converted the same way, so a sale at a limit always fits
// it: £5.00 is 8,150 sat at £61,352, as a sale and as a £5 limit; four of
// them fit £20 a day, though 4 x 8,150 sat is 1,000 msat over the day's
// 32,599 sat, which the 24-hour check allows for (500 msat a spend).
func TestASaleAtACurrencyLimitFitsIt(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	const idJPY = "00000000000000000000000000000004"
	card, cardJPY := activeCard(t, s, id), activeCard(t, s, idJPY)
	for i, c := range []Account{card, cardJPY} {
		if _, err := s.Credit(ctx, c, 3_000_000_000, fmt.Sprint("credit-", i), ""); err != nil {
			t.Fatal(err)
		}
	}
	prices := map[string]int64{"GBP": 61352, "JPY": 12780023}
	s.Rate = func() (rates.Prices, bool) { return rates.Prices{Per: prices}, true }
	n := 0
	hold := func(acct Account, msat int64) (Hold, error) {
		n++
		return s.OpenHold(ctx, HoldRequest{Account: acct, Kind: KindSpend, AmountMsat: msat, PaymentHash: fmt.Sprint("sale-", n), Invoice: "lnbc"})
	}
	sale := rates.SatForMinor(500, 61352, "GBP") * 1000
	if sale != 8_150_000 {
		t.Fatalf("a £5.00 sale: %d msat", sale)
	}
	if _, err := s.SetLimitsMinor(ctx, id, "GBP", 500, 2000); err != nil {
		t.Fatal(err)
	}
	if h, err := hold(card, sale+1); !errors.Is(err, ErrOverPerTap) {
		t.Fatalf("1 msat over a £5.00 sale: %v %v", h, err)
	}
	for i := 0; i < 4; i++ {
		h, err := hold(card, sale)
		if err != nil {
			t.Fatalf("£5.00 sale #%d: %v", i+1, err)
		}
		if _, err := s.SettleHold(ctx, h.ID, 0); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := hold(card, sale); !errors.Is(err, ErrOverDaily) {
		t.Fatalf("a fifth £5.00 sale: %v", err)
	}
	// A card limited in sat keeps its exact day: no allowance.
	if _, err := s.SetLimits(ctx, id, 8150, 32600); err != nil {
		t.Fatal(err)
	}
	if _, err := hold(card, 1); !errors.Is(err, ErrOverDaily) {
		t.Fatalf("a sat-limited card past its day: %v", err)
	}
	// ¥480 at ¥12,780,023 is 3,756 sat (JPY has no decimals).
	if _, err := s.SetLimitsMinor(ctx, idJPY, "JPY", 480, 480); err != nil {
		t.Fatal(err)
	}
	if got := rates.SatForMinor(480, 12780023, "JPY"); got != 3756 {
		t.Fatalf("¥480: %d sat", got)
	}
	if _, err := hold(cardJPY, 3_756_001); !errors.Is(err, ErrOverPerTap) {
		t.Fatalf("1 msat over ¥480: %v", err)
	}
	if _, err := hold(cardJPY, 3_756_000); err != nil {
		t.Fatalf("¥480: %v", err)
	}
}

// The 24-hour allowance for rounding is for a sale at a limit, not a way to
// stretch it: it stops growing after 10 spends, so 1-sat taps on a card
// limited in a currency pass the converted day by at most 5 sat.
func TestTinySpendsCannotStretchACurrencyDay(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	if _, err := s.Credit(ctx, card, 3_000_000_000, "credit", ""); err != nil {
		t.Fatal(err)
	}
	s.Rate = func() (rates.Prices, bool) { return rates.Prices{Per: map[string]int64{"GBP": 61352}}, true }
	c, err := s.SetLimitsMinor(ctx, id, "GBP", 10, 10) // £0.10 = 163 sat
	if err != nil {
		t.Fatal(err)
	}
	_, daily, _ := s.LimitsMsat(c)
	if daily != 163_000 {
		t.Fatalf("£0.10: %d msat", daily)
	}
	var spent int64
	for i := 0; ; i++ {
		if i > 1000 {
			t.Fatal("1-sat taps were never refused")
		}
		h, err := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 1000, PaymentHash: fmt.Sprint("tiny-", i), Invoice: "lnbc"})
		if errors.Is(err, ErrOverDaily) {
			break
		}
		if err != nil {
			t.Fatalf("tap %d: %v", i, err)
		}
		if _, err := s.SettleHold(ctx, h.ID, 0); err != nil {
			t.Fatal(err)
		}
		spent += 1000
	}
	if spent != daily+5000 {
		t.Fatalf("spent %d msat of a %d msat day: the allowance is at most 5,000", spent, daily)
	}
}

// A limit near the most a currency limit may be (10^10 minor units) at a price
// of 1 is 10^16 sat: capped at 2,000,000 sat before it becomes msat, never
// overflowing into a negative limit that refuses every tap.
func TestAHugeCurrencyLimitAtATinyPriceIsCapped(t *testing.T) {
	s := &Store{Rate: func() (rates.Prices, bool) { return rates.Prices{Per: map[string]int64{"GBP": 1}}, true }}
	c := Card{LimitCurrency: "GBP", PerTapMinor: 9_999_999_999, DailyMinor: 10_000_000_000}
	if perTap, daily, ok := s.LimitsMsat(c); !ok || perTap != maxLimitMsat || daily != maxLimitMsat {
		t.Fatalf("10^10 pence at £1 a bitcoin: %d %d %v", perTap, daily, ok)
	}
}

// A tap against limits in a currency logs the rate it was checked at and
// where that came from:
// once per hold, refused or not; nothing for LimitsMsat, as GET /wallet
// calls it, nor for a card limited in sat.
func TestATapAgainstCurrencyLimitsLogsTheRate(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	const id2 = "00000000000000000000000000000002"
	card, card2 := activeCard(t, s, id), activeCard(t, s, id2)
	if _, err := s.Credit(ctx, card, 5_000_000, "credit-1", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Credit(ctx, card2, 3_000_000_000, "credit-2", ""); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 17, 7, 22, 51, 0, time.UTC)
	p := rates.Prices{Time: at.Unix(), From: []string{rates.Coinbase, rates.Kraken}, Per: map[string]int64{"GBP": 61352}}
	s.Rate = func() (rates.Prices, bool) { return p, true }
	var buf bytes.Buffer
	s.Log = log.New(&buf, "", 0)
	c, err := s.SetLimitsMinor(ctx, id, "GBP", 500, 5000)
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("store: card %s's limits (£5.00 a tap, £50.00 a day) = %s sat a tap, %s sat a day at £61,352 a bitcoin, %s\n",
		id, rates.Thousands(rates.SatForMinor(500, 61352, "GBP")), rates.Thousands(rates.SatForMinor(5000, 61352, "GBP")), rates.Words(p))
	if !strings.Contains(want, "8,150 sat a tap, 81,497 sat a day") || !strings.Contains(want, "from Coinbase and Kraken at 07:22:51") {
		t.Fatalf("the expected line itself is off: %q", want)
	}
	h, err := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 1_000_000, PaymentHash: "tap-1", Invoice: "lnbc"})
	if err != nil {
		t.Fatal(err)
	}
	s.ReleaseHold(ctx, h.ID)
	if buf.String() != want {
		t.Fatalf("a passing tap logged %q, want %q", buf.String(), want)
	}
	// Refused for want of money: within the limit, the card holds only 5,000 sat.
	buf.Reset()
	if _, err := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 8_000_000, PaymentHash: "tap-2", Invoice: "lnbc"}); err == nil {
		t.Fatal("a tap beyond the balance passed")
	}
	if buf.String() != want {
		t.Fatalf("a refused tap logged %q, want %q", buf.String(), want)
	}
	// Refused for the limit: still one line.
	buf.Reset()
	if _, err := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 9_000_000, PaymentHash: "tap-3", Invoice: "lnbc"}); !errors.Is(err, ErrOverPerTap) {
		t.Fatalf("over the limit: %v", err)
	}
	if buf.String() != want {
		t.Fatalf("an over-limit tap logged %q", buf.String())
	}
	buf.Reset()
	if _, _, ok := s.LimitsMsat(c); !ok {
		t.Fatal("no limits")
	}
	if buf.Len() != 0 {
		t.Fatalf("LimitsMsat logged %q", buf.String())
	}
	if _, err := s.SetLimits(ctx, id2, 5000, 10000); err != nil {
		t.Fatal(err)
	}
	if _, err := s.OpenHold(ctx, HoldRequest{Account: card2, Kind: KindSpend, AmountMsat: 1_000_000, PaymentHash: "tap-4", Invoice: "lnbc"}); err != nil {
		t.Fatal(err)
	}
	if buf.Len() != 0 {
		t.Fatalf("a card limited in sat logged %q", buf.String())
	}
}
