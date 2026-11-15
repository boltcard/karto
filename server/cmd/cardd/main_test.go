package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/rates"
	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/testvec"
)

// TestMain points cardd serve's three sources of the rate at a closed port:
// serve's tests never reach mempool.space, Coinbase or Kraken, and a test of
// the rate gives its own -rates-*-url.
func TestMain(m *testing.M) {
	os.Setenv("CARDD_RATES_MEMPOOL_URL", "http://127.0.0.1:1/api/v1/prices")
	os.Setenv("CARDD_RATES_COINBASE_URL", "http://127.0.0.1:1/v2/exchange-rates")
	os.Setenv("CARDD_RATES_KRAKEN_URL", "http://127.0.0.1:1/0/public/Ticker")
	os.Exit(m.Run())
}

// rateArgs are the three -rates-*-url flags, each pointing at a fake of its
// source answering GBP 61,352 a bitcoin.
func rateArgs(t *testing.T) []string {
	t.Helper()
	answers := []string{
		`{"time":%d,"USD":80854,"EUR":72070,"GBP":61352,"CAD":114850,"CHF":67032,"AUD":116376,"JPY":12780023}`,
		`{"data":{"currency":"BTC","rates":{"USD":"80854","EUR":"72070","GBP":"61352","CAD":"114850","CHF":"67032","AUD":"116376","JPY":"12780023"}}}`,
		`{"error":[],"result":{"BTC/USD":{"a":["80855"],"b":["80853"]},"BTC/EUR":{"a":["72071"],"b":["72069"]},"BTC/GBP":{"a":["61353"],"b":["61351"]},` +
			`"BTC/CAD":{"a":["114851"],"b":["114849"]},"BTC/CHF":{"a":["67033"],"b":["67031"]},"BTC/AUD":{"a":["116377"],"b":["116375"]},"BTC/JPY":{"a":["12780024"],"b":["12780022"]}}}`,
	}
	var args []string
	for i, flag := range []string{"-rates-mempool-url", "-rates-coinbase-url", "-rates-kraken-url"} {
		answer := answers[i]
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body := answer
			if flag == "-rates-mempool-url" { // mempool.space's answer has its time
				body = fmt.Sprintf(answer, time.Now().Unix())
			}
			io.WriteString(w, body)
		}))
		t.Cleanup(srv.Close)
		args = append(args, flag, srv.URL)
	}
	return args
}

// cardd serve asks the three sources from its start and keeps the rate in
// rates.json beside the database, not in it, so a new rate leaves a backup's
// snapshot as it was; the store's limits read the same rate.
func TestServeFetchesTheRate(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	args := append(serveArgs(t, f.URL), rateArgs(t)...)
	srv, err := newServer(args)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.cleanup()
	ctx := context.Background()
	if _, ok := srv.store.Rate(); ok {
		t.Fatal("a rate before any fetch")
	}
	dir := t.TempDir()
	before, after := filepath.Join(dir, "before.db"), filepath.Join(dir, "after.db")
	if err := srv.store.SnapshotTo(ctx, before); err != nil {
		t.Fatal(err)
	}
	if err := srv.rates.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	if p, _ := srv.rates.Last(); !reflect.DeepEqual(p.From, []string{rates.Mempool, rates.Coinbase, rates.Kraken}) {
		t.Fatalf("the rate's sources: %v", p.From)
	}
	if err := srv.store.SnapshotTo(ctx, after); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(before)
	b, _ := os.ReadFile(after)
	if len(a) == 0 || !bytes.Equal(a, b) {
		t.Fatal("a new rate changed the snapshot: the backup would make a new version every 5 minutes")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(args[1]), "rates.json")); err != nil {
		t.Fatalf("no rates.json beside the database: %v", err)
	}
	if p, ok := srv.store.Rate(); !ok || p.Per["GBP"] != 61352 {
		t.Fatalf("the store's rate of GBP: %d %v", p.Per["GBP"], ok)
	}
	// run starts the fetching: a second server has its rate within seconds of starting.
	srv2, err := newServer(append(serveArgs(t, f.URL), rateArgs(t)...))
	if err != nil {
		t.Fatal(err)
	}
	defer srv2.cleanup()
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go srv2.run(runCtx)
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if _, ok := srv2.rates.Last(); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no rate 5 s after serve started")
		}
	}
}

