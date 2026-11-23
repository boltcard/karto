package api

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/boltcard/karto/server/internal/alerts"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/bip353"
	"github.com/boltcard/karto/server/internal/cards"
	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/lnaddr"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/renew"
	"github.com/boltcard/karto/server/internal/sendto"
	"github.com/boltcard/karto/server/internal/store"
)

type moneyWorld struct {
	*client
	money *Money
	f     *phoenixdtest.Fake
	l     *ledger.Ledger
	ln    *httptest.Server // a Lightning address's server, for sends
	db    string           // the store's file, for a test that sets a column the API never does
	swept int              // times Money.Sweep ran
	logs  *bytes.Buffer    // what Money logged
	// hangRenewals: LNVPS's renewal invoices hang in the fake phoenixd until released.
	hangRenewals *atomic.Bool
	names        testNames // BIP353 names, by "user@domain"
	// comments: the LUD-12 comment each callback got ("" for none), in order.
	comments *commentLog
}

// commentLog keeps the comments the fake address's callbacks got.
type commentLog struct {
	mu   sync.Mutex
	seen []string
}

func (c *commentLog) add(s string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seen = append(c.seen, s)
}

func (c *commentLog) all() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.seen...)
}

// moneySetup: the active card cardID with 100k sat, pool with 50k sat,
// phoenixd holding exactly that, and replay protection on.
// renewedTo is the date the fake LNVPS's renewal invoices say the VM now runs to: 60 days on, on the hour, so a
// server's own estimate of 40 days on is always earlier.
var renewedTo = time.Now().UTC().Add(60 * 24 * time.Hour).Truncate(time.Hour)

func moneySetup(t *testing.T) *moneyWorld {
	t.Helper()
	ctx := context.Background()
	db := filepath.Join(t.TempDir(), "cardd.db")
	st, err := store.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	svc, _ := cards.New(st, issuer, "vm-1.lnvps.cloud")
	st.ReserveCard(ctx, cardID, "Daily", "")
	st.ActivateCard(ctx, cardID, 1)
	st.Credit(ctx, store.CardAccount(cardID), 100_000_000, "c", "")
	st.Credit(ctx, store.Pool, 50_000_000, "p", "")
	f := phoenixdtest.New()
	t.Cleanup(f.Close)
	f.BalanceSat = 150_000
	pd := phoenixd.New(f.URL, phoenixdtest.Password)
	l := ledger.New(st, pd, log.New(io.Discard, "", 0))
	if err := l.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	// alice@pay.example.com: every request goes to this server, which asks
	// the fake phoenixd for an invoice of the amount.
	// shop: an LNURL-pay URL whose invoices carry a description hash that
	// doesn't match its metadata; slow@ takes 1.5 s to answer. 1009 is VM
	// 1009's LNVPS Lightning address, which renewals pay.
	hangRenewals := new(atomic.Bool)
	comments := &commentLog{}
	ln := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/lnurlp/1009":
			w.Write([]byte(`{"tag":"payRequest","callback":"http://api.lnvps.net/api/v1/vm/1009/renew-lnurlp","minSendable":100000,"maxSendable":1000000000,"metadata":"[[\"text/plain\",\"Extend VM 1009\"]]"}`))
			return
		case "/api/v1/vm/1009/renew-lnurlp":
			var amt int64
			fmt.Sscan(r.URL.Query().Get("amount"), &amt)
			bolt11, hash := f.InvoiceWithDescription(amt, "VM renewal 1009 to "+renewedTo.Format("2006-01-02 15:04:05")+".5 UTC")
			if hangRenewals.Load() {
				f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
			}
			json.NewEncoder(w).Encode(map[string]any{"pr": bolt11, "routes": []any{}})
			return
		case "/.well-known/lnurlp/alice":
			w.Write([]byte(`{"tag":"payRequest","callback":"http://pay.example.com/cb","minSendable":1000,"maxSendable":100000000,"metadata":"[]"}`))
			return
		case "/.well-known/lnurlp/noted":
			// Takes a comment of up to 60 characters (LUD-12).
			w.Write([]byte(`{"tag":"payRequest","callback":"http://pay.example.com/cb","minSendable":1000,"maxSendable":100000000,"metadata":"[]","commentAllowed":60}`))
			return
		case "/lnurlp/shop":
			w.Write([]byte(`{"tag":"payRequest","callback":"http://pay.example.com/cb-shop","minSendable":1000,"maxSendable":100000000,"metadata":"[[\"text/plain\",\"Shop\"]]"}`))
			return
		case "/.well-known/lnurlp/slow":
			time.Sleep(1500 * time.Millisecond)
			return
		}
		var amt int64
		fmt.Sscan(r.URL.Query().Get("amount"), &amt)
		comments.add(r.URL.Query().Get("comment"))
		bolt11, _ := f.Invoice(amt)
		if r.URL.Path == "/cb-shop" {
			bolt11, _, _ = pd.CreateInvoice(r.Context(), amt/1000, strings.Repeat("00", 32), "elsewhere", time.Hour)
		}
		json.NewEncoder(w).Encode(map[string]any{"pr": bolt11, "routes": []any{}})
	}))
	t.Cleanup(ln.Close)
	tr := &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, ln.Listener.Addr().String())
	}}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	raw, _ := key.PublicKey.Bytes()
	keyID := deviceauth.KeyID(raw)
	auth := &deviceauth.Verifier{
		// The world's own key is an owner whatever id it signs with; any other device is the store's (pos_test.go).
		Lookup: func(ctx context.Context, id string) (*ecdsa.PublicKey, deviceauth.Role, error) {
			if id == keyID {
				return &key.PublicKey, deviceauth.Owner, nil
			}
			return storeLookup(ctx, st, id)
		},
		Now:  time.Now,
		Seen: st.SeeSignature,
	}
	logs := &bytes.Buffer{}
	addresses := &lnaddr.Resolver{HTTP: &http.Client{Transport: tr}, Scheme: "http"}
	names := testNames{}
	looker := &sendto.Looker{Offers: pd, Names: names, Addresses: addresses, Now: time.Now}
	st.SetMeta(ctx, "vm.id", "1009")
	money := &Money{Store: st, Ledger: l, Liquidity: pd.Liquidity, Invoices: pd, Host: "vm-1.lnvps.cloud", Addresses: addresses, Lookup: looker,
		SendWait: 2 * time.Second, ResolveWait: 500 * time.Millisecond, Log: log.New(logs, "", 0),
		Hosting: &renew.Renewer{Store: st, Ledger: l, Resolver: addresses, Decoder: pd, LNVPS: "http://api.lnvps.net",
			Now: time.Now, Log: log.New(logs, "", 0)}}
	money.Push = &alerts.Sender{Store: st, Log: log.New(io.Discard, "", 0)}
	w := &moneyWorld{money: money, f: f, l: l, ln: ln, db: db, logs: logs, hangRenewals: hangRenewals, names: names, comments: comments}
	money.Sweep = func(context.Context) error { w.swept++; return nil }
	srv := httptest.NewServer(New(svc, auth, "test", st, money, nil))
	t.Cleanup(srv.Close)
	w.client = &client{t: t, srv: srv, st: st, key: key, keyID: keyID}
	return w
}

