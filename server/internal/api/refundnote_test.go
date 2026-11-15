package api

import (
	"context"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/store"
)

// A refund's note to the customer: the words, and how they fit.

func TestRefundNoteWords(t *testing.T) {
	paid := time.Date(2026, 10, 20, 16, 22, 5, 0, time.UTC)
	bst := 60
	cases := []struct {
		name   string
		offset *int
		limit  int
		want   string
	}{
		{"Pixel 9a", &bst, 140, "Refund from Pixel 9a for the sale of 17:22, 20 Oct"},
		{"", &bst, 140, "Refund for the sale of 17:22, 20 Oct"},
		{"Pixel 9a", nil, 140, "Refund from Pixel 9a"},
		{"", nil, 140, "Refund"},
		// Over the limit: the date goes first, then the sale, then the name.
		{"Pixel 9a", &bst, 45, "Refund from Pixel 9a for the sale of 17:22"},
		{"Pixel 9a", &bst, 30, "Refund from Pixel 9a"},
		{"Pixel 9a", &bst, 12, "Refund"},
		{"Pixel 9a", &bst, 5, ""},
	}
	for _, c := range cases {
		if got := refundNote(c.name, paid, c.offset)(c.limit); got != c.want {
			t.Errorf("%q offset %v limit %d: %q, want %q", c.name, c.offset, c.limit, got, c.want)
		}
	}
}

// A refund to an address that takes a comment sends the note, naming the wallet and the sale's time in the phone's
// offset (?offset=); one that takes none gets none; a send gets none.
func TestRefundSendsItsNote(t *testing.T) {
	w := moneySetup(t)
	if _, err := w.st.SetWalletName(context.Background(), "Pixel 9a"); err != nil {
		t.Fatal(err)
	}
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "")
	s, _ := w.st.SaleByID(context.Background(), id)
	at := s.PaidAt.In(time.FixedZone("", 60*60))
	status, out := w.do("POST", "/api/v1/sales/"+id+"/refund?offset=60", map[string]any{"id": uuid(), "amountMsat": 1_000_000, "from": "pool", "to": "noted@pay.example.com"})
	if status != 200 || out["status"] != "sent" {
		t.Fatalf("%d %v", status, out)
	}
	want := "Refund from Pixel 9a for the sale of " + at.Format("15:04") + ", " + at.Format("2 Jan")
	if got := w.comments.all(); len(got) != 1 || got[0] != want {
		t.Fatalf("comments %q, want %q", got, want)
	}

	// No offset (an older wallet): no time.
	id = w.paidWithLink(till, 1000, "")
	if status, out := w.refund(id, map[string]any{"id": uuid(), "amountMsat": 1_000_000, "from": "pool", "to": "noted@pay.example.com"}); status != 200 {
		t.Fatalf("%d %v", status, out)
	}
	// An address that takes no comment, and a send: none.
	id = w.paidWithLink(till, 1000, "")
	if status, out := w.do("POST", "/api/v1/sales/"+id+"/refund?offset=60", map[string]any{"id": uuid(), "amountMsat": 1_000_000, "from": "pool", "to": "alice@pay.example.com"}); status != 200 {
		t.Fatalf("%d %v", status, out)
	}
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": uuid(), "to": "noted@pay.example.com", "amountMsat": 2_000_000}); status != 200 {
		t.Fatalf("send: %d %v", status, out)
	}
	if got := w.comments.all(); len(got) != 4 || got[1] != "Refund from Pixel 9a" || got[2] != "" || got[3] != "" {
		t.Fatalf("comments %q", got)
	}
}

// An own-card refund (booked inside) and a refund to a bare invoice send no
// note: neither asks any address.
func TestRefundWithoutAnAddressSendsNoNote(t *testing.T) {
	w := moneySetup(t)
	ctx := context.Background()
	if err := w.st.NewRefundLink(ctx, ownToken, cardID, "k1", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	till := w.device(store.RolePos, "Till 1")
	w.paidWithLink(till, 1000, "") // Shop's float for the invoice refund's fee
	own := w.paidWithLink(till, 1000, "lnurlp://vm-1.lnvps.cloud/refund/"+ownToken)
	if status, out := w.do("POST", "/api/v1/sales/"+own+"/refund?offset=60", map[string]any{"id": uuid(), "amountMsat": 1_000_000, "from": "shop"}); status != 200 || out["feeMsat"] != 0.0 {
		t.Fatalf("own card: %d %v", status, out)
	}
	id := w.paidWithLink(till, 1000, "")
	bolt11, _ := w.f.Invoice(1_000_000)
	if status, out := w.do("POST", "/api/v1/sales/"+id+"/refund?offset=60", map[string]any{"id": uuid(), "amountMsat": 1_000_000, "from": "pool", "to": bolt11}); status != 200 {
		t.Fatalf("invoice: %d %v", status, out)
	}
	if got := w.comments.all(); len(got) != 0 {
		t.Fatalf("an address was asked: %q", got)
	}
}

// An offset out of range is no offset.
func TestRefundOffsetOutOfRange(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "")
	if status, out := w.do("POST", "/api/v1/sales/"+id+"/refund?offset=9999", map[string]any{"id": uuid(), "amountMsat": 1_000_000, "from": "pool", "to": "noted@pay.example.com"}); status != 200 {
		t.Fatalf("%d %v", status, out)
	}
	if got := w.comments.all(); len(got) != 1 || got[0] != "Refund" {
		t.Fatalf("comments %q", got)
	}
}

// The sale's day is the phone's: a sale paid at 23:30 UTC is the next day an hour east.
func TestRefundNoteDayIsThePhones(t *testing.T) {
	paid := time.Date(2026, 10, 20, 23, 30, 0, 0, time.UTC)
	east := 60
	if got := refundNote("", paid, &east)(140); got != "Refund for the sale of 00:30, 21 Oct" {
		t.Fatalf("%q", got)
	}
}