func TestDeviceCommands(t *testing.T) {
	db := filepath.Join(t.TempDir(), "cardd.db")
	v := testvec.Load(t).DeviceAuth
	var out bytes.Buffer
	if err := run([]string{"device", "add", "-db", db, "-pubkey", strings.ToUpper(v.PublicKey) + "\n", "-name", "Pixel"}, &out); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != v.KeyID {
		t.Fatalf("add printed %q, want %s", out.String(), v.KeyID)
	}
	out.Reset()
	run([]string{"device", "list", "-db", db}, &out)
	if !strings.Contains(out.String(), v.KeyID+"\tPixel\tactive") {
		t.Fatalf("list: %q", out.String())
	}
	if err := run([]string{"device", "revoke", "-db", db, "-key-id", v.KeyID}, &out); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	run([]string{"device", "list", "-db", db}, &out)
	if !strings.Contains(out.String(), "revoked") {
		t.Fatalf("list after revoke: %q", out.String())
	}
	if err := run([]string{"device", "add", "-db", db, "-pubkey", "04abcd", "-name", "x"}, &out); err == nil {
		t.Fatal("accepted an invalid public key")
	}
}

func TestIssuerKeyFile(t *testing.T) {
	dir := t.TempDir()
	write := func(name, s string) string {
		p := filepath.Join(dir, name)
		os.WriteFile(p, []byte(s), 0o600)
		return p
	}
	if _, err := readIssuerKey(write("ok", "866a12e42e31a09aa8ca4f25a02e999e\n")); err != nil {
		t.Fatalf("trailing newline rejected: %v", err)
	}
	for name, s := range map[string]string{"short": "866a12e4", "nothex": strings.Repeat("z", 32), "empty": ""} {
		if _, err := readIssuerKey(write(name, s)); err == nil {
			t.Errorf("%s: accepted %q", name, s)
		}
	}
	if _, err := readIssuerKey(""); err == nil {
		t.Error("missing flag accepted")
	}
}

// serveArgs: a database, an issuer key and a phoenix.conf for the fake phoenixd.
func serveArgs(t *testing.T, pdURL string) []string {
	dir := t.TempDir()
	key := filepath.Join(dir, "issuer.key")
	os.WriteFile(key, []byte("866a12e42e31a09aa8ca4f25a02e999e"), 0o600)
	conf := filepath.Join(dir, "phoenix.conf")
	os.WriteFile(conf, []byte("http-password="+phoenixdtest.Password+"\nwebhook-secret="+phoenixdtest.WebhookSecret+"\n"), 0o644)
	return []string{"-db", filepath.Join(dir, "cardd.db"), "-host", "vm-1.lnvps.cloud", "-issuer-key-file", key,
		"-phoenixd-url", pdURL, "-phoenixd-conf", conf}
}