func (w *moneyWorld) balance(a store.Account) int64 {
	b, _ := w.st.Balance(context.Background(), a)
	return b.AvailableMsat()
}

func TestWallet(t *testing.T) {
	w := moneySetup(t)
	status, out := w.do("GET", "/api/v1/wallet", nil)
	if status != 200 {
		t.Fatalf("%d %v", status, out)
	}
	cs := out["cards"].([]any)
	c := cs[0].(map[string]any)
	if len(cs) != 1 || c["balanceMsat"] != 100_000_000.0 || c["address"] != "ce07ce1279d@vm-1.lnvps.cloud" || c["perTapSat"] != 20_000.0 || c["name"] != "Daily" {
		t.Fatalf("cards: %v", cs)
	}
	pool := out["pool"].(map[string]any)
	if pool["balanceMsat"] != 50_000_000.0 || pool["address"] != "pool@vm-1.lnvps.cloud" || out["paused"] != false {
		t.Fatalf("pool: %v", out)
	}
	// The most a Send out can take: all but phoenixd's fee and 1 sat (ledger.SendableMsat). Hosting has no such figure.
	if pool["sendableMsat"] != 49_795_000.0 {
		t.Fatalf("pool sendable: %v", pool)
	}
	if _, ok := out["hosting"].(map[string]any)["sendableMsat"]; ok {
		t.Fatalf("hosting: %v", out["hosting"])
	}
	if liq := out["liquidity"].(map[string]any); liq["channel"] != false || liq["usable"] != false || liq["feeCreditSat"] != 0.0 || liq["firstChannelFeeSat"] != 21_411.0 {
		t.Fatalf("liquidity: %v", liq)
	}
}

func TestMoveOncePerRequestID(t *testing.T) {
	w := moneySetup(t)
	body := map[string]any{"id": "move-1", "from": "pool", "to": cardID, "amountMsat": 10_000_000}
	for i := 0; i < 2; i++ {
		if status, out := w.do("POST", "/api/v1/move", body); status != 200 || out["status"] != "moved" {
			t.Fatalf("move #%d: %d %v", i, status, out)
		}
	}
	if w.balance(store.Pool) != 40_000_000 {
		t.Fatalf("moved twice: pool %d", w.balance(store.Pool))
	}
	body["amountMsat"] = 1
	if status, out := w.do("POST", "/api/v1/move", body); status != 409 || out["error"] != "request_mismatch" {
		t.Fatalf("same id, other body: %d %v", status, out)
	}
	big := map[string]any{"id": "move-2", "from": "pool", "to": "hosting", "amountMsat": 999_000_000}
	if status, out := w.do("POST", "/api/v1/move", big); status != 409 || out["error"] != "insufficient" {
		t.Fatalf("too much: %d %v", status, out)
	}
	if status, out := w.do("POST", "/api/v1/move", map[string]any{"from": "pool", "to": "hosting", "amountMsat": 1}); status != 400 {
		t.Fatalf("no id: %d %v", status, out)
	}
}

// cardd stopped after moving but before answering: at the next start the
// request id is forgotten, and the app's retry is answered without moving again.
func TestAMoveCutOffByARestartIsNotRepeated(t *testing.T) {
	w := moneySetup(t)
	ctx := context.Background()
	w.st.BeginRequest(ctx, "move-1", "the first attempt")
	if err := w.st.MoveOnce(ctx, "request:move-1", store.Pool, store.CardAccount(cardID), 10_000_000, ""); err != nil {
		t.Fatal(err)
	}
	w.st.TidyAtStart(ctx)
	body := map[string]any{"id": "move-1", "from": "pool", "to": cardID, "amountMsat": 10_000_000}
	if status, out := w.do("POST", "/api/v1/move", body); status != 200 || out["status"] != "moved" {
		t.Fatalf("retry: %d %v", status, out)
	}
	if w.balance(store.Pool) != 40_000_000 {
		t.Fatalf("moved twice: pool %d", w.balance(store.Pool))
	}
}

// cardd stopped during a send to a Lightning address, after paying but before
// answering: the retry is answered from that payment, not paid again with a
// new invoice.
func TestASendCutOffByARestartIsNotRepeated(t *testing.T) {
	w := moneySetup(t)
	ctx := context.Background()
	w.st.BeginRequest(ctx, "s", "the first attempt")
	bolt11, _ := w.f.Invoice(2_000_000) // what alice@pay.example.com gave then
	inv, _ := w.l.Decode(ctx, bolt11)
	done := make(chan ledger.Outcome, 1)
	if _, err := w.l.PayOnce(ctx, "request:s", store.Pool, store.KindSend, bolt11, inv, store.HoldAbout{}, done); err != nil {
		t.Fatal(err)
	}
	<-done
	w.st.TidyAtStart(ctx)
	body := map[string]any{"id": "s", "to": "alice@pay.example.com", "amountMsat": 2_000_000}
	if status, out := w.do("POST", "/api/v1/send", body); status != 200 || out["status"] != "sent" || out["amountMsat"] != 2_000_000.0 {
		t.Fatalf("retry: %d %v", status, out)
	}
	if paid := w.f.Paid(); len(paid) != 1 {
		t.Fatalf("paid %d times", len(paid))
	}
}

func TestSendAnInvoiceOnce(t *testing.T) {
	w := moneySetup(t)
	bolt11, hash := w.f.Invoice(10_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{FeeMsat: 4_321})
	body := map[string]any{"id": "send-1", "to": bolt11}
	for i := 0; i < 2; i++ {
		status, out := w.do("POST", "/api/v1/send", body)
		if status != 200 || out["status"] != "sent" || out["feeMsat"] != 4_321.0 || out["paymentHash"] != hash || out["amountMsat"] != 10_000_000.0 {
			t.Fatalf("send #%d: %d %v", i, status, out)
		}
	}
	if len(w.f.Paid()) != 1 || w.balance(store.Pool) != 50_000_000-10_000_000-4_321 {
		t.Fatalf("paid %d times, pool %d", len(w.f.Paid()), w.balance(store.Pool))
	}
}

