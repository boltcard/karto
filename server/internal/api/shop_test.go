package api

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/store"
)

// plain sends a request with no device signature, as a phone not yet paired does.
func (c *client) plain(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	b, ok := body.([]byte)
	if !ok {
		b, _ = json.Marshal(body)
	}
	req, _ := http.NewRequest(method, c.srv.URL+path, bytes.NewReader(b))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// newKey is a phone's key before it is paired: a client that can sign, its
// key id, and its public key as the pairing call sends it.
func (w *moneyWorld) newKey() (*client, string) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	raw, _ := key.PublicKey.Bytes()
	return &client{t: w.t, srv: w.srv, st: w.st, key: key, keyID: deviceauth.KeyID(raw)}, hex.EncodeToString(raw)
}

// code asks for a pairing code as the wallet does.
func (w *moneyWorld) code(name string) string {
	w.t.Helper()
	status, out := w.do("POST", "/api/v1/shop/codes", map[string]any{"name": name})
	if status != 201 {
		w.t.Fatalf("code for %q: %d %v", name, status, out)
	}
	return out["code"].(string)
}

// Pairing end to end: the wallet gets a code, a phone
// sends it with a key it made, and is a PoS phone from then on.
func TestPairingAPoSPhone(t *testing.T) {
	w := moneySetup(t)
	status, out := w.do("POST", "/api/v1/shop/codes", map[string]any{"name": "  Till 1 "})
	code, _ := out["code"].(string)
	if status != 201 || !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(code) {
		t.Fatalf("code: %d %v", status, out)
	}
	if left := int64(out["expires"].(float64)) - time.Now().Unix(); left < 595 || left > 600 {
		t.Fatalf("the code lasts %d s, want 10 minutes", left)
	}
	// The server keeps the code's hash, never the code.
	sum := sha256.Sum256([]byte(code))
	if _, err := w.st.PairPos(context.Background(), code, "x", "y"); err == nil {
		t.Fatal("the code itself is what the store holds")
	}
	phone, pub := w.newKey()
	if status, out := phone.do("GET", "/api/v1/pos/me", nil); status != 401 {
		t.Fatalf("before pairing: %d %v", status, out)
	}
	status, out = w.plain("POST", "/pos/pair", map[string]any{"code": code, "publicKey": strings.ToUpper(pub)})
	if status != 201 || out["keyId"] != phone.keyID || out["name"] != "Till 1" {
		t.Fatalf("pair: %d %v (hash %x)", status, out, sum)
	}
	if status, out := phone.do("GET", "/api/v1/pos/me", nil); status != 200 || out["role"] != "pos" || out["name"] != "Till 1" {
		t.Fatalf("after pairing: %d %v", status, out)
	}
	if log := w.logs.String(); !strings.Contains(log, `shop: paired PoS phone `+phone.keyID+` as "Till 1"`) || strings.Contains(log, code) {
		t.Fatalf("the pairing in the log (and never the code): %q", log)
	}
	if status, out := phone.do("GET", "/api/v1/wallet", nil); status != 403 || out["error"] != "not_allowed" {
		t.Fatalf("a paired phone on the wallet: %d %v", status, out)
	}
	// The code is used up.
	_, pub2 := w.newKey()
	if status, out := w.plain("POST", "/pos/pair", map[string]any{"code": code, "publicKey": pub2}); status != 403 || out["error"] != "bad_code" {
		t.Fatalf("the code again: %d %v", status, out)
	}
	if status, out := w.do("GET", "/api/v1/wallet", nil); status != 200 || out["shop"].(map[string]any)["phones"] != 1.0 {
		t.Fatalf("the wallet's count of phones: %d %v", status, out["shop"])
	}
}

