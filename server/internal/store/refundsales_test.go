package store

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"
)

// Refunds of till sales: what
// migration 14 adds to sales, the till's return link, and the history and
// day totals that know a refund.

func TestMigration14(t *testing.T) {
	s := open(t)
	if SchemaVersion() < 14 {
		t.Fatalf("schema %d, want 14 or later", SchemaVersion())
	}
	for _, c := range []struct{ table, column string }{
		{"sales", "return_link"}, {"sales", "refund_tx_id"}, {"holds", "sale_id"},
		{"refund_links", "token"}, {"refund_links", "card_id"}, {"refund_links", "k1"},
		{"refund_links", "claimed_at"}, {"refund_links", "expires_at"},
	} {
		var n int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, c.table, c.column).Scan(&n); err != nil || n != 1 {
			t.Fatalf("%s.%s: %d %v", c.table, c.column, n, err)
		}
	}
	found := false
	for _, o := range ownTables {
		found = found || (o.migration == 14 && o.table == "refund_links")
	}
	if !found {
		t.Fatalf("ownTables %+v has no {14, refund_links}", ownTables)
	}
}

func TestSaleCardKeepsReturnLink(t *testing.T) {
	ctx := context.Background()
	s, _ := tills(t)
	sale(t, s, saleA, till1, 5_000_000)
	got, err := s.SaleCard(ctx, saleA, till1, "https://x.example/lnurlp/1")
	if err != nil || got.ReturnLink != "https://x.example/lnurlp/1" || got.CardAt == nil {
		t.Fatalf("%+v %v", got, err)
	}
}

// The card's server can pay before the till's card step arrives:
// a sale paid under 60 s ago with no card mark still takes it.
func TestSaleCardJustPaid(t *testing.T) {
	ctx := context.Background()
	s, now := tills(t)
	sale(t, s, saleA, till1, 5_000_000)
	paid(t, s, saleA, 5_000_000)
	*now = now.Add(30 * time.Second)
	got, err := s.SaleCard(ctx, saleA, till1, "https://x.example/lnurlp/1")
	if err != nil || got.ReturnLink != "https://x.example/lnurlp/1" || got.Method() != "card" {
		t.Fatalf("30 s after: %+v %v", got, err)
	}
	sale(t, s, saleB, till1, 5_000_000)
	paid(t, s, saleB, 5_000_000)
	*now = now.Add(61 * time.Second)
	got, err = s.SaleCard(ctx, saleB, till1, "https://x.example/lnurlp/2")
	if err != nil || got.ReturnLink != "" || got.Method() != "qr" {
		t.Fatalf("61 s after: %+v %v", got, err)
	}
}

func TestSaleCardOtherTill(t *testing.T) {
	s, _ := tills(t)
	sale(t, s, saleA, till1, 5_000_000)
	if _, err := s.SaleCard(context.Background(), saleA, till2, "https://x.example/lnurlp/1"); !errors.Is(err, ErrNotYourSale) {
		t.Fatalf("%v", err)
	}
}

// refunded books a refund of the sale from Shop by hand and points the sale
// at it, as settling a refund's hold does.
func refunded(t *testing.T, s *Store, saleID string, msat int64) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var err error
		id, _, err = s.postID(ctx, tx, s.now().Unix(), KindRefund, "", "refund of sale "+saleID, Entry{Shop, -msat - 3_000}, Entry{World, msat}, Entry{Fees, 3_000})
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE sales SET refund_tx_id = ? WHERE id = ?`, id, saleID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestSaleDaysLeavesRefundedOut(t *testing.T) {
	ctx := context.Background()
	s, _ := tills(t)
	sale(t, s, saleA, till1, 5_000_000)
	paid(t, s, saleA, 5_000_000)
	sale(t, s, saleB, till1, 849_000)
	paid(t, s, saleB, 849_000)
	refunded(t, s, saleA, 5_000_000)
	days, err := s.SaleDays(ctx, "", 0, 10)
	if err != nil || len(days) != 1 || days[0].Count != 1 || days[0].TotalMsat != 849_000 {
		t.Fatalf("%+v %v", days, err)
	}
}

func TestHistoryRefundJoinsSale(t *testing.T) {
	ctx := context.Background()
	s, _ := tills(t)
	sale(t, s, saleA, till1, 5_000_000)
	paid(t, s, saleA, 5_000_000)
	refund := refunded(t, s, saleA, 5_000_000)
	h, err := s.History(ctx, Shop, 0, 10)
	if err != nil || len(h) != 2 {
		t.Fatalf("%+v %v", h, err)
	}
	r, sold := h[0], h[1]
	if r.Kind != KindRefund || r.Sale == nil || r.Sale.ID != saleA {
		t.Fatalf("refund row %+v", r)
	}
	if sold.Kind != KindSale || sold.Sale == nil || sold.Sale.RefundTxID != refund || sold.Sale.RefundMsat != 5_000_000 ||
		sold.Sale.RefundFrom != Shop || sold.Sale.PaidAt.IsZero() {
		t.Fatalf("sale row %+v %+v", sold, sold.Sale)
	}
	got, err := s.SaleByID(ctx, saleA)
	if err != nil || got.RefundTxID != refund || got.RefundMsat != 5_000_000 || got.RefundAt == nil || got.RefundPending {
		t.Fatalf("sale %+v %v", got, err)
	}
}