// Send out takes all of Pool but phoenixd's fee and 1 sat (the wallet's sendableMsat), and no more.
func TestSendOutTakesAllOfPoolButPhoenixdsFeeAndASat(t *testing.T) {
	w := moneySetup(t)
	s := ledger.SendableMsat(50_000_000)
	over, _ := w.f.Invoice(s + 1_000)
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "s1", "to": over}); status != 409 || out["error"] != "insufficient" {
		t.Fatalf("a sat more: %d %v", status, out)
	}
	bolt11, hash := w.f.Invoice(s)
	fee := 4_000 + s*4/1000
	w.f.SetOutcome(hash, phoenixdtest.Outcome{FeeMsat: fee})
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "s2", "to": bolt11}); status != 200 || out["status"] != "sent" {
		t.Fatalf("all: %d %v", status, out)
	}
	if got := w.balance(store.Pool); got != 50_000_000-s-fee {
		t.Fatalf("pool %d", got)
	}
}

func TestSendToALightningAddress(t *testing.T) {
	w := moneySetup(t)
	status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "s", "to": "alice@pay.example.com", "amountMsat": 2_000_000})
	if status != 200 || out["status"] != "sent" || out["amountMsat"] != 2_000_000.0 {
		t.Fatalf("%d %v", status, out)
	}
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "s2", "to": "alice@pay.example.com"}); status != 400 {
		t.Fatalf("no amount: %d %v", status, out)
	}
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "s3", "to": "bob@pay.example.com", "amountMsat": 1000}); status != 400 || out["error"] != "bad_address" {
		t.Fatalf("unknown user: %d %v", status, out)
	}
}

func TestSendAnswersPendingAfterTheWait(t *testing.T) {
	w := moneySetup(t)
	bolt11, hash := w.f.Invoice(1_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "slow", "to": bolt11}); status != 200 || out["status"] != "pending" || out["paymentHash"] != hash {
		t.Fatalf("%d %v", status, out)
	}
	w.f.Release(hash, false, 0)
}

func TestSendIsRefusedWhilePaused(t *testing.T) {
	w := moneySetup(t)
	w.f.BalanceSat = 0
	w.l.Reconcile(context.Background())
	bolt11, _ := w.f.Invoice(1_000_000)
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "x", "to": bolt11}); status != 503 || out["error"] != "paused" {
		t.Fatalf("%d %v", status, out)
	}
	resp, _ := http.Get(w.srv.URL + "/health")
	var health map[string]any
	json.NewDecoder(resp.Body).Decode(&health)
	resp.Body.Close()
	if health["alert"] != "spending paused" {
		t.Fatalf("health: %v", health)
	}
}

// The way out of a pause: the books are set to phoenixd's balance.
func TestReconcileSetsTheBooksToPhoenixd(t *testing.T) {
	w := moneySetup(t)
	w.f.BalanceSat = 140_000 // 10,000 sat less than the books
	w.l.Reconcile(context.Background())
	if _, out := w.do("GET", "/api/v1/wallet", nil); out["paused"] != true {
		t.Fatalf("not paused: %v", out)
	}
	if status, out := w.do("POST", "/api/v1/ledger/reconcile", nil); status != 200 || out["bookedMsat"] != -10_000_000.0 {
		t.Fatalf("reconcile: %d %v", status, out)
	}
	if w.swept != 1 {
		t.Fatalf("swept %d times before setting the books", w.swept)
	}
	if _, out := w.do("GET", "/api/v1/wallet", nil); out["paused"] != false || w.balance(store.Pool) != 40_000_000 {
		t.Fatalf("after: %v, pool %d", out, w.balance(store.Pool))
	}
	w.f.Down = true
	if status, out := w.do("POST", "/api/v1/ledger/reconcile", nil); status != 503 || out["error"] != "phoenixd_unreachable" {
		t.Fatalf("phoenixd down: %d %v", status, out)
	}
}

func TestFreezeLimitsAndWipeToPool(t *testing.T) {
	w := moneySetup(t)
	for _, step := range []struct{ path, state string }{{"/freeze", "frozen"}, {"/freeze", "frozen"}, {"/unfreeze", "active"}} {
		if status, out := w.do("POST", "/api/v1/cards/"+cardID+step.path, nil); status != 200 || out["state"] != step.state {
			t.Fatalf("%s: %d %v", step.path, status, out)
		}
	}
	if status, out := w.do("PATCH", "/api/v1/cards/"+cardID+"/limits", map[string]int{"perTapSat": 5000, "dailySat": 10000}); status != 200 || out["perTapSat"] != 5000.0 {
		t.Fatalf("limits: %d %v", status, out)
	}
	if status, out := w.do("PATCH", "/api/v1/cards/"+cardID+"/limits", map[string]int{"perTapSat": 5000, "dailySat": 100}); status != 400 || out["error"] != "bad_limits" {
		t.Fatalf("bad limits: %d %v", status, out)
	}
	if status, out := w.do("POST", "/api/v1/cards/"+cardID+"/wipe", nil); status != 200 || out["state"] != "wiping" {
		t.Fatalf("wipe: %d %v", status, out)
	}
	if w.balance(store.Pool) != 150_000_000 {
		t.Fatalf("pool after the wipe: %d", w.balance(store.Pool))
	}
	status, out := w.do("GET", "/api/v1/accounts/"+cardID+"/history", nil)
	txs := out["transactions"].([]any)
	if status != 200 || len(txs) != 2 || txs[0].(map[string]any)["kind"] != "wipe" || txs[0].(map[string]any)["amountMsat"] != -100_000_000.0 {
		t.Fatalf("history: %d %v", status, out)
	}
}

// A request sent twice with the same signature is refused the second time.
func TestAReplayedRequestIsRefused(t *testing.T) {
	w := moneySetup(t)
	ts := time.Now().Unix()
	digest := sha256.Sum256([]byte(deviceauth.Canonical("GET", "/api/v1/wallet", ts, nil)))
	sig, _ := ecdsa.SignASN1(rand.Reader, w.key, digest[:])
	send := func() int {
		req, _ := http.NewRequest("GET", w.srv.URL+"/api/v1/wallet", bytes.NewReader(nil))
		req.Header.Set("Authorization", fmt.Sprintf("Device %s.%d.%x", w.keyID, ts, sig))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if first, second := send(), send(); first != 200 || second != 401 {
		t.Fatalf("first %d, second %d", first, second)
	}
}

// An invoice without an amount is paid for the amount given (whole sats).
func TestSendAnInvoiceWithoutAnAmount(t *testing.T) {
	w := moneySetup(t)
	bolt11, hash := w.f.Invoice(0)
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "n1", "to": bolt11}); status != 400 || out["error"] != "bad_invoice" {
		t.Fatalf("no amount given: %d %v", status, out)
	}
	status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "n2", "to": bolt11, "amountMsat": 3_000_000})
	if status != 200 || out["status"] != "sent" || out["amountMsat"] != 3_000_000.0 || w.f.PaidMsat(hash) != 3_000_000 {
		t.Fatalf("%d %v, phoenixd paid %d", status, out, w.f.PaidMsat(hash))
	}
	withAmount, _ := w.f.Invoice(1_000_000)
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "n3", "to": withAmount, "amountMsat": 2_000_000}); status != 400 || out["error"] != "bad_invoice" {
		t.Fatalf("amounts that disagree: %d %v", status, out)
	}
}

