package lnurl_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/cardkeys"
	"github.com/boltcard/karto/server/internal/cards"
	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/lnurl"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/sun"
)

var (
	issuer, _ = hex.DecodeString("00000000000000000000000000000001")
	uid, _    = hex.DecodeString("04a39493cc8680")
)

const cardID = "e07ce1279d980ecb892a81924b67bf18" // cardkeys.ID(issuer, uid)

type world struct {
	t       *testing.T
	st      *store.Store
	f       *phoenixdtest.Fake
	l       *ledger.Ledger
	s       *lnurl.Server
	pub     *httptest.Server // the public routes
	hook    *httptest.Server // phoenixd's webhook, cardd's internal port
	counter uint32
}

// setup: an active card "Daily" with 100k sat, phoenixd holding the same.
func setup(t *testing.T) *world {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "cardd.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	svc, _ := cards.New(st, issuer, "vm-1.lnvps.cloud")
	st.ReserveCard(ctx, cardID, "Daily", "")
	st.ActivateCard(ctx, cardID, 1)
	st.Credit(ctx, store.CardAccount(cardID), 100_000_000, "first", "")
	f := phoenixdtest.New()
	t.Cleanup(f.Close)
	f.BalanceSat, f.Channel = 100_000, true
	client := phoenixd.New(f.URL, phoenixdtest.Password)
	logger := log.New(io.Discard, "", 0)
	l := ledger.New(st, client, logger)
	if err := l.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	// The wait for phoenixd's fee credit to rise is 5 s in cardd; the fake shows a rise after 20 ms.
	s := &lnurl.Server{Cards: svc, Store: st, Ledger: l, Invoices: client, Host: "vm-1.lnvps.cloud", Log: logger, Now: time.Now,
		Wait: 300 * time.Millisecond, Poll: 5 * time.Millisecond}
	mux := http.NewServeMux()
	s.Routes(mux)
	w := &world{t: t, st: st, f: f, l: l, s: s, pub: httptest.NewServer(mux), hook: httptest.NewServer(s.Webhook(phoenixdtest.WebhookSecret)), counter: 1}
	t.Cleanup(w.pub.Close)
	t.Cleanup(w.hook.Close)
	f.WebhookURL = w.hook.URL
	return w
}

