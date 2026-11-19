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
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/backup"
	"github.com/boltcard/karto/server/internal/cardkeys"
	"github.com/boltcard/karto/server/internal/cards"
	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/sun"
)

var (
	issuer, _ = hex.DecodeString("00000000000000000000000000000001")
	uid, _    = hex.DecodeString("04a39493cc8680")
)

const cardID = "e07ce1279d980ecb892a81924b67bf18"

type client struct {
	t     *testing.T
	srv   *httptest.Server
	st    *store.Store
	key   *ecdsa.PrivateKey
	keyID string
}

func setup(t *testing.T) *client {
	t.Helper()
	return setupWith(t, func(*store.Store) *backup.Snapshotter { return nil })
}

// setupWith is setup with the backup routes of the Snapshotter that backups makes.
func setupWith(t *testing.T, backups func(*store.Store) *backup.Snapshotter) *client {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "cardd.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	svc, err := cards.New(st, issuer, "vm-1.lnvps.cloud")
	if err != nil {
		t.Fatal(err)
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	raw, _ := key.PublicKey.Bytes()
	keyID := deviceauth.KeyID(raw)
	auth := &deviceauth.Verifier{
		Lookup: func(_ context.Context, id string) (*ecdsa.PublicKey, deviceauth.Role, error) {
			if id != keyID {
				return nil, "", deviceauth.ErrUnknownDevice
			}
			return &key.PublicKey, deviceauth.Owner, nil
		},
		Now: time.Now,
	}
	srv := httptest.NewServer(New(svc, auth, "test", st, nil, backups(st)))
	t.Cleanup(srv.Close)
	return &client{t: t, srv: srv, st: st, key: key, keyID: keyID}
}

// do sends a signed request and decodes the JSON reply.
func (c *client) do(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	status, out, err := c.doWith(http.DefaultClient, method, path, body)
	if err != nil {
		c.t.Fatal(err)
	}
	return status, out
}

// doWith signs and sends one request with hc (a short timeout, say).
func (c *client) doWith(hc *http.Client, method, path string, body any) (int, map[string]any, error) {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, c.srv.URL+path, bytes.NewReader(b))
	ts := time.Now().Unix()
	digest := sha256.Sum256([]byte(deviceauth.Canonical(method, path, ts, b)))
	sig, _ := ecdsa.SignASN1(rand.Reader, c.key, digest[:])
	req.Header.Set("Authorization", fmt.Sprintf("Device %s.%d.%x", c.keyID, ts, sig))
	resp, err := hc.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out, nil
}

func tapFor(t *testing.T, version, counter uint32) map[string]string {
	k, _ := cardkeys.Derive(issuer, uid, version)
	p, c, err := sun.Build(k.K1, k.K2, uid, counter, [5]byte{})
	if err != nil {
		t.Fatal(err)
	}
	return map[string]string{"p": strings.ToUpper(hex.EncodeToString(p)), "c": strings.ToUpper(hex.EncodeToString(c))}
}

// adoptBody is POST /cards/adopt's body for a tap, at version.
func adoptBody(version uint32, name string, tap map[string]string) map[string]any {
	return map[string]any{"version": version, "name": name, "p": tap["p"], "c": tap["c"]}
}

func TestHealthNeedsNoAuth(t *testing.T) {
	c := setup(t)
	resp, err := http.Get(c.srv.URL + "/health")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("health: %v %v", resp.StatusCode, err)
	}
}

// The app compares the server's bundle with its own on open, to offer "Update server".
func TestServerInfo(t *testing.T) {
	c := setup(t)
	code, body := c.do("GET", "/api/v1/server", nil)
	if code != 200 || body["version"] != "test" || body["bundle"] != "" || body["schema"] != float64(store.SchemaVersion()) {
		t.Fatalf("before install: %d %v", code, body)
	}
	if err := c.st.SetMeta(context.Background(), "bundle.sha256", "ab12"); err != nil {
		t.Fatal(err)
	}
	code, body = c.do("GET", "/api/v1/server", nil)
	if code != 200 || body["bundle"] != "ab12" {
		t.Fatalf("after install: %d %v", code, body)
	}
	resp, _ := http.Get(c.srv.URL + "/api/v1/server")
	if resp.StatusCode != 401 {
		t.Fatalf("unsigned: got %d, want 401", resp.StatusCode)
	}
}

func TestAPIRequiresAuth(t *testing.T) {
	c := setup(t)
	resp, _ := http.Post(c.srv.URL+"/api/v1/cards", "application/json", strings.NewReader(`{"id":"`+cardID+`"}`))
	if resp.StatusCode != 401 {
		t.Fatalf("got %d, want 401", resp.StatusCode)
	}
}