// A general LNURL-pay URL is paid like an address. Its invoice's description
// hash doesn't match the metadata here: that is logged, not refused (current
// LUD-06 asks wallets to check the amount only).
func TestSendToAPayURL(t *testing.T) {
	w := moneySetup(t)
	status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "u", "to": "http://pay.example.com/lnurlp/shop", "amountMsat": 2_000_000})
	if status != 200 || out["status"] != "sent" {
		t.Fatalf("%d %v", status, out)
	}
	if !strings.Contains(w.logs.String(), "description hash") {
		t.Fatalf("mismatch not logged: %q", w.logs.String())
	}
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "u2", "to": "http://pay.example.com/lnurlp/shop"}); status != 400 {
		t.Fatalf("no amount: %d %v", status, out)
	}
}

// Resolving an address has its own deadline inside the send's.
func TestResolvingAnAddressHasItsOwnDeadline(t *testing.T) {
	w := moneySetup(t)
	start := time.Now()
	status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "sl", "to": "slow@pay.example.com", "amountMsat": 1_000_000})
	if status != 400 || out["error"] != "bad_address" || time.Since(start) > 1200*time.Millisecond {
		t.Fatalf("%d %v after %s", status, out, time.Since(start))
	}
}

// The phone gave up on a send while it was still on its way: the request id
// is free again at once, and the retry answers from the payment, which went
// on without the request.
func TestACancelledRequestFreesItsID(t *testing.T) {
	w := moneySetup(t)
	bolt11, hash := w.f.Invoice(1_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{Hang: true})
	defer w.f.Release(hash, false, 0)
	body := map[string]any{"id": "gave-up", "to": bolt11}
	if _, _, err := w.doWith(&http.Client{Timeout: 300 * time.Millisecond}, "POST", "/api/v1/send", body); err == nil {
		t.Fatal("the phone's request didn't time out")
	}
	var status int
	var out map[string]any
	for i := 0; i < 50; i++ { // the handler notices the phone left
		if status, out = w.do("POST", "/api/v1/send", body); status != 409 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status != 200 || out["status"] != "pending" || out["paymentHash"] != hash {
		t.Fatalf("retry: %d %v", status, out)
	}
}

func TestAMalformedMoveIsABadRequest(t *testing.T) {
	w := moneySetup(t)
	for _, body := range []map[string]any{
		{"id": "m1", "from": "pool", "to": cardID, "amountMsat": 0},
		{"id": "m2", "from": "pool", "to": "pool", "amountMsat": 1000},
	} {
		if status, out := w.do("POST", "/api/v1/move", body); status != 400 {
			t.Fatalf("%v: %d %v", body, status, out)
		}
	}
}

func TestHistoryShowsFees(t *testing.T) {
	w := moneySetup(t)
	bolt11, hash := w.f.Invoice(10_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{FeeMsat: 4_321})
	w.do("POST", "/api/v1/send", map[string]any{"id": "f", "to": bolt11})
	_, out := w.do("GET", "/api/v1/accounts/pool/history", nil)
	tx := out["transactions"].([]any)[0].(map[string]any)
	if tx["kind"] != "send" || tx["amountMsat"] != -10_004_321.0 || tx["feeMsat"] != 4_321.0 {
		t.Fatalf("history: %v", tx)
	}
}

func TestHostingSyncAndStatus(t *testing.T) {
	w := moneySetup(t)
	if status, out := w.do("GET", "/api/v1/hosting", nil); status != 200 || out["synced"] != false || out["willRenew"] != false {
		t.Fatalf("before a sync: %d %v", status, out)
	}
	expires := time.Now().Add(40 * 24 * time.Hour).Unix()
	status, out := w.do("PUT", "/api/v1/hosting", map[string]any{"expires": expires, "satPerDay": 221.395, "vatOk": true})
	if status != 200 || out["synced"] != true || out["expires"] != float64(expires) || out["msatPerDay"] != 221_395.0 || out["vatOk"] != true {
		t.Fatalf("sync: %d %v", status, out)
	}
	for _, bad := range []struct {
		body map[string]any
		code string
	}{
		{map[string]any{"expires": expires, "satPerDay": 5, "vatOk": true}, "bad_sync"},
		{map[string]any{"expires": expires + 3*365*24*3600, "satPerDay": 221, "vatOk": true}, "bad_sync"},
		{map[string]any{"expires": expires, "satPerDay": 221}, "malformed"},
		{map[string]any{"expires": expires, "satPerDay": 221, "vatOk": "yes"}, "malformed"},
		{map[string]any{"expires": expires, "satPerDay": 221, "vatOk": true, "vmId": 1009}, "malformed"},
		{map[string]any{"expires": expires, "satPerDay": 221, "vatOk": true, "utcOffsetMin": 900}, "bad_sync"},
		{map[string]any{"expires": expires, "satPerDay": 221, "vatOk": true, "utcOffsetMin": "60"}, "malformed"},
	} {
		if status, out := w.do("PUT", "/api/v1/hosting", bad.body); status != 400 || out["error"] != bad.code {
			t.Fatalf("%v: %d %v", bad.body, status, out)
		}
	}
	if _, out := w.do("GET", "/api/v1/hosting", nil); out["expires"] != float64(expires) || out["msatPerDay"] != 221_395.0 {
		t.Fatalf("a refused sync changed the estimate: %v", out)
	}
	// The phone's offset from UTC, for hosting's daily alert.
	if status, out := w.do("PUT", "/api/v1/hosting", map[string]any{"expires": expires, "satPerDay": 221.395, "vatOk": true, "utcOffsetMin": 60}); status != 200 {
		t.Fatalf("a sync with the phone's offset: %d %v", status, out)
	}
}

func TestRenewNowOncePerRequestID(t *testing.T) {
	ctx := context.Background()
	w := moneySetup(t)
	w.st.Credit(ctx, store.Hosting, 10_000_000, "h", "")
	w.f.BalanceSat += 10_000
	if status, out := w.do("POST", "/api/v1/hosting/renew", map[string]any{"id": "r0", "days": 1}); status != 409 || out["error"] != "not_synced" {
		t.Fatalf("before a sync: %d %v", status, out)
	}
	w.do("PUT", "/api/v1/hosting", map[string]any{"expires": time.Now().Add(40 * 24 * time.Hour).Unix(), "satPerDay": 221.395, "vatOk": true})
	if status, out := w.do("POST", "/api/v1/hosting/renew", map[string]any{"id": "r1", "days": 366}); status != 400 || out["error"] != "bad_days" {
		t.Fatalf("366 days: %d %v", status, out)
	}
	var first map[string]any
	for i := 0; i < 2; i++ {
		status, out := w.do("POST", "/api/v1/hosting/renew", map[string]any{"id": "r2", "days": 1})
		if status != 200 || out["status"] != "sent" || out["amountMsat"] != 222_000.0 || out["paymentHash"] == "" {
			t.Fatalf("renew #%d: %d %v", i, status, out)
		}
		if first == nil {
			first = out
		} else if out["paymentHash"] != first["paymentHash"] {
			t.Fatalf("the same id paid again: %v, then %v", first, out)
		}
	}
	if paid := w.f.Paid(); len(paid) != 1 || w.balance(store.Hosting) != 10_000_000-222_000 {
		t.Fatalf("paid %d; hosting %d", len(paid), w.balance(store.Hosting))
	}
	want := renewedTo.Unix()
	if _, out := w.do("GET", "/api/v1/hosting", nil); out["expires"] != float64(want) || out["problem"] != "" {
		t.Fatalf("after renewing: %v", out)
	}
	if status, out := w.do("GET", "/api/v1/accounts/hosting/history", nil); status != 200 || out["transactions"].([]any)[0].(map[string]any)["kind"] != "renew" {
		t.Fatalf("history: %v", out)
	}
}

// A renewal still on its way when SendWait ends answers pending, as a send
// does; once it settles, the estimate moves to LNVPS's date.
func TestRenewNowAnswersPendingThenCounts(t *testing.T) {
	ctx := context.Background()
	w := moneySetup(t)
	w.st.Credit(ctx, store.Hosting, 10_000_000, "h", "")
	w.f.BalanceSat += 10_000
	w.do("PUT", "/api/v1/hosting", map[string]any{"expires": time.Now().Add(40 * 24 * time.Hour).Unix(), "satPerDay": 221.395, "vatOk": true})
	w.hangRenewals.Store(true)
	status, out := w.do("POST", "/api/v1/hosting/renew", map[string]any{"id": "r1", "days": 1})
	if status != 200 || out["status"] != "pending" {
		t.Fatalf("%d %v", status, out)
	}
	w.f.Release(out["paymentHash"].(string), false, 1000)
	want := float64(renewedTo.Unix())
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if _, h := w.do("GET", "/api/v1/hosting", nil); h["expires"] == want {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the settled renewal was never counted")
		}
	}
	if w.balance(store.Hosting) != 10_000_000-223_000 {
		t.Fatalf("hosting %d", w.balance(store.Hosting))
	}
}

