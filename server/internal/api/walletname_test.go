package api

import (
	"strings"
	"testing"

	"github.com/boltcard/karto/server/internal/store"
)

// The wallet names itself: "" until then, trimmed as kept, and every
// wallet phone hears of it through a moved rev.
func TestWalletNameSetAndRead(t *testing.T) {
	w := moneySetup(t)
	w.money.Bell = NewBell()
	status, out := w.do("GET", "/api/v1/wallet", nil)
	if status != 200 || out["name"] != "" || out["rev"] == nil {
		t.Fatalf("a new wallet's name: %d %v", status, out["name"])
	}
	before := out["rev"]
	if status, out := w.do("PUT", "/api/v1/wallet/name", map[string]any{"name": " Pixel 9a "}); status != 200 || out["name"] != "Pixel 9a" {
		t.Fatalf("set: %d %v", status, out)
	}
	_, out = w.do("GET", "/api/v1/wallet", nil)
	if out["name"] != "Pixel 9a" || out["rev"] == before {
		t.Fatalf("after: name %v, rev %v (was %v)", out["name"], out["rev"], before)
	}
}

// A name a till would refuse is refused here, a body too big to be a name is
// refused unread, and a PoS phone can't name the wallet.
func TestWalletNameRefused(t *testing.T) {
	w := moneySetup(t)
	if status, out := w.do("PUT", "/api/v1/wallet/name", map[string]any{"name": "a\u200bb"}); status != 400 || out["error"] != "bad_name" {
		t.Fatalf("a hidden mark: %d %v", status, out)
	}
	if status, out := w.do("PUT", "/api/v1/wallet/name", map[string]any{"name": strings.Repeat("a", 5<<10)}); status != 400 {
		t.Fatalf("a 5 KiB body: %d %v", status, out)
	}
	till := w.device(store.RolePos, "Till 1")
	if status, out := till.do("PUT", "/api/v1/wallet/name", map[string]any{"name": "Mine"}); status != 403 || out["error"] != "not_allowed" {
		t.Fatalf("a till naming the wallet: %d %v", status, out)
	}
	if _, out := w.do("GET", "/api/v1/wallet", nil); out["name"] != "" {
		t.Fatalf("nothing was kept: %v", out["name"])
	}
}

// A till reads the wallet's name beside its own, in /pos/me and in the answer
// to its pairing.
func TestTillsHearTheWalletName(t *testing.T) {
	w := moneySetup(t)
	till := w.device(store.RolePos, "Till 1")
	if status, out := till.do("GET", "/api/v1/pos/me", nil); status != 200 || out["wallet"] != "" || out["name"] != "Till 1" {
		t.Fatalf("before naming: %d %v", status, out)
	}
	w.do("PUT", "/api/v1/wallet/name", map[string]any{"name": "Pixel 9a"})
	if _, out := till.do("GET", "/api/v1/pos/me", nil); out["wallet"] != "Pixel 9a" || out["name"] != "Till 1" {
		t.Fatalf("after naming: %v", out)
	}
	code := w.code("Till 2")
	_, pub := w.newKey()
	if status, out := w.plain("POST", "/pos/pair", map[string]any{"code": code, "publicKey": pub}); status != 201 || out["wallet"] != "Pixel 9a" || out["name"] != "Till 2" {
		t.Fatalf("pair: %d %v", status, out)
	}
}