func TestServeHealth(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	srv, err := newServer(serveArgs(t, f.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer srv.cleanup()
	rec := httptest.NewRecorder()
	srv.public.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("health: %d %s", rec.Code, rec.Body.String())
	}
	args := serveArgs(t, f.URL)
	if _, err := newServer(append(args[:2:2], args[4:]...)); err == nil {
		t.Fatal("missing -host accepted")
	}
	if _, err := newServer(append(serveArgs(t, f.URL), "-host", "https://vm-1.lnvps.cloud")); err == nil {
		t.Fatal("a URL as -host accepted")
	}
	if _, err := newServer(append(serveArgs(t, f.URL), "-phoenixd-conf", filepath.Join(t.TempDir(), "none"))); err == nil {
		t.Fatal("missing phoenix.conf accepted")
	}
}

// The wiring: the public mux serves top-up addresses, spending is allowed
// once the ledger has reconciled, and only the webhook mux takes phoenixd's
// payment_received.
func TestServeWiring(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	srv, err := newServer(serveArgs(t, f.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer srv.cleanup()
	pub := httptest.NewServer(srv.public)
	defer pub.Close()
	hook := httptest.NewServer(srv.webhook)
	defer hook.Close()

	get := func(path string) map[string]any {
		resp, err := http.Get(pub.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		json.NewDecoder(resp.Body).Decode(&out)
		return out
	}
	if pr := get("/.well-known/lnurlp/pool"); pr["tag"] != "payRequest" {
		t.Fatalf("payRequest: %v", pr)
	}
	if h := get("/health"); h["alert"] != "spending paused" {
		t.Fatalf("health before the first check: %v", h)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.run(ctx)
	for i := 0; get("/health")["alert"] != nil; i++ {
		if i > 100 {
			t.Fatal("still paused after the first check")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cb := get("/lnurlp/pool/cb?amount=5000000")
	f.WebhookURL = hook.URL + "/phoenixd"
	f.Channel = true
	f.Receive(cb["pr"].(string), 5000, 0)
	if b, _ := srv.store.Balance(ctx, store.Pool); b.EntriesMsat != 5_000_000 {
		t.Fatalf("the webhook didn't credit pool: %+v", b)
	}
	resp, _ := http.Post(pub.URL+"/phoenixd", "application/json", strings.NewReader("{}"))
	if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("the public port took a webhook: HTTP %d", resp.StatusCode)
	}
}

// cardd renews the VM through LNVPS's own host, over https, from hosting.
func TestServeRenews(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	srv, err := newServer(serveArgs(t, f.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer srv.cleanup()
	r := srv.renewer
	if r == nil || r.LNVPS != "https://api.lnvps.net" || r.Resolver == nil || r.Resolver.Scheme != "https" || r.Decoder == nil || r.Ledger == nil || r.Store != srv.store {
		t.Fatalf("renewer %+v", r)
	}
}

// A restore keeps this phone and revokes every other one, and refuses a keep
// id that would lock this phone out.
func TestDeviceRevokeOthers(t *testing.T) {
	db := filepath.Join(t.TempDir(), "cardd.db")
	v := testvec.Load(t).DeviceAuth
	var out bytes.Buffer
	if err := run([]string{"device", "add", "-db", db, "-pubkey", v.PublicKey, "-name", "Pixel"}, &out); err != nil {
		t.Fatal(err)
	}
	st, _ := store.Open(db)
	st.AddDevice(context.Background(), store.Device{KeyID: "aaaaaaaaaaaaaaaa", PublicKey: "04aa", Name: "Lost"})
	st.Close()
	if err := run([]string{"device", "revoke-others", "-db", db, "-keep", "bbbbbbbbbbbbbbbb"}, &out); err == nil {
		t.Fatal("kept an unknown device")
	}
	out.Reset()
	if err := run([]string{"device", "revoke-others", "-db", db, "-keep", v.KeyID}, &out); err != nil || strings.TrimSpace(out.String()) != "1" {
		t.Fatalf("%q %v", out.String(), err)
	}
	out.Reset()
	run([]string{"device", "list", "-db", db}, &out)
	if !strings.Contains(out.String(), v.KeyID+"\tPixel\tactive") || !strings.Contains(out.String(), "aaaaaaaaaaaaaaaa\tLost\trevoked") {
		t.Fatalf("list: %q", out.String())
	}
}

// cardd serve backs up next to its database, from start-up.
func TestServeBacksUp(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	args := serveArgs(t, f.URL)
	srv, err := newServer(args)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.cleanup()
	srv.store.SetMeta(context.Background(), "backup.recipient", testvec.Load(t).Phrase.BackupAgeRecipient)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.run(ctx)
	want := filepath.Join(filepath.Dir(args[1]), "backups", "1.age")
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if _, err := os.Stat(want); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no %s", want)
		}
	}
}

// `cardd ledger reconcile` books the difference to pool.
func TestLedgerReconcile(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	args := serveArgs(t, f.URL)
	ledgerArgs := append([]string{"ledger", "reconcile"}, append(args[0:2:2], args[6:]...)...)
	st, err := store.Open(args[1])
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	st.Credit(ctx, store.Pool, 10_000_000, "h", "")
	// phoenixd lost 7,000 sat, and a 5,000 sat top-up arrived while cardd missed its webhook.
	f.BalanceSat, f.Channel = 3_000, true
	bolt11, _, err := phoenixd.New(f.URL, phoenixdtest.Password).CreateInvoice(ctx, 5_000, strings.Repeat("ab", 32), "pool", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	f.Receive(bolt11, 5_000, 0)
	var out bytes.Buffer
	if err := run(ledgerArgs, &out); err != nil {
		t.Fatal(err)
	}
	// The sweep credited the top-up first: the books are set by the 7,000 sat lost.
	if b, _ := st.Balance(ctx, store.Pool); b.EntriesMsat != 8_000_000 || !strings.Contains(out.String(), "-7000000 msat") {
		t.Fatalf("pool %+v, said %q", b, out.String())
	}
	out.Reset()
	if err := run(ledgerArgs, &out); err != nil || !strings.Contains(out.String(), "add up") {
		t.Fatalf("again: %q %v", out.String(), err)
	}
	// After a restore the books are set once the channel is back, not by hand.
	st.SetMeta(ctx, "restore.reconcile", "pending")
	if err := run(ledgerArgs, &out); !errors.Is(err, ledger.ErrRestorePending) {
		t.Fatalf("while a restore is pending: %v", err)
	}
}

// `cardd ledger holds` lists the payments in progress, touching nothing:
// install.sh recovery-check refuses while there are any.
func TestLedgerHolds(t *testing.T) {
	db := filepath.Join(t.TempDir(), "cardd.db")
	st, err := store.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	holds := func() string {
		t.Helper()
		var out bytes.Buffer
		if err := run([]string{"ledger", "holds", "-db", db}, &out); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	if got := holds(); got != "" {
		t.Fatalf("with none open: %q", got)
	}
	st.Credit(ctx, store.Pool, 10_000_000, "h", "")
	h, err := st.OpenHold(ctx, store.HoldRequest{Account: store.Pool, Kind: store.KindSend, AmountMsat: 1_000_000, FeeBudgetMsat: 10_000, PaymentHash: strings.Repeat("ab", 32)})
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("%d\tpool\tsend\t1000000\t%s\n", h.ID, h.CreatedAt.UTC().Format(time.RFC3339))
	if got := holds(); got != want {
		t.Fatalf("one open: %q, want %q", got, want)
	}
	if b, _ := st.Balance(ctx, store.Pool); b.HeldMsat != 1_010_000 {
		t.Fatalf("listing changed the hold: %+v", b)
	}
	if _, err := st.ReleaseHold(ctx, h.ID); err != nil {
		t.Fatal(err)
	}
	if got := holds(); got != "" {
		t.Fatalf("after its release: %q", got)
	}
}

// CARDD_RESTORE_CHANNEL_WAIT shortens the wait for a channel after a
// restore (the stack test's 10 s).
func TestRestoreChannelWait(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	for env, want := range map[string]time.Duration{"": 30 * time.Minute, "10s": 10 * time.Second, "soon": 0} {
		t.Setenv("CARDD_RESTORE_CHANNEL_WAIT", env)
		srv, err := newServer(serveArgs(t, f.URL))
		if want == 0 {
			if err == nil {
				srv.cleanup()
				t.Fatalf("%q accepted", env)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%q: %v", env, err)
		}
		srv.cleanup()
		if srv.ledger.RestoreWait != want || srv.ledger.Liquidity == nil {
			t.Fatalf("%q: %v", env, srv.ledger.RestoreWait)
		}
	}
}

func TestLookupRejectsRevokedDevice(t *testing.T) {
	db := filepath.Join(t.TempDir(), "cardd.db")
	v := testvec.Load(t).DeviceAuth
	var out bytes.Buffer
	if err := run([]string{"device", "add", "-db", db, "-pubkey", v.PublicKey, "-name", "Pixel"}, &out); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	if _, role, err := lookup(st)(ctx, v.KeyID); err != nil || role != deviceauth.Owner {
		t.Fatalf("active device: %q %v", role, err)
	}
	// A PoS phone is looked up with its role, and the list says so in a fourth column.
	st.AddDevice(ctx, store.Device{KeyID: "cccccccccccccccc", PublicKey: v.PublicKey[:128] + "00", Name: "Till 1", Role: store.RolePos})
	if _, role, _ := lookup(st)(ctx, "cccccccccccccccc"); role != deviceauth.Pos {
		t.Fatalf("a PoS phone looked up as %q", role)
	}
	out.Reset()
	run([]string{"device", "list", "-db", db}, &out)
	if !strings.Contains(out.String(), v.KeyID+"\tPixel\tactive\n") || !strings.Contains(out.String(), "cccccccccccccccc\tTill 1\tactive\tpos\n") {
		t.Fatalf("list: %q", out.String())
	}
	if err := st.RevokeDevice(ctx, v.KeyID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := lookup(st)(ctx, v.KeyID); !errors.Is(err, deviceauth.ErrUnknownDevice) {
		t.Fatalf("revoked device: got %v, want ErrUnknownDevice", err)
	}
	if _, _, err := lookup(st)(ctx, "0000000000000000"); !errors.Is(err, deviceauth.ErrUnknownDevice) {
		t.Fatalf("unknown device: got %v", err)
	}
}

// Onboarding may run `device add` again after a crash: it must succeed
// with the same key id. A revoked key stays revoked.
func TestDeviceAddIsIdempotent(t *testing.T) {
	db := filepath.Join(t.TempDir(), "cardd.db")
	v := testvec.Load(t).DeviceAuth
	add := []string{"device", "add", "-db", db, "-pubkey", v.PublicKey, "-name", "Pixel"}
	for i := 0; i < 2; i++ {
		var out bytes.Buffer
		if err := run(add, &out); err != nil {
			t.Fatalf("add #%d: %v", i+1, err)
		}
		if strings.TrimSpace(out.String()) != v.KeyID {
			t.Fatalf("add #%d printed %q", i+1, out.String())
		}
	}
	var out bytes.Buffer
	run([]string{"device", "list", "-db", db}, &out)
	if n := strings.Count(out.String(), "\n"); n != 1 {
		t.Fatalf("list has %d devices, want 1: %q", n, out.String())
	}
	if err := run([]string{"device", "revoke", "-db", db, "-key-id", v.KeyID}, &out); err != nil {
		t.Fatal(err)
	}
	err := run(add, &out)
	if err == nil || !strings.Contains(err.Error(), "revoked") {
		t.Fatalf("re-adding a revoked key: got %v, want an error mentioning revoked", err)
	}
	// 5 tells the app this is final: retrying can't help, the phone needs a new key.
	if code := exitCode(err); code != 5 {
		t.Fatalf("exit code for a revoked key = %d, want 5", code)
	}
}

// `device add` with a PoS phone's key (a device's role never
// changes) finds the device, prints its id and leaves it a PoS phone; a
// removed PoS phone's key is refused like any revoked key.
func TestDeviceAddLeavesAPoSPhoneAPoSPhone(t *testing.T) {
	ctx := context.Background()
	db := filepath.Join(t.TempDir(), "cardd.db")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	raw, _ := key.PublicKey.Bytes()
	id, pub := deviceauth.KeyID(raw), hex.EncodeToString(raw)
	st, err := store.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AddDevice(ctx, store.Device{KeyID: id, PublicKey: pub, Name: "Till 1", Role: store.RolePos}); err != nil {
		t.Fatal(err)
	}
	st.Close()
	var out bytes.Buffer
	if err := run([]string{"device", "add", "-db", db, "-pubkey", pub, "-name", "Wallet"}, &out); err != nil || strings.TrimSpace(out.String()) != id {
		t.Fatalf("add: %q %v", out.String(), err)
	}
	out.Reset()
	run([]string{"device", "list", "-db", db}, &out)
	if out.String() != id+"\tTill 1\tactive\tpos\n" {
		t.Fatalf("list: %q", out.String())
	}
	if err := run([]string{"device", "revoke", "-db", db, "-key-id", id}, &out); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"device", "add", "-db", db, "-pubkey", pub, "-name", "Wallet"}, &out); !errors.Is(err, errRevoked) {
		t.Fatalf("add of a removed PoS phone's key: got %v, want errRevoked", err)
	}
}

// `cardd ledger reconcile` (and the app's Set the books) also has the fee
// credit cardd counts taken afresh from phoenixd, and says what became of it
// when phoenixd's channel isn't up: phoenixd's own figure can't be trusted
// then, so the count is forgotten and re-read at the first 5-minute check
// with the channel up.
func TestLedgerReconcileAndTheFeeCredit(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	args := serveArgs(t, f.URL)
	ledgerArgs := append([]string{"ledger", "reconcile"}, append(args[0:2:2], args[6:]...)...)
	st, err := store.Open(args[1])
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	st.Credit(ctx, store.Pool, 10_000_000, "h", "")
	st.SetKeptFeeCredit(ctx, 5_000)
	kept := func() int64 {
		t.Helper()
		sat, known, err := st.KeptFeeCredit(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !known {
			return -1
		}
		return sat
	}
	// The channel up, the books adding up: phoenixd's figure is taken, higher or lower, and nothing more is said.
	f.BalanceSat, f.Channel, f.FeeCreditSat = 10_000, true, 7_000
	var out bytes.Buffer
	if err := run(ledgerArgs, &out); err != nil || kept() != 7_000 || strings.Contains(out.String(), "fee credit") || !strings.Contains(out.String(), "add up") {
		t.Fatalf("channel up: %q %v, kept %d", out.String(), err, kept())
	}
	// phoenixd restarted and not yet reconnected (it reports no fee credit), and 2,000 sat short: the books are
	// set, the false 0 isn't taken, the count is forgotten, and the person is told.
	f.BalanceSat, f.ChannelState, f.FeeCreditSat = 8_000, "Offline", 0
	out.Reset()
	if err := run(ledgerArgs, &out); err != nil || kept() != -1 {
		t.Fatalf("channel down: %q %v, kept %d", out.String(), err, kept())
	}
	for _, want := range []string{"-2000000 msat", "phoenixd's channel isn't up", "forgotten", "5-minute check"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("channel down: the output lacks %q: %q", want, out.String())
		}
	}
}