// After a restore GET /wallet carries the reconcile's state, setting the
// books is refused until it is done, and with no channel the person sets
// them to phoenixd's balance.
func TestWalletShowsTheRestore(t *testing.T) {
	ctx := context.Background()
	w := moneySetup(t)
	if _, out := w.do("GET", "/api/v1/wallet", nil); out["restore"] != nil || !hasKey(out, "restore") {
		t.Fatalf("no restore: %v", out)
	}
	if err := w.st.PrepareRestored(ctx, "a1b2 3 1790000000", "", store.RestoredVM{ID: "1003", Host: "vm-1003.lnvps.cloud", IPv4: "45.67.89.170"}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	w.l.Liquidity = phoenixd.New(w.f.URL, phoenixdtest.Password).Liquidity
	w.l.Now = func() time.Time { return now }
	w.l.CheckRestore(ctx)
	w.l.Reconcile(ctx)
	_, out := w.do("GET", "/api/v1/wallet", nil)
	if r := out["restore"].(map[string]any); len(r) != 2 || r["state"] != "pending" || r["from"] != "a1b2 3 1790000000" || out["paused"] != true {
		t.Fatalf("pending: %v", out)
	}
	if status, out := w.do("POST", "/api/v1/ledger/reconcile", nil); status != 409 || out["error"] != "restore_pending" {
		t.Fatalf("reconcile while pending: %d %v", status, out)
	}
	if status, out := w.do("POST", "/api/v1/ledger/restore-books", nil); status != 409 || out["error"] != "not_no_channel" {
		t.Fatalf("restore-books while pending: %d %v", status, out)
	}
	now = now.Add(31 * time.Minute)
	w.l.CheckRestore(ctx)
	if _, out := w.do("GET", "/api/v1/wallet", nil); out["restore"].(map[string]any)["state"] != "no_channel" {
		t.Fatalf("no channel: %v", out["restore"])
	}
	w.f.Channel, w.f.ChannelState = true, "Offline"
	if status, out := w.do("POST", "/api/v1/ledger/restore-books", nil); status != 409 || out["error"] != "channel_not_up" {
		t.Fatalf("restore-books with a channel not up: %d %v", status, out)
	}
	w.f.SetDown(true)
	if status, out := w.do("POST", "/api/v1/ledger/restore-books", nil); status != 503 || out["error"] != "phoenixd_unreachable" {
		t.Fatalf("restore-books with phoenixd down: %d %v", status, out)
	}
	w.f.SetDown(false)
	w.f.Channel = false
	w.f.BalanceSat = 140_000 // 10,000 sat less than the backup's books
	if status, out := w.do("POST", "/api/v1/ledger/restore-books", nil); status != 200 || out["bookedMsat"] != -10_000_000.0 {
		t.Fatalf("restore-books: %d %v", status, out)
	}
	_, out = w.do("GET", "/api/v1/wallet", nil)
	r := out["restore"].(map[string]any)
	if r["state"] != "done" || r["reconciledMsat"] != -10_000_000.0 || r["reconciledAt"] != float64(now.Unix()) || out["paused"] != false || w.balance(store.Pool) != 40_000_000 {
		t.Fatalf("done: %v, pool %d", out, w.balance(store.Pool))
	}
	if status, out := w.do("POST", "/api/v1/ledger/restore-books", nil); status != 409 || out["error"] != "not_no_channel" {
		t.Fatalf("restore-books again: %d %v", status, out)
	}
	if hasKey(r, "final") {
		t.Fatalf("final without restore.final: %v", r)
	}
	// From the old server's final snapshot (cardd restore -final).
	w.st.SetMeta(ctx, "restore.final", "1")
	if _, out := w.do("GET", "/api/v1/wallet", nil); out["restore"].(map[string]any)["final"] != true {
		t.Fatalf("final: %v", out["restore"])
	}
}

func hasKey(m map[string]any, k string) bool {
	_, ok := m[k]
	return ok
}

// Shop in the wallet: its balance, no address, and how many PoS
// phones and paid sales there are; it is moved from like any account, never to.
func TestWalletShowsShop(t *testing.T) {
	w := moneySetup(t)
	status, out := w.do("GET", "/api/v1/wallet", nil)
	shop, ok := out["shop"].(map[string]any)
	if status != 200 || !ok || shop["balanceMsat"] != 0.0 || shop["heldMsat"] != 0.0 || shop["address"] != "" || shop["phones"] != 0.0 || shop["sales"] != 0.0 {
		t.Fatalf("%d shop: %v", status, out["shop"])
	}
	move := func(id, from, to string) (int, map[string]any) {
		return w.do("POST", "/api/v1/move", map[string]any{"id": id, "from": from, "to": to, "amountMsat": 1000})
	}
	if status, out := move("m1", "shop", "pool"); status != 409 || out["error"] != "insufficient" {
		t.Fatalf("from an empty shop: %d %v", status, out)
	}
	if status, out := move("m2", "pool", "shop"); status != 409 || out["error"] != "cannot_receive" {
		t.Fatalf("to shop: %d %v", status, out)
	}
	if status, out := w.do("GET", "/api/v1/accounts/shop/history", nil); status != 200 || len(out["transactions"].([]any)) != 0 {
		t.Fatalf("shop's history: %d %v", status, out)
	}
}

// A send to an address or a pay URL says in the log how long the recipient's
// server took to give its invoice: time a send spends before any money is
// held, which the ledger's line for the payment can't show. The
// address is not in the log. A send to an invoice has no such line.
func TestASendLogsHowLongItsAddressTook(t *testing.T) {
	w := moneySetup(t)
	status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "r1", "to": "http://pay.example.com/lnurlp/shop", "amountMsat": 2_000_000})
	if status != 200 || out["status"] != "sent" {
		t.Fatalf("%d %v", status, out)
	}
	want := regexp.MustCompile(fmt.Sprintf(`(?m)^api: send %s: the address gave its invoice after \d+ ms$`, out["paymentHash"]))
	if got := w.logs.String(); !want.MatchString(got) || strings.Contains(got, "pay.example.com") {
		t.Fatalf("log: %q", got)
	}
	w.logs.Reset()
	bolt11, _ := w.f.Invoice(1_000_000)
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "r2", "to": bolt11}); status != 200 || out["status"] != "sent" {
		t.Fatalf("%d %v", status, out)
	}
	if got := w.logs.String(); strings.Contains(got, "the address") {
		t.Fatalf("log of a send to an invoice: %q", got)
	}
	// One whose server gives no invoice says how long that took, too.
	w.logs.Reset()
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "r3", "to": "nobody@nowhere.example.com", "amountMsat": 2_000_000}); status == 200 {
		t.Fatalf("an address with no server was paid: %v", out)
	}
	if got := w.logs.String(); !regexp.MustCompile(`(?m)^api: send: the address gave no invoice after \d+ ms$`).MatchString(got) || strings.Contains(got, "nowhere.example.com") {
		t.Fatalf("log: %q", got)
	}
}