func TestCardLifecycle(t *testing.T) {
	c := setup(t)
	status, out := c.do("POST", "/api/v1/cards", map[string]string{"id": cardID})
	if status != 200 || out["version"] != 0.0 || out["state"] != "programming" || out["lnurlw"] != "lnurlw://vm-1.lnvps.cloud/ln" || out["host"] != "vm-1.lnvps.cloud" {
		t.Fatalf("reserve: %d %v", status, out)
	}
	status, out = c.do("POST", "/api/v1/cards/"+cardID+"/confirm", tapFor(t, 0, 0))
	if status != 200 || out["state"] != "active" {
		t.Fatalf("confirm: %d %v", status, out)
	}
	status, out = c.do("POST", "/api/v1/cards/check", tapFor(t, 0, 1))
	if status != 200 || out["id"] != cardID || out["counter"] != 1.0 {
		t.Fatalf("check: %d %v", status, out)
	}
	status, out = c.do("POST", "/api/v1/cards/check", tapFor(t, 0, 1))
	if status != 409 || out["error"] != "replayed" {
		t.Fatalf("replay: %d %v", status, out)
	}
}

// After a restore, the list says which cards need their owner's check, and
// the check (POST /cards/check with the card's tap) clears it.
func TestCheckAfterARestore(t *testing.T) {
	c := setup(t)
	c.do("POST", "/api/v1/cards", map[string]string{"id": cardID})
	c.do("POST", "/api/v1/cards/"+cardID+"/confirm", tapFor(t, 0, 1))
	_, out := c.do("GET", "/api/v1/cards", nil)
	if card := out["cards"].([]any)[0].(map[string]any); card["needsCheck"] != nil {
		t.Fatalf("before a restore: %v", card)
	}
	if err := c.st.PrepareRestored(context.Background(), "backup", "04aa", store.RestoredVM{ID: "2", Host: "vm-2.lnvps.cloud", IPv4: "192.0.2.2"}); err != nil {
		t.Fatal(err)
	}
	_, out = c.do("GET", "/api/v1/cards", nil)
	if card := out["cards"].([]any)[0].(map[string]any); card["needsCheck"] != true {
		t.Fatalf("after the restore: %v", card)
	}
	if status, out := c.do("POST", "/api/v1/cards/check", tapFor(t, 0, 1)); status != 409 || out["error"] != "replayed" {
		t.Fatalf("an old tap: %d %v", status, out)
	}
	status, out := c.do("POST", "/api/v1/cards/check", tapFor(t, 0, 12))
	if status != 200 || out["counter"] != 12.0 || out["needsCheck"] != nil {
		t.Fatalf("check: %d %v", status, out)
	}
}

func TestErrorCodes(t *testing.T) {
	c := setup(t)
	cases := []struct {
		path   string
		body   any
		status int
		code   string
	}{
		{"/api/v1/cards", map[string]string{"id": "nope"}, 400, "malformed"},
		{"/api/v1/cards", map[string]string{"id": cardID, "extra": "x"}, 400, "malformed"},
		{"/api/v1/cards/check", map[string]string{"p": "ab", "c": "cd"}, 400, "malformed"},
		{"/api/v1/cards/check", map[string]string{"p": "ef963ff7828658a599f3041510671e88", "c": "94eed9ee65337086"}, 422, "not_ours"},
		{"/api/v1/cards/check", tapFor(t, 0, 3), 404, "unknown_card"},
		{"/api/v1/cards/adopt", adoptBody(1, "", tapFor(t, 0, 3)), 422, "bad_mac"},
		{"/api/v1/cards/adopt", adoptBody(0, "", map[string]string{"p": "ef963ff7828658a599f3041510671e88", "c": "94eed9ee65337086"}), 422, "not_ours"},
		{"/api/v1/cards", map[string]string{"id": cardID}, 200, ""},
		{"/api/v1/cards/check", tapFor(t, 0, 4), 409, "not_active"},
	}
	for _, tc := range cases {
		status, out := c.do("POST", tc.path, tc.body)
		if code, _ := out["error"].(string); status != tc.status || code != tc.code {
			t.Errorf("%s %v: got %d %v, want %d %s", tc.path, tc.body, status, out, tc.status, tc.code)
		}
	}
}

