package api

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/store"
)

// Refunding a till sale: the
// till's return link, sales on the wire, and POST /api/v1/sales/{id}/refund.

const ownToken = "0123456789abcdef0123456789abcdef"

// paidWithLink sells sat on till, tells the card step the link (none for ""),
// then credits the sale in full.
func (w *moneyWorld) paidWithLink(till *client, sat int64, link string) string {
	w.t.Helper()
	id := uuid()
	status, out := sell(till, id, sat)
	if status != 201 {
		w.t.Fatalf("sale: %d %v", status, out)
	}
	var body any
	if link != "" {
		body = map[string]any{"returnLink": link}
	}
	if status, out := till.do("POST", "/api/v1/pos/sales/"+id+"/card", body); status != 200 {
		w.t.Fatalf("card step: %d %v", status, out)
	}
	info, _ := w.f.InvoiceInfo(theSale(out)["invoice"].(string))
	if done, err := w.st.CreditSale(context.Background(), id, sat*1000, info.PaymentHash, "received"); err != nil || !done {
		w.t.Fatalf("credit: %v %v", done, err)
	}
	return id
}

func (w *moneyWorld) refund(id string, body map[string]any) (int, map[string]any) {
	return w.do("POST", "/api/v1/sales/"+id+"/refund", body)
}

func TestSaleCardEmptyBody(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "")
	if s, _ := w.st.SaleByID(context.Background(), id); s.Method() != "card" || s.ReturnLink != "" {
		t.Fatalf("%+v", s)
	}
}

func TestSaleCardReturnLink(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "lnurlp://shop.example/x")
	if s, _ := w.st.SaleByID(context.Background(), id); s.ReturnLink != "https://shop.example/x" {
		t.Fatalf("%+v", s)
	}
	other := uuid()
	sell(till, other, 1000)
	if status, out := till.do("POST", "/api/v1/pos/sales/"+other+"/card", map[string]any{"returnLink": "ftp://x"}); status != 400 {
		t.Fatalf("ftp: %d %v", status, out)
	}
}

func TestSaleJSONRefundKey(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "https://shop.example/x")
	_, out := w.do("GET", "/api/v1/pos/sales/"+id, nil)
	s := theSale(out)
	if v, ok := s["refund"]; !ok || v != nil {
		t.Fatalf("an owner's sale before a refund: %v", s)
	}
	if ra, _ := s["returnAddress"].(map[string]any); ra["host"] != "shop.example" {
		t.Fatalf("returnAddress: %v", s)
	}
	_, out = till.do("GET", "/api/v1/pos/sales/"+id, nil)
	if hasKey(theSale(out), "returnAddress") {
		t.Fatalf("a till sees the return address: %v", theSale(out))
	}
	bolt11, _ := w.f.Invoice(1_000_000)
	if status, out := w.refund(id, map[string]any{"id": "r1", "amountMsat": 1_000_000, "from": "pool", "to": bolt11}); status != 200 || out["status"] != "sent" {
		t.Fatalf("refund: %d %v", status, out)
	}
	_, out = till.do("GET", "/api/v1/pos/sales/"+id, nil)
	if r, _ := theSale(out)["refund"].(map[string]any); r["state"] != "paid" || r["amountMsat"] != 1_000_000.0 {
		t.Fatalf("after: %v", theSale(out))
	}
	rows := func(acct string) []any {
		t.Helper()
		_, hist := w.do("GET", "/api/v1/accounts/"+acct+"/history", nil)
		txs, _ := hist["transactions"].([]any)
		if len(txs) == 0 {
			t.Fatalf("%s's history %v", acct, hist)
		}
		return txs
	}
	first := rows("pool")[0].(map[string]any)
	if first["kind"] != "refund" || first["sale"].(map[string]any)["id"] != id {
		t.Fatalf("the refund's row in pool: %v", first)
	}
	sold := rows("shop")[0].(map[string]any)["sale"].(map[string]any)
	if r, _ := sold["refund"].(map[string]any); r["state"] != "paid" || r["from"] != "pool" || sold["paidAt"] == nil {
		t.Fatalf("the sale's row: %v", sold)
	}
}

func TestRefundRoutePaysFromShop(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	w.paidWithLink(till, 1000, "") // Shop's float: the refund's fee budget needs it
	id := w.paidWithLink(till, 8000, "")
	bolt11, hash := w.f.Invoice(8_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{FeeMsat: 3_000})
	status, out := w.refund(id, map[string]any{"id": "r1", "amountMsat": 8_000_000, "from": "shop", "to": bolt11})
	if status != 200 || out["status"] != "sent" || out["feeMsat"] != 3_000.0 {
		t.Fatalf("%d %v", status, out)
	}
	if got := w.balance(store.Shop); got != 1_000_000-3_000 {
		t.Fatalf("shop has %d", got)
	}
}