// A send keeps the address paid, the link's own text and the person's note;
// its line opens with them and its proof.
func TestASendsLineOpensWithItsFacts(t *testing.T) {
	w := moneySetup(t)
	status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "n1", "to": "http://pay.example.com/lnurlp/shop", "amountMsat": 2_000_000, "comment": "  for the\nshop  "})
	if status != 200 || out["status"] != "sent" {
		t.Fatalf("%d %v", status, out)
	}
	_, hist := w.do("GET", "/api/v1/accounts/pool/history", nil)
	line := hist["transactions"].([]any)[0].(map[string]any)
	if line["comment"] != "for the shop" {
		t.Fatalf("history line: %v", line)
	}
	id := int64(line["id"].(float64))
	status, got := w.do("GET", fmt.Sprintf("/api/v1/accounts/pool/transactions/%d", id), nil)
	p, _ := got["payment"].(map[string]any)
	hash, _ := p["hash"].(string)
	preimage, _ := p["preimage"].(string)
	invoice, _ := p["invoice"].(string)
	if status != 200 || got["comment"] != "for the shop" || p == nil || p["destination"] != "http://pay.example.com/lnurlp/shop" || p["description"] != "Shop" ||
		len(hash) != 64 || len(preimage) != 64 || !strings.HasPrefix(invoice, "ln") {
		t.Fatalf("%d %v", status, got)
	}
	if status, out := w.do("GET", fmt.Sprintf("/api/v1/accounts/hosting/transactions/%d", id), nil); status != 404 || out["error"] != "not_found" {
		t.Fatalf("another account's line: %d %v", status, out)
	}
	if status, out := w.do("GET", "/api/v1/accounts/pool/transactions/99999", nil); status != 404 || out["error"] != "not_found" {
		t.Fatalf("an unknown line: %d %v", status, out)
	}
	if status, out := w.do("GET", "/api/v1/accounts/fees/transactions/1", nil); status != 400 {
		t.Fatalf("fees named: %d %v", status, out)
	}
}

// A line's preimage in three states: not asked of phoenixd yet
// (NULL) has no preimage key; asked and not known ("") is an empty string;
// known is 64 hex characters.
func TestAPreimageInItsThreeStates(t *testing.T) {
	w := moneySetup(t)
	bolt11, _ := w.f.Invoice(1_000_000)
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "r1", "to": bolt11}); status != 200 || out["status"] != "sent" {
		t.Fatalf("%d %v", status, out)
	}
	_, hist := w.do("GET", "/api/v1/accounts/pool/history", nil)
	id := int64(hist["transactions"].([]any)[0].(map[string]any)["id"].(float64))
	payment := func() map[string]any {
		t.Helper()
		status, got := w.do("GET", fmt.Sprintf("/api/v1/accounts/pool/transactions/%d", id), nil)
		p, _ := got["payment"].(map[string]any)
		if status != 200 || p == nil {
			t.Fatalf("%d %v", status, got)
		}
		return p
	}
	set := func(preimage any) {
		t.Helper()
		db, err := sql.Open("sqlite", "file:"+w.db)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		if _, err := db.Exec(`UPDATE holds SET preimage = ?`, preimage); err != nil {
			t.Fatal(err)
		}
	}
	if p := payment(); !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(fmt.Sprint(p["preimage"])) {
		t.Fatalf("known: %v", p)
	}
	set(nil)
	if p := payment(); p["preimage"] != nil {
		t.Fatalf("not asked yet: %v", p)
	} else if _, ok := p["preimage"]; ok {
		t.Fatalf("not asked yet, a preimage key: %v", p)
	}
	set("")
	if p := payment(); p["preimage"] != "" {
		t.Fatalf("not known: %v", p)
	}
}

