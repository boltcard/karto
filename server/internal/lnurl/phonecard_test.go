package lnurl_test

// A phone's card: cardd is not changed for it, since it sees a card only
// through p and c. The taps here are the app's own, as its code makes them for a phone that is a card
// (testvectors/phonecard.json, written and checked by app/src/phoneCard/taps.test.ts), put to cardd's own handlers.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/boltcard/karto/server/internal/cardkeys"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/sun"
)

type phoneCardVectors struct {
	IssuerKey string `json:"issuerKey"`
	LNURLW    string `json:"lnurlw"`
	Cards     []struct {
		N   uint32 `json:"n"`
		UID string `json:"uid"`
		ID  string `json:"id"`
	} `json:"cards"`
	Random         string   `json:"random"`
	First          uint32   `json:"first"`
	Batch          []string `json:"batch"`
	NextBatchFirst string   `json:"nextBatchFirst"`
}

func loadPhoneCard(t *testing.T) phoneCardVectors {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "testvectors", "phonecard.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v phoneCardVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(v.Cards) != 2 || len(v.Batch) != 16 || v.NextBatchFirst == "" {
		t.Fatalf("vectors: %d cards, %d taps", len(v.Cards), len(v.Batch))
	}
	return v
}

// tapOf is a link's p and c, and the path a terminal asks cardd with.
func tapOf(t *testing.T, link string) (p, c, path string) {
	t.Helper()
	u, err := url.Parse(link)
	if err != nil || u.Scheme != "lnurlw" || u.Host != "vm-1.lnvps.cloud" || u.Path != "/ln" {
		t.Fatalf("not this server's card link: %q", link)
	}
	return u.Query().Get("p"), u.Query().Get("c"), "/ln?" + u.RawQuery
}

func TestAPhonesCardHasAnIDNoChipHas(t *testing.T) {
	v := loadPhoneCard(t)
	if v.IssuerKey != hex.EncodeToString(issuer) {
		t.Fatalf("the vectors' issuer key is %s, this world's %x", v.IssuerKey, issuer)
	}
	for _, card := range v.Cards {
		uid, _ := hex.DecodeString(card.UID)
		if len(uid) != 7 || uid[0] != 0x00 {
			t.Fatalf("card %d: uid %s", card.N, card.UID)
		}
		id, err := cardkeys.ID(issuer, uid)
		if err != nil || hex.EncodeToString(id) != card.ID {
			t.Fatalf("card %d: cardd lists %x, the app %s (%v)", card.N, id, card.ID, err)
		}
	}
}

// The app's taps are byte for byte what cardd's own Build gives for the same ID, counter and random bytes.
func TestTheAppsTapsAreCarddsOwn(t *testing.T) {
	v := loadPhoneCard(t)
	uid, _ := hex.DecodeString(v.Cards[0].UID)
	k1, _ := cardkeys.K1(issuer)
	keys, _ := cardkeys.Derive(issuer, uid, 0)
	raw, _ := hex.DecodeString(v.Random)
	var random [5]byte
	copy(random[:], raw)
	for i, link := range append(append([]string{}, v.Batch...), v.NextBatchFirst) {
		p, c, err := sun.Build(k1, keys.K2, uid, v.First+uint32(i), random)
		if err != nil {
			t.Fatal(err)
		}
		gotP, gotC, _ := tapOf(t, link)
		wantP, wantC := strings.ToUpper(hex.EncodeToString(p)), strings.ToUpper(hex.EncodeToString(c))
		if gotP != wantP || gotC != wantC {
			t.Fatalf("tap %d: the app made p=%s c=%s, cardd p=%s c=%s", i, gotP, gotC, wantP, wantC)
		}
	}
}

// laterTap is a tap of the vectors' first card at a counter past both batches, as the phone would go on to make.
func laterTap(t *testing.T, v phoneCardVectors, counter uint32) string {
	t.Helper()
	uid, _ := hex.DecodeString(v.Cards[0].UID)
	k1, _ := cardkeys.K1(issuer)
	keys, _ := cardkeys.Derive(issuer, uid, 0)
	p, c, err := sun.Build(k1, keys.K2, uid, counter, [5]byte{9, 8, 7, 6, 5})
	if err != nil {
		t.Fatal(err)
	}
	return "/ln?p=" + strings.ToUpper(hex.EncodeToString(p)) + "&c=" + strings.ToUpper(hex.EncodeToString(c))
}