func TestPairingRefusals(t *testing.T) {
	w := moneySetup(t)
	_, pub := w.newKey()
	pair := func(body any) (int, map[string]any) { return w.plain("POST", "/pos/pair", body) }
	// Every failed code answers alike: unknown, malformed, dropped, replaced.
	dropped := w.code("Till 1")
	if status, _ := w.do("DELETE", "/api/v1/shop/codes", nil); status != 204 {
		t.Fatalf("drop: %d", status)
	}
	replaced := w.code("Till 1")
	code := w.code("Till 1")
	for _, bad := range []string{strings.Repeat("0", 32), "nonsense", "", dropped, replaced, strings.ToUpper(code)} {
		if status, out := pair(map[string]any{"code": bad, "publicKey": pub}); status != 403 || out["error"] != "bad_code" {
			t.Fatalf("code %q: %d %v", bad, status, out)
		}
	}
	// A key that doesn't parse, an unknown field, a body over 4 KB: refused, and the code is still good.
	for _, body := range []any{
		map[string]any{"code": code, "publicKey": "04abcd"},
		map[string]any{"code": code, "publicKey": pub, "role": "owner"},
		[]byte(`{"code":"` + code + `","publicKey":"` + pub + `","pad":"` + strings.Repeat("x", 4096) + `"}`),
		[]byte(`not json`),
	} {
		if status, out := pair(body); status != 400 && status != 413 {
			t.Fatalf("%v: %d %v", body, status, out)
		}
	}
	// An owner's key and a paired PoS phone's: refused, and the code is still good.
	owner := w.device(store.RoleOwner, "Second wallet")
	till := w.device(store.RolePos, "Till 9")
	for _, c := range []*client{owner, till} {
		raw, _ := c.key.PublicKey.Bytes()
		if status, out := pair(map[string]any{"code": code, "publicKey": hex.EncodeToString(raw)}); status != 409 || out["error"] != "key_known" {
			t.Fatalf("%s's key: %d %v", c.keyID, status, out)
		}
	}
	if status, out := pair(map[string]any{"code": code, "publicKey": pub}); status != 201 {
		t.Fatalf("the code after the refusals: %d %v", status, out)
	}
	// A removed PoS phone pairs again as the same phone, under the new name.
	if status, _ := w.do("DELETE", "/api/v1/shop/phones/"+till.keyID, nil); status != 204 {
		t.Fatalf("remove: %d", status)
	}
	raw, _ := till.key.PublicKey.Bytes()
	if status, out := pair(map[string]any{"code": w.code("Stall"), "publicKey": hex.EncodeToString(raw)}); status != 201 || out["keyId"] != till.keyID || out["name"] != "Stall" {
		t.Fatalf("pairing a removed phone again: %d %v", status, out)
	}
	if status, _ := till.do("GET", "/api/v1/pos/me", nil); status != 200 {
		t.Fatalf("the phone paired again is refused: %d", status)
	}
	// The pairing route takes no device signature and gives none away: a signed call is just a call.
	if status, _ := owner.do("POST", "/pos/pair", map[string]any{"code": "x", "publicKey": pub}); status != 403 {
		t.Fatalf("a signed pairing call: %d", status)
	}
}

func TestCodeNames(t *testing.T) {
	w := moneySetup(t)
	w.device(store.RolePos, "Till 1")
	for name, want := range map[string]string{"": "bad_name", "   ": "bad_name", strings.Repeat("x", 25): "bad_name"} {
		if status, out := w.do("POST", "/api/v1/shop/codes", map[string]any{"name": name}); status != 400 || out["error"] != want {
			t.Fatalf("%q: %d %v", name, status, out)
		}
	}
	if status, out := w.do("POST", "/api/v1/shop/codes", map[string]any{"name": "Till 1"}); status != 409 || out["error"] != "name_taken" {
		t.Fatalf("a paired phone's name: %d %v", status, out)
	}
	if status, out := w.do("POST", "/api/v1/shop/codes", map[string]any{}); status != 400 {
		t.Fatalf("no name: %d %v", status, out)
	}
}

