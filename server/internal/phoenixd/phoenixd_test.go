package phoenixd_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
)

func TestReadConf(t *testing.T) {
	path := filepath.Join(t.TempDir(), "phoenix.conf")
	os.WriteFile(path, []byte("\nhttp-password=pw1\nhttp-password-limited-access=pw2\nwebhook-secret=sec\n"), 0o644)
	c, err := phoenixd.ReadConf(path)
	if err != nil || c.HTTPPassword != "pw1" || c.WebhookSecret != "sec" {
		t.Fatalf("%+v %v", c, err)
	}
	os.WriteFile(path, []byte("http-password=pw1\n"), 0o644)
	if _, err := phoenixd.ReadConf(path); err == nil {
		t.Fatal("a conf without webhook-secret was accepted")
	}
}

func TestVerifyWebhook(t *testing.T) {
	// HMAC-SHA256("secret", "body"), as phoenixd's X-Phoenix-Signature.
	sig := "dc46983557fea127b43af721467eb9b3fde2338fe3e14f51952aa8478c13d355"
	if !phoenixd.VerifyWebhook("secret", []byte("body"), sig) {
		t.Fatal("good signature refused")
	}
	if phoenixd.VerifyWebhook("secret", []byte("bodY"), sig) || phoenixd.VerifyWebhook("secret", []byte("body"), "zz") {
		t.Fatal("bad signature accepted")
	}
}