func TestRefundRouteFromPool(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 8000, "")
	bolt11, _ := w.f.Invoice(8_000_000)
	if status, out := w.refund(id, map[string]any{"id": "r1", "amountMsat": 8_000_000, "from": "pool", "to": bolt11}); status != 200 || out["status"] != "sent" {
		t.Fatalf("%d %v", status, out)
	}
	if w.balance(store.Shop) != 8_000_000 || w.balance(store.Pool) >= 50_000_000-8_000_000+1 {
		t.Fatalf("shop %d pool %d", w.balance(store.Shop), w.balance(store.Pool))
	}
}

func TestRefundRouteAmountAtRate(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	w.rate(mempoolPrices)
	w.do("PUT", "/api/v1/currency", map[string]string{"currency": "GBP"})
	id := uuid()
	_, out := sellAt(till, id, "GBP", 250) // 4,075 sat at 61,352
	info, _ := w.f.InvoiceInfo(theSale(out)["invoice"].(string))
	w.st.CreditSale(context.Background(), id, 4_075_000, info.PaymentHash, "received")
	w.rate(repriced(mempoolPrices, "GBP", 63_000)) // £2.50 is 3,968 sat now
	try := func(msat int64) (int, map[string]any) {
		bolt11, _ := w.f.Invoice(msat)
		return w.refund(id, map[string]any{"id": uuid(), "amountMsat": msat, "from": "pool", "to": bolt11})
	}
	if status, out := try(3_800_000); status != 409 || out["error"] != "wrong_amount" || out["amountMsat"] != 3_968_000.0 {
		t.Fatalf("4.2%% off: %d %v", status, out)
	}
	if status, out := try(4_040_000); status != 200 {
		t.Fatalf("1.8%% off: %d %v", status, out)
	}
	// Another sale, no rate: only priceMsat itself.
	w.rate(mempoolPrices)
	id2 := uuid()
	_, out = sellAt(till, id2, "GBP", 250)
	info, _ = w.f.InvoiceInfo(theSale(out)["invoice"].(string))
	w.st.CreditSale(context.Background(), id2, 4_075_000, info.PaymentHash, "received")
	w.noRate()
	id = id2
	if status, out := try(3_968_000); status != 409 || out["error"] != "wrong_amount" || out["amountMsat"] != 4_075_000.0 {
		t.Fatalf("no rate, the old figure: %d %v", status, out)
	}
	if status, out := try(4_075_000); status != 200 {
		t.Fatalf("no rate, priceMsat: %d %v", status, out)
	}
}

func TestRefundRouteTwice(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "")
	for i, want := range []int{200, 409} {
		bolt11, _ := w.f.Invoice(1_000_000)
		status, out := w.refund(id, map[string]any{"id": uuid(), "amountMsat": 1_000_000, "from": "pool", "to": bolt11})
		if status != want || (want == 409 && out["error"] != "already_refunded") {
			t.Fatalf("#%d: %d %v", i, status, out)
		}
	}
}

func TestRefundRouteSameIDReplays(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "")
	bolt11, _ := w.f.Invoice(1_000_000)
	body := map[string]any{"id": "r1", "amountMsat": 1_000_000, "from": "pool", "to": bolt11}
	for i := 0; i < 2; i++ {
		if status, out := w.refund(id, body); status != 200 || out["status"] != "sent" {
			t.Fatalf("#%d: %d %v", i, status, out)
		}
	}
	if len(w.f.Paid()) != 1 {
		t.Fatalf("paid %d times", len(w.f.Paid()))
	}
}

func TestRefundAfterFailure(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "")
	bolt11, hash := w.f.Invoice(1_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Fail: true})
	body := map[string]any{"id": "r1", "amountMsat": 1_000_000, "from": "pool", "to": bolt11}
	for i := 0; i < 2; i++ {
		if status, out := w.refund(id, body); status != 200 || out["status"] != "failed" {
			t.Fatalf("#%d: %d %v", i, status, out)
		}
	}
	good, _ := w.f.Invoice(1_000_000)
	if status, out := w.refund(id, map[string]any{"id": "r2", "amountMsat": 1_000_000, "from": "pool", "to": good}); status != 200 || out["status"] != "sent" {
		t.Fatalf("a new request: %d %v", status, out)
	}
}

func TestRefundRouteOwnToken(t *testing.T) {
	w := moneySetup(t)
	ctx := context.Background()
	if err := w.st.NewRefundLink(ctx, ownToken, cardID, "k1", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 8000, "lnurlp://vm-1.lnvps.cloud/refund/"+ownToken)
	_, out := w.do("GET", "/api/v1/pos/sales/"+id, nil)
	if ra, _ := theSale(out)["returnAddress"].(map[string]any); ra["card"].(map[string]any)["name"] != "Daily" {
		t.Fatalf("returnAddress: %v", theSale(out))
	}
	before := w.balance(store.CardAccount(cardID))
	status, out := w.refund(id, map[string]any{"id": "r1", "amountMsat": 8_000_000, "from": "shop"})
	if status != 200 || out["status"] != "sent" || out["feeMsat"] != 0.0 {
		t.Fatalf("%d %v", status, out)
	}
	if w.balance(store.CardAccount(cardID)) != before+8_000_000 || w.balance(store.Shop) != 0 || len(w.f.Paid()) != 0 {
		t.Fatalf("card %d shop %d paid %d", w.balance(store.CardAccount(cardID)), w.balance(store.Shop), len(w.f.Paid()))
	}
	if status, out := w.refund(id, map[string]any{"id": "r1", "amountMsat": 8_000_000, "from": "shop"}); status != 200 || out["status"] != "sent" {
		t.Fatalf("again: %d %v", status, out)
	}
}