func TestAPhonesCardIsACardToCardd(t *testing.T) {
	v := loadPhoneCard(t)
	w := setup(t)
	ctx := context.Background()
	id := v.Cards[0].ID
	path := func(i int) string { _, _, path := tapOf(t, v.Batch[i]); return path }

	// The wallet's two calls: reserve the id, then confirm with the first tap. No chip, nothing held.
	if _, err := w.s.Cards.Reserve(ctx, id, "Pixel 8 Pro"); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	p, c, _ := tapOf(t, v.Batch[0])
	card, err := w.s.Cards.Confirm(ctx, id, p, c)
	if err != nil || card.State != store.StateActive || card.LastCounter != int64(v.First) || card.Version != 0 {
		t.Fatalf("confirm: %v %+v", err, card)
	}

	// The tap that confirmed the card is used up.
	if r := w.get(path(0)); r["status"] != "ERROR" || !strings.Contains(r["reason"].(string), "already used") {
		t.Fatalf("the confirming tap again: %v", r)
	}
	// A till's fetch of the next tap, and a payment from the card.
	if _, err := w.st.Credit(ctx, store.CardAccount(id), 50_000_000, "moved on", ""); err != nil {
		t.Fatal(err)
	}
	wr := w.get(path(1))
	if wr["tag"] != "withdrawRequest" || wr["k1"] == nil || wr["defaultDescription"] != "Bolt Card" {
		t.Fatalf("tap 1: %v", wr)
	}
	bolt11, hash := w.f.Invoice(5_000_000)
	w.f.SetOutcome(hash, phoenixdtest.Outcome{FeeMsat: 2_000})
	if ok := w.get(wr["callback"].(string) + "?k1=" + wr["k1"].(string) + "&pr=" + bolt11); ok["status"] != "OK" {
		t.Fatalf("callback: %v", ok)
	}
	eventually(t, "the phone's card paid", func() bool { return w.balance(store.CardAccount(id)) == 50_000_000-5_000_000-2_000 })
	// The same tap again pays nothing.
	if r := w.get(path(1)); r["status"] != "ERROR" || !strings.Contains(r["reason"].(string), "already used") {
		t.Fatalf("tap 1 again: %v", r)
	}
	// A later tap is taken; one a reader skipped is then too old.
	if r := w.get(path(3)); r["tag"] != "withdrawRequest" {
		t.Fatalf("tap 3: %v", r)
	}
	if r := w.get(path(2)); r["status"] != "ERROR" {
		t.Fatalf("tap 2 after tap 3: %v", r)
	}
	// The next batch begins 16 above this one's first, whatever was handed out of this one.
	_, _, next := tapOf(t, v.NextBatchFirst)
	if r := w.get(next); r["tag"] != "withdrawRequest" {
		t.Fatalf("the next batch's first tap: %v", r)
	}
	if r := w.get(path(15)); r["status"] != "ERROR" {
		t.Fatalf("the old batch's last tap after the next batch's first: %v", r)
	}
	// Frozen, it is refused as any card is; wiped, its balance is in pool and its taps pay no more: so a phone
	// that is no longer paired stops paying once the wallet has removed its card.
	if _, err := w.s.Cards.Freeze(ctx, id); err != nil {
		t.Fatal(err)
	}
	if r := w.get(laterTap(t, v, v.First+40)); r["status"] != "ERROR" || !strings.Contains(r["reason"].(string), "frozen") {
		t.Fatalf("a frozen phone's card: %v", r)
	}
	if _, err := w.s.Cards.Wipe(ctx, id); err != nil {
		t.Fatalf("wipe: %v", err)
	}
	if got, err := w.s.Cards.Wiped(ctx, id); err != nil || got.State != store.StateReset {
		t.Fatalf("wiped: %v %+v", err, got)
	}
	if left := w.balance(store.CardAccount(id)); left != 0 {
		t.Fatalf("a removed phone's card still holds %d msat", left)
	}
	if r := w.get(laterTap(t, v, v.First+41)); r["status"] != "ERROR" {
		t.Fatalf("a removed phone's card was answered: %v", r)
	}
}