func TestAgainstTheFake(t *testing.T) {
	ctx := context.Background()
	f := phoenixdtest.New()
	defer f.Close()
	c := phoenixd.New(f.URL, phoenixdtest.Password)

	bolt11, hash, err := c.CreateInvoice(ctx, 30_000, strings.Repeat("ab", 32), "pool", 10*time.Minute)
	if err != nil || hash == "" || bolt11 == "" {
		t.Fatalf("create: %q %q %v", bolt11, hash, err)
	}
	if p, found, err := c.IncomingPayment(ctx, hash); err != nil || !found || p.IsPaid || p.ExternalID != "pool" {
		t.Fatalf("unpaid: %+v %v %v", p, found, err)
	}
	if d, err := c.DecodeInvoice(ctx, bolt11); err != nil || d.DescriptionHash != strings.Repeat("ab", 32) {
		t.Fatalf("description hash: %+v %v", d, err)
	}
	// 30,000 sat sent; the first channel took 21,411 sat; phoenixd reports
	// the 8,589 sat that arrived.
	f.Receive(bolt11, 8_589, 21_411_000)
	p, _, _ := c.IncomingPayment(ctx, hash)
	if !p.IsPaid || p.CreditMsat() != 8_589_000 {
		t.Fatalf("paid: %+v credit %d", p, p.CreditMsat())
	}
	if list, err := c.ListIncoming(ctx, 0, 10, 0); err != nil || len(list) != 1 || list[0].PaymentHash != hash {
		t.Fatalf("list: %+v %v", list, err)
	}

	inv, h2 := f.Invoice(1_234_000)
	d, err := c.DecodeInvoice(ctx, inv)
	if err != nil || d.AmountMsat != 1_234_000 || d.PaymentHash != h2 || d.Chain != "mainnet" || !d.ExpiresAt().After(time.Now()) {
		t.Fatalf("decode: %+v %v", d, err)
	}
	if o, _ := c.OutgoingByHash(ctx, h2); o.Status != phoenixd.OutgoingNone {
		t.Fatalf("before paying: %+v", o)
	}
	f.SetOutcome(h2, phoenixdtest.Outcome{FeeMsat: 5_000})
	if r, err := c.PayInvoice(ctx, inv, 0); err != nil || !r.Sent {
		t.Fatalf("pay: %+v %v", r, err)
	}
	if o, _ := c.OutgoingByHash(ctx, h2); o.Status != phoenixd.OutgoingPaid || o.FeesMsat != 5_000 {
		t.Fatalf("after paying: %+v", o)
	}
	inv3, h3 := f.Invoice(1000)
	f.SetOutcome(h3, phoenixdtest.Outcome{Fail: true})
	if r, err := c.PayInvoice(ctx, inv3, 0); err != nil || r.Sent || r.Reason == "" {
		t.Fatalf("failed pay: %+v %v", r, err)
	}
	if o, _ := c.OutgoingByHash(ctx, h3); o.Status != phoenixd.OutgoingFailed {
		t.Fatalf("failed status: %+v", o)
	}
	if l, err := c.Liquidity(ctx); err != nil || l.Channel || l.FirstChannelFeeSat != 21_411 {
		t.Fatalf("liquidity: %+v %v", l, err)
	}
	if has, err := c.HasChannel(ctx); err != nil || has {
		t.Fatalf("has channel: %v %v", has, err)
	}
	b4, _, _ := c.CreateInvoice(ctx, 2_000, strings.Repeat("ab", 32), "pool", 10*time.Minute)
	f.ReceiveAsFeeCredit(b4)
	if l, _ := c.Liquidity(ctx); l.FeeCreditSat != 2_000 {
		t.Fatalf("fee credit: %+v", l)
	}
	// A channel whose peer is reconnecting still exists, and isn't usable.
	f.Channel, f.ChannelState = true, "Offline"
	if l, _ := c.Liquidity(ctx); !l.Channel || l.Usable || l.FirstChannelFeeSat != 0 {
		t.Fatalf("offline channel: %+v", l)
	}
	if has, _ := c.HasChannel(ctx); !has {
		t.Fatal("an offline channel doesn't count")
	}
	f.ChannelState = "Closed"
	if has, _ := c.HasChannel(ctx); has {
		t.Fatal("a closed channel counts")
	}
	// An invoice without an amount is paid for the amount given, in sats.
	inv4, h4 := f.Invoice(0)
	if d, _ := c.DecodeInvoice(ctx, inv4); d.AmountMsat != 0 {
		t.Fatalf("no-amount invoice decoded with %d msat", d.AmountMsat)
	}
	if r, err := c.PayInvoice(ctx, inv4, 2_500); err != nil || !r.Sent || f.PaidMsat(h4) != 2_500_000 {
		t.Fatalf("pay with an amount: %+v %v, paid %d", r, err, f.PaidMsat(h4))
	}
	// phoenixd refusing the request (HTTP 4xx) means it sent nothing.
	_, err = c.PayInvoice(ctx, "lnbcgarbage", 0)
	var refused *phoenixd.RefusedError
	if !errors.Is(err, phoenixd.ErrRefused) || errors.Is(err, phoenixd.ErrUnreachable) || !errors.As(err, &refused) || refused.Status != 400 {
		t.Fatalf("refused: %v", err)
	}
	// "Not found" means no such payment only from phoenixd's lookups; a 404
	// for a route phoenixd doesn't have is an error.
	f.MissingRoute = "/payments/outgoingbyhash/"
	if o, err := c.OutgoingByHash(ctx, h2); err == nil {
		t.Fatalf("a missing route read as %+v", o)
	}
	f.MissingRoute = ""
	// A 5xx is phoenixd reached and failing: not a refusal (a payinvoice may
	// have sent), and told apart from no answer by its type. To a
	// caller asking only whether phoenixd answered, it is unreachable,
	// never cardd's own 500.
	f.Broken = "/payments/outgoingbyhash/"
	_, err = c.OutgoingByHash(ctx, h2)
	var failed *phoenixd.ServerError
	if !errors.As(err, &failed) || failed.Status != 500 || errors.Is(err, phoenixd.ErrRefused) || !errors.Is(err, phoenixd.ErrUnreachable) {
		t.Fatalf("a 500: %v", err)
	}
	if want := "phoenixd: GET /payments/outgoingbyhash/" + h2 + ": HTTP 500: Internal Server Error"; err.Error() != want {
		t.Fatalf("a 500's text %q, want %q", err, want)
	}
	f.Broken = ""
	f.Down = true
	if _, err := c.BalanceSat(ctx); !errors.Is(err, phoenixd.ErrUnreachable) || errors.As(err, &failed) {
		t.Fatalf("down: %v", err)
	}
}