// The person's note: cleaned, counted in characters, refused over 200, and
// removed when empty; a send's note is refused the same way
// before any money is held.
func TestANotesRules(t *testing.T) {
	w := moneySetup(t)
	bolt11, _ := w.f.Invoice(1_000_000)
	w.do("POST", "/api/v1/send", map[string]any{"id": "r1", "to": bolt11})
	_, hist := w.do("GET", "/api/v1/accounts/pool/history", nil)
	id := int64(hist["transactions"].([]any)[0].(map[string]any)["id"].(float64))
	path := fmt.Sprintf("/api/v1/accounts/pool/transactions/%d", id)
	for _, c := range []struct {
		in, want string
		status   int
	}{
		{"a\nb‮c", "a b c", 200},
		{strings.Repeat("😀", 200), strings.Repeat("😀", 200), 200},
		{strings.Repeat("x", 201), "", 400},
		{"   ", "", 200},
	} {
		status, out := w.do("PATCH", path, map[string]any{"comment": c.in})
		if status != c.status || (status == 200 && out["comment"] != c.want) || (status == 400 && out["error"] != "bad_note") {
			t.Fatalf("%q: %d %v", c.in, status, out)
		}
	}
	if status, out := w.do("PATCH", path, map[string]any{"comment": "x", "other": 1}); status != 400 || out["error"] != "malformed" {
		t.Fatalf("unknown field: %d %v", status, out)
	}
	// The edges of the route: a note is set on this account's own
	// lines only, and the body says what the note is.
	w.do("PATCH", path, map[string]any{"comment": "kept"})
	for _, c := range []struct {
		name, path string
		body       any
		status     int
		code       string
	}{
		{"an id that isn't a number", "/api/v1/accounts/pool/transactions/abc", map[string]any{"comment": "x"}, 400, "malformed"},
		{"an id of 0", "/api/v1/accounts/pool/transactions/0", map[string]any{"comment": "x"}, 400, "malformed"},
		{"an unknown account", fmt.Sprintf("/api/v1/accounts/nope/transactions/%d", id), map[string]any{"comment": "x"}, 400, "malformed"},
		{"another account's line", fmt.Sprintf("/api/v1/accounts/hosting/transactions/%d", id), map[string]any{"comment": "x"}, 404, "not_found"},
		{"a line that doesn't exist", fmt.Sprintf("/api/v1/accounts/pool/transactions/%d", id+999), map[string]any{"comment": "x"}, 404, "not_found"},
		{"a comment that isn't text", path, map[string]any{"comment": 5}, 400, "malformed"},
		{"no comment: required, not a removal", path, map[string]any{}, 400, "malformed"},
		{"a null comment: required, not a removal", path, map[string]any{"comment": nil}, 400, "malformed"},
	} {
		if status, out := w.do("PATCH", c.path, c.body); status != c.status || out["error"] != c.code {
			t.Fatalf("%s: %d %v", c.name, status, out)
		}
	}
	if _, line := w.do("GET", path, nil); line["comment"] != "kept" {
		t.Fatalf("a refused PATCH changed the note: %v", line)
	}
	bolt11, _ = w.f.Invoice(1_000_000)
	before := w.balance(store.Pool) // moneyWorld's: the account's available msat
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "r2", "to": bolt11, "comment": strings.Repeat("x", 201)}); status != 400 || out["error"] != "bad_note" {
		t.Fatalf("send with a long note: %d %v", status, out)
	}
	if w.balance(store.Pool) != before {
		t.Fatal("money held for a refused note")
	}
}

// testNames stands in for bip353.Resolver: a name's offer, or its error.
type testNames map[string]any

func (n testNames) Resolve(_ context.Context, user, domain string) (bip353.Result, error) {
	switch v := n[user+"@"+domain].(type) {
	case string:
		return bip353.Result{URI: "bitcoin:?lno=" + v, Offer: v}, nil
	case error:
		return bip353.Result{}, v
	}
	return bip353.Result{}, bip353.ErrNone
}

func TestLookingUpOverTheAPI(t *testing.T) {
	w := moneySetup(t)
	fixed := w.f.Offer(4_500_000, "Flat white, large", "Ana's Café")
	free := w.f.Offer(0, "", "")
	w.names["alice@phoenixwallet.me"] = free
	status, out := w.do("POST", "/api/v1/send/lookup", map[string]any{"to": fixed})
	if status != 200 || out["kind"] != "offer" || out["amountMsat"] != 4_500_000.0 || out["description"] != "Flat white, large" || out["issuer"] != "Ana's Café" || hasKey(out, "name") {
		t.Fatalf("fixed offer: %d %v", status, out)
	}
	status, out = w.do("POST", "/api/v1/send/lookup", map[string]any{"to": "₿alice@phoenixwallet.me"})
	if status != 200 || out["kind"] != "offer" || out["offer"] != free || out["name"] != "₿alice@phoenixwallet.me" || out["amountMsat"] != nil || !hasKey(out, "amountMsat") {
		t.Fatalf("a ₿ name: %d %v", status, out)
	}
	// A plain name with no record: LNURL, as today.
	status, out = w.do("POST", "/api/v1/send/lookup", map[string]any{"to": "alice@pay.example.com"})
	if status != 200 || out["kind"] != "payurl" || out["to"] != "alice@pay.example.com" || out["minMsat"] != 1_000.0 || out["maxMsat"] != 100_000_000.0 {
		t.Fatalf("an LNURL address: %d %v", status, out)
	}
	w.f.OfferCurrency(fixed, "USD")
	status, out = w.do("POST", "/api/v1/send/lookup", map[string]any{"to": fixed})
	if status != 400 || out["error"] != "bad_destination" || out["message"] != "This offer is priced in USD: Send out can only pay offers priced in sats." {
		t.Fatalf("a currency: %d %v", status, out)
	}
}

// phoenixd refusing a decode for any reason but a bad offer (here its
// password, a 401) is phoenixd failing: 503, never bad_destination or a 500.
func TestALookupPhoenixdRefusesIsUnreachable(t *testing.T) {
	w := moneySetup(t)
	offer := w.f.Offer(0, "", "")
	w.money.Lookup.Offers = phoenixd.New(w.f.URL, "not-the-password")
	status, out := w.do("POST", "/api/v1/send/lookup", map[string]any{"to": offer})
	if status != 503 || out["error"] != "phoenixd_unreachable" {
		t.Fatalf("%d %v", status, out)
	}
}

// phoenixd failing inside (a 500 from /decodeoffer) is phoenixd unreachable
// too, not cardd's own 500.
func TestALookupPhoenixdFailsIsUnreachable(t *testing.T) {
	w := moneySetup(t)
	offer := w.f.Offer(0, "", "")
	w.f.Broken = "/decodeoffer"
	status, out := w.do("POST", "/api/v1/send/lookup", map[string]any{"to": offer})
	if status != 503 || out["error"] != "phoenixd_unreachable" {
		t.Fatalf("%d %v", status, out)
	}
}