// A card of this wallet wiped since the sale is no return
// address (the wallet then asks for an invoice), and a refund to its link
// is refused, not booked.
func TestRefundOwnTokenWipedCard(t *testing.T) {
	w := moneySetup(t)
	ctx := context.Background()
	if err := w.st.NewRefundLink(ctx, ownToken, cardID, "k1", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "lnurlp://vm-1.lnvps.cloud/refund/"+ownToken)
	if _, err := w.st.StartWipe(ctx, cardID); err != nil {
		t.Fatal(err)
	}
	_, out := w.do("GET", "/api/v1/pos/sales/"+id, nil)
	if hasKey(theSale(out), "returnAddress") {
		t.Fatalf("a wiped card offered as the return address: %v", theSale(out))
	}
	if status, out := w.refund(id, map[string]any{"id": "r1", "amountMsat": 1_000_000, "from": "pool"}); status != 409 || out["error"] != "cannot_receive" {
		t.Fatalf("%d %v", status, out)
	}
}

func TestRefundRefusesOwnHostNonToken(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "")
	for _, to := range []string{"https://vm-1.lnvps.cloud/.well-known/lnurlp/pool", "https://VM-1.LNVPS.CLOUD/refund/" + ownToken, "pool@vm-1.lnvps.cloud"} {
		if status, out := w.refund(id, map[string]any{"id": uuid(), "amountMsat": 1_000_000, "from": "pool", "to": to}); status != 409 || out["error"] != "bad_return_link" {
			t.Fatalf("%s: %d %v", to, status, out)
		}
	}
	if len(w.f.Paid()) != 0 {
		t.Fatal("paid ourselves")
	}
}

func TestRefundRouteNotForPos(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "")
	if status, out := till.do("POST", "/api/v1/sales/"+id+"/refund", map[string]any{"id": "r1", "amountMsat": 1_000_000, "from": "pool"}); status != http.StatusForbidden {
		t.Fatalf("%d %v", status, out)
	}
}

func TestRefundPaymentInProgress(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "")
	hung, hash := w.f.Invoice(2_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	defer w.f.Release(hash, false, 0)
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "s1", "to": hung}); status != 200 || out["status"] != "pending" {
		t.Fatalf("send: %d %v", status, out)
	}
	bolt11, _ := w.f.Invoice(1_000_000)
	if status, out := w.refund(id, map[string]any{"id": "r1", "amountMsat": 1_000_000, "from": "pool", "to": bolt11}); status != 409 || out["error"] != "payment_in_progress" {
		t.Fatalf("%d %v", status, out)
	}
}

// The phone gave up mid-flight (once forgets the id): the same id again
// answers the payment it made, and pays once.
func TestRefundRetryAfterDrop(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := w.paidWithLink(till, 1000, "")
	bolt11, hash := w.f.Invoice(1_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	body := map[string]any{"id": "r1", "amountMsat": 1_000_000, "from": "pool", "to": bolt11}
	if _, _, err := w.doWith(&http.Client{Timeout: 300 * time.Millisecond}, "POST", "/api/v1/sales/"+id+"/refund", body); err == nil {
		t.Fatal("the phone's request didn't time out")
	}
	var status int
	var out map[string]any
	for i := 0; i < 50; i++ {
		if status, out = w.refund(id, body); status != 409 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status != 200 || out["status"] != "pending" || out["paymentHash"] != hash {
		t.Fatalf("retry: %d %v", status, out)
	}
	w.f.Release(hash, false, 0)
}

// A refund from Shop is followed by GET /send/{id}: the held read hears
// Shop's ring, not only Pool's.
func TestSendStateFollowsShopRefund(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	w.paidWithLink(till, 1000, "") // Shop's float for the fee budget
	id := w.paidWithLink(till, 1000, "")
	bolt11, hash := w.f.Invoice(1_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	w.money.SendWait = 200 * time.Millisecond
	if status, out := w.refund(id, map[string]any{"id": "r1", "amountMsat": 1_000_000, "from": "shop", "to": bolt11}); status != 200 || out["status"] != "pending" {
		t.Fatalf("%d %v", status, out)
	}
	go func() {
		time.Sleep(300 * time.Millisecond)
		w.f.Release(hash, false, 0)
	}()
	start := time.Now()
	status, out := w.do("GET", "/api/v1/send/r1?wait=20", nil)
	if status != 200 || out["status"] != "sent" || time.Since(start) > 5*time.Second {
		t.Fatalf("%d %v after %v", status, out, time.Since(start))
	}
}
