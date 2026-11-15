package lnurl_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/store"
)

// A new refund link on each tap of a card of this server
// (LUD-19's payLink): it pays back only that card, and names nothing.

var payLinkShape = regexp.MustCompile(`^lnurlp://vm-1\.lnvps\.cloud/refund/([0-9a-f]{32})$`)

// tapLink taps the card and answers its payLink's token.
func (w *world) tapLink() string {
	w.t.Helper()
	wr := w.get(w.tap())
	m := payLinkShape.FindStringSubmatch(wr["payLink"].(string))
	if wr["tag"] != "withdrawRequest" || m == nil {
		w.t.Fatalf("withdrawRequest: %v", wr)
	}
	return m[1]
}

func TestWithdrawRequestHasPayLink(t *testing.T) {
	w := setup(t)
	if a, b := w.tapLink(), w.tapLink(); a == b {
		t.Fatalf("two taps, one token %s", a)
	}
}

const refundMetadata = `[["text/plain","Refund"]]`

func TestBackRequestNamesNothing(t *testing.T) {
	w := setup(t)
	token := w.tapLink()
	pr := w.get("/refund/" + token)
	if pr["tag"] != "payRequest" || pr["metadata"] != refundMetadata || pr["callback"] != "https://vm-1.lnvps.cloud/refund/"+token+"/cb" ||
		pr["minSendable"] != 1000.0 || pr["commentAllowed"] != 140.0 { // the shop's note to the customer
		t.Fatalf("payRequest: %v", pr)
	}
	if s := strings.ToLower(pr["metadata"].(string)); strings.Contains(s, "daily") || strings.Contains(s, "@") {
		t.Fatalf("names the card: %v", pr)
	}
}

func TestBackCallbackCreditsCard(t *testing.T) {
	w := setup(t)
	token := w.tapLink()
	before := w.balance(store.CardAccount(cardID))
	cb := w.get("/refund/" + token + "/cb?amount=8000000")
	bolt11, _ := cb["pr"].(string)
	inv, err := phoenixd.New(w.f.URL, phoenixdtest.Password).DecodeInvoice(context.Background(), bolt11)
	sum := sha256.Sum256([]byte(refundMetadata))
	if err != nil || inv.DescriptionHash != hex.EncodeToString(sum[:]) || inv.AmountMsat != 8_000_000 {
		t.Fatalf("invoice: %+v %v (%v)", inv, err, cb)
	}
	w.f.Receive(bolt11, 8_000, 0)
	eventually(t, "the card credited", func() bool { return w.balance(store.CardAccount(cardID)) == before+8_000_000 })
}

// The money a refund link brings is a top-up of the card marked as a refund.
func TestBackCallbackMarksRefund(t *testing.T) {
	w := setup(t)
	token := w.tapLink()
	card := store.CardAccount(cardID)
	before := w.balance(card)
	bolt11, _ := w.get("/refund/" + token + "/cb?amount=8000000")["pr"].(string)
	w.f.Receive(bolt11, 8_000, 0)
	eventually(t, "the card credited", func() bool { return w.balance(card) == before+8_000_000 })
	h, err := w.st.History(context.Background(), card, 0, 1)
	if err != nil || len(h) != 1 || h[0].Kind != store.KindTopup || h[0].Via != "refund" {
		t.Fatalf("%+v %v", h, err)
	}
}

// The shop's note (LUD-12) with a refund link's payment is kept as the
// card's Refund line's payer's note, cleaned and cut as a top-up's is.
func TestBackCallbackKeepsTheShopsNote(t *testing.T) {
	w := setup(t)
	token := w.tapLink()
	card := store.CardAccount(cardID)
	before := w.balance(card)
	bolt11, _ := w.get("/refund/" + token + "/cb?amount=8000000&comment=" + url.QueryEscape("Refund from Pixel 9a for the sale of 17:22, 20 Oct"))["pr"].(string)
	w.f.Receive(bolt11, 8_000, 0)
	eventually(t, "the card credited", func() bool { return w.balance(card) == before+8_000_000 })
	h, err := w.st.History(context.Background(), card, 0, 1)
	if err != nil || len(h) != 1 || h[0].Via != "refund" || h[0].PayerNote != "Refund from Pixel 9a for the sale of 17:22, 20 Oct" {
		t.Fatalf("%+v %v", h, err)
	}
	if got := w.get("/refund/" + token + "/cb?amount=8000000&comment=" + strings.Repeat("x", 2049)); got["status"] != "ERROR" {
		t.Fatalf("an over-long comment: %v", got)
	}
}

// A card wiped between the invoice and its payment: the money goes to Pool,
// still a refund.
func TestBackCallbackWipedSincePool(t *testing.T) {
	w := setup(t)
	token := w.tapLink()
	bolt11, _ := w.get("/refund/" + token + "/cb?amount=8000000")["pr"].(string)
	w.st.StartWipe(context.Background(), cardID)
	before := w.balance(store.Pool)
	w.f.Receive(bolt11, 8_000, 0)
	eventually(t, "pool credited", func() bool { return w.balance(store.Pool) >= before+8_000_000 })
	h, err := w.st.History(context.Background(), store.Pool, 0, 5)
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range h {
		if l.Kind == store.KindTopup && l.AmountMsat == 8_000_000 {
			if l.Via != "refund" {
				t.Fatalf("pool's line %+v", l)
			}
			return
		}
	}
	t.Fatalf("no 8000 sat top-up in pool: %+v", h)
}

func TestBackRefusesGoneCard(t *testing.T) {
	w := setup(t)
	token := w.tapLink()
	w.st.StartWipe(context.Background(), cardID)
	for _, path := range []string{"/refund/" + token, "/refund/" + token + "/cb?amount=8000000"} {
		if got := w.get(path); got["status"] != "ERROR" || got["reason"] != "This card can't take payments any more." {
			t.Fatalf("%s: %v", path, got)
		}
	}
	if got := w.get("/refund/0123456789abcdef0123456789abcdef"); got["status"] != "ERROR" {
		t.Fatalf("an unknown token: %v", got)
	}
}
