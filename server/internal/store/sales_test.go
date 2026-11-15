package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

const (
	till1 = "1111111111111111"
	till2 = "2222222222222222"
	saleA = "0a000000-0000-4000-8000-00000000000a"
	saleB = "0b000000-0000-4000-8000-00000000000b"
	saleC = "0c000000-0000-4000-8000-00000000000c"
)

// tills opens a store with a clock and two PoS phones.
func tills(t *testing.T) (*Store, *time.Time) {
	t.Helper()
	ctx := context.Background()
	s := open(t)
	now := clock(s)
	for id, name := range map[string]string{till1: "Till 1", till2: "Till 2"} {
		if err := s.AddDevice(ctx, Device{KeyID: id, PublicKey: "04" + id, Name: name, Role: RolePos}); err != nil {
			t.Fatal(err)
		}
	}
	return s, now
}

// sale makes an open sale of msat by device, good for 10 minutes.
func sale(t *testing.T, s *Store, id, device string, msat int64) Sale {
	t.Helper()
	out, err := s.NewSale(context.Background(), Sale{ID: id, Device: device, AmountMsat: msat, PaymentHash: "hash-" + id, Invoice: "lnbc-" + id,
		ExpiresAt: s.now().Add(10 * time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// A sale is made once per id: the same request again finds
// it, and the id can't be taken for another phone's sale or another amount.
func TestASaleIsMadeOncePerID(t *testing.T) {
	ctx := context.Background()
	s, now := tills(t)
	if _, found, err := s.SaleAgain(ctx, saleA, till1, 2_500_000); err != nil || found {
		t.Fatalf("before it is made: %v %v", found, err)
	}
	made := sale(t, s, saleA, till1, 2_500_000)
	if made.State != SaleOpen || made.DeviceName != "Till 1" || made.AmountMsat != 2_500_000 || made.Invoice != "lnbc-"+saleA ||
		!made.CreatedAt.Equal(*now) || !made.ExpiresAt.Equal(now.Add(10*time.Minute)) || made.CardAt != nil || made.PaidAt != nil || made.Method() != "" {
		t.Fatalf("made %+v", made)
	}
	again, found, err := s.SaleAgain(ctx, saleA, till1, 2_500_000)
	if err != nil || !found || again.Invoice != made.Invoice || again.State != SaleOpen {
		t.Fatalf("the same request again: %+v %v %v", again, found, err)
	}
	if _, _, err := s.SaleAgain(ctx, saleA, till2, 2_500_000); !errors.Is(err, ErrSaleExists) {
		t.Fatalf("the id from another phone: got %v, want ErrSaleExists", err)
	}
	if _, _, err := s.SaleAgain(ctx, saleA, till1, 2_500_001); !errors.Is(err, ErrSaleExists) {
		t.Fatalf("the id for another amount: got %v, want ErrSaleExists", err)
	}
	// Two requests with one id that both got as far as an invoice: the second insert is the first's sale.
	second, err := s.NewSale(ctx, Sale{ID: saleA, Device: till1, AmountMsat: 2_500_000, PaymentHash: "hash-2", Invoice: "lnbc-2", ExpiresAt: now.Add(time.Hour)})
	if err != nil || second.Invoice != made.Invoice {
		t.Fatalf("a second insert of the id: %+v %v", second, err)
	}
	if _, err := s.NewSale(ctx, Sale{ID: saleA, Device: till2, AmountMsat: 2_500_000, PaymentHash: "hash-3", Invoice: "lnbc-3", ExpiresAt: now.Add(time.Hour)}); !errors.Is(err, ErrSaleExists) {
		t.Fatalf("a second insert from another phone: got %v", err)
	}
	if _, err := s.SaleByID(ctx, saleB); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an unknown sale: got %v", err)
	}
}

// A PoS phone has one sale open at a time: its new sale cancels its last
// one, and nobody else's.
func TestANewSaleCancelsThePhonesOpenOne(t *testing.T) {
	ctx := context.Background()
	s, _ := tills(t)
	sale(t, s, saleA, till1, 1_000)
	sale(t, s, saleC, till2, 3_000)
	sale(t, s, saleB, till1, 2_000)
	for id, want := range map[string]SaleState{saleA: SaleCancelled, saleB: SaleOpen, saleC: SaleOpen} {
		if got, err := s.SaleByID(ctx, id); err != nil || got.State != want {
			t.Fatalf("%s: %q %v, want %q", id, got.State, err, want)
		}
	}
}

// An open sale past its time reads as expired, and stays so.
func TestASaleRunsOutWhenItIsRead(t *testing.T) {
	ctx := context.Background()
	s, now := tills(t)
	sale(t, s, saleA, till1, 1_000)
	*now = now.Add(10 * time.Minute) // its last second
	if got, _ := s.SaleByID(ctx, saleA); got.State != SaleOpen {
		t.Fatalf("at its last second: %q", got.State)
	}
	*now = now.Add(time.Second)
	if got, _ := s.SaleByID(ctx, saleA); got.State != SaleExpired {
		t.Fatalf("a second later: %q", got.State)
	}
	*now = now.Add(-time.Hour) // a clock set back doesn't open it again
	if got, _ := s.SaleByID(ctx, saleA); got.State != SaleExpired {
		t.Fatalf("after the clock went back: %q", got.State)
	}
	// One that ran out is no longer "the phone's open sale": a new one leaves it expired, not cancelled.
	*now = now.Add(2 * time.Hour)
	sale(t, s, saleB, till1, 1_000)
	if got, _ := s.SaleByID(ctx, saleA); got.State != SaleExpired {
		t.Fatalf("after the phone's next sale: %q", got.State)
	}
}

// Saying a card took the sale, and cancelling it, are the sale's own phone's.
func TestCardAndCancelAreTheSalesOwnPhones(t *testing.T) {
	ctx := context.Background()
	s, now := tills(t)
	sale(t, s, saleA, till1, 1_000)
	if _, err := s.SaleCard(ctx, saleA, till2, ""); !errors.Is(err, ErrNotYourSale) {
		t.Fatalf("card by another phone: got %v", err)
	}
	if _, err := s.CancelSale(ctx, saleA, till2); !errors.Is(err, ErrNotYourSale) {
		t.Fatalf("cancel by another phone: got %v", err)
	}
	for _, f := range []func(context.Context, string, string) (Sale, error){func(ctx context.Context, id, device string) (Sale, error) { return s.SaleCard(ctx, id, device, "") }, s.CancelSale} {
		if _, err := f(ctx, saleB, till1); !errors.Is(err, ErrNotFound) {
			t.Fatalf("an unknown sale: got %v", err)
		}
	}
	first := *now
	got, err := s.SaleCard(ctx, saleA, till1, "")
	if err != nil || got.CardAt == nil || !got.CardAt.Equal(first) || got.State != SaleOpen || got.Method() != "" {
		t.Fatalf("card: %+v %v", got, err)
	}
	*now = now.Add(time.Minute)
	if got, _ := s.SaleCard(ctx, saleA, till1, ""); !got.CardAt.Equal(first) {
		t.Fatalf("card said twice moved its time: %v", got.CardAt)
	}
	if got, err := s.CancelSale(ctx, saleA, till1); err != nil || got.State != SaleCancelled {
		t.Fatalf("cancel: %+v %v", got, err)
	}
	if got, err := s.CancelSale(ctx, saleA, till1); err != nil || got.State != SaleCancelled {
		t.Fatalf("cancel twice: %+v %v", got, err)
	}
	// A sale that isn't open is left as it is by both.
	sale(t, s, saleB, till1, 1_000)
	*now = now.Add(11 * time.Minute)
	if got, err := s.CancelSale(ctx, saleB, till1); err != nil || got.State != SaleExpired {
		t.Fatalf("cancelling one that ran out: %+v %v", got, err)
	}
	if got, err := s.SaleCard(ctx, saleB, till1, ""); err != nil || got.CardAt != nil {
		t.Fatalf("card on one that ran out: %+v %v", got, err)
	}
}

// paid credits a sale as phoenixd's payment does.
func paid(t *testing.T, s *Store, id string, msat int64) {
	t.Helper()
	done, err := s.CreditSale(context.Background(), id, msat, "hash-"+id, "received")
	if err != nil || !done {
		t.Fatalf("crediting %s: %v %v", id, done, err)
	}
}

// The money for a sale reaches Shop once, and the sale is paid from then on,
// whatever it was before: phoenixd can't withdraw an invoice.
func TestASaleIsPaidOnce(t *testing.T) {
	ctx := context.Background()
	s, now := tills(t)
	sale(t, s, saleA, till1, 2_500_000)
	*now = now.Add(time.Minute)
	paid(t, s, saleA, 2_500_000)
	got, err := s.SaleByID(ctx, saleA)
	if err != nil || got.State != SalePaid || got.PaidAt == nil || !got.PaidAt.Equal(*now) || got.ReceivedMsat != 2_500_000 || got.TxID == 0 || got.Method() != "qr" {
		t.Fatalf("paid: %+v %v", got, err)
	}
	if done, err := s.CreditSale(ctx, saleA, 2_500_000, "hash-"+saleA, "received"); err != nil || done {
		t.Fatalf("credited twice: %v %v", done, err)
	}
	if got := available(t, s, Shop); got != 2_500_000 {
		t.Fatalf("shop has %d", got)
	}
	// Paid is final: cancelling, a card's word once cardStepLate has passed
	// (a card's word a moment after the payment still counts), and time
	// leave it.
	if got, _ := s.CancelSale(ctx, saleA, till1); got.State != SalePaid {
		t.Fatalf("cancelled after it was paid: %q", got.State)
	}
	*now = now.Add(cardStepLate + time.Second)
	if got, _ := s.SaleCard(ctx, saleA, till1, ""); got.CardAt != nil || got.Method() != "qr" {
		t.Fatalf("card said after it was paid: %+v", got)
	}
	*now = now.Add(time.Hour)
	if got, _ := s.SaleByID(ctx, saleA); got.State != SalePaid {
		t.Fatalf("an hour on: %q", got.State)
	}
	history, _ := s.History(ctx, Shop, 0, 10)
	if len(history) != 1 || history[0].Kind != KindSale || history[0].AmountMsat != 2_500_000 || history[0].ID != got.TxID {
		t.Fatalf("shop's history: %+v", history)
	}
}

func TestASaleIsPaidWhateverItWas(t *testing.T) {
	ctx := context.Background()
	s, now := tills(t)
	// A card took it, then it was paid: by card, as far as the phone said.
	sale(t, s, saleA, till1, 1_000_000)
	s.SaleCard(ctx, saleA, till1, "")
	paid(t, s, saleA, 1_000_000)
	if got, _ := s.SaleByID(ctx, saleA); got.State != SalePaid || got.Method() != "card" {
		t.Fatalf("by card: %+v", got)
	}
	// Cancelled, then paid by the customer who had already scanned it.
	sale(t, s, saleB, till1, 2_000_000)
	s.CancelSale(ctx, saleB, till1)
	paid(t, s, saleB, 2_000_000)
	if got, _ := s.SaleByID(ctx, saleB); got.State != SalePaid || got.ReceivedMsat != 2_000_000 {
		t.Fatalf("paid after cancel: %+v", got)
	}
	// Ran out (as the server read it), then the payment in flight landed; and its phone was removed meanwhile.
	sale(t, s, saleC, till2, 3_000_000)
	*now = now.Add(11 * time.Minute)
	if got, _ := s.SaleByID(ctx, saleC); got.State != SaleExpired {
		t.Fatalf("not expired: %q", got.State)
	}
	if err := s.RevokePosPhone(ctx, till2); err != nil {
		t.Fatal(err)
	}
	paid(t, s, saleC, 3_000_000)
	if got, _ := s.SaleByID(ctx, saleC); got.State != SalePaid || got.DeviceName != "Till 2" {
		t.Fatalf("paid after it ran out, its phone removed: %+v", got)
	}
	if got := available(t, s, Shop); got != 6_000_000 {
		t.Fatalf("shop has %d, want all three", got)
	}
	if phones, sales, _ := s.ShopCounts(ctx); phones != 1 || sales != 3 {
		t.Fatalf("counts: %d phones, %d sales", phones, sales)
	}
	list, _ := s.PosPhones(ctx)
	if len(list) != 1 || list[0].Sales != 2 || list[0].LastSale == nil {
		t.Fatalf("Till 1 in the list: %+v", list)
	}
}

// A sale whose money all went toward more room is paid
// with nothing received, and still has its line in Shop's history.
func TestASaleCreditedNothingIsStillPaidAndListed(t *testing.T) {
	ctx := context.Background()
	s, _ := tills(t)
	sale(t, s, saleA, till1, 2_500_000)
	paid(t, s, saleA, 0)
	got, _ := s.SaleByID(ctx, saleA)
	if got.State != SalePaid || got.ReceivedMsat != 0 || got.TxID == 0 {
		t.Fatalf("paid: %+v", got)
	}
	history, _ := s.History(ctx, Shop, 0, 10)
	if len(history) != 1 || history[0].Kind != KindSale || history[0].AmountMsat != 0 || history[0].ID != got.TxID {
		t.Fatalf("shop's history: %+v", history)
	}
	if owed, _ := s.OwedMsat(ctx); owed != 0 {
		t.Fatalf("owed %d", owed)
	}
}

// Money for a sale the server has no record of, or whose record is for
// another invoice, reaches Shop all the same, and no other sale is touched.
func TestMoneyForASaleWithNoRecord(t *testing.T) {
	ctx := context.Background()
	s, _ := tills(t)
	sale(t, s, saleA, till1, 1_000_000)
	if done, err := s.CreditSale(ctx, saleB, 700_000, "hash-unknown", "received"); err != nil || !done {
		t.Fatalf("no record: %v %v", done, err)
	}
	if done, err := s.CreditSale(ctx, saleA, 300_000, "another-hash", "received"); err != nil || !done {
		t.Fatalf("another invoice: %v %v", done, err)
	}
	if got := available(t, s, Shop); got != 1_000_000 {
		t.Fatalf("shop has %d", got)
	}
	if got, _ := s.SaleByID(ctx, saleA); got.State != SaleOpen {
		t.Fatalf("the sale: %q", got.State)
	}
	history, _ := s.History(ctx, Shop, 0, 10)
	if len(history) != 2 || !strings.Contains(history[0].Note, "no record of this sale") || !strings.Contains(history[1].Note, "no record of this sale") {
		t.Fatalf("notes: %+v", history)
	}
}

// The paid sales, newest first, a page at a time, from every phone or from one; nothing unpaid.
func TestPaidSalesNewestFirst(t *testing.T) {
	ctx := context.Background()
	s, now := tills(t)
	ids := []string{saleA, saleB, saleC}
	for i, id := range ids {
		sale(t, s, id, []string{till1, till2, till1}[i], int64(i+1)*1_000_000)
		*now = now.Add(time.Minute)
		paid(t, s, id, int64(i+1)*1_000_000)
	}
	sale(t, s, "0d000000-0000-4000-8000-00000000000d", till1, 9_000_000) // open
	sale(t, s, "0e000000-0000-4000-8000-00000000000e", till1, 9_000_000) // cancels the one before
	all, err := s.PaidSales(ctx, "", 0, 50)
	if err != nil || len(all) != 3 || all[0].ID != saleC || all[1].ID != saleB || all[2].ID != saleA || all[1].DeviceName != "Till 2" {
		t.Fatalf("all: %+v %v", all, err)
	}
	page, _ := s.PaidSales(ctx, "", 0, 2)
	if len(page) != 2 || page[1].ID != saleB {
		t.Fatalf("first page: %+v", page)
	}
	rest, _ := s.PaidSales(ctx, "", page[1].TxID, 2)
	if len(rest) != 1 || rest[0].ID != saleA {
		t.Fatalf("second page: %+v", rest)
	}
	// One phone's: the sales it took, and a page of them.
	mine, err := s.PaidSales(ctx, till1, 0, 50)
	if err != nil || len(mine) != 2 || mine[0].ID != saleC || mine[1].ID != saleA {
		t.Fatalf("till 1's: %+v %v", mine, err)
	}
	if more, _ := s.PaidSales(ctx, till1, mine[0].TxID, 1); len(more) != 1 || more[0].ID != saleA {
		t.Fatalf("till 1's next page: %+v", more)
	}
	if theirs, _ := s.PaidSales(ctx, till2, 0, 50); len(theirs) != 1 || theirs[0].ID != saleB {
		t.Fatalf("till 2's: %+v", theirs)
	}
}

// Paid sales counted by the phone's local day: the prices, not what Shop
// received; from every phone, or from one.
func TestSaleDays(t *testing.T) {
	ctx := context.Background()
	s, now := tills(t)
	day := int64(1_790_035_200) // 2026-09-22 00:00:00 UTC
	at := func(id string, unix, price, received int64) {
		t.Helper()
		*now = time.Unix(unix-60, 0)
		sale(t, s, id, till1, price)
		*now = time.Unix(unix, 0)
		paid(t, s, id, received)
	}
	at(saleA, day-1, 1_000_000, 1_000_000)     // 23:59:59 the day before, UTC
	at(saleB, day, 2_000_000, 0)               // midnight: all of it set aside
	at(saleC, day+86399, 4_000_000, 4_000_000) // 23:59:59
	utc, err := s.SaleDays(ctx, "", 0, 30)
	if err != nil || len(utc) != 2 || utc[0] != (SaleDay{Day: day, Count: 2, TotalMsat: 6_000_000}) || utc[1] != (SaleDay{Day: day - 86400, Count: 1, TotalMsat: 1_000_000}) {
		t.Fatalf("UTC: %+v %v", utc, err)
	}
	// An hour east, the day begins an hour sooner: the first two are the 23rd's, the last the 24th's.
	east, _ := s.SaleDays(ctx, "", 60, 30)
	if len(east) != 2 || east[0] != (SaleDay{Day: day + 86400 - 3600, Count: 1, TotalMsat: 4_000_000}) || east[1] != (SaleDay{Day: day - 3600, Count: 2, TotalMsat: 3_000_000}) {
		t.Fatalf("an hour east: %+v", east)
	}
	// Twelve hours west, the day begins at noon UTC: the last one alone is in the newest day.
	west, _ := s.SaleDays(ctx, "", -720, 30)
	if len(west) != 2 || west[0] != (SaleDay{Day: day + 43200, Count: 1, TotalMsat: 4_000_000}) || west[1] != (SaleDay{Day: day - 43200, Count: 2, TotalMsat: 3_000_000}) {
		t.Fatalf("twelve hours west: %+v", west)
	}
	if one, _ := s.SaleDays(ctx, "", 0, 1); len(one) != 1 || one[0].Day != day {
		t.Fatalf("the newest day alone: %+v", one)
	}
	// Another phone's sale that day: counted for the shop, and for that phone alone.
	*now = time.Unix(day+3600-60, 0)
	sale(t, s, "0d000000-0000-4000-8000-00000000000d", till2, 8_000_000)
	*now = time.Unix(day+3600, 0)
	paid(t, s, "0d000000-0000-4000-8000-00000000000d", 8_000_000)
	if shop, _ := s.SaleDays(ctx, "", 0, 30); len(shop) != 2 || shop[0] != (SaleDay{Day: day, Count: 3, TotalMsat: 14_000_000}) {
		t.Fatalf("the shop's days: %+v", shop)
	}
	if mine, _ := s.SaleDays(ctx, till1, 0, 30); len(mine) != 2 || mine[0] != (SaleDay{Day: day, Count: 2, TotalMsat: 6_000_000}) || mine[1] != (SaleDay{Day: day - 86400, Count: 1, TotalMsat: 1_000_000}) {
		t.Fatalf("till 1's days: %+v", mine)
	}
	if theirs, _ := s.SaleDays(ctx, till2, 0, 30); len(theirs) != 1 || theirs[0] != (SaleDay{Day: day, Count: 1, TotalMsat: 8_000_000}) {
		t.Fatalf("till 2's days: %+v", theirs)
	}
}

// An account's history names the other account of a move, and a sale's
// phone, way of paying and price.
func TestHistoryNamesTheOtherAccountAndTheSale(t *testing.T) {
	ctx := context.Background()
	s, _ := tills(t)
	card := activeCard(t, s, id)
	s.Credit(ctx, Pool, 10_000_000, "top", "")
	sale(t, s, saleA, till1, 2_500_000)
	s.SaleCard(ctx, saleA, till1, "")
	paid(t, s, saleA, 2_000_000) // 500 sat of it went toward more room
	sale(t, s, saleB, till2, 1_000_000)
	paid(t, s, saleB, 1_000_000)
	s.CreditSale(ctx, saleC, 300_000, "hash-unknown", "received") // no record of it
	for _, m := range []struct{ from, to Account }{{Pool, card}, {Pool, Hosting}, {Shop, Pool}, {card, Hosting}} {
		if err := s.Move(ctx, m.from, m.to, 100_000, ""); err != nil {
			t.Fatal(err)
		}
	}
	s.RenamePosPhone(ctx, till2, "Back room")
	others := func(acct Account) (out []Account) {
		t.Helper()
		txs, err := s.History(ctx, acct, 0, 20)
		if err != nil {
			t.Fatal(err)
		}
		for _, tx := range txs {
			if tx.Kind == KindMove {
				out = append(out, tx.Other)
			} else if tx.Other != "" {
				t.Fatalf("%s's %s names %q", acct, tx.Kind, tx.Other)
			}
		}
		return out
	}
	for acct, want := range map[Account][]Account{
		Pool:    {Shop, Hosting, card}, // newest first
		card:    {Hosting, Pool},
		Hosting: {card, Pool},
		Shop:    {Pool},
	} {
		if got := others(acct); fmt.Sprint(got) != fmt.Sprint(want) {
			t.Fatalf("%s's moves name %v, want %v", acct, got, want)
		}
	}
	txs, _ := s.History(ctx, Shop, 0, 20)
	if len(txs) != 4 || txs[0].Kind != KindMove || txs[0].Sale != nil {
		t.Fatalf("shop's history: %+v", txs)
	}
	if got := txs[1]; got.Sale != nil || got.AmountMsat != 300_000 {
		t.Fatalf("the payment with no record: %+v", got)
	}
	// Each sale's paid time is there; the rest compared exactly.
	unpaid := func(ts *TxSale) TxSale {
		if ts == nil || ts.PaidAt.IsZero() {
			t.Fatalf("a sale with no paid time: %+v", ts)
		}
		c := *ts
		c.PaidAt = time.Time{}
		return c
	}
	if got := txs[2].Sale; unpaid(got) != (TxSale{ID: saleB, Method: "qr", Device: "Back room", PriceMsat: 1_000_000}) {
		t.Fatalf("the second sale: %+v", got)
	}
	if got := txs[3]; got.Sale == nil || unpaid(got.Sale) != (TxSale{ID: saleA, Method: "card", Device: "Till 1", PriceMsat: 2_500_000}) || got.AmountMsat != 2_000_000 {
		t.Fatalf("the first sale: %+v %+v", got, got.Sale)
	}
	// A top-up's entry has neither.
	if txs, _ := s.History(ctx, Pool, 0, 20); txs[len(txs)-1].Kind != KindTopup || txs[len(txs)-1].Other != "" || txs[len(txs)-1].Sale != nil {
		t.Fatalf("pool's top-up: %+v", txs[len(txs)-1])
	}
}

// A sale rung up in a currency
// keeps its price, and the same request again is found by that price,
// not by its sats: a till's retry after the rate moved gets the first sale,
// with its first sats. A priced sale is never a sale typed in sat, nor the
// other way round; Shop's history names the price.
func TestAPricedSaleIsFoundAgainByItsPrice(t *testing.T) {
	ctx := context.Background()
	s, now := tills(t)
	priced := func(id, device, currency string, minor, msat int64, hash string) (Sale, error) {
		return s.NewSale(ctx, Sale{ID: id, Device: device, AmountMsat: msat, PriceCurrency: currency, PriceMinor: minor,
			PaymentHash: hash, Invoice: "lnbc-" + hash, ExpiresAt: now.Add(10 * time.Minute)})
	}
	if _, found, err := s.SaleAgainPriced(ctx, saleA, till1, "GBP", 250); err != nil || found {
		t.Fatalf("before it is made: %v %v", found, err)
	}
	made, err := priced(saleA, till1, "GBP", 250, 4_075_000, "hash-"+saleA)
	if err != nil || made.PriceCurrency != "GBP" || made.PriceMinor != 250 || made.AmountMsat != 4_075_000 {
		t.Fatalf("made %+v %v", made, err)
	}
	again, found, err := s.SaleAgainPriced(ctx, saleA, till1, "GBP", 250)
	if err != nil || !found || again.AmountMsat != 4_075_000 || again.Invoice != made.Invoice {
		t.Fatalf("again: %+v %v %v", again, found, err)
	}
	// Two requests that both got as far as an invoice, the rate moved between them: the first's sale and sats.
	second, err := priced(saleA, till1, "GBP", 250, 3_571_000, "hash-2")
	if err != nil || second.AmountMsat != 4_075_000 || second.Invoice != made.Invoice {
		t.Fatalf("a second insert after the rate moved: %+v %v", second, err)
	}
	for _, other := range []struct {
		device, currency string
		minor            int64
	}{{till2, "GBP", 250}, {till1, "GBP", 251}, {till1, "EUR", 250}} {
		if _, _, err := s.SaleAgainPriced(ctx, saleA, other.device, other.currency, other.minor); !errors.Is(err, ErrSaleExists) {
			t.Fatalf("%+v: got %v, want ErrSaleExists", other, err)
		}
	}
	if _, _, err := s.SaleAgain(ctx, saleA, till1, 4_075_000); !errors.Is(err, ErrSaleExists) {
		t.Fatalf("the priced sale's id typed in sat: got %v, want ErrSaleExists", err)
	}
	plain := sale(t, s, saleC, till2, 2_000_000)
	if plain.PriceCurrency != "" || plain.PriceMinor != 0 {
		t.Fatalf("a sale typed in sat: %+v", plain)
	}
	if _, _, err := s.SaleAgainPriced(ctx, saleC, till2, "GBP", 250); !errors.Is(err, ErrSaleExists) {
		t.Fatalf("a sat sale's id priced: got %v, want ErrSaleExists", err)
	}
	paid(t, s, saleA, 4_075_000)
	paid(t, s, saleC, 2_000_000)
	hist, err := s.History(ctx, Shop, 0, 10)
	if err != nil || len(hist) != 2 {
		t.Fatalf("shop's history: %+v %v", hist, err)
	}
	if got := hist[1].Sale; got == nil || got.PriceCurrency != "GBP" || got.PriceMinor != 250 || got.PriceMsat != 4_075_000 {
		t.Fatalf("the priced sale in the history: %+v", got)
	}
	if got := hist[0].Sale; got == nil || got.PriceCurrency != "" || got.PriceMinor != 0 || got.PriceMsat != 2_000_000 {
		t.Fatalf("the sat sale in the history: %+v", got)
	}
	// One line read alone (a payment's page) has the price too.
	if l, err := s.Line(ctx, Shop, hist[1].ID); err != nil || l.Sale == nil || l.Sale.PriceCurrency != "GBP" || l.Sale.PriceMinor != 250 {
		t.Fatalf("the priced sale's line: %+v %v", l, err)
	}
}

func TestASalesLineHasItsHashAndInvoice(t *testing.T) {
	ctx := context.Background()
	s, _ := tills(t)
	sale(t, s, saleA, till1, 2_500_000)
	paid(t, s, saleA, 2_500_000)
	hist, err := s.History(ctx, Shop, 0, 1)
	if err != nil || len(hist) != 1 {
		t.Fatal(hist, err)
	}
	l, err := s.Line(ctx, Shop, hist[0].ID)
	if err != nil || l.Payment == nil || *l.Payment != (LinePayment{Hash: "hash-" + saleA, Invoice: "lnbc-" + saleA}) {
		t.Fatalf("sale's line: %+v %v", l, err)
	}
}
