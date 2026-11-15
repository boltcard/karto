package api

import (
	"context"
	"crypto/rand"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/store"
)

// uuid is a sale's id as a PoS phone makes one.
func uuid() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func sell(c *client, id string, sat any) (int, map[string]any) {
	return c.do("POST", "/api/v1/pos/sales", map[string]any{"id": id, "amountSat": sat})
}

func theSale(out map[string]any) map[string]any {
	s, _ := out["sale"].(map[string]any)
	return s
}

// A PoS phone makes a sale: an invoice of phoenixd's for
// the amount, tied to the sale, good for 10 minutes.
func TestMakingASale(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := uuid()
	status, out := sell(till, id, 2500)
	s := theSale(out)
	if status != 201 || s["id"] != id || s["amountMsat"] != 2_500_000.0 || s["state"] != "open" || s["method"] != "" ||
		hasKey(s, "paidAt") || hasKey(s, "receivedMsat") {
		t.Fatalf("made: %d %v", status, out)
	}
	if d := s["device"].(map[string]any); d["keyId"] != till.keyID || d["name"] != "Till 1" {
		t.Fatalf("device: %v", s["device"])
	}
	now := time.Now().Unix()
	if created, expires := int64(s["created"].(float64)), int64(s["expires"].(float64)); now-created > 5 || expires-created < 595 || expires-created > 605 {
		t.Fatalf("created %d, expires %d, now %d", created, expires, now)
	}
	invoice := s["invoice"].(string)
	info, ok := w.f.InvoiceInfo(invoice)
	if !ok || info.AmountMsat != 2_500_000 || info.Description != "Karto PoS" || info.ExternalID != "sale:"+id || info.ExpirySeconds != 600 {
		t.Fatalf("phoenixd's invoice: %+v %v", info, ok)
	}
	// The same request again is the same sale: no second invoice.
	status, out = sell(till, id, 2500)
	if status != 200 || theSale(out)["invoice"] != invoice || w.f.InvoiceCount() != 1 {
		t.Fatalf("again: %d %v, %d invoices", status, out, w.f.InvoiceCount())
	}
	// The id can't become another sale.
	if status, out := sell(till, id, 2501); status != 409 || out["error"] != "sale_exists" {
		t.Fatalf("the id for another amount: %d %v", status, out)
	}
	other := w.device(store.RolePos, "Till 2")
	if status, out := sell(other, id, 2500); status != 409 || out["error"] != "sale_exists" {
		t.Fatalf("the id from another phone: %d %v", status, out)
	}
	// Karto Wallet has no till.
	if status, out := sell(w.client, uuid(), 2500); status != 403 || out["error"] != "not_allowed" {
		t.Fatalf("an owner selling: %d %v", status, out)
	}
	if w.f.InvoiceCount() != 1 {
		t.Fatalf("%d invoices after the refusals, want 1", w.f.InvoiceCount())
	}
}

func TestASalesIDAndAmount(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	for _, id := range []string{"", "days", "1234", "0A000000-0000-4000-8000-00000000000A", "0a000000-0000-4000-8000-00000000000", "0a000000_0000_4000_8000_00000000000a"} {
		if status, out := sell(till, id, 100); status != 400 {
			t.Fatalf("id %q: %d %v", id, status, out)
		}
	}
	for _, sat := range []any{0, -1, 2_000_001, 1.5, "100", nil} {
		if status, out := sell(till, uuid(), sat); status != 400 {
			t.Fatalf("amount %v: %d %v", sat, status, out)
		}
	}
	if w.f.InvoiceCount() != 0 {
		t.Fatalf("%d invoices for refused sales", w.f.InvoiceCount())
	}
	for _, sat := range []int{1, 2_000_000} {
		if status, out := sell(till, uuid(), sat); status != 201 || theSale(out)["amountMsat"] != float64(sat)*1000 {
			t.Fatalf("amount %d: %d %v", sat, status, out)
		}
	}
}

// phoenixd not answering: no sale is kept. Spending paused, no channel: sales are made all the same.
func TestASaleNeedsOnlyPhoenixd(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	id := uuid()
	w.f.SetDown(true)
	if status, out := sell(till, id, 100); status != 503 || out["error"] != "no_invoice" {
		t.Fatalf("phoenixd down: %d %v", status, out)
	}
	w.f.SetDown(false)
	if status, _ := till.do("GET", "/api/v1/pos/sales/"+id, nil); status != 404 {
		t.Fatalf("the sale that got no invoice: %d", status)
	}
	// The fake has no channel here, and now the books disagree with it too.
	w.st.Credit(context.Background(), store.Pool, 999_000_000, "too-much", "")
	if err := w.l.Reconcile(context.Background()); err == nil {
		t.Fatal("the books still add up")
	}
	if status, out := sell(till, id, 100); status != 201 {
		t.Fatalf("paused, no channel: %d %v", status, out)
	}
}

// A full channel is no reason to refuse a sale: phoenixd
// takes every payment, and cardd doesn't ask about the room.
func TestASaleIsMadeWithNoRoom(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	w.f.Set(func(f *phoenixdtest.Fake) { f.Channel, f.InboundSat = true, 0 })
	info := w.f.Calls("/getinfo")
	if status, out := sell(till, uuid(), 2500); status != 201 || theSale(out)["state"] != "open" {
		t.Fatalf("with no room: %d %v", status, out)
	}
	if w.f.Calls("/getinfo") != info {
		t.Fatal("making a sale asked phoenixd about its channels")
	}
}

