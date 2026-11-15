package store

import (
	"context"
	"strings"
	"testing"
)

func TestMigration15(t *testing.T) {
	s := open(t)
	if SchemaVersion() != 15 {
		t.Fatalf("schema %d, want 15", SchemaVersion())
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('ledger_tx') WHERE name = 'via'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("ledger_tx.via: %d %v", n, err)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'sales_tx'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("index sales_tx: %d %v", n, err)
	}
	found := false
	for _, o := range ownTables {
		found = found || (o.migration == 15 && o.table == "sales_tx" && o.kind == "index")
	}
	if !found {
		t.Fatalf("ownTables %+v has no {15, index sales_tx}", ownTables)
	}
}

// A database whose migration 15 is another cardd's (no sales_tx index) is refused.
func TestOwnMigration15Index(t *testing.T) {
	s := open(t)
	if _, err := s.db.Exec(`DROP INDEX sales_tx`); err != nil {
		t.Fatal(err)
	}
	err := s.checkOwnMigrations()
	if err == nil || !strings.Contains(err.Error(), "sales_tx") {
		t.Fatalf("got %v", err)
	}
}

// A top-up credited with via "refund" keeps it on its line.
func TestCreditVia(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if _, err := s.CreditVia(ctx, Pool, 7_000, "hash68", "received", "refund"); err != nil {
		t.Fatal(err)
	}
	h, err := s.History(ctx, Pool, 0, 10)
	if err != nil || len(h) != 1 || h[0].Kind != KindTopup || h[0].Via != "refund" {
		t.Fatalf("%+v %v", h, err)
	}
	if _, err := s.Credit(ctx, Pool, 3_000, "hash-plain", "received"); err != nil {
		t.Fatal(err)
	}
	h, _ = s.History(ctx, Pool, 0, 10)
	if h[0].Via != "" {
		t.Fatalf("a plain top-up has via %q", h[0].Via)
	}
}

// An own-card refund's lines name each other's account: the card on
// Shop's line, Shop on the card's.
func TestRefundLinesNameOtherAccount(t *testing.T) {
	ctx := context.Background()
	s := soldAndPaid(t)
	shopMoney(t, s, 2_000_000, "float")
	card := activeCard(t, s, refundCard)
	if _, err := s.RefundToCard(ctx, "request:one", saleA, Shop, refundCard, 8_000_000); err != nil {
		t.Fatal(err)
	}
	h, err := s.History(ctx, Shop, 0, 1)
	if err != nil || len(h) != 1 || h[0].Kind != KindRefund || h[0].Other != card {
		t.Fatalf("shop's line %+v %v", h, err)
	}
	h, err = s.History(ctx, card, 0, 1)
	if err != nil || len(h) != 1 || h[0].Kind != KindRefund || h[0].Other != Shop || h[0].Sale == nil || h[0].Sale.ID != saleA {
		t.Fatalf("card's line %+v %v", h, err)
	}
}

// A refund paid over Lightning has no other account of this wallet: not
// world, not fees.
func TestLightningRefundNamesNoOther(t *testing.T) {
	ctx := context.Background()
	s, _ := tills(t)
	sale(t, s, saleA, till1, 5_000_000)
	paid(t, s, saleA, 5_000_000)
	refunded(t, s, saleA, 5_000_000)
	h, err := s.History(ctx, Shop, 0, 1)
	if err != nil || len(h) != 1 || h[0].Kind != KindRefund || h[0].Other != "" {
		t.Fatalf("%+v %v", h, err)
	}
}

// History finds a line's sale by index, both the sale it paid and the sale it
// refunded, and a move's or refund's other account by its line: no scan of
// sales or of ledger_entry's other legs, no automatic index (the
// index on ledger_entry(tx_id)).
func TestHistoryJoinsSalesByIndex(t *testing.T) {
	s := open(t)
	rows, err := s.db.Query(`EXPLAIN QUERY PLAN `+txSelect+`t.id < ? GROUP BY t.id ORDER BY t.id DESC LIMIT ?`, Shop, Shop, 100, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	for _, d := range plan {
		if strings.Contains(d, "SCAN s") || strings.Contains(d, "SCAN o") || strings.Contains(d, "SCAN f") || strings.Contains(d, "AUTOMATIC") {
			t.Fatalf("plan scans sales: %q", plan)
		}
	}
	if len(plan) == 0 {
		t.Fatal("no plan")
	}
}