// get fetches a public URL (the path part of an https://vm-1.lnvps.cloud/... callback).
func (w *world) get(rawURL string) map[string]any {
	w.t.Helper()
	u, _ := url.Parse(rawURL)
	resp, err := http.Get(w.pub.URL + u.RequestURI())
	if err != nil {
		w.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return out
}

// tap is what a terminal reads from the card: the next p and c.
func (w *world) tap() string {
	w.t.Helper()
	w.counter++
	k1, _ := cardkeys.K1(issuer)
	keys, _ := cardkeys.Derive(issuer, uid, 0)
	p, c, _ := sun.Build(k1, keys.K2, uid, w.counter, [5]byte{1, 2, 3, 4, 5})
	return "/ln?p=" + strings.ToUpper(hex.EncodeToString(p)) + "&c=" + strings.ToUpper(hex.EncodeToString(c))
}

func (w *world) balance(a store.Account) int64 {
	b, _ := w.st.Balance(context.Background(), a)
	return b.AvailableMsat()
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("never: %s", what)
}

func TestTopUpByAddress(t *testing.T) {
	w := setup(t)
	pr := w.get("/.well-known/lnurlp/pool")
	if pr["tag"] != "payRequest" || pr["callback"] != "https://vm-1.lnvps.cloud/lnurlp/pool/cb" || pr["minSendable"] != 1000.0 {
		t.Fatalf("payRequest: %v", pr)
	}
	meta := pr["metadata"].(string)
	if !strings.Contains(meta, `"text/identifier","pool@vm-1.lnvps.cloud"`) {
		t.Fatalf("metadata: %s", meta)
	}
	cb := w.get(pr["callback"].(string) + "?amount=30000000")
	bolt11, _ := cb["pr"].(string)
	inv, err := phoenixd.New(w.f.URL, phoenixdtest.Password).DecodeInvoice(context.Background(), bolt11)
	sum := sha256.Sum256([]byte(meta))
	if err != nil || inv.Description != "" || inv.DescriptionHash != hex.EncodeToString(sum[:]) || inv.AmountMsat != 30_000_000 {
		t.Fatalf("invoice: %+v %v", inv, err)
	}
	// The first top-up opens phoenixd's channel: of 30,000 sat, 21,411 go to
	// fees and phoenixd reports the 8,589 that arrived.
	w.f.Receive(bolt11, 8_589, 21_411_000)
	eventually(t, "pool credited", func() bool { return w.balance(store.Pool) == 8_589_000 })
	w.f.SendWebhook(w.hook.URL, inv.PaymentHash, phoenixdtest.WebhookSecret) // again: credited once
	if got := w.balance(store.Pool); got != 8_589_000 {
		t.Fatalf("after a repeated webhook: %d", got)
	}
}

func TestACardsAddressTakesTopUpsOnlyWhileItCan(t *testing.T) {
	w := setup(t)
	name := "c" + cardID[:10]
	if got := lnurl.Address("vm-1.lnvps.cloud", store.CardAccount(cardID)); got != name+"@vm-1.lnvps.cloud" {
		t.Fatalf("address %s", got)
	}
	if pr := w.get("/.well-known/lnurlp/" + name); !strings.Contains(pr["metadata"].(string), "Top up Daily") {
		t.Fatalf("card payRequest: %v", pr)
	}
	w.st.StartWipe(context.Background(), cardID)
	if pr := w.get("/.well-known/lnurlp/" + name); pr["status"] != "ERROR" {
		t.Fatalf("a wiped card took top-ups: %v", pr)
	}
	if pr := w.get("/.well-known/lnurlp/nobody"); pr["status"] != "ERROR" {
		t.Fatalf("unknown name: %v", pr)
	}
}

func TestTopUpAmountChecks(t *testing.T) {
	w := setup(t)
	for _, amt := range []string{"999", "1500", "2000001000", "x"} {
		if cb := w.get("/lnurlp/pool/cb?amount=" + amt); cb["status"] != "ERROR" {
			t.Errorf("amount %s: %v", amt, cb)
		}
	}
}

func TestWebhookChecksTheSignature(t *testing.T) {
	w := setup(t)
	w.f.WebhookURL = ""
	cb := w.get("/lnurlp/pool/cb?amount=5000000")
	w.f.Receive(cb["pr"].(string), 5000, 0)
	inv, _ := phoenixd.New(w.f.URL, phoenixdtest.Password).DecodeInvoice(context.Background(), cb["pr"].(string))
	if code, _ := w.f.SendWebhook(w.hook.URL, inv.PaymentHash, "wrong secret"); code != http.StatusUnauthorized {
		t.Fatalf("bad signature: HTTP %d", code)
	}
	if w.balance(store.Pool) != 0 {
		t.Fatal("credited on a bad signature")
	}
}

func TestSweepCatchesAMissedWebhook(t *testing.T) {
	w := setup(t)
	w.f.WebhookURL = "" // cardd was down
	cb := w.get("/lnurlp/pool/cb?amount=5000000")
	w.f.Receive(cb["pr"].(string), 5000, 0)
	for i := 0; i < 2; i++ {
		if err := w.s.Sweep(context.Background(), 0); err != nil {
			t.Fatal(err)
		}
	}
	if got := w.balance(store.Pool); got != 5_000_000 {
		t.Fatalf("pool %d", got)
	}
}

// A payment too small for the first channel goes to phoenixd's fee credit:
// phoenixd reports it like any payment, with no fees and no channel. It is
// credited as 0, by the webhook and by the sweep.
func TestFeeCreditIsCreditedAsZero(t *testing.T) {
	w := setup(t)
	w.f.Channel = false
	cb := w.get("/lnurlp/pool/cb?amount=1000000")
	w.f.ReceiveAsFeeCredit(cb["pr"].(string))
	if err := w.s.Sweep(context.Background(), 0); err != nil {
		t.Fatal(err)
	}
	if got := w.balance(store.Pool); got != 0 {
		t.Fatalf("pool %d", got)
	}
	if err := w.l.Reconcile(context.Background()); err != nil {
		t.Fatalf("the books no longer add up: %v", err)
	}
}

func TestSpendAtATerminal(t *testing.T) {
	w := setup(t)
	wr := w.get(w.tap())
	if wr["tag"] != "withdrawRequest" || wr["callback"] != "https://vm-1.lnvps.cloud/ln/cb" || wr["defaultDescription"] != "Bolt Card" {
		t.Fatalf("withdrawRequest: %v", wr)
	}
	if wr["maxWithdrawable"] != 100_000_000_000.0 { // 1 BTC: the tap says nothing about the money
		t.Fatalf("max: %v", wr["maxWithdrawable"])
	}
	bolt11, hash := w.f.Invoice(5_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{FeeMsat: 2_000})
	if ok := w.get(wr["callback"].(string) + "?k1=" + wr["k1"].(string) + "&pr=" + bolt11); ok["status"] != "OK" {
		t.Fatalf("callback: %v", ok)
	}
	eventually(t, "spend settled", func() bool { return w.balance(store.CardAccount(cardID)) == 100_000_000-5_000_000-2_000 })
	// The k1 is used up.
	if again := w.get(wr["callback"].(string) + "?k1=" + wr["k1"].(string) + "&pr=" + bolt11); again["status"] != "ERROR" {
		t.Fatalf("k1 reused: %v", again)
	}
}

func TestAReplayedTapIsRefused(t *testing.T) {
	w := setup(t)
	tap := w.tap()
	w.get(tap)
	if again := w.get(tap); again["status"] != "ERROR" || !strings.Contains(again["reason"].(string), "already used") {
		t.Fatalf("replay: %v", again)
	}
}

func TestRefusalsTheTerminalShows(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	pay := func(sat int64) map[string]any {
		t.Helper()
		wr := w.get(w.tap())
		if wr["status"] == "ERROR" {
			return wr
		}
		bolt11, _ := w.f.Invoice(sat * 1000)
		return w.get("/ln/cb?k1=" + wr["k1"].(string) + "&pr=" + bolt11)
	}
	if r := pay(20_001); !strings.Contains(r["reason"].(string), "limit per payment") {
		t.Fatalf("over per tap: %v", r)
	}
	wr := w.get(w.tap())
	if r := w.get("/ln/cb?k1=" + wr["k1"].(string) + "&pr=" + w.f.ExpiredInvoice(1000)); !strings.Contains(r["reason"].(string), "expired") {
		t.Fatalf("expired invoice: %v", r)
	}
	// One payment at a time.
	wr = w.get(w.tap())
	bolt11, hash := w.f.Invoice(1_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	w.get("/ln/cb?k1=" + wr["k1"].(string) + "&pr=" + bolt11)
	if r := pay(1000); !strings.Contains(r["reason"].(string), "in progress") {
		t.Fatalf("second payment: %v", r)
	}
	w.f.Release(hash, false, 0)
	eventually(t, "first payment settled", func() bool { h, _ := w.st.OpenHolds(ctx); return len(h) == 0 })
	w.st.FreezeCard(ctx, cardID)
	if r := pay(1000); !strings.Contains(r["reason"].(string), "frozen") {
		t.Fatalf("frozen: %v", r)
	}
	w.st.UnfreezeCard(ctx, cardID)
	w.f.BalanceSat = 1 // the books no longer add up
	w.l.Reconcile(ctx)
	if r := pay(1000); !strings.Contains(r["reason"].(string), "paused") {
		t.Fatalf("paused: %v", r)
	}
}

// A tap tells the reader nothing about the card's money (privacy, and a
// skimmed tap doesn't say how much to ask for): maxWithdrawable is always
// 1 BTC, and the balance is checked when the invoice arrives.
func TestATapRevealsNothingAboutTheMoney(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	full := w.get(w.tap())
	w.st.Move(ctx, store.CardAccount(cardID), store.Pool, 100_000_000, "") // nothing left
	empty := w.get(w.tap())
	if full["maxWithdrawable"] != 100_000_000_000.0 || empty["tag"] != "withdrawRequest" || empty["maxWithdrawable"] != full["maxWithdrawable"] {
		t.Fatalf("full %v, empty %v", full, empty)
	}
	bolt11, _ := w.f.Invoice(1_000_000)
	if r := w.get(empty["callback"].(string) + "?k1=" + empty["k1"].(string) + "&pr=" + bolt11); !strings.Contains(r["reason"].(string), "enough money") {
		t.Fatalf("empty card paid: %v", r)
	}
}

// The invoice is read before the k1 is used up: a phoenixd hiccup at that
// moment leaves the tap usable, so the terminal can try again.
func TestAPhoenixdHiccupLeavesTheTapUsable(t *testing.T) {
	w := setup(t)
	wr := w.get(w.tap())
	bolt11, _ := w.f.Invoice(1_000_000)
	cb := wr["callback"].(string) + "?k1=" + wr["k1"].(string) + "&pr=" + bolt11
	w.f.SetDown(true)
	if r := w.get(cb); r["status"] != "ERROR" {
		t.Fatalf("with phoenixd down: %v", r)
	}
	w.f.SetDown(false)
	if r := w.get(cb); r["status"] != "OK" {
		t.Fatalf("again: %v", r)
	}
}

// Shop has no Lightning address: only sales fill it.
func TestShopHasNoAddress(t *testing.T) {
	w := setup(t)
	if a := lnurl.Address("vm-1.lnvps.cloud", store.Shop); a != "" {
		t.Fatalf("shop's address is %q", a)
	}
	if pr := w.get("/.well-known/lnurlp/shop"); pr["status"] != "ERROR" {
		t.Fatalf("shop@ answered %v", pr)
	}
	if cb := w.get("/lnurlp/shop/cb?amount=5000000"); cb["status"] != "ERROR" {
		t.Fatalf("shop's callback answered %v", cb)
	}
}

const saleID = "0a000000-0000-4000-8000-00000000000a"

// aSale makes a PoS phone and an open sale of sat with an invoice of the
// fake phoenixd's, as cardd's API does.
func (w *world) aSale(sat int64) (bolt11 string) {
	w.t.Helper()
	ctx := context.Background()
	w.st.AddDevice(ctx, store.Device{KeyID: "1111111111111111", PublicKey: "0411", Name: "Till 1", Role: store.RolePos})
	bolt11, hash, err := phoenixd.New(w.f.URL, phoenixdtest.Password).CreateInvoiceDescribed(ctx, sat, "Karto PoS", "sale:"+saleID, 10*time.Minute)
	if err != nil {
		w.t.Fatal(err)
	}
	if _, err := w.st.NewSale(ctx, store.Sale{ID: saleID, Device: "1111111111111111", AmountMsat: sat * 1000, PaymentHash: hash, Invoice: bolt11,
		ExpiresAt: time.Now().Add(10 * time.Minute)}); err != nil {
		w.t.Fatal(err)
	}
	return bolt11
}

func (w *world) sale() store.Sale {
	w.t.Helper()
	s, err := w.st.SaleByID(context.Background(), saleID)
	if err != nil {
		w.t.Fatal(err)
	}
	return s
}

// A sale's payment is credited to Shop and the sale is paid, by the webhook.
func TestASaleIsPaidByTheWebhook(t *testing.T) {
	w := setup(t)
	w.f.Receive(w.aSale(2500), 2500, 0)
	eventually(t, "the sale paid", func() bool { return w.sale().State == store.SalePaid })
	if got := w.balance(store.Shop); got != 2_500_000 {
		t.Fatalf("shop %d", got)
	}
	if s := w.sale(); s.ReceivedMsat != 2_500_000 || s.Method() != "qr" {
		t.Fatalf("the sale: %+v", s)
	}
	if got := w.balance(store.Pool); got != 0 {
		t.Fatalf("a sale's money in pool: %d", got)
	}
	if err := w.l.Reconcile(context.Background()); err != nil {
		t.Fatalf("the books with a sale in them: %v", err)
	}
}

// And by the sweep when the webhook was missed, once however often it runs;
// a cancelled sale paid afterwards is paid.
func TestASaleIsPaidByTheSweepOnce(t *testing.T) {
	w := setup(t)
	w.f.WebhookURL = "" // cardd was down
	bolt11 := w.aSale(2500)
	if _, err := w.st.CancelSale(context.Background(), saleID, "1111111111111111"); err != nil {
		t.Fatal(err)
	}
	w.f.Receive(bolt11, 2500, 0)
	for i := 0; i < 3; i++ {
		if err := w.s.Sweep(context.Background(), 0); err != nil {
			t.Fatal(err)
		}
	}
	if got := w.balance(store.Shop); got != 2_500_000 {
		t.Fatalf("shop %d", got)
	}
	if s := w.sale(); s.State != store.SalePaid {
		t.Fatalf("the cancelled sale that was paid: %q", s.State)
	}
}

// A sale that paid phoenixd's fee for more room is credited what was left.
func TestASaleThatBoughtRoomIsCreditedNet(t *testing.T) {
	w := setup(t)
	w.f.Receive(w.aSale(50_000), 28_589, 21_411_000)
	eventually(t, "the sale paid", func() bool { return w.sale().State == store.SalePaid })
	if got := w.balance(store.Shop); got != 28_589_000 {
		t.Fatalf("shop %d", got)
	}
	if s := w.sale(); s.ReceivedMsat != 28_589_000 || s.AmountMsat != 50_000_000 {
		t.Fatalf("the sale: %+v", s)
	}
}

// With no channel a sale's money goes to phoenixd's fee credit:
// the sale is paid, the customer having paid, and Shop gets nothing.
func TestASaleWithNoChannelIsPaidAndCreditedNothing(t *testing.T) {
	w := setup(t)
	w.f.Channel = false
	w.f.ReceiveAsFeeCredit(w.aSale(2500))
	eventually(t, "the sale paid", func() bool { return w.sale().State == store.SalePaid })
	if s := w.sale(); s.ReceivedMsat != 0 {
		t.Fatalf("the sale: %+v", s)
	}
	if got := w.balance(store.Shop); got != 0 {
		t.Fatalf("shop %d", got)
	}
	if err := w.l.Reconcile(context.Background()); err != nil {
		t.Fatalf("the books: %v", err)
	}
}

// Money for a sale cardd has no record of reaches Shop all the same.
func TestMoneyForASaleCarddDoesNotKnow(t *testing.T) {
	w := setup(t)
	bolt11, _, err := phoenixd.New(w.f.URL, phoenixdtest.Password).CreateInvoiceDescribed(context.Background(), 700, "Karto PoS", "sale:"+saleID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	w.f.Receive(bolt11, 700, 0)
	eventually(t, "shop credited", func() bool { return w.balance(store.Shop) == 700_000 })
}

// What a payment brought in: phoenixd reports a payment
// set aside as fee credit like one that reached the balance, so cardd keeps
// count of the fee credit to tell them apart.

func (w *world) topUp(sat int64) string {
	w.t.Helper()
	cb := w.get("/lnurlp/pool/cb?amount=" + strconv.FormatInt(sat*1000, 10))
	pr, ok := cb["pr"].(string)
	if !ok {
		w.t.Fatalf("top-up invoice: %v", cb)
	}
	return pr
}

// kept is the fee credit cardd has accounted for; -1 while it has none yet.
func (w *world) kept() int64 {
	w.t.Helper()
	sat, known, err := w.st.KeptFeeCredit(context.Background())
	if err != nil {
		w.t.Fatal(err)
	}
	if !known {
		return -1
	}
	return sat
}

func (w *world) keep(sat int64) {
	w.t.Helper()
	if err := w.st.SetKeptFeeCredit(context.Background(), sat); err != nil {
		w.t.Fatal(err)
	}
}

// credited waits until the payment of bolt11 is in the books.
func (w *world) credited(bolt11 string) {
	w.t.Helper()
	info, _ := w.f.InvoiceInfo(bolt11)
	eventually(w.t, "the payment credited", func() bool {
		yes, _ := w.st.Credited(context.Background(), info.PaymentHash)
		return yes
	})
}

func (w *world) booksAddUp() {
	w.t.Helper()
	if err := w.l.Reconcile(context.Background()); err != nil {
		w.t.Fatalf("the books: %v", err)
	}
}

// A payment set aside while there is a channel: phoenixd's fee credit rises
// only after the webhook, cardd waits for it, and nothing is credited. A
// top-up and a sale alike; two in a row each find their own share.
func TestAPaymentSetAsideIsCreditedNothing(t *testing.T) {
	w := setup(t)
	w.keep(0)
	w.f.Set(func(f *phoenixdtest.Fake) { f.InboundSat = 1_000 })
	top := w.topUp(2_500)
	w.f.ReceiveAsFeeCredit(top)
	w.credited(top)
	if w.balance(store.Pool) != 0 || w.kept() != 2_500 {
		t.Fatalf("the top-up: pool %d, kept %d", w.balance(store.Pool), w.kept())
	}
	sold := w.aSale(4_000)
	w.f.ReceiveAsFeeCredit(sold)
	w.credited(sold)
	if s := w.sale(); s.State != store.SalePaid || s.ReceivedMsat != 0 || w.balance(store.Shop) != 0 || w.kept() != 6_500 {
		t.Fatalf("the sale: %+v, shop %d, kept %d", s, w.balance(store.Shop), w.kept())
	}
	w.booksAddUp()
}

// A payment the channel had room for is credited whole at once: nothing of
// it can have been set aside, and phoenixd's balance isn't even asked.
func TestAPaymentThatFitsIsCreditedAtOnce(t *testing.T) {
	w := setup(t)
	w.keep(0)
	asked := w.f.Calls("/getbalance")
	top := w.topUp(2_500)
	w.f.Receive(top, 2_500, 0)
	w.credited(top)
	// No wait: a wait always asks for the balance.
	if w.balance(store.Pool) != 2_500_000 || w.kept() != 0 || w.f.Calls("/getbalance") != asked {
		t.Fatalf("pool %d, kept %d, %d balance calls", w.balance(store.Pool), w.kept(), w.f.Calls("/getbalance")-asked)
	}
}

// Room now doesn't prove room then when cardd has just paid something out
// and the room seen is no more than that payment can have made: it waits for
// a rise, finds none, and credits whole.
func TestAfterARecentHoldThatCouldHaveMadeTheRoomCarddWaits(t *testing.T) {
	w := setup(t)
	w.keep(0)
	// 3,000 sat of room will be seen after the payment: enough for its 2,500,
	// but not without the 1,010 the payment going out may have freed.
	w.f.Set(func(f *phoenixdtest.Fake) { f.InboundSat = 5_500 })
	if _, err := w.st.OpenHold(context.Background(), store.HoldRequest{Account: store.CardAccount(cardID), Kind: store.KindSpend, AmountMsat: 1_000_000,
		FeeBudgetMsat: 10_000, PaymentHash: "going-out"}); err != nil {
		t.Fatal(err)
	}
	asked := w.f.Calls("/getbalance")
	top := w.topUp(2_500)
	start := time.Now()
	w.f.Receive(top, 2_500, 0)
	w.credited(top)
	if w.balance(store.Pool) != 2_500_000 || w.kept() != 0 || w.f.Calls("/getbalance") == asked || time.Since(start) < 300*time.Millisecond {
		t.Fatalf("pool %d, kept %d, %d balance calls, %v", w.balance(store.Pool), w.kept(), w.f.Calls("/getbalance")-asked, time.Since(start))
	}
}

// The webhook tells of a payment before it credits it (Server.Paid): a till's
// held read of the sale answers at once, however long the books take. One
// that isn't phoenixd's tells of nothing.
func TestTheWebhookTellsOfAPaymentBeforeItsCredit(t *testing.T) {
	w := setup(t)
	w.keep(0)
	w.f.Set(func(f *phoenixdtest.Fake) { f.InboundSat = 1_000 }) // no room: the credit takes the whole wait
	told := make(chan string, 4)
	w.s.Paid = func(hash string) {
		if yes, _ := w.st.Credited(context.Background(), hash); yes {
			hash = "credited before it was told: " + hash
		}
		told <- hash
	}
	sold := w.aSale(4_000)
	info, _ := w.f.InvoiceInfo(sold)
	if status, _ := w.f.SendWebhook(w.hook.URL, info.PaymentHash, "not-the-secret"); status != 401 {
		t.Fatalf("a webhook with another secret: %d", status)
	}
	select {
	case h := <-told:
		t.Fatalf("told by a webhook that isn't phoenixd's: %s", h)
	default:
	}
	go w.f.Receive(sold, 4_000, 0)
	select {
	case h := <-told:
		if h != info.PaymentHash {
			t.Fatal(h)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("not told before the credit's wait was over")
	}
	w.credited(sold)
}

// What cardd paid out counts from the payment's arrival, not from the last
// 10 seconds before its credit: a credit can run long after (queued behind
// others that waited, or the sweep's for a payment that came while cardd was
// down), and a payment out that ended in between made room all the same.
func TestWhatWasPaidOutSinceThePaymentCountsHoweverLateTheCredit(t *testing.T) {
	w := setup(t)
	w.keep(0)
	ctx := context.Background()
	// 3,000 sat of room will be seen: not enough for the payment's 2,500 without the 1,010 a payment out may have freed.
	w.f.Set(func(f *phoenixdtest.Fake) { f.InboundSat = 5_500 })
	h, err := w.st.OpenHold(ctx, store.HoldRequest{Account: store.CardAccount(cardID), Kind: store.KindSpend, AmountMsat: 1_000_000,
		FeeBudgetMsat: 10_000, PaymentHash: "went-out"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.st.SettleHold(ctx, h.ID, 2_000); err != nil {
		t.Fatal(err)
	}
	// The credit runs 20 seconds after the payment out ended, and after the payment in arrived.
	w.s.Now = func() time.Time { return time.Now().Add(20 * time.Second) }
	asked := w.f.Calls("/getbalance")
	top := w.topUp(2_500)
	start := time.Now()
	w.f.Receive(top, 2_500, 0)
	w.credited(top)
	if w.balance(store.Pool) != 2_500_000 || w.kept() != 0 || w.f.Calls("/getbalance") == asked || time.Since(start) < 300*time.Millisecond {
		t.Fatalf("pool %d, kept %d, %d balance calls, %v: credited without the wait", w.balance(store.Pool), w.kept(), w.f.Calls("/getbalance")-asked, time.Since(start))
	}
}

// A payment going out is no reason to wait when the channel had room to
// spare without it: a card of this server paying this server's own sale is
// credited at once (every such sale once took the whole wait).
func TestAfterARecentHoldWithRoomToSpareCarddDoesNotWait(t *testing.T) {
	w := setup(t)
	w.keep(0)
	if _, err := w.st.OpenHold(context.Background(), store.HoldRequest{Account: store.CardAccount(cardID), Kind: store.KindSpend, AmountMsat: 1_000_000,
		FeeBudgetMsat: 10_000, PaymentHash: "going-out"}); err != nil {
		t.Fatal(err)
	}
	asked := w.f.Calls("/getbalance")
	sold := w.aSale(1_000)
	start := time.Now()
	w.f.Receive(sold, 1_000, 0)
	w.credited(sold)
	if s := w.sale(); s.State != store.SalePaid || s.ReceivedMsat != 1_000_000 || w.balance(store.Shop) != 1_000_000 || w.kept() != 0 ||
		w.f.Calls("/getbalance") != asked || time.Since(start) >= 300*time.Millisecond {
		t.Fatalf("%+v, shop %d, kept %d, %d balance calls, %v", s, w.balance(store.Shop), w.kept(), w.f.Calls("/getbalance")-asked, time.Since(start))
	}
}

// No room for it, and no rise by the end of the wait: credited whole. (If it
// was set aside after all, the invariant pauses spending: the old failure.)
func TestNoRiseByTheEndOfTheWaitIsCreditedWhole(t *testing.T) {
	w := setup(t)
	w.keep(0)
	w.f.Set(func(f *phoenixdtest.Fake) { f.InboundSat = 1_000 })
	top := w.topUp(2_500)
	start := time.Now()
	w.f.Receive(top, 2_500, 0)
	w.credited(top)
	if w.balance(store.Pool) != 2_500_000 || w.kept() != 0 || time.Since(start) < 300*time.Millisecond {
		t.Fatalf("pool %d, kept %d, %v", w.balance(store.Pool), w.kept(), time.Since(start))
	}
	w.booksAddUp()
}

// Two payments at the same moment into a full channel, one set aside and
// one to the balance: one credit at a time, and the total is right (which of
// the two is docked can swap; the books add up either way).
func TestTwoPaymentsAtOnceAreCreditedRightInTotal(t *testing.T) {
	w := setup(t)
	w.keep(0)
	w.f.Set(func(f *phoenixdtest.Fake) { f.InboundSat = 1_000 })
	aside, whole := w.topUp(2_500), w.topUp(2_500)
	done := make(chan struct{}, 2)
	go func() { w.f.ReceiveAsFeeCredit(aside); done <- struct{}{} }()
	go func() { w.f.Receive(whole, 2_500, 0); done <- struct{}{} }()
	<-done
	<-done
	w.credited(aside)
	w.credited(whole)
	if w.balance(store.Pool) != 2_500_000 || w.kept() != 2_500 {
		t.Fatalf("pool %d, kept %d", w.balance(store.Pool), w.kept())
	}
	w.booksAddUp()
}

// Two set aside whose webhooks were missed: the sweep credits them in
// whatever order phoenixd lists them, each its own share of the rise.
func TestTwoSetAsideFoundByTheSweep(t *testing.T) {
	for _, saleFirst := range []bool{false, true} {
		w := setup(t)
		w.keep(0)
		w.f.Set(func(f *phoenixdtest.Fake) { f.InboundSat, f.WebhookURL = 1_000, "" })
		top, sold := w.topUp(2_500), w.aSale(4_000)
		// phoenixd lists them in the order they were received: the smaller first, then the larger first.
		first, second := top, sold
		if saleFirst {
			first, second = sold, top
		}
		w.f.ReceiveAsFeeCredit(first)
		time.Sleep(3 * time.Millisecond)
		w.f.ReceiveAsFeeCredit(second)
		for i := 0; i < 2; i++ {
			if err := w.s.Sweep(context.Background(), 0); err != nil {
				t.Fatal(err)
			}
		}
		if w.balance(store.Pool) != 0 || w.balance(store.Shop) != 0 || w.kept() != 6_500 || w.sale().State != store.SalePaid {
			t.Fatalf("sale first %v: pool %d, shop %d, kept %d, sale %q", saleFirst, w.balance(store.Pool), w.balance(store.Shop), w.kept(), w.sale().State)
		}
		w.booksAddUp()
	}
}

// A payment that bought room is credited what reached the balance, and the
// kept figure becomes phoenixd's, which the purchase has already lowered.
func TestAPaymentThatBoughtRoom(t *testing.T) {
	w := setup(t)
	w.keep(3_000)
	w.f.Set(func(f *phoenixdtest.Fake) { f.FeeCreditSat = 3_000 })
	top := w.topUp(50_000)
	w.f.ReceiveBuyingRoom(top, 21_411_000, 2_600)
	w.credited(top)
	if w.balance(store.Pool) != 31_189_000 || w.kept() != 400 {
		t.Fatalf("pool %d, kept %d", w.balance(store.Pool), w.kept())
	}
	w.booksAddUp()
}

// A top-up that opened the channel books phoenixd's fee to fees, once: the
// webhook redelivered and the sweep add nothing.
func TestATopUpThatBoughtRoomBooksItsFee(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.keep(0)
	w.f.Set(func(f *phoenixdtest.Fake) { f.Channel, f.InboundSat, f.FeeCreditSat = false, 0, 0 })
	top := w.topUp(30_000)
	w.f.ReceiveBuyingRoom(top, 22_327_000, 0)
	w.credited(top)
	h, err := w.st.History(ctx, store.Pool, 0, 1)
	if err != nil || len(h) != 1 || h[0].AmountMsat != 7_673_000 || h[0].FeeMsat != 22_327_000 {
		t.Fatalf("history %+v %v", h, err)
	}
	info, _ := w.f.InvoiceInfo(top)
	w.f.SendWebhook(w.hook.URL, info.PaymentHash, phoenixdtest.WebhookSecret)
	if err := w.s.Sweep(ctx, 0); err != nil {
		t.Fatal(err)
	}
	fees, err := w.st.Balance(ctx, store.Fees)
	if err != nil || fees.EntriesMsat != 22_327_000 {
		t.Fatalf("fees %+v %v, want 22,327,000 once", fees, err)
	}
	w.booksAddUp()
}

// With no channel nothing is credited and the kept
// figure moves up by the whole amount all the same; the payment that opens
// the channel sets it to phoenixd's, so what the purchase left of the fee
// credit isn't taken from the next payment.
func TestWithNoChannelTheKeptFigureMovesToo(t *testing.T) {
	w := setup(t)
	w.f.Set(func(f *phoenixdtest.Fake) { f.Channel, f.InboundSat = false, 0 })
	for i, sat := range []int64{1_000, 1_500} {
		top := w.topUp(sat)
		w.f.ReceiveAsFeeCredit(top)
		w.credited(top)
		if want := []int64{1_000, 2_500}[i]; w.kept() != want || w.balance(store.Pool) != 0 {
			t.Fatalf("payment %d: kept %d, pool %d", i, w.kept(), w.balance(store.Pool))
		}
	}
	if h, err := w.st.History(context.Background(), store.Pool, 0, 2); err != nil || len(h) != 2 || h[0].FeeMsat != 0 || h[1].FeeMsat != 0 {
		t.Fatalf("the fee-credit payments: %+v %v", h, err)
	}
	eventually(t, "phoenixd's fee credit", func() bool { return w.f.FeeCredit() == 2_500 })
	opens := w.topUp(60_000)
	w.f.ReceiveBuyingRoom(opens, 22_000_000, 2_000) // 500 sat of fee credit is left
	w.credited(opens)
	if w.kept() != 500 || w.balance(store.Pool) != 40_000_000 {
		t.Fatalf("the payment that opened the channel: kept %d, pool %d", w.kept(), w.balance(store.Pool))
	}
	// The next payment doesn't fit the room, finds no rise over the 500, and is credited whole.
	w.f.Set(func(f *phoenixdtest.Fake) { f.InboundSat = 1_000 })
	next := w.topUp(2_500)
	w.f.Receive(next, 2_500, 0)
	w.credited(next)
	if w.balance(store.Pool) != 42_500_000 || w.kept() != 500 {
		t.Fatalf("the next payment: pool %d, kept %d", w.balance(store.Pool), w.kept())
	}
	w.booksAddUp()
}

// The sweep lists the last day's payments every 5 minutes: one already in
// the books moves nothing, and phoenixd isn't asked about it.
func TestTheSweepListingACreditedPaymentAsksNothing(t *testing.T) {
	w := setup(t)
	w.keep(0)
	w.f.Set(func(f *phoenixdtest.Fake) { f.InboundSat = 1_000 })
	top := w.topUp(2_500)
	w.f.ReceiveAsFeeCredit(top)
	w.credited(top)
	eventually(t, "phoenixd's fee credit", func() bool { return w.f.FeeCredit() == 2_500 })
	// A later rise that is nobody's yet must not be handed to a payment already credited.
	w.f.Set(func(f *phoenixdtest.Fake) { f.FeeCreditSat = 9_000 })
	balance, info := w.f.Calls("/getbalance"), w.f.Calls("/getinfo")
	for i := 0; i < 3; i++ {
		if err := w.s.Sweep(context.Background(), 0); err != nil {
			t.Fatal(err)
		}
	}
	if w.kept() != 2_500 || w.f.Calls("/getbalance") != balance || w.f.Calls("/getinfo") != info {
		t.Fatalf("kept %d, %d balance and %d info calls", w.kept(), w.f.Calls("/getbalance")-balance, w.f.Calls("/getinfo")-info)
	}
	// Nor does a webhook sent twice.
	hash, _ := w.f.InvoiceInfo(top)
	if code, _ := w.f.SendWebhook(w.hook.URL, hash.PaymentHash, phoenixdtest.WebhookSecret); code != http.StatusNoContent {
		t.Fatalf("the webhook again: HTTP %d", code)
	}
	if w.kept() != 2_500 || w.f.Calls("/getbalance") != balance {
		t.Fatalf("after the webhook again: kept %d, %d balance calls", w.kept(), w.f.Calls("/getbalance")-balance)
	}
}

// A kept figure above phoenixd's (something lowered it that cardd didn't
// see) is left at a credit: the payment is credited whole.
func TestAKeptFigureAbovePhoenixdsIsLeftAtACredit(t *testing.T) {
	w := setup(t)
	w.keep(5_000)
	w.f.Set(func(f *phoenixdtest.Fake) { f.FeeCreditSat, f.InboundSat = 1_000, 1_000 })
	top := w.topUp(2_500)
	w.f.Receive(top, 2_500, 0)
	w.credited(top)
	if w.balance(store.Pool) != 2_500_000 || w.kept() != 5_000 {
		t.Fatalf("pool %d, kept %d", w.balance(store.Pool), w.kept())
	}
}

// Until cardd has a first figure, a payment with no fee and a channel is
// credited whole at once.
func TestBeforeTheFirstFigureAPaymentIsCreditedWhole(t *testing.T) {
	w := setup(t)
	w.f.Set(func(f *phoenixdtest.Fake) { f.InboundSat = 1_000 })
	asked := w.f.Calls("/getbalance")
	top := w.topUp(2_500)
	w.f.ReceiveAsFeeCredit(top)
	w.credited(top)
	if w.balance(store.Pool) != 2_500_000 || w.kept() != -1 || w.f.Calls("/getbalance") != asked {
		t.Fatalf("pool %d, kept %d, %d balance calls", w.balance(store.Pool), w.kept(), w.f.Calls("/getbalance")-asked)
	}
}

// The kept figure is set to phoenixd's only when phoenixd's can be trusted:
// after a restart phoenixd reports no fee credit until it has reconnected
// to ACINQ, and a channel that isn't Normal says it hasn't.
func TestSettlingTheKeptFigure(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.keep(5_000)
	set := func(feeCredit int64, state string) {
		w.f.Set(func(f *phoenixdtest.Fake) { f.FeeCreditSat, f.ChannelState = feeCredit, state })
	}
	for _, state := range []string{"Offline", "Syncing"} {
		set(0, state)
		if err := w.s.SettleFeeCredit(ctx); err != nil || w.kept() != 5_000 {
			t.Fatalf("while %s: %v, kept %d", state, err, w.kept())
		}
		// Set the books while the channel isn't up: phoenixd's 0 is never taken, and
		// the figure isn't left either, since the 5-minute check could only ever lower it: it is forgotten, and
		// the first check with the channel up takes phoenixd's real figure, whichever way it differs.
		if reset, err := w.s.ResetFeeCredit(ctx); err != nil || reset || w.kept() != -1 {
			t.Fatalf("reset while %s: %v %v, kept %d", state, reset, err, w.kept())
		}
		if err := w.s.SettleFeeCredit(ctx); err != nil || w.kept() != -1 {
			t.Fatalf("the check while still %s: %v, kept %d", state, err, w.kept())
		}
		set(7_000, "Normal") // higher than the 5,000 it had: taken all the same
		if err := w.s.SettleFeeCredit(ctx); err != nil || w.kept() != 7_000 {
			t.Fatalf("the first check with the channel up after a reset while %s: %v, kept %d", state, err, w.kept())
		}
		w.keep(5_000)
	}
	// Back, with a lower figure (a purchase used some): the 5-minute check takes it.
	set(2_000, "Normal")
	if err := w.s.SettleFeeCredit(ctx); err != nil || w.kept() != 2_000 {
		t.Fatalf("lowered: %v, kept %d", err, w.kept())
	}
	// A higher figure is a payment not credited yet: the check leaves it for that credit to share out.
	set(9_000, "Normal")
	if err := w.s.SettleFeeCredit(ctx); err != nil || w.kept() != 2_000 {
		t.Fatalf("a rise: %v, kept %d", err, w.kept())
	}
	// Set the books and a restore's reconcile take phoenixd's figure outright.
	if reset, err := w.s.ResetFeeCredit(ctx); err != nil || !reset || w.kept() != 9_000 {
		t.Fatalf("reset: %v %v, kept %d", reset, err, w.kept())
	}
	// The first figure, on a server that has none yet (the first check after the migration).
	w.st.DeleteMeta(ctx, "phoenixd.fee_credit_sat")
	set(0, "Offline")
	if err := w.s.SettleFeeCredit(ctx); err != nil || w.kept() != -1 {
		t.Fatalf("no figure, offline: %v, kept %d", err, w.kept())
	}
	set(9_000, "Normal")
	if err := w.s.SettleFeeCredit(ctx); err != nil || w.kept() != 9_000 {
		t.Fatalf("the first figure: %v, kept %d", err, w.kept())
	}
	// With no channel at all the figure isn't read before a purchase sets it: phoenixd's is taken.
	w.f.Set(func(f *phoenixdtest.Fake) { f.Channel, f.FeeCreditSat = false, 300 })
	if reset, err := w.s.ResetFeeCredit(ctx); err != nil || !reset || w.kept() != 300 {
		t.Fatalf("no channel: %v %v, kept %d", reset, err, w.kept())
	}
}

// A payment that bought room while cardd was down, found by the sweep at the
// next start before phoenixd has reconnected to ACINQ: phoenixd reports a fee
// credit of 0 until it has, so the kept figure is left alone, and the
// 5-minute check takes phoenixd's once the channel is Normal.
func TestAPurchaseFoundBeforePhoenixdHasReconnected(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.keep(3_000)
	top := w.topUp(50_000)
	w.f.Set(func(f *phoenixdtest.Fake) { f.FeeCreditSat, f.WebhookURL = 3_000, "" })
	w.f.ReceiveBuyingRoom(top, 21_411_000, 2_600) // 400 sat of fee credit is left, in truth
	w.f.Set(func(f *phoenixdtest.Fake) { f.ChannelState, f.FeeCreditSat = "Offline", 0 })
	if err := w.s.Sweep(ctx, 0); err != nil {
		t.Fatal(err)
	}
	if w.balance(store.Pool) != 31_189_000 || w.kept() != 3_000 {
		t.Fatalf("found while phoenixd was reconnecting: pool %d, kept %d", w.balance(store.Pool), w.kept())
	}
	w.f.Set(func(f *phoenixdtest.Fake) { f.ChannelState, f.FeeCreditSat = "Normal", 400 })
	if err := w.s.SettleFeeCredit(ctx); err != nil || w.kept() != 400 {
		t.Fatalf("once it has: %v, kept %d", err, w.kept())
	}
}

// phoenixd stops waiting for a webhook's answer after about 10 seconds and
// never sends it again. A credit that is waiting for the fee credit to rise
// goes on without the request that brought it.
func TestACreditOutlivesTheWebhooksRequest(t *testing.T) {
	w := setup(t)
	w.keep(0)
	w.f.Set(func(f *phoenixdtest.Fake) { f.InboundSat, f.WebhookURL = 1_000, "" })
	top := w.topUp(2_500)
	w.f.ReceiveAsFeeCredit(top)                                // with no webhook the fake's figure rises at once:
	w.f.Set(func(f *phoenixdtest.Fake) { f.FeeCreditSat = 0 }) // put it back, as before ACINQ has confirmed it
	info, _ := w.f.InvoiceInfo(top)
	body, _ := json.Marshal(map[string]any{"type": "payment_received", "paymentHash": info.PaymentHash})
	mac := hmac.New(sha256.New, []byte(phoenixdtest.WebhookSecret))
	mac.Write(body)
	req, _ := http.NewRequest("POST", w.hook.URL, bytes.NewReader(body))
	req.Header.Set("X-Phoenix-Signature", hex.EncodeToString(mac.Sum(nil)))
	// The caller gives up after 40 ms, well inside cardd's wait; the rise comes at 120 ms.
	if _, err := (&http.Client{Timeout: 40 * time.Millisecond}).Do(req); err == nil {
		t.Fatal("the webhook answered before the wait was over")
	}
	time.Sleep(80 * time.Millisecond)
	w.f.Set(func(f *phoenixdtest.Fake) { f.FeeCreditSat = 2_500 })
	w.credited(top)
	if w.balance(store.Pool) != 0 || w.kept() != 2_500 {
		t.Fatalf("pool %d, kept %d", w.balance(store.Pool), w.kept())
	}
}

// A credit says in the log how long after phoenixd had the payment the books
// had it, a sale's and a top-up's alike: when money shows late, the log says
// whether the wait was here.
func TestACreditLogsHowLongTheBooksTook(t *testing.T) {
	w := setup(t)
	logs := &bytes.Buffer{}
	w.s.Log = log.New(logs, "", 0)
	w.f.Receive(w.aSale(2500), 2500, 0)
	w.f.Receive(w.topUp(3000), 3000, 0)
	got := logs.String()
	for _, want := range []string{
		`(?m)^lnurl: sale ` + saleID + ` paid \([0-9a-f]{64}\): received 2500 sat; in the books \d+ ms after phoenixd had it$`,
		`(?m)^lnurl: top-up [0-9a-f]{64} for pool: received 3000 sat; in the books \d+ ms after phoenixd had it$`,
	} {
		if !regexp.MustCompile(want).MatchString(got) {
			t.Fatalf("log: %q\nwant: %s", got, want)
		}
	}
}

// A payment whose webhook never came is found by the quick look, which
// asks phoenixd for the last minutes' payments every QuickLook (2 seconds in
// cardd): the person sees it within seconds, where the sweep alone took up
// to 5 minutes ("webhook missed must be quicker (5s at worst)"). A sale it
// credits rings the sale's read, as the webhook would have.
func TestTheQuickLookFindsAPaymentWhoseWebhookNeverCame(t *testing.T) {
	w := setup(t)
	w.f.Set(func(f *phoenixdtest.Fake) { f.WebhookURL = "" })
	rung := make(chan string, 4)
	w.s.Paid = func(paymentHash string) { rung <- paymentHash }
	w.s.QuickLook = 20 * time.Millisecond
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go w.s.RunSweep(ctx)
	time.Sleep(100 * time.Millisecond) // the sweep at start has been and gone
	top, sale := w.topUp(5_000), w.aSale(2_500)
	w.f.Receive(top, 5_000, 0)
	w.f.Receive(sale, 2_500, 0)
	w.credited(top)
	w.credited(sale)
	if w.balance(store.Pool) != 5_000_000 || w.balance(store.Shop) != 2_500_000 || w.sale().State != store.SalePaid {
		t.Fatalf("pool %d, shop %d, the sale %s", w.balance(store.Pool), w.balance(store.Shop), w.sale().State)
	}
	info, _ := w.f.InvoiceInfo(sale)
	select {
	case hash := <-rung:
		if hash != info.PaymentHash {
			t.Fatalf("rang %s, the sale's is %s", hash, info.PaymentHash)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the sale's read wasn't rung")
	}
	// More looks credit nothing twice.
	time.Sleep(100 * time.Millisecond)
	if w.balance(store.Pool) != 5_000_000 || w.balance(store.Shop) != 2_500_000 {
		t.Fatalf("after more looks: pool %d, shop %d", w.balance(store.Pool), w.balance(store.Shop))
	}
	w.booksAddUp()
}

// A webhook and a look can meet on one payment: it is credited once.
func TestAWebhookAndTheQuickLookCreditAPaymentOnce(t *testing.T) {
	w := setup(t)
	w.s.QuickLook = 5 * time.Millisecond
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go w.s.RunSweep(ctx)
	for i := 0; i < 20; i++ {
		w.f.Receive(w.topUp(1_000), 1_000, 0)
	}
	// However loaded the machine: until all 20 are in the books, then through more looks.
	eventually(t, "20 top-ups credited", func() bool { return w.balance(store.Pool) >= 20_000_000 })
	time.Sleep(100 * time.Millisecond)
	if got := w.balance(store.Pool); got != 20_000_000 {
		t.Fatalf("pool %d after 20 top-ups of 1,000 sat", got)
	}
	w.booksAddUp()
}

// A look that can't ask phoenixd says so once when that starts and once
// when it ends, not every 2 seconds. (A look every 10 ms has 200 ms in which
// to fail: on a machine too loaded for that, this test and the others that
// run on real time are not to be trusted.)
func TestAFailingQuickLookLogsItsStartAndItsEnd(t *testing.T) {
	w := setup(t)
	logs := &syncBuffer{}
	w.s.Log = log.New(logs, "", 0)
	w.s.QuickLook = 10 * time.Millisecond
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go w.s.RunSweep(ctx)
	time.Sleep(100 * time.Millisecond)
	w.f.SetDown(true)
	time.Sleep(200 * time.Millisecond)
	w.f.SetDown(false)
	eventually(t, "the look working again", func() bool { return strings.Contains(logs.String(), "works again") })
	got := logs.String()
	if strings.Count(got, "lnurl: the quick look for missed webhooks is failing: ") != 1 || strings.Count(got, "lnurl: the quick look for missed webhooks works again") != 1 {
		t.Fatalf("log: %q", got)
	}
}

// syncBuffer is a log read while it is written.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// The sweep takes phoenixd's list a page at a time, newest first as phoenixd
// gives it: every payment of more than a page is credited.
func TestTheSweepCreditsMoreThanAPage(t *testing.T) {
	w := setup(t)
	w.f.Set(func(f *phoenixdtest.Fake) { f.WebhookURL = "" })
	for i := 0; i < 130; i++ {
		w.f.Receive(w.topUp(1_000), 1_000, 0)
	}
	if err := w.s.Sweep(context.Background(), 0); err != nil {
		t.Fatal(err)
	}
	if got := w.balance(store.Pool); got != 130_000_000 {
		t.Fatalf("pool %d after 130 top-ups of 1,000 sat", got)
	}
}