// One open sale a phone; anyone of the shop reads a sale; only its own phone
// says a card took it or cancels it.
func TestReadingCardAndCancel(t *testing.T) {
	w := moneySetup(t)
	till1, till2 := w.device(store.RolePos, "Till 1"), w.device(store.RolePos, "Till 2")
	first, second, theirs := uuid(), uuid(), uuid()
	sell(till1, first, 1000)
	sell(till2, theirs, 3000)
	sell(till1, second, 2000)
	read := func(c *client, id string) map[string]any {
		t.Helper()
		status, out := c.do("GET", "/api/v1/pos/sales/"+id, nil)
		if status != 200 {
			t.Fatalf("read %s: %d %v", id, status, out)
		}
		return theSale(out)
	}
	if s := read(till2, first); s["state"] != "cancelled" || hasKey(s, "invoice") {
		t.Fatalf("the phone's earlier sale: %v", s)
	}
	if s := read(till2, second); s["state"] != "open" || !hasKey(s, "invoice") || hasKey(s, "txId") {
		t.Fatalf("another phone's open sale: %v", s)
	}
	if s := read(w.client, theirs); s["state"] != "open" || s["amountMsat"] != 3_000_000.0 {
		t.Fatalf("an owner reading: %v", s)
	}
	if status, _ := till1.do("GET", "/api/v1/pos/sales/"+uuid(), nil); status != 404 {
		t.Fatalf("an unknown sale: %d", status)
	}
	// An id that isn't a UUID's shape never reaches the store: 400, on each of the three routes.
	for _, bad := range []string{"1234", "0A000000-0000-4000-8000-00000000000A", "x'--"} {
		if status, _ := till1.do("GET", "/api/v1/pos/sales/"+bad, nil); status != 400 {
			t.Fatalf("read %q: %d", bad, status)
		}
		for _, step := range []string{"card", "cancel"} {
			if status, _ := till1.do("POST", "/api/v1/pos/sales/"+bad+"/"+step, nil); status != 400 {
				t.Fatalf("%s %q: %d", step, bad, status)
			}
		}
	}
	for _, step := range []string{"card", "cancel"} {
		path := "/api/v1/pos/sales/" + second + "/" + step
		if status, out := till2.do("POST", path, nil); status != 403 || out["error"] != "not_allowed" {
			t.Fatalf("%s by another phone: %d %v", step, status, out)
		}
		if status, out := w.do("POST", path, nil); status != 403 || out["error"] != "not_allowed" {
			t.Fatalf("%s by an owner: %d %v", step, status, out)
		}
		if status, _ := till1.do("POST", "/api/v1/pos/sales/"+uuid()+"/"+step, nil); status != 404 {
			t.Fatalf("%s on an unknown sale: %d", step, status)
		}
	}
	if status, out := till1.do("POST", "/api/v1/pos/sales/"+second+"/card", nil); status != 200 || theSale(out)["state"] != "open" || theSale(out)["method"] != "" {
		t.Fatalf("card: %d %v", status, out)
	}
	if status, out := till1.do("POST", "/api/v1/pos/sales/"+second+"/cancel", nil); status != 200 || theSale(out)["state"] != "cancelled" || hasKey(theSale(out), "invoice") {
		t.Fatalf("cancel: %d %v", status, out)
	}
	if status, out := till1.do("POST", "/api/v1/pos/sales/"+second+"/cancel", nil); status != 200 || theSale(out)["state"] != "cancelled" {
		t.Fatalf("cancel twice: %d %v", status, out)
	}
	if s := read(till1, theirs); s["state"] != "open" {
		t.Fatalf("the other phone's sale after all that: %v", s)
	}
}

// A sale reads paid as soon as phoenixd says its invoice is, by its payment
// hash: a till doesn't wait for the books, which may take their time over
// what the payment brought in (the fee credit's wait). The books' figures
// (txId, what Shop received) come once the payment is credited.
func TestASaleReadsPaidFromItsInvoice(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	read := func(c *client, id string) map[string]any {
		t.Helper()
		status, out := c.do("GET", "/api/v1/pos/sales/"+id, nil)
		if status != 200 {
			t.Fatalf("read %s: %d %v", id, status, out)
		}
		return theSale(out)
	}
	id := uuid()
	_, out := sell(till, id, 2500)
	invoice := theSale(out)["invoice"].(string)
	info, _ := w.f.InvoiceInfo(invoice)
	till.do("POST", "/api/v1/pos/sales/"+id+"/card", nil)
	if s := read(till, id); s["state"] != "open" {
		t.Fatalf("before the payment: %v", s)
	}
	// phoenixd has the payment; nothing has credited it (no webhook here).
	before := time.Now().Unix()
	w.f.Receive(invoice, 2500, 0)
	s := read(till, id)
	if s["state"] != "paid" || s["method"] != "card" || hasKey(s, "invoice") || hasKey(s, "txId") || hasKey(s, "receivedMsat") {
		t.Fatalf("paid at phoenixd, not yet in the books: %v", s)
	}
	if paidAt, _ := s["paidAt"].(float64); int64(paidAt) < before || int64(paidAt) > before+5 {
		t.Fatalf("paidAt %v, want phoenixd's time of the payment (about %d)", s["paidAt"], before)
	}
	if s := read(w.client, id); s["state"] != "paid" || hasKey(s, "receivedMsat") || hasKey(s, "txId") {
		t.Fatalf("an owner reading before the books: %v", s)
	}
	// Reading credits nothing: that is the webhook's and the sweep's.
	if b, _ := w.st.Balance(context.Background(), store.Shop); b.EntriesMsat != 0 {
		t.Fatalf("Shop holds %d msat after reads alone", b.EntriesMsat)
	}
	// Once credited, the books answer, and phoenixd is asked no more.
	if done, err := w.st.CreditSale(context.Background(), id, 2_400_000, info.PaymentHash, "received"); err != nil || !done {
		t.Fatalf("credit: %v %v", done, err)
	}
	asked := w.f.Calls("/payments/incoming/" + info.PaymentHash)
	if s := read(w.client, id); s["state"] != "paid" || s["receivedMsat"] != 2_400_000.0 || !hasKey(s, "txId") {
		t.Fatalf("after the books: %v", s)
	}
	if w.f.Calls("/payments/incoming/"+info.PaymentHash) != asked {
		t.Fatal("a sale paid in the books still asked phoenixd")
	}

	// A cancelled sale that is paid all the same reads paid; one that isn't stays cancelled.
	late := uuid()
	_, out = sell(till, late, 700)
	lateInvoice := theSale(out)["invoice"].(string)
	till.do("POST", "/api/v1/pos/sales/"+late+"/cancel", nil)
	if s := read(till, late); s["state"] != "cancelled" {
		t.Fatalf("cancelled, unpaid: %v", s)
	}
	w.f.Receive(lateInvoice, 700, 0)
	if s := read(till, late); s["state"] != "paid" || s["method"] != "qr" {
		t.Fatalf("cancelled, then paid: %v", s)
	}

	// phoenixd not answering: the books' answer, not an error.
	open := uuid()
	sell(till, open, 900)
	w.f.SetDown(true)
	if s := read(till, open); s["state"] != "open" || !hasKey(s, "invoice") {
		t.Fatalf("phoenixd down: %v", s)
	}
}