func TestSendAnOffer(t *testing.T) {
	w := moneySetup(t)
	offer := w.f.Offer(0, "Coffee", "Ana's Café")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{FeeMsat: 4_400})
	status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "o1", "to": offer, "amountMsat": 1_000_000})
	if status != 200 || out["status"] != "sent" || out["feeMsat"] != 4_400.0 || out["paymentHash"] != w.f.OfferPayments(offer)[0] {
		t.Fatalf("%d %v", status, out)
	}
	if w.balance(store.Pool) != 50_000_000-1_000_000-4_400 {
		t.Fatalf("pool %d", w.balance(store.Pool))
	}
	h, _ := w.st.HoldByRef(context.Background(), "request:o1")
	if h.About.Destination != "an offer from Ana's Café" || h.About.Description != "Coffee" {
		t.Fatalf("what it was: %+v", h.About)
	}
	// An offer with no amount needs one; a fixed one must agree.
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "o2", "to": offer}); status != 400 {
		t.Fatalf("no amount: %d %v", status, out)
	}
	fixed := w.f.Offer(2_000_000, "", "")
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "o3", "to": fixed, "amountMsat": 3_000_000}); status != 400 {
		t.Fatalf("another amount: %d %v", status, out)
	}
	// Absent or equal: a negative amount is neither.
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "o3n", "to": fixed, "amountMsat": -1_000}); status != 400 || out["error"] != "malformed" {
		t.Fatalf("a negative amount: %d %v", status, out)
	}
	if _, err := w.st.HoldByRef(context.Background(), "request:o3n"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a hold was made for a negative amount: %v", err)
	}
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "o4", "to": fixed}); status != 200 || out["amountMsat"] != 2_000_000.0 {
		t.Fatalf("the offer's own amount: %d %v", status, out)
	}
	// A name only goes with an offer.
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "o5", "to": "alice@pay.example.com", "amountMsat": 1_000, "name": "₿alice@pay.example.com"}); status != 400 || out["error"] != "malformed" {
		t.Fatalf("a name with an address: %d %v", status, out)
	}
}

func TestANameWhoseRecordChangedIsRefused(t *testing.T) {
	w := moneySetup(t)
	first, second := w.f.Offer(0, "", ""), w.f.Offer(0, "", "")
	w.names["alice@phoenixwallet.me"] = second // changed since Check showed first
	status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "c1", "to": first, "amountMsat": 1_000_000, "name": "₿alice@phoenixwallet.me"})
	if status != 400 || out["error"] != "bad_destination" || out["message"] != "₿alice@phoenixwallet.me's record changed since it was looked up: look it up again." {
		t.Fatalf("%d %v", status, out)
	}
	if _, err := w.st.HoldByRef(context.Background(), "request:c1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a hold was made: %v", err)
	}
	w.names["alice@phoenixwallet.me"] = first
	status, out = w.do("POST", "/api/v1/send", map[string]any{"id": "c2", "to": first, "amountMsat": 1_000_000, "name": "₿alice@phoenixwallet.me"})
	if status != 200 || out["status"] != "sent" {
		t.Fatalf("unchanged: %d %v", status, out)
	}
	if h, _ := w.st.HoldByRef(context.Background(), "request:c2"); h.About.Destination != "₿alice@phoenixwallet.me" {
		t.Fatalf("destination: %+v", h.About)
	}
}

// An offer that expired between the lookup and Send is checked again and
// refused before any money is held.
func TestAnOfferExpiredSinceTheLookupIsRefused(t *testing.T) {
	w := moneySetup(t)
	offer := w.f.Offer(0, "", "")
	if status, out := w.do("POST", "/api/v1/send/lookup", map[string]any{"to": offer}); status != 200 {
		t.Fatalf("lookup: %d %v", status, out)
	}
	w.f.OfferExpired(offer)
	before := w.balance(store.Pool)
	status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "x1", "to": offer, "amountMsat": 1_000_000})
	if status != 400 || out["error"] != "bad_destination" || out["message"] != "This offer has expired." {
		t.Fatalf("%d %v", status, out)
	}
	if _, err := w.st.HoldByRef(context.Background(), "request:x1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a hold was made: %v", err)
	}
	if w.balance(store.Pool) != before {
		t.Fatal("money moved for an expired offer")
	}
}

func TestANotSentOfferSaysWhy(t *testing.T) {
	w := moneySetup(t)
	offer := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Fail: "no response to the invoice request"})
	status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "n1", "to": offer, "amountMsat": 1_000_000})
	if status != 200 || out["status"] != "failed" || out["reason"] != "The receiving wallet didn't answer: it may be offline. Try again later." {
		t.Fatalf("%d %v", status, out)
	}
	if status, out := w.do("GET", "/api/v1/send/n1", nil); status != 200 || out["status"] != "failed" || out["reason"] != "The receiving wallet didn't answer: it may be offline. Try again later." {
		t.Fatalf("its state, read later: %d %v", status, out)
	}
}

// The held read wakes on the store's bell as the hold settles: the recheck
// is set far past the test, so only the ring can answer it in time.
func TestSendStateFollowsAPendingOffer(t *testing.T) {
	w := moneySetup(t)
	w.money.Bell, w.money.HeldRecheck = NewBell(), 30*time.Second
	w.st.Changed = w.money.Bell.Changed
	offer := w.f.Offer(0, "", "")
	w.f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true})
	status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "p1", "to": offer, "amountMsat": 1_000_000})
	if status != 200 || out["status"] != "pending" || out["paymentHash"] != "" {
		t.Fatalf("pending: %d %v", status, out)
	}
	if status, out := w.do("GET", "/api/v1/send/p1", nil); status != 200 || out["status"] != "pending" {
		t.Fatalf("read now: %d %v", status, out)
	}
	got := make(chan map[string]any, 1)
	go func() {
		_, out := w.do("GET", "/api/v1/send/p1?wait=10", nil)
		got <- out
	}()
	time.Sleep(100 * time.Millisecond)
	w.f.ReleaseOffer(offer, false, 3_300)
	select {
	case out := <-got:
		if out["status"] != "sent" || out["feeMsat"] != 3_300.0 || out["paymentHash"] == "" {
			t.Fatalf("held read: %v", out)
		}
	case <-time.After(time.Second):
		t.Fatal("the held read didn't answer within a second of the send ending: the bell rang nothing")
	}
	if status, out := w.do("GET", "/api/v1/send/nobody", nil); status != 404 || out["error"] != "not_found" {
		t.Fatalf("an unknown id: %d %v", status, out)
	}
}

// phoenixd failing to decode an invoice (HTTP 500) is phoenixd unreachable,
// not "the invoice can't be paid": the person isn't told their invoice is bad.
func TestSendWhenDecodeinvoiceFailsIsUnreachable(t *testing.T) {
	w := moneySetup(t)
	bolt11, _ := w.f.Invoice(1_000_000)
	w.f.Broken = "/decodeinvoice"
	status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "d500", "to": bolt11})
	if status != 503 || out["error"] != "phoenixd_unreachable" {
		t.Fatalf("%d %v", status, out)
	}
	if w.balance(store.Pool) != 50_000_000 {
		t.Fatalf("pool %d", w.balance(store.Pool))
	}
}
