package api

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/deviceauth"
)

// The docker stack test (deploy/test/stack-test.sh) runs this against its
// cardd through Caddy, with the real phoenixd behind it: the test vectors'
// device (an owner) asks for a pairing code, a new key pairs with it as a
// PoS phone and makes a sale, whose invoice phoenixd itself made; the phone
// is kept to its own routes, and removed. The fake phoenixd of the other
// tests takes any request; this is what shows phoenixd takes cardd's.
func TestAStackPoSSale(t *testing.T) {
	base := os.Getenv("CARDD_STACK_URL")
	if base == "" {
		t.Skip("CARDD_STACK_URL not set")
	}
	raw, err := os.ReadFile(vectorsPath())
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		DeviceAuth struct {
			PrivateKey string `json:"privateKey"`
			KeyID      string `json:"keyId"`
		} `json:"deviceAuth"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	d, _ := hex.DecodeString(v.DeviceAuth.PrivateKey)
	ownerKey, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), d)
	if err != nil {
		t.Fatal(err)
	}
	hc := &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	// call sends a request signed by key as keyID, or unsigned with no key.
	call := func(key *ecdsa.PrivateKey, keyID, method, path string, body any) (int, map[string]any) {
		t.Helper()
		var b []byte
		if body != nil {
			b, _ = json.Marshal(body)
		}
		req, _ := http.NewRequest(method, base+path, bytes.NewReader(b))
		if key != nil {
			ts := time.Now().Unix()
			digest := sha256.Sum256([]byte(deviceauth.Canonical(method, path, ts, b)))
			sig, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", fmt.Sprintf("Device %s.%d.%x", keyID, ts, sig))
		}
		resp, err := hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	owner := func(method, path string, body any) (int, map[string]any) {
		return call(ownerKey, v.DeviceAuth.KeyID, method, path, body)
	}

	status, out := owner("POST", "/api/v1/shop/codes", map[string]string{"name": "Stack till"})
	code, _ := out["code"].(string)
	if status != 201 || len(code) != 32 {
		t.Fatalf("code: %d %v", status, out)
	}
	posKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pub, _ := posKey.PublicKey.Bytes()
	posID := deviceauth.KeyID(pub)
	if status, out := call(nil, "", "POST", "/pos/pair", map[string]string{"code": code, "publicKey": hex.EncodeToString(pub)}); status != 201 || out["keyId"] != posID || out["name"] != "Stack till" {
		t.Fatalf("pair: %d %v", status, out)
	}
	pos := func(method, path string, body any) (int, map[string]any) {
		return call(posKey, posID, method, path, body)
	}
	if status, out := pos("GET", "/api/v1/pos/me", nil); status != 200 || out["role"] != "pos" {
		t.Fatalf("me: %d %v", status, out)
	}
	if status, out := pos("GET", "/api/v1/wallet", nil); status != 403 || out["error"] != "not_allowed" {
		t.Fatalf("a PoS phone on the wallet: %d %v", status, out)
	}
	// 2,500 sat: phoenixd's own invoice says 25 micro-bitcoin.
	id := uuid()
	status, out = pos("POST", "/api/v1/pos/sales", map[string]any{"id": id, "amountSat": 2500})
	sale, _ := out["sale"].(map[string]any)
	invoice, _ := sale["invoice"].(string)
	if status != 201 || sale["state"] != "open" || !strings.HasPrefix(invoice, "lnbc25u1") {
		t.Fatalf("sale: %d %v", status, out)
	}
	if status, out := pos("POST", "/api/v1/pos/sales", map[string]any{"id": id, "amountSat": 2500}); status != 200 || out["sale"].(map[string]any)["invoice"] != invoice {
		t.Fatalf("the sale again: %d %v", status, out)
	}
	if status, out := owner("GET", "/api/v1/pos/sales/"+id, nil); status != 200 || out["sale"].(map[string]any)["state"] != "open" {
		t.Fatalf("the owner reading it: %d %v", status, out)
	}
	if status, out := pos("POST", "/api/v1/pos/sales/"+id+"/cancel", nil); status != 200 || out["sale"].(map[string]any)["state"] != "cancelled" {
		t.Fatalf("cancel: %d %v", status, out)
	}
	if status, out := owner("GET", "/api/v1/wallet", nil); status != 200 || out["shop"].(map[string]any)["phones"] != 1.0 {
		t.Fatalf("the wallet's shop: %d %v", status, out["shop"])
	}
	if status, _ := owner("DELETE", "/api/v1/shop/phones/"+posID, nil); status != 204 {
		t.Fatalf("remove: %d", status)
	}
	if status, _ := pos("GET", "/api/v1/pos/me", nil); status != 401 {
		t.Fatalf("the removed phone: %d", status)
	}
}
