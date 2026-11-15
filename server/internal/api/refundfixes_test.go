package api

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/store"
)

// A line's via in the API: on a top-up that came through a refund link, on
// history and on a line, absent otherwise.

func TestALinesViaInTheAPI(t *testing.T) {
	w := moneySetup(t)
	if done, err := w.st.CreditVia(context.Background(), store.Pool, 2_000_000, "h68", "received", "refund"); !done || err != nil {
		t.Fatalf("credit: %v %v", done, err)
	}
	tx := newestOf(w, "pool")
	if tx["via"] != "refund" || tx["kind"] != "topup" {
		t.Fatalf("history: %v", tx)
	}
	_, line := w.do("GET", fmt.Sprintf("/api/v1/accounts/pool/transactions/%d", int64(tx["id"].(float64))), nil)
	if line["via"] != "refund" {
		t.Fatalf("line: %v", line)
	}
	if done, err := w.st.Credit(context.Background(), store.Pool, 1_000_000, "h-plain", "received"); !done || err != nil {
		t.Fatalf("credit: %v %v", done, err)
	}
	if tx := newestOf(w, "pool"); hasKey(tx, "via") {
		t.Fatalf("a plain top-up: %v", tx)
	}
}

// Our own token link with a trailing dot on the host is still our card: booked
// inside, no fee.
func TestRefundOwnTokenTrailingDot(t *testing.T) {
	w := moneySetup(t)
	ctx := context.Background()
	if err := w.st.NewRefundLink(ctx, ownToken, cardID, "k1", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 8000, "")
	before := w.balance(store.CardAccount(cardID))
	status, out := w.refund(id, map[string]any{"id": uuid(), "amountMsat": 8_000_000, "from": "shop", "to": "https://vm-1.lnvps.cloud./refund/" + ownToken})
	if status != 200 || out["status"] != "sent" || out["feeMsat"] != 0.0 || w.balance(store.CardAccount(cardID)) != before+8_000_000 {
		t.Fatalf("%d %v", status, out)
	}
}

// This server in other spellings is refused before any payment: a
// trailing dot, and its own IP address (meta vm.ipv4).
func TestRefundRefusesOwnHostSpellings(t *testing.T) {
	w := moneySetup(t)
	if err := w.st.SetMeta(context.Background(), "vm.ipv4", "45.67.89.10"); err != nil {
		t.Fatal(err)
	}
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "")
	for _, to := range []string{"https://vm-1.lnvps.cloud./.well-known/lnurlp/pool", "https://45.67.89.10/.well-known/lnurlp/pool", "lnurlp://45.67.89.10/refund/" + ownToken} {
		if status, out := w.refund(id, map[string]any{"id": uuid(), "amountMsat": 1_000_000, "from": "pool", "to": to}); status != 409 || out["error"] != "bad_return_link" {
			t.Fatalf("%s: %d %v", to, status, out)
		}
	}
	if len(w.f.Paid()) != 0 {
		t.Fatal("paid ourselves")
	}
}

// The customer's invoice for another amount than the refund: other_amount
// with the invoice's amount, nothing paid.
func TestRefundOtherAmountInvoice(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 8000, "")
	bolt11, _ := w.f.Invoice(9_000_000)
	status, out := w.refund(id, map[string]any{"id": uuid(), "amountMsat": 8_000_000, "from": "pool", "to": bolt11})
	if status != 409 || out["error"] != "other_amount" || out["amountMsat"] != 9_000_000.0 || out["of"] != "invoice" {
		t.Fatalf("%d %v", status, out)
	}
	if len(w.f.Paid()) != 0 {
		t.Fatal("paid")
	}
}

// The customer's offer for another amount: other_amount with the offer's
// amount, nothing paid.
func TestRefundOtherAmountOffer(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 8000, "")
	offer := w.f.Offer(9_000_000, "", "")
	status, out := w.refund(id, map[string]any{"id": uuid(), "amountMsat": 8_000_000, "from": "pool", "to": offer})
	if status != 409 || out["error"] != "other_amount" || out["amountMsat"] != 9_000_000.0 || out["of"] != "offer" {
		t.Fatalf("%d %v", status, out)
	}
	if len(w.f.OfferPayments(offer)) != 0 {
		t.Fatal("paid")
	}
}

// Send out keeps its own refusal for an invoice of another amount.
func TestSendOtherAmountStaysBadInvoice(t *testing.T) {
	w := moneySetup(t)
	bolt11, _ := w.f.Invoice(9_000_000)
	status, out := w.do("POST", "/api/v1/send", map[string]any{"id": uuid(), "to": bolt11, "amountMsat": 8_000_000})
	if status != 400 || out["error"] != "bad_invoice" {
		t.Fatalf("%d %v", status, out)
	}
}