// A contract check against a real phoenixd (no funds needed):
//
//	CARDD_PHOENIXD_TEST_URL=http://127.0.0.1:9740 CARDD_PHOENIXD_TEST_PASSWORD=... go test ./internal/phoenixd/
func TestAgainstARealPhoenixd(t *testing.T) {
	url := os.Getenv("CARDD_PHOENIXD_TEST_URL")
	if url == "" {
		t.Skip("CARDD_PHOENIXD_TEST_URL not set")
	}
	ctx := context.Background()
	c := phoenixd.New(url, os.Getenv("CARDD_PHOENIXD_TEST_PASSWORD"))
	bolt11, hash, err := c.CreateInvoice(ctx, 1000, strings.Repeat("ab", 32), "pool", 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	d, err := c.DecodeInvoice(ctx, bolt11)
	if err != nil || d.AmountMsat != 1_000_000 || d.PaymentHash != hash || d.Chain != "mainnet" || !d.ExpiresAt().After(time.Now()) {
		t.Fatalf("decode: %+v %v", d, err)
	}
	if p, found, err := c.IncomingPayment(ctx, hash); err != nil || !found || p.IsPaid || p.ExternalID != "pool" {
		t.Fatalf("incoming: %+v %v %v", p, found, err)
	}
	if o, err := c.OutgoingByHash(ctx, strings.Repeat("00", 32)); err != nil || o.Status != phoenixd.OutgoingNone {
		t.Fatalf("outgoing: %+v %v", o, err)
	}
	if d.DescriptionHash != strings.Repeat("ab", 32) {
		t.Fatalf("description hash: %+v", d)
	}
	if _, err := c.PayInvoice(ctx, "lnbcgarbage", 0); !errors.Is(err, phoenixd.ErrRefused) {
		t.Fatalf("garbage invoice: %v", err)
	}
	if _, err := c.BalanceSat(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ListIncoming(ctx, 0, 5, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := c.HasChannel(ctx); err != nil {
		t.Fatal(err)
	}
	l, err := c.Liquidity(ctx)
	if err != nil || (!l.Channel && l.FirstChannelFeeSat < 1000) {
		t.Fatalf("liquidity: %+v %v", l, err)
	}
	t.Logf("liquidity %+v", l)
}

// LNVPS's renewal invoices carry a description, which renewals read.
func TestTheFakeKeepsAnInvoicesDescription(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	memo := "VM renewal 1009 to 2026-11-09 14:22:33.123456 UTC"
	bolt11, hash := f.InvoiceWithDescription(221_000, memo)
	inv, err := phoenixd.New(f.URL, phoenixdtest.Password).DecodeInvoice(context.Background(), bolt11)
	if err != nil || inv.Description != memo || inv.PaymentHash != hash || inv.AmountMsat != 221_000 || inv.DescriptionHash != "" {
		t.Fatalf("%+v %v", inv, err)
	}
}

// A payment out is read by the id payinvoice answered with (the API's "Get
// outgoing payment"): where it stands, its exact fee, and phoenixd's own
// times for it. By its hash it reads the same.
func TestAnOutgoingPaymentByItsID(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	c := phoenixd.New(f.URL, phoenixdtest.Password)
	ctx := context.Background()
	inv, hash := f.Invoice(1_234_000)
	f.SetOutcome(hash, phoenixdtest.Outcome{FeeMsat: 5_000})
	before := time.Now().Truncate(time.Millisecond)
	r, err := c.PayInvoice(ctx, inv, 0)
	if err != nil || !r.Sent || r.PaymentID == "" {
		t.Fatalf("pay: %+v %v", r, err)
	}
	o, err := c.OutgoingByID(ctx, r.PaymentID)
	if err != nil || o.Status != phoenixd.OutgoingPaid || o.FeesMsat != 5_000 {
		t.Fatalf("by id: %+v %v", o, err)
	}
	if o.CreatedAt.Before(before) || o.CompletedAt.Before(o.CreatedAt) || o.CompletedAt.After(time.Now()) {
		t.Fatalf("times: created %v, completed %v", o.CreatedAt, o.CompletedAt)
	}
	if byHash, err := c.OutgoingByHash(ctx, hash); err != nil || byHash != o {
		t.Fatalf("by hash: %+v %v, by id %+v", byHash, err, o)
	}
	// One phoenixd has no record of: none, as by hash.
	if o, err := c.OutgoingByID(ctx, "3f0d6c1e-8a57-4b0e-9c2d-5e1f7a9b4c60"); err != nil || o.Status != phoenixd.OutgoingNone {
		t.Fatalf("unknown id: %+v %v", o, err)
	}
	// A payment that failed is answered without an id, and has no end time to
	// read as paid by.
	inv2, hash2 := f.Invoice(1000)
	f.SetOutcome(hash2, phoenixdtest.Outcome{Fail: true})
	if r, err := c.PayInvoice(ctx, inv2, 0); err != nil || r.Sent || r.PaymentID != "" {
		t.Fatalf("failed pay: %+v %v", r, err)
	}
	if o, err := c.OutgoingByHash(ctx, hash2); err != nil || o.Status != phoenixd.OutgoingFailed || o.CompletedAt.IsZero() {
		t.Fatalf("failed: %+v %v", o, err)
	}
}

func TestPayAnOffer(t *testing.T) {
	ctx := context.Background()
	f := phoenixdtest.New()
	defer f.Close()
	c := phoenixd.New(f.URL, phoenixdtest.Password)
	offer := f.Offer(0, "Coffee", "Ana's Café")
	o, err := c.DecodeOffer(ctx, offer)
	if err != nil || o.Chain != "mainnet" || o.AmountMsat != 0 || o.Description != "Coffee" || o.Issuer != "Ana's Café" || o.Currency != "" {
		t.Fatalf("decode: %+v %v", o, err)
	}
	if _, err := c.DecodeOffer(ctx, "lno1nonsense"); !errors.Is(err, phoenixd.ErrRefused) {
		t.Fatalf("an offer phoenixd can't read: %v", err)
	}
	f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{FeeMsat: 4_400})
	r, err := c.PayOffer(ctx, offer, 1_000)
	if err != nil || !r.Sent || r.PaymentHash == "" || r.PaymentID == "" || r.RecipientSat != 1_000 {
		t.Fatalf("pay: %+v %v", r, err)
	}
	// phoenixd's units: sent is whole sats of amount + fee, rounded down; fees msat.
	recs, err := c.ListOutgoing(ctx, 0, time.Now().Add(time.Minute).UnixMilli(), 100, 0)
	if err != nil || len(recs) != 1 {
		t.Fatalf("list: %+v %v", recs, err)
	}
	if got := recs[0]; got.Hash != r.PaymentHash || got.ID != r.PaymentID || got.SubType != "lightning" || got.SentSat != 1_004 || got.FeesMsat != 4_400 || got.Status != phoenixd.OutgoingPaid {
		t.Fatalf("record: %+v", got)
	}
}

func TestAnOffersFailures(t *testing.T) {
	ctx := context.Background()
	f := phoenixdtest.New()
	defer f.Close()
	c := phoenixd.New(f.URL, phoenixdtest.Password)
	offer := f.Offer(0, "", "")
	f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Fail: "no response to the invoice request"})
	if r, err := c.PayOffer(ctx, offer, 1_000); err != nil || r.Sent || r.PaymentHash != "" || r.Reason != "no response to the invoice request" {
		t.Fatalf("no invoice: %+v %v", r, err)
	}
	f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{FailPaid: true})
	if r, err := c.PayOffer(ctx, offer, 1_000); err != nil || r.Sent || r.PaymentHash == "" {
		t.Fatalf("payment failed: %+v %v", r, err)
	}
	f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{EarlyFail: true})
	r, err := c.PayOffer(ctx, offer, 1_000)
	if err != nil || r.Sent || r.PaymentHash == "" {
		t.Fatalf("early failure: %+v %v", r, err)
	}
	if o, err := c.OutgoingByHash(ctx, r.PaymentHash); err != nil || o.Status != phoenixd.OutgoingNone {
		t.Fatalf("an early failure leaves no record: %+v %v", o, err)
	}
	f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Refuse: true})
	if _, err := c.PayOffer(ctx, offer, 1_000); !errors.Is(err, phoenixd.ErrRefused) {
		t.Fatalf("refused: %v", err)
	}
}

