package api

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/store"
)

// storeLookup reads a device from the store, as cardd's own lookup does.
func storeLookup(ctx context.Context, st *store.Store, id string) (*ecdsa.PublicKey, deviceauth.Role, error) {
	d, err := st.GetDevice(ctx, id)
	if errors.Is(err, store.ErrNotFound) || (err == nil && d.RevokedAt != nil) {
		return nil, "", deviceauth.ErrUnknownDevice
	}
	if err != nil {
		return nil, "", err
	}
	pub, _, err := deviceauth.ParsePublicKey(d.PublicKey)
	return pub, deviceauth.Role(d.Role), err
}

// device makes a key, registers it in the store with role and name, and
// returns a client that signs with it.
func (w *moneyWorld) device(role store.Role, name string) *client {
	w.t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	raw, _ := key.PublicKey.Bytes()
	id := deviceauth.KeyID(raw)
	if err := w.st.AddDevice(context.Background(), store.Device{KeyID: id, PublicKey: hex.EncodeToString(raw), Name: name, Role: role}); err != nil {
		w.t.Fatal(err)
	}
	return &client{t: w.t, srv: w.srv, st: w.st, key: key, keyID: id}
}

// ownerRoutes is every route under /api/v1/ outside /api/v1/pos/, with a
// path that fits it. A PoS phone gets none of them.
// TestEveryRouteIsInTheBoundaryTable keeps the list whole.
var ownerRoutes = []string{
	"GET /api/v1/server",
	"POST /api/v1/sales/{id}/refund",
	"POST /api/v1/cards",
	"POST /api/v1/cards/check",
	"POST /api/v1/cards/{id}/confirm",
	"POST /api/v1/cards/adopt",
	"PUT /api/v1/cards/{id}/host",
	"GET /api/v1/cards",
	"PATCH /api/v1/cards/{id}",
	"POST /api/v1/cards/{id}/wipe",
	"POST /api/v1/cards/{id}/wiped",
	"PUT /api/v1/cards/{id}/photo",
	"DELETE /api/v1/cards/{id}/photo",
	"GET /api/v1/cards/{id}/photo",
	"GET /api/v1/wallet",
	"GET /api/v1/push",
	"PUT /api/v1/push",
	"DELETE /api/v1/push",
	"POST /api/v1/push/test",
	"GET /api/v1/accounts/{account}/history",
	"GET /api/v1/accounts/{account}/transactions/{id}",
	"PATCH /api/v1/accounts/{account}/transactions/{id}",
	"GET /api/v1/send/recent",
	"DELETE /api/v1/send/recent",
	"POST /api/v1/move",
	"POST /api/v1/send",
	"POST /api/v1/send/lookup",
	"GET /api/v1/send/{id}",
	"POST /api/v1/cards/{id}/freeze",
	"POST /api/v1/cards/{id}/unfreeze",
	"PATCH /api/v1/cards/{id}/limits",
	"POST /api/v1/ledger/reconcile",
	"POST /api/v1/ledger/restore-books",
	"GET /api/v1/hosting",
	"PUT /api/v1/hosting",
	"POST /api/v1/hosting/renew",
	"GET /api/v1/backups",
	"GET /api/v1/backups/{version}",
	"POST /api/v1/shop/codes",
	"DELETE /api/v1/shop/codes",
	"GET /api/v1/shop/phones",
	"PATCH /api/v1/shop/phones/{keyId}",
	"DELETE /api/v1/shop/phones/{keyId}",
	"PUT /api/v1/currency",
	"PUT /api/v1/wallet/name",
}

// posRoutes is every route under /api/v1/pos/, and whether an owner is
// refused it (the PoS-only ones).
var posRoutes = map[string]bool{
	"GET /api/v1/pos/me":                 false,
	"GET /api/v1/pos/fiat":               false,
	"DELETE /api/v1/pos/me":              true,
	"POST /api/v1/pos/sales":             true,
	"GET /api/v1/pos/sales":              false,
	"GET /api/v1/pos/sales/days":         false,
	"GET /api/v1/pos/sales/{id}":         false,
	"POST /api/v1/pos/sales/{id}/card":   true,
	"POST /api/v1/pos/sales/{id}/cancel": true,
}

// fill puts something in a route pattern's wildcards.
func fill(pattern string) (method, path string) {
	method, path, _ = strings.Cut(pattern, " ")
	if strings.HasPrefix(path, "/api/v1/pos/sales/") {
		path = strings.Replace(path, "{id}", "0a000000-0000-4000-8000-00000000000a", 1)
	}
	path = strings.NewReplacer("{id}", cardID, "{account}", "pool", "{version}", "1", "{keyId}", "aaaaaaaaaaaaaaaa").Replace(path)
	return method, path
}