func TestCardListRenameAndWipe(t *testing.T) {
	c := setup(t)
	status, out := c.do("POST", "/api/v1/cards", map[string]string{"id": cardID, "name": "Daily"})
	if status != 200 || out["name"] != "Daily" || out["lnurlw"] != "lnurlw://vm-1.lnvps.cloud/ln" {
		t.Fatalf("reserve: %d %v", status, out)
	}
	if status, out = c.do("POST", "/api/v1/cards/"+cardID+"/confirm", tapFor(t, 0, 0)); status != 200 {
		t.Fatalf("confirm: %d %v", status, out)
	}
	status, out = c.do("GET", "/api/v1/cards", nil)
	list, _ := out["cards"].([]any)
	if status != 200 || len(list) != 1 {
		t.Fatalf("list: %d %v", status, out)
	}
	first := list[0].(map[string]any)
	if first["id"] != cardID || first["state"] != "active" || first["created"] == nil || first["updated"] == nil {
		t.Fatalf("list entry: %v", first)
	}
	if status, out = c.do("PATCH", "/api/v1/cards/"+cardID, map[string]string{"name": "Kids"}); status != 200 || out["name"] != "Kids" {
		t.Fatalf("rename: %d %v", status, out)
	}
	for _, step := range []struct{ path, state string }{{"/wipe", "wiping"}, {"/wipe", "wiping"}, {"/wiped", "reset"}, {"/wiped", "reset"}} {
		if status, out = c.do("POST", "/api/v1/cards/"+cardID+step.path, nil); status != 200 || out["state"] != step.state {
			t.Fatalf("%s: %d %v", step.path, status, out)
		}
	}
	if status, out = c.do("POST", "/api/v1/cards/"+cardID+"/wipe", nil); status != 409 || out["error"] != "conflict" {
		t.Fatalf("wipe a reset card: %d %v", status, out)
	}
	if status, out = c.do("POST", "/api/v1/cards", map[string]string{"id": cardID}); status != 200 || out["version"] != 1.0 || out["name"] != "Kids" {
		t.Fatalf("reserve after the wipe: %d %v", status, out)
	}
	if status, out = c.do("PATCH", "/api/v1/cards/"+cardID, map[string]string{"name": strings.Repeat("x", 41)}); status != 400 || out["error"] != "bad_name" {
		t.Fatalf("long name: %d %v", status, out)
	}
	if status, out = c.do("POST", "/api/v1/cards/ffffffffffffffffffffffffffffffff/wipe", nil); status != 404 || out["error"] != "not_found" {
		t.Fatalf("unknown card: %d %v", status, out)
	}
}

func TestEmptyCardListIsAnArray(t *testing.T) {
	c := setup(t)
	status, out := c.do("GET", "/api/v1/cards", nil)
	if list, ok := out["cards"].([]any); status != 200 || !ok || len(list) != 0 {
		t.Fatalf("got %d %v", status, out)
	}
}

// Phrase only: the app adopts a tapped card at the version it found (no host
// yet: its URL isn't rewritten), then sets its host once the same hold has
// re-pointed it.
func TestAdoptAndSetHost(t *testing.T) {
	c := setup(t)
	status, out := c.do("POST", "/api/v1/cards/adopt", adoptBody(2, "Daily", tapFor(t, 2, 9)))
	if status != 200 || out["id"] != cardID || out["state"] != "active" || out["version"] != 2.0 ||
		out["counter"] != 9.0 || out["name"] != "Daily" || out["host"] != "" {
		t.Fatalf("adopt: %d %v", status, out)
	}
	if status, out = c.do("POST", "/api/v1/cards/check", tapFor(t, 2, 9)); status != 409 || out["error"] != "replayed" {
		t.Fatalf("the adopting tap again: %d %v", status, out)
	}
	if status, out = c.do("POST", "/api/v1/cards/adopt", adoptBody(2, "", tapFor(t, 2, 10))); status != 409 || out["error"] != "conflict" {
		t.Fatalf("a known card: %d %v", status, out)
	}
	if status, out = c.do("PUT", "/api/v1/cards/"+cardID+"/host", map[string]string{"host": "vm-2.lnvps.cloud"}); status != 200 || out["host"] != "vm-2.lnvps.cloud" {
		t.Fatalf("set host: %d %v", status, out)
	}
	_, out = c.do("GET", "/api/v1/cards", nil)
	if list, _ := out["cards"].([]any); len(list) != 1 || list[0].(map[string]any)["host"] != "vm-2.lnvps.cloud" {
		t.Fatalf("list: %v", out)
	}
	if status, out = c.do("PUT", "/api/v1/cards/"+cardID+"/host", map[string]string{"host": "vm-2.lnvps.cloud:443"}); status != 400 || out["error"] != "bad_host" {
		t.Fatalf("bad host: %d %v", status, out)
	}
	c.do("POST", "/api/v1/cards/"+cardID+"/wipe", nil)
	c.do("POST", "/api/v1/cards/"+cardID+"/wiped", nil)
	if status, out = c.do("PUT", "/api/v1/cards/"+cardID+"/host", map[string]string{"host": "vm-3.lnvps.cloud"}); status != 409 || out["error"] != "conflict" {
		t.Fatalf("reset card: %d %v", status, out)
	}
}