func TestTheOutgoingListHasOnChainPayments(t *testing.T) {
	ctx := context.Background()
	f := phoenixdtest.New()
	defer f.Close()
	c := phoenixd.New(f.URL, phoenixdtest.Password)
	f.OnChainOut(1_000_000)
	recs, err := c.ListOutgoing(ctx, 0, time.Now().Add(time.Minute).UnixMilli(), 100, 0)
	if err != nil || len(recs) != 1 || recs[0].SubType == "lightning" || recs[0].Hash != "" {
		t.Fatalf("on-chain: %+v %v", recs, err)
	}
}

func TestAHangingOfferHasNoRecordUntilItsInvoiceComes(t *testing.T) {
	ctx := context.Background()
	f := phoenixdtest.New()
	defer f.Close()
	c := phoenixd.New(f.URL, phoenixdtest.Password)
	offer := f.Offer(0, "", "")
	f.SetOfferOutcome(offer, phoenixdtest.OfferOutcome{Hang: true, Unrecorded: true})
	got := make(chan phoenixd.PayResult, 1)
	go func() { r, _ := c.PayOffer(ctx, offer, 2_000); got <- r }()
	for len(f.OfferPayments(offer)) == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if recs, _ := c.ListOutgoing(ctx, 0, time.Now().Add(time.Minute).UnixMilli(), 100, 0); len(recs) != 0 {
		t.Fatalf("a record before the invoice came: %+v", recs)
	}
	hash := f.ReleaseOffer(offer, false, 1_500)
	if r := <-got; !r.Sent || r.PaymentHash != hash {
		t.Fatalf("released: %+v", r)
	}
}

// phoenixd answering a 5xx, or a 200 whose body isn't JSON, is phoenixd
// failing, not the request: every caller reads it as no answer.
func TestATroubledAnswerIsUnreachable(t *testing.T) {
	ctx := context.Background()
	for name, answer := range map[string]func(w http.ResponseWriter){
		"502":      func(w http.ResponseWriter) { http.Error(w, "bad gateway", http.StatusBadGateway) },
		"not JSON": func(w http.ResponseWriter) { w.Write([]byte("<html>starting up</html>")) },
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { answer(w) }))
		c := phoenixd.New(srv.URL, "pw")
		if _, err := c.DecodeOffer(ctx, "lno1x"); !errors.Is(err, phoenixd.ErrUnreachable) {
			t.Errorf("%s: %v", name, err)
		}
		srv.Close()
	}
}