// The boundary: a PoS phone is
// refused every route outside /api/v1/pos/, before any handler, and an owner
// is refused the PoS-only ones.
func TestAPoSPhoneReachesOnlyItsOwnRoutes(t *testing.T) {
	w := moneySetup(t)
	pos := w.device(store.RolePos, "Till 1")
	for _, route := range ownerRoutes {
		method, path := fill(route)
		if status, out := pos.do(method, path, map[string]any{}); status != 403 || out["error"] != "not_allowed" {
			t.Fatalf("a PoS phone on %s: %d %v", route, status, out)
		}
	}
	// Nothing a PoS phone asked for happened: the wallet is as it was.
	if w.balance(store.Pool) != 50_000_000 || w.balance(store.CardAccount(cardID)) != 100_000_000 {
		t.Fatalf("money moved: pool %d, card %d", w.balance(store.Pool), w.balance(store.CardAccount(cardID)))
	}
	if c, err := w.st.GetCard(context.Background(), cardID); err != nil || c.State != store.StateActive || c.Name != "Daily" {
		t.Fatalf("the card changed: %+v %v", c, err)
	}
	// A path no route has: closed outside the prefix, simply missing inside it.
	if status, out := pos.do("GET", "/api/v1/not-a-route-yet", nil); status != 403 || out["error"] != "not_allowed" {
		t.Fatalf("a made-up path: %d %v", status, out)
	}
	if status, _ := pos.do("GET", "/api/v1/pos/not-a-route-yet", nil); status != 404 {
		t.Fatalf("a made-up path under /pos/: %d", status)
	}
	for route, posOnly := range posRoutes {
		if !posOnly {
			continue
		}
		method, path := fill(route)
		if status, out := w.do(method, path, map[string]any{}); status != 403 || out["error"] != "not_allowed" {
			t.Fatalf("an owner on the PoS-only %s: %d %v", route, status, out)
		}
	}
	// An owner is refused none of the others (whatever else each answers to an empty request; this goes last,
	// since some of them act).
	for _, route := range ownerRoutes {
		method, path := fill(route)
		if status, out := w.do(method, path, map[string]any{}); status == 403 && out["error"] == "not_allowed" {
			t.Fatalf("an owner on %s: %d %v", route, status, out)
		}
	}
}

// publicRoutes is every route with no device auth at all: on the outer mux,
// beside the /api/v1/ subtree. A new one fails the test below until it is
// listed here, which is where a reviewer looks.
var publicRoutes = []string{
	"GET /health",
	"POST /pos/pair",
}

// Every route the package registers is in one of the three tables above, so
// a new route can't be added without the boundary test trying it, nor a
// public one without being listed. (Go's ServeMux can't list its routes: the
// source can.) Every registration must be a literal pattern with a method:
// one without a method would answer every method, and one built at run time
// couldn't be read here.
func TestEveryRouteIsInTheBoundaryTable(t *testing.T) {
	listed := map[string]bool{}
	for _, r := range ownerRoutes {
		listed[r] = true
	}
	for r := range posRoutes {
		listed[r] = true
	}
	for _, r := range publicRoutes {
		listed[r] = true
	}
	files, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	registration := regexp.MustCompile(`\.Handle(?:Func)?\(\s*([^,]+),`)
	withMethod := regexp.MustCompile(`^"([A-Z]+ /[^"]*)"$`)
	found := 0
	for _, f := range files {
		if !strings.HasSuffix(f.Name(), ".go") || strings.HasSuffix(f.Name(), "_test.go") {
			continue
		}
		src, err := os.ReadFile(f.Name())
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range registration.FindAllStringSubmatch(string(src), -1) {
			arg := strings.TrimSpace(m[1])
			if arg == `"/api/v1/"` {
				continue // the subtree itself, handed to the auth middleware
			}
			lit := withMethod.FindStringSubmatch(arg)
			if lit == nil {
				t.Errorf("%s registers %s: every route is a literal pattern with a method", f.Name(), arg)
				continue
			}
			route := lit[1]
			found++
			if !listed[route] {
				t.Errorf("%s registers %q, which the boundary tables don't list", f.Name(), route)
			}
			_, path, _ := strings.Cut(route, " ")
			_, isPos := posRoutes[route]
			isPublic := false
			for _, r := range publicRoutes {
				isPublic = isPublic || r == route
			}
			switch {
			case strings.HasPrefix(path, deviceauth.PosPrefix) != isPos:
				t.Errorf("%q is in the wrong table for its path", route)
			case strings.HasPrefix(path, "/api/v1/") == isPublic:
				t.Errorf("%q: a route under /api/v1/ needs a device, and one outside it is public", route)
			}
			delete(listed, route)
		}
	}
	if found == 0 {
		t.Fatal("no routes found: the pattern no longer matches how routes are registered")
	}
	for r := range listed {
		t.Errorf("the boundary tables list %q, which no file registers", r)
	}
}

// What a device is to the server, and a PoS phone unpairing itself.
func TestPosMeAndUnpair(t *testing.T) {
	w := moneySetup(t)
	pos := w.device(store.RolePos, "Till 1")
	if status, out := pos.do("GET", "/api/v1/pos/me", nil); status != 200 || out["keyId"] != pos.keyID || out["name"] != "Till 1" || out["role"] != "pos" {
		t.Fatalf("me: %d %v", status, out)
	}
	owner := w.device(store.RoleOwner, "Second phone")
	if status, out := owner.do("GET", "/api/v1/pos/me", nil); status != 200 || out["name"] != "Second phone" || out["role"] != "owner" {
		t.Fatalf("an owner's me: %d %v", status, out)
	}
	if status, out := owner.do("DELETE", "/api/v1/pos/me", nil); status != 403 || out["error"] != "not_allowed" {
		t.Fatalf("an owner unpairing itself: %d %v", status, out)
	}
	if status, out := pos.do("DELETE", "/api/v1/pos/me", nil); status != 204 {
		t.Fatalf("unpair: %d %v", status, out)
	}
	if status, out := pos.do("GET", "/api/v1/pos/me", nil); status != 401 || !strings.Contains(out["message"].(string), "unknown or revoked device") {
		t.Fatalf("after unpairing: %d %v", status, out)
	}
	if status, _ := owner.do("GET", "/api/v1/pos/me", nil); status != 200 {
		t.Fatalf("the owner was unpaired too: %d", status)
	}
}