// A till may have its read of a sale held (?wait=seconds): the server answers
// at the payment, which phoenixd's webhook rings in, and otherwise looks at
// the invoice again each HeldRecheck, so a webhook that never came costs
// that long and no more; with no payment it answers when the wait is over.
func TestAHeldReadOfASale(t *testing.T) {
	w := moneySetup(t)
	w.money.Bell, w.money.HeldRecheck = NewBell(), 10*time.Second
	till := w.device(store.RolePos, "Till 1")
	type answer struct {
		sale  map[string]any
		after time.Duration
	}
	held := func(id, wait string) <-chan answer {
		t.Helper()
		out, start := make(chan answer, 1), time.Now()
		go func() {
			status, body := till.do("GET", "/api/v1/pos/sales/"+id+"?wait="+wait, nil)
			if status != 200 {
				t.Errorf("held read: %d %v", status, body)
			}
			out <- answer{theSale(body), time.Since(start)}
		}()
		return out
	}
	newSale := func(sat int) (id, invoice, hash string) {
		t.Helper()
		id = uuid()
		_, out := sell(till, id, sat)
		invoice = theSale(out)["invoice"].(string)
		info, _ := w.f.InvoiceInfo(invoice)
		return id, invoice, info.PaymentHash
	}

	// Rung in: answered at the payment, long before the wait or the next look.
	id, invoice, hash := newSale(2500)
	got := held(id, "5")
	select {
	case a := <-got:
		t.Fatalf("answered before any payment, after %v: %v", a.after, a.sale)
	case <-time.After(300 * time.Millisecond):
	}
	w.f.Receive(invoice, 2500, 0)
	w.money.Bell.Paid(hash)
	select {
	case a := <-got:
		if a.sale["state"] != "paid" || a.after > 2*time.Second {
			t.Fatalf("rung in: %v after %v", a.sale, a.after)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a rung read wasn't answered")
	}
	// A ring for another payment answers nothing.
	id, invoice, _ = newSale(700)
	got = held(id, "1")
	w.money.Bell.Paid(hash)
	if a := <-got; a.sale["state"] != "open" || a.after < 900*time.Millisecond {
		t.Fatalf("another sale's ring: %v after %v", a.sale, a.after)
	}
	w.f.Receive(invoice, 700, 0)
	// Paid already, or no wait asked: at once.
	if a := <-held(id, "5"); a.sale["state"] != "paid" || a.after > time.Second {
		t.Fatalf("already paid: %v after %v", a.sale, a.after)
	}
	id, _, _ = newSale(900)
	if a := <-held(id, "0"); a.sale["state"] != "open" || a.after > time.Second {
		t.Fatalf("wait=0: %v after %v", a.sale, a.after)
	}
	// A wait is whole seconds, none below 0; more than the most is the most.
	for _, bad := range []string{"-1", "1.5", "soon", ""} {
		if status, out := till.do("GET", "/api/v1/pos/sales/"+id+"?wait="+bad, nil); status != 400 {
			t.Fatalf("wait=%q: %d %v", bad, status, out)
		}
	}
	if d, ok := heldWait("999"); !ok || d != maxHeldWait {
		t.Fatalf("wait=999: %v %v", d, ok)
	}
}

// With no ring (the webhook never came, or there is no bell), a held read
// finds the payment at its next look.
func TestAHeldReadLooksAgainWithoutARing(t *testing.T) {
	w := moneySetup(t)
	w.money.HeldRecheck = 100 * time.Millisecond
	till := w.device(store.RolePos, "Till 1")
	id := uuid()
	_, out := sell(till, id, 700)
	invoice := theSale(out)["invoice"].(string)
	time.AfterFunc(250*time.Millisecond, func() { w.f.Receive(invoice, 700, 0) })
	start := time.Now()
	status, body := till.do("GET", "/api/v1/pos/sales/"+id+"?wait=5", nil)
	if after := time.Since(start); status != 200 || theSale(body)["state"] != "paid" || after < 250*time.Millisecond || after > 2*time.Second {
		t.Fatalf("found by looking again: %d %v after %v", status, body, after)
	}
}

// A read of an account's history can be held too (?after=<id>&wait=seconds):
// answered when the account has a transaction newer than the one named,
// which the ledger rings in when a payment out of it ends, and by a look
// each HeldRecheck besides; with nothing new, when the wait is over. It is
// how a phone that is a card learns its payment has settled without asking
// each second.
func TestAHeldReadOfAnAccountsHistory(t *testing.T) {
	w := moneySetup(t)
	w.money.Bell, w.money.HeldRecheck = NewBell(), 10*time.Second
	ctx := context.Background()
	acct := store.CardAccount(cardID)
	newest := func() int64 {
		t.Helper()
		_, out := w.do("GET", "/api/v1/accounts/"+cardID+"/history?limit=1", nil)
		return int64(out["transactions"].([]any)[0].(map[string]any)["id"].(float64))
	}
	type answer struct {
		ids   []int64
		after time.Duration
	}
	held := func(query string) <-chan answer {
		out, start := make(chan answer, 1), time.Now()
		go func() {
			status, body := w.do("GET", "/api/v1/accounts/"+cardID+"/history?"+query, nil)
			if status != 200 {
				t.Errorf("held history: %d %v", status, body)
			}
			var ids []int64
			for _, tx := range body["transactions"].([]any) {
				ids = append(ids, int64(tx.(map[string]any)["id"].(float64)))
			}
			out <- answer{ids, time.Since(start)}
		}()
		return out
	}
	first := newest()
	// Rung in: answered with the new transaction first, long before the wait or the next look.
	got := held(fmt.Sprintf("limit=5&after=%d&wait=5", first))
	select {
	case a := <-got:
		t.Fatalf("answered with nothing new, after %v: %v", a.after, a.ids)
	case <-time.After(300 * time.Millisecond):
	}
	w.st.Credit(ctx, acct, 1_000, "one-more", "")
	w.money.Bell.Changed([]store.Account{acct})
	select {
	case a := <-got:
		if len(a.ids) != 2 || a.ids[0] <= first || a.ids[1] != first || a.after > 2*time.Second {
			t.Fatalf("rung in: %v after %v", a.ids, a.after)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a rung read wasn't answered")
	}
	// Another account's ring answers nothing; with nothing new the answer comes when the wait is over.
	second := newest()
	got = held(fmt.Sprintf("after=%d&wait=1", second))
	w.money.Bell.Changed([]store.Account{store.Pool})
	if a := <-got; len(a.ids) != 2 || a.ids[0] != second || a.after < 900*time.Millisecond {
		t.Fatalf("nothing new: %v after %v", a.ids, a.after)
	}
	// Something newer already there, or no wait: at once.
	if a := <-held(fmt.Sprintf("after=%d&wait=5", first)); len(a.ids) != 2 || a.after > time.Second {
		t.Fatalf("already newer: %v after %v", a.ids, a.after)
	}
	if a := <-held(fmt.Sprintf("after=%d", second)); len(a.ids) != 2 || a.after > time.Second {
		t.Fatalf("no wait: %v after %v", a.ids, a.after)
	}
	// A wait needs the transaction it waits past; neither may be anything but a whole number, 0 or more.
	for _, bad := range []string{"wait=5", "after=x&wait=5", "after=-1&wait=5", "after=1&wait=soon", "after=1&wait=-2"} {
		if status, out := w.do("GET", "/api/v1/accounts/"+cardID+"/history?"+bad, nil); status != 400 {
			t.Fatalf("%s: %d %v", bad, status, out)
		}
	}
}

// With no ring, a held read of a history finds what is new at its next look.
func TestAHeldReadOfAHistoryLooksAgainWithoutARing(t *testing.T) {
	w := moneySetup(t)
	w.money.HeldRecheck = 100 * time.Millisecond
	acct := store.CardAccount(cardID)
	_, out := w.do("GET", "/api/v1/accounts/"+cardID+"/history?limit=1", nil)
	first := int64(out["transactions"].([]any)[0].(map[string]any)["id"].(float64))
	time.AfterFunc(250*time.Millisecond, func() { w.st.Credit(context.Background(), acct, 1_000, "one-more", "") })
	start := time.Now()
	status, body := w.do("GET", fmt.Sprintf("/api/v1/accounts/%s/history?after=%d&wait=5", cardID, first), nil)
	if after := time.Since(start); status != 200 || len(body["transactions"].([]any)) != 2 || after < 250*time.Millisecond || after > 2*time.Second {
		t.Fatalf("found by looking again: %d %v after %v", status, body, after)
	}
}

// A ring that brings nothing new (a payment out of the account was given
// back) doesn't end the listening: the next ring, for the payment that went
// through, is heard at once and not at the next look.
func TestAHeldReadHearsTheRingAfterOneThatBroughtNothing(t *testing.T) {
	w := moneySetup(t)
	w.money.Bell, w.money.HeldRecheck = NewBell(), 20*time.Second
	acct := store.CardAccount(cardID)
	_, out := w.do("GET", "/api/v1/accounts/"+cardID+"/history?limit=1", nil)
	first := int64(out["transactions"].([]any)[0].(map[string]any)["id"].(float64))
	start, answered := time.Now(), make(chan time.Duration, 1)
	go func() {
		status, body := w.do("GET", fmt.Sprintf("/api/v1/accounts/%s/history?after=%d&wait=10", cardID, first), nil)
		if status != 200 || len(body["transactions"].([]any)) != 2 {
			t.Errorf("held history: %d %v", status, body)
		}
		answered <- time.Since(start)
	}()
	time.Sleep(200 * time.Millisecond)
	w.money.Bell.Changed([]store.Account{acct}) // given back: the history has nothing new
	time.Sleep(200 * time.Millisecond)
	w.st.Credit(context.Background(), acct, 1_000, "one-more", "")
	w.money.Bell.Changed([]store.Account{acct})
	if after := <-answered; after > 5*time.Second {
		t.Fatalf("answered %v after it was asked: the second ring wasn't heard", after)
	}
}

// A change to the books answers a held read of the account's history as it
// commits: the store tells the bell, with no caller ringing. A top-up was
// found only by the read's look a second on.
func TestACreditAnswersAHeldHistoryReadAsItCommits(t *testing.T) {
	w := moneySetup(t)
	w.money.Bell, w.money.HeldRecheck = NewBell(), 20*time.Second
	w.st.Changed = w.money.Bell.Changed
	acct := store.CardAccount(cardID)
	_, out := w.do("GET", "/api/v1/accounts/"+cardID+"/history?limit=1", nil)
	first := int64(out["transactions"].([]any)[0].(map[string]any)["id"].(float64))
	start, answered := time.Now(), make(chan time.Duration, 1)
	go func() {
		status, body := w.do("GET", fmt.Sprintf("/api/v1/accounts/%s/history?after=%d&wait=10", cardID, first), nil)
		if status != 200 || len(body["transactions"].([]any)) != 2 {
			t.Errorf("held history: %d %v", status, body)
		}
		answered <- time.Since(start)
	}()
	time.Sleep(200 * time.Millisecond)
	w.st.Credit(context.Background(), acct, 1_000, "one-more", "")
	if after := <-answered; after > 5*time.Second {
		t.Fatalf("answered %v after it was asked: the credit rang nothing", after)
	}
}

// A hold opening rings its account too (the Wallet read shows the money
// held): a held read of the history finds nothing newer and goes on
// waiting, and the payment's settling then answers it.
func TestAHoldOpeningLeavesAHeldHistoryReadWaiting(t *testing.T) {
	w := moneySetup(t)
	w.money.Bell, w.money.HeldRecheck = NewBell(), 20*time.Second
	w.st.Changed = w.money.Bell.Changed
	ctx := context.Background()
	acct := store.CardAccount(cardID)
	_, out := w.do("GET", "/api/v1/accounts/"+cardID+"/history?limit=1", nil)
	first := int64(out["transactions"].([]any)[0].(map[string]any)["id"].(float64))
	start, answered := time.Now(), make(chan time.Duration, 1)
	go func() {
		w.do("GET", fmt.Sprintf("/api/v1/accounts/%s/history?after=%d&wait=10", cardID, first), nil)
		answered <- time.Since(start)
	}()
	time.Sleep(200 * time.Millisecond)
	h, err := w.st.OpenHold(ctx, store.HoldRequest{Account: acct, Kind: store.KindSpend, AmountMsat: 1_000, FeeBudgetMsat: 1_000, PaymentHash: "p1"})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case after := <-answered:
		t.Fatalf("answered %v after it was asked, by a hold opening", after)
	case <-time.After(300 * time.Millisecond):
	}
	if _, err := w.st.SettleHold(ctx, h.ID, 0); err != nil {
		t.Fatal(err)
	}
	if after := <-answered; after > 5*time.Second {
		t.Fatalf("answered %v after it was asked: the settling rang nothing", after)
	}
}

// The bell counts the changes to the books, and says the count as a rev: a
// held Wallet read answers when it has moved. A sale's ring is not a change
// to the books; a restart's revs are all new.
func TestTheBellCountsTheBooksChanges(t *testing.T) {
	b := NewBell()
	first := b.Rev()
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9]+$`).MatchString(first) {
		t.Fatalf("rev %q", first)
	}
	anyone, stopAny := b.listen(anyKey)
	defer stopAny()
	pool, stopPool := b.listen(movedKey(store.Pool))
	defer stopPool()
	shop, stopShop := b.listen(movedKey(store.Shop))
	defer stopShop()
	b.Changed([]store.Account{store.Pool})
	second := b.Rev()
	if second == first || second[:8] != first[:8] {
		t.Fatalf("rev after a change: %q, was %q", second, first)
	}
	for name, ch := range map[string]<-chan struct{}{"the books": anyone, "pool": pool} {
		select {
		case <-ch:
		default:
			t.Fatalf("%s's listener wasn't told", name)
		}
	}
	select {
	case <-shop:
		t.Fatal("shop's listener was told of pool's change")
	default:
	}
	b.Paid("h")
	if b.Rev() != second {
		t.Fatalf("a sale's ring moved the rev: %q", b.Rev())
	}
	if other := NewBell().Rev(); other[:8] == first[:8] {
		t.Fatalf("a new bell's rev %q begins as the old one's %q", other, first)
	}
	// A nil bell counts nothing and has no rev.
	var none *Bell
	none.Changed([]store.Account{store.Pool})
	if none.Rev() != "" {
		t.Fatalf("a nil bell's rev: %q", none.Rev())
	}
}

// The bell wakes the reads listening for a payment hash, each once, and
// keeps nothing for a read that stopped listening.
func TestTheSaleBell(t *testing.T) {
	b := NewBell()
	b.ring("nobody") // no one listening: nothing kept
	one, stopOne := b.listen("h")
	two, stopTwo := b.listen("h")
	other, stopOther := b.listen("x")
	defer stopOther()
	b.ring("h")
	b.ring("h") // a second ring finds them already told
	for _, ch := range []<-chan struct{}{one, two} {
		select {
		case <-ch:
		case <-time.After(time.Second):
			t.Fatal("a listener wasn't told")
		}
	}
	select {
	case <-other:
		t.Fatal("another hash's listener was told")
	default:
	}
	stopOne()
	stopTwo()
	stopOne() // twice is harmless
	if n := len(b.waiting); n != 1 {
		t.Fatalf("%d hashes still listened for, want the other one alone", n)
	}
	// A nil bell listens to nothing and rings nothing.
	var none *Bell
	none.ring("h")
	ch, stop := none.listen("h")
	stop()
	select {
	case <-ch:
		t.Fatal("a nil bell rang")
	default:
	}
}

// A phone makes at most one new sale a second; the same request again isn't a new sale.
func TestNotFasterThanOneSaleASecond(t *testing.T) {
	w := moneySetup(t)
	w.money.SaleGap = time.Second
	till1, till2 := w.device(store.RolePos, "Till 1"), w.device(store.RolePos, "Till 2")
	id := uuid()
	// An attempt phoenixd gave no invoice for isn't a sale: its retry isn't too fast.
	w.f.SetDown(true)
	if status, out := sell(till1, id, 100); status != 503 {
		t.Fatalf("phoenixd down: %d %v", status, out)
	}
	w.f.SetDown(false)
	if status, out := sell(till1, id, 100); status != 201 {
		t.Fatalf("the first: %d %v", status, out)
	}
	if status, out := sell(till1, uuid(), 100); status != 429 || out["error"] != "slow_down" {
		t.Fatalf("a second at once: %d %v", status, out)
	}
	if status, out := sell(till1, id, 100); status != 200 {
		t.Fatalf("the first again: %d %v", status, out)
	}
	if status, out := sell(till2, uuid(), 100); status != 201 {
		t.Fatalf("another phone at the same moment: %d %v", status, out)
	}
	time.Sleep(1100 * time.Millisecond)
	if status, out := sell(till1, uuid(), 100); status != 201 {
		t.Fatalf("after the gap: %d %v", status, out)
	}
	if w.f.InvoiceCount() != 3 {
		t.Fatalf("%d invoices, want 3", w.f.InvoiceCount())
	}
}

// soldAndPaid makes a sale and credits it as phoenixd's payment would be.
func (w *moneyWorld) soldAndPaid(c *client, sat, receivedSat int64) string {
	w.t.Helper()
	id := uuid()
	status, out := sell(c, id, sat)
	if status != 201 {
		w.t.Fatalf("sale: %d %v", status, out)
	}
	info, _ := w.f.InvoiceInfo(theSale(out)["invoice"].(string))
	if done, err := w.st.CreditSale(context.Background(), id, receivedSat*1000, info.PaymentHash, "received"); err != nil || !done {
		w.t.Fatalf("credit: %v %v", done, err)
	}
	return id
}

// The shop's paid sales as its phones and its owner list them: a PoS phone
// the sales it took, the owner every phone's, with what Shop received.
func TestListingPaidSales(t *testing.T) {
	w := moneySetup(t)
	till1, till2 := w.device(store.RolePos, "Till 1"), w.device(store.RolePos, "Till 2")
	a := w.soldAndPaid(till1, 1000, 1000)
	b := w.soldAndPaid(till2, 2000, 0) // all of it toward more room
	c := w.soldAndPaid(till1, 4000, 4000)
	sell(till1, uuid(), 9000) // open: not in the list
	list := func(cl *client, query string) []any {
		t.Helper()
		status, out := cl.do("GET", "/api/v1/pos/sales"+query, nil)
		if status != 200 {
			t.Fatalf("list%s: %d %v", query, status, out)
		}
		return out["sales"].([]any)
	}
	sales := list(till1, "")
	if len(sales) != 2 {
		t.Fatalf("%d sales, want till 1's 2 paid", len(sales))
	}
	for i, want := range []string{c, a} {
		s := sales[i].(map[string]any)
		if s["id"] != want || s["state"] != "paid" || s["method"] != "qr" || !hasKey(s, "paidAt") || hasKey(s, "invoice") || hasKey(s, "receivedMsat") {
			t.Fatalf("sale %d as a PoS phone sees it: %v", i, s)
		}
	}
	theirs := list(till2, "")
	if len(theirs) != 1 {
		t.Fatalf("till 2: %v, want its one sale", theirs)
	}
	if s := theirs[0].(map[string]any); s["id"] != b || s["amountMsat"] != 2_000_000.0 || s["device"].(map[string]any)["name"] != "Till 2" {
		t.Fatalf("the sale credited nothing, to its till: %v", s)
	}
	owners := list(w.client, "")
	if len(owners) != 3 || owners[0].(map[string]any)["id"] != c || owners[2].(map[string]any)["id"] != a {
		t.Fatalf("the owner: %v, want every phone's 3", owners)
	}
	if s := owners[1].(map[string]any); s["receivedMsat"] != 0.0 || s["amountMsat"] != 2_000_000.0 {
		t.Fatalf("the same sale to its owner: %v", s)
	}
	if s := owners[0].(map[string]any); s["receivedMsat"] != 4_000_000.0 {
		t.Fatalf("the newest to its owner: %v", s)
	}
	// A page at a time, by the last one's place in the ledger.
	page := list(w.client, "?limit=2")
	if len(page) != 2 || page[1].(map[string]any)["id"] != b {
		t.Fatalf("first page: %v", page)
	}
	// The page's last sale carries that place, so a phone can ask for the next.
	last, _ := w.st.SaleByID(context.Background(), b)
	if got := page[1].(map[string]any)["txId"]; got != float64(last.TxID) || last.TxID == 0 {
		t.Fatalf("a paid sale's txId %v, want %d", got, last.TxID)
	}
	rest := list(w.client, fmt.Sprintf("?limit=2&before=%.0f", page[1].(map[string]any)["txId"]))
	if len(rest) != 1 || rest[0].(map[string]any)["id"] != a {
		t.Fatalf("second page: %v", rest)
	}
	// A till's pages are its own sales'.
	mine := list(till1, "?limit=1")
	if len(mine) != 1 || mine[0].(map[string]any)["id"] != c {
		t.Fatalf("till 1's first page: %v", mine)
	}
	more := list(till1, fmt.Sprintf("?limit=1&before=%.0f", mine[0].(map[string]any)["txId"]))
	if len(more) != 1 || more[0].(map[string]any)["id"] != a {
		t.Fatalf("till 1's second page: %v", more)
	}
	if got := list(w.client, "?limit=0"); len(got) != 3 {
		t.Fatalf("a limit out of range: %d sales", len(got))
	}
	// The wallet's counts follow.
	_, out := w.do("GET", "/api/v1/wallet", nil)
	if shop := out["shop"].(map[string]any); shop["sales"] != 3.0 || shop["balanceMsat"] != 5_000_000.0 || shop["phones"] != 2.0 {
		t.Fatalf("the wallet's shop: %v", shop)
	}
	_, out = w.do("GET", "/api/v1/shop/phones", nil)
	for _, p := range out["phones"].([]any) {
		p := p.(map[string]any)
		want := map[string]float64{"Till 1": 2, "Till 2": 1}[p["name"].(string)]
		if p["sales"] != want || !hasKey(p, "lastSale") {
			t.Fatalf("phone %v, want %v sales", p, want)
		}
	}
}

// Paid sales by the phone's local day: a PoS phone counts its own, the owner
// every phone's.
func TestSalesByDay(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	if status, out := till.do("GET", "/api/v1/pos/sales/days?offset=0", nil); status != 200 || len(out["days"].([]any)) != 0 {
		t.Fatalf("no sales: %d %v", status, out)
	}
	w.soldAndPaid(till, 1000, 1000)
	w.soldAndPaid(till, 2500, 0)
	other := w.device(store.RolePos, "Till 2")
	w.soldAndPaid(other, 4000, 4000)
	for _, c := range []struct {
		who          *client
		count, total float64
	}{{till, 2, 3_500_000}, {other, 1, 4_000_000}, {w.client, 3, 7_500_000}} {
		// Fourteen hours east every sale made now is in one local day, which began within the last 24 hours.
		status, out := c.who.do("GET", "/api/v1/pos/sales/days?offset=840&limit=5", nil)
		days, _ := out["days"].([]any)
		if status != 200 || len(days) != 1 {
			t.Fatalf("days: %d %v", status, out)
		}
		d := days[0].(map[string]any)
		start := int64(d["day"].(float64))
		if d["count"] != c.count || d["totalMsat"] != c.total || (start+840*60)%86400 != 0 || time.Now().Unix()-start < 0 || time.Now().Unix()-start >= 86400 {
			t.Fatalf("the day, want %v sales of %v msat: %v", c.count, c.total, d)
		}
	}
	for _, bad := range []string{"", "?offset=x", "?offset=841", "?offset=-841", "?offset=1.5"} {
		if status, out := till.do("GET", "/api/v1/pos/sales/days"+bad, nil); status != 400 {
			t.Fatalf("days%s: %d %v", bad, status, out)
		}
	}
	if status, out := till.do("GET", "/api/v1/pos/sales/days?offset=-840&limit=1000", nil); status != 200 {
		t.Fatalf("a limit out of range: %d %v", status, out)
	}
}

// History as the app reads it: a move names its other
// account as the API names accounts, and a sale its phone, way of paying
// and price; entries of other kinds have neither field.
func TestHistoryNamesTheOtherAccountAndTheSale(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	w.soldAndPaid(till, 2500, 2000)
	move := func(id, from, to string) {
		t.Helper()
		if status, out := w.do("POST", "/api/v1/move", map[string]any{"id": id, "from": from, "to": to, "amountMsat": 100_000}); status != 200 {
			t.Fatalf("move %s to %s: %d %v", from, to, status, out)
		}
	}
	move("m1", "shop", "pool")
	move("m2", "pool", cardID)
	move("m3", cardID, "hosting")
	history := func(account string) []map[string]any {
		t.Helper()
		status, out := w.do("GET", "/api/v1/accounts/"+account+"/history", nil)
		if status != 200 {
			t.Fatalf("%s's history: %d %v", account, status, out)
		}
		var txs []map[string]any
		for _, tx := range out["transactions"].([]any) {
			txs = append(txs, tx.(map[string]any))
		}
		return txs
	}
	shop := history("shop")
	if len(shop) != 2 || shop[0]["kind"] != "move" || shop[0]["other"] != "pool" || hasKey(shop[0], "sale") {
		t.Fatalf("shop's move: %v", shop)
	}
	s, _ := shop[1]["sale"].(map[string]any)
	if shop[1]["kind"] != "sale" || shop[1]["amountMsat"] != 2_000_000.0 || hasKey(shop[1], "other") ||
		s["method"] != "qr" || s["device"] != "Till 1" || s["priceMsat"] != 2_500_000.0 || len(s["id"].(string)) != 36 {
		t.Fatalf("shop's sale: %v", shop[1])
	}
	pool := history("pool")
	if pool[0]["other"] != cardID || pool[1]["other"] != "shop" {
		t.Fatalf("pool's moves: %v", pool[:2])
	}
	if last := pool[len(pool)-1]; last["kind"] != "topup" || hasKey(last, "other") || hasKey(last, "sale") {
		t.Fatalf("pool's top-up: %v", last)
	}
	card := history(cardID)
	if card[0]["other"] != "hosting" || card[1]["other"] != "pool" {
		t.Fatalf("the card's moves: %v", card[:2])
	}
	if hosting := history("hosting"); hosting[0]["other"] != cardID {
		t.Fatalf("hosting's move: %v", hosting[0])
	}
}

// A read of the wallet can be held (?since=<rev>&wait=seconds): answered at
// once when the books have changed since the rev it was given, and otherwise
// when they do, or when the wait is over. It is how the Wallet page shows
// money as it arrives without asking each second.
func TestAHeldReadOfTheWallet(t *testing.T) {
	w := moneySetup(t)
	w.money.Bell, w.money.HeldRecheck = NewBell(), 20*time.Second
	w.st.Changed = w.money.Bell.Changed
	ctx := context.Background()
	type answer struct {
		rev   string
		pool  float64
		after time.Duration
	}
	read := func(query string) answer {
		t.Helper()
		start := time.Now()
		status, out := w.do("GET", "/api/v1/wallet"+query, nil)
		if status != 200 {
			t.Errorf("wallet%s: %d %v", query, status, out)
			return answer{}
		}
		rev, _ := out["rev"].(string)
		return answer{rev, out["pool"].(map[string]any)["balanceMsat"].(float64), time.Since(start)}
	}
	held := func(query string) <-chan answer {
		out := make(chan answer, 1)
		go func() { out <- read(query) }()
		return out
	}
	// As today, with the rev: the count of the books' changes.
	first := read("")
	if first.rev == "" || first.rev != w.money.Bell.Rev() || first.pool != 50_000_000 {
		t.Fatalf("a plain read: %+v, the bell's rev %q", first, w.money.Bell.Rev())
	}
	// Held, and answered as a credit commits: long before the wait, with the new balance and a new rev.
	got := held("?since=" + first.rev + "&wait=10")
	select {
	case a := <-got:
		t.Fatalf("answered with nothing new, after %v: %+v", a.after, a)
	case <-time.After(300 * time.Millisecond):
	}
	w.st.Credit(ctx, store.Pool, 3_000_000, "one-more", "")
	second := <-got
	if second.rev == first.rev || second.pool != 53_000_000 || second.after > 5*time.Second {
		t.Fatalf("rung in: %+v", second)
	}
	// A rev from before the last change: at once.
	if a := read("?since=" + first.rev + "&wait=10"); a.rev != second.rev || a.after > time.Second {
		t.Fatalf("behind: %+v", a)
	}
	// With nothing new the answer comes when the wait is over, as it then reads.
	if a := read("?since=" + second.rev + "&wait=1"); a.rev != second.rev || a.after < 900*time.Millisecond {
		t.Fatalf("nothing new: %+v", a)
	}
	// No wait: at once, whatever since says.
	if a := read("?since=" + second.rev); a.rev != second.rev || a.after > time.Second {
		t.Fatalf("no wait: %+v", a)
	}
	// A wait needs the rev it waits past, and each has its shape.
	for _, bad := range []string{"?wait=5", "?since=x&wait=5", "?since=zzzzzzzz-1&wait=5", "?since=0123abcd-&wait=5", "?since=" + second.rev + "&wait=soon",
		"?since=" + second.rev + "&wait=-2", "?since=0123abcd-" + strings.Repeat("1", 60) + "&wait=5", "?since=x"} {
		if status, out := w.do("GET", "/api/v1/wallet"+bad, nil); status != 400 {
			t.Fatalf("%s: %d %v", bad, status, out)
		}
	}
}

// The rev a wallet's answer carries is read before its balances: a change
// that commits while the answer is being made has the next ask, made with
// that rev, answered at once. No change is missed between two asks.
func TestAWalletsRevIsReadBeforeItsBalances(t *testing.T) {
	w := moneySetup(t)
	w.money.Bell, w.money.HeldRecheck = NewBell(), 20*time.Second
	w.st.Changed = w.money.Bell.Changed
	before := w.money.Bell.Rev()
	liquidity, once := w.money.Liquidity, false
	// A top-up lands while the answer is being made.
	w.money.Liquidity = func(ctx context.Context) (phoenixd.Liquidity, error) {
		if !once {
			once = true
			w.st.Credit(ctx, store.Pool, 3_000_000, "meanwhile", "")
		}
		return liquidity(ctx)
	}
	status, out := w.do("GET", "/api/v1/wallet", nil)
	if status != 200 || out["rev"] != before || w.money.Bell.Rev() == before {
		t.Fatalf("%d, rev %v; it was %q before and the bell's is now %q", status, out["rev"], before, w.money.Bell.Rev())
	}
	start := time.Now()
	status, out = w.do("GET", "/api/v1/wallet?since="+before+"&wait=10", nil)
	if after := time.Since(start); status != 200 || after > 2*time.Second || out["pool"].(map[string]any)["balanceMsat"] != 53_000_000.0 {
		t.Fatalf("the next ask: %d after %v, %v", status, after, out["pool"])
	}
}

// With no bell (a server run without one) the wallet has no rev, and a
// read asking to be held is answered at once.
func TestAWalletWithNoBellHasNoRev(t *testing.T) {
	w := moneySetup(t)
	w.money.Bell = nil
	if status, out := w.do("GET", "/api/v1/wallet", nil); status != 200 || out["rev"] != nil {
		t.Fatalf("%d, rev %v", status, out["rev"])
	}
	start := time.Now()
	if status, _ := w.do("GET", "/api/v1/wallet?since=0123abcd-4&wait=10", nil); status != 200 || time.Since(start) > 2*time.Second {
		t.Fatalf("%d after %v", status, time.Since(start))
	}
}