// The PoS phones as the wallet lists, renames and removes them.
func TestShopPhones(t *testing.T) {
	w := moneySetup(t)
	ctx := context.Background()
	if status, out := w.do("GET", "/api/v1/shop/phones", nil); status != 200 || len(out["phones"].([]any)) != 0 || hasKey(out, "restored") {
		t.Fatalf("no phones: %d %v", status, out)
	}
	till1 := w.device(store.RolePos, "Till 1")
	till2 := w.device(store.RolePos, "Till 2")
	owner := w.device(store.RoleOwner, "Second wallet")
	w.st.SetMeta(ctx, "restore.from", "backup 3")
	status, out := w.do("GET", "/api/v1/shop/phones", nil)
	phones := out["phones"].([]any)
	if status != 200 || len(phones) != 2 {
		t.Fatalf("phones: %d %v", status, out)
	}
	byID := map[string]map[string]any{}
	for _, p := range phones {
		p := p.(map[string]any)
		byID[p["keyId"].(string)] = p
	}
	p := byID[till1.keyID]
	if p["name"] != "Till 1" || p["sales"] != 0.0 || hasKey(p, "lastSale") || time.Now().Unix()-int64(p["created"].(float64)) > 5 {
		t.Fatalf("Till 1: %v", p)
	}
	if at := int64(out["restored"].(float64)); time.Now().Unix()-at > 5 {
		t.Fatalf("restored: %v", out["restored"])
	}
	path := "/api/v1/shop/phones/"
	if status, out := w.do("PATCH", path+till1.keyID, map[string]any{"name": "Till 2"}); status != 409 || out["error"] != "name_taken" {
		t.Fatalf("another's name: %d %v", status, out)
	}
	if status, out := w.do("PATCH", path+till1.keyID, map[string]any{"name": "Till 1"}); status != 200 {
		t.Fatalf("its own name: %d %v", status, out)
	}
	if status, out := w.do("PATCH", path+till1.keyID, map[string]any{"name": ""}); status != 400 || out["error"] != "bad_name" {
		t.Fatalf("no name: %d %v", status, out)
	}
	if status, out := w.do("PATCH", path+till1.keyID, map[string]any{"name": " Front "}); status != 200 || out["name"] != "Front" || out["keyId"] != till1.keyID {
		t.Fatalf("rename: %d %v", status, out)
	}
	if status, out := till1.do("GET", "/api/v1/pos/me", nil); status != 200 || out["name"] != "Front" {
		t.Fatalf("the phone's own name: %d %v", status, out)
	}
	if log := w.logs.String(); !strings.Contains(log, `shop: PoS phone `+till1.keyID+` renamed "Front"`) {
		t.Fatalf("the rename isn't in the log: %q", log)
	}
	for _, id := range []string{owner.keyID, w.keyID, "ffffffffffffffff"} {
		if status, out := w.do("PATCH", path+id, map[string]any{"name": "X"}); status != 404 {
			t.Fatalf("rename %s: %d %v", id, status, out)
		}
		if status, out := w.do("DELETE", path+id, nil); status != 404 {
			t.Fatalf("remove %s: %d %v", id, status, out)
		}
	}
	if status, _ := owner.do("GET", "/api/v1/wallet", nil); status != 200 {
		t.Fatalf("an owner was removed by the shop's routes: %d", status)
	}
	// Removed: its very next request is refused, and the list no longer has it.
	if status, _ := w.do("DELETE", path+till2.keyID, nil); status != 204 {
		t.Fatalf("remove: %d", status)
	}
	if log := w.logs.String(); !strings.Contains(log, "shop: PoS phone "+till2.keyID+" removed") {
		t.Fatalf("the removal isn't in the log: %q", log)
	}
	if status, out := till2.do("GET", "/api/v1/pos/me", nil); status != 401 || !strings.Contains(out["message"].(string), "unknown or revoked device") {
		t.Fatalf("a removed phone: %d %v", status, out)
	}
	if status, _ := w.do("DELETE", path+till2.keyID, nil); status != 404 {
		t.Fatalf("removed twice: %d", status)
	}
	if _, out := w.do("GET", "/api/v1/shop/phones", nil); len(out["phones"].([]any)) != 1 {
		t.Fatalf("after removing: %v", out)
	}
}
