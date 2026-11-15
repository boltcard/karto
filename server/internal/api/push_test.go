package api

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/boltcard/karto/server/internal/store"
)

var b64u = base64.RawURLEncoding

// pushBody is a PUT body with fresh, valid keys.
func pushBody(endpoint, transport string) map[string]any {
	k, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	rand.Read(auth)
	return map[string]any{"endpoint": endpoint, "p256dh": b64u.EncodeToString(k.PublicKey().Bytes()),
		"auth": b64u.EncodeToString(auth), "transport": transport}
}

// pushSetup is moneySetup with the world's own key stored as an owner device,
// as a paired phone is (a push endpoint belongs to a stored device).
func pushSetup(t *testing.T) *moneyWorld {
	t.Helper()
	w := moneySetup(t)
	if err := w.st.AddDevice(context.Background(), store.Device{KeyID: w.keyID, PublicKey: "04", Name: "test phone"}); err != nil {
		t.Fatal(err)
	}
	return w
}

func TestPushGetBeforeAny(t *testing.T) {
	w := pushSetup(t)
	w.money.Push.NtfyPublic = "https://vm-1.lnvps.cloud:8443"
	status, out := w.do("GET", "/api/v1/push", nil)
	if status != 200 || out["endpoint"] != nil || out["ntfy"] != "https://vm-1.lnvps.cloud:8443" {
		t.Fatalf("%d %v", status, out)
	}
	if k, _ := out["vapidPublicKey"].(string); len(k) != 87 {
		t.Errorf("vapidPublicKey %q, want 65 bytes of base64url", k)
	}
}

func TestPushPutThenGet(t *testing.T) {
	w := pushSetup(t)
	status, out := w.do("PUT", "/api/v1/push", pushBody("https://push.example.com/wpush/secret-token", "unifiedpush"))
	if status != 200 {
		t.Fatalf("%d %v", status, out)
	}
	_, got := w.do("GET", "/api/v1/push", nil)
	ep, _ := got["endpoint"].(map[string]any)
	if ep == nil || ep["transport"] != "unifiedpush" || ep["origin"] != "https://push.example.com" ||
		ep["deliveredAt"] != nil || ep["failures"] != 0.0 || ep["createdAt"] == nil {
		t.Fatalf("endpoint %v", got)
	}
	if strings.Contains(strings.Join([]string{ep["origin"].(string)}, ""), "secret") || got["ntfy"] != "" {
		t.Errorf("the path leaked or ntfy not empty: %v", got)
	}
	status, out = w.do("PUT", "/api/v1/push", pushBody("https://fcm.example.com/other", "fcm"))
	if _, got = w.do("GET", "/api/v1/push", nil); status != 200 || got["endpoint"].(map[string]any)["transport"] != "fcm" {
		t.Fatalf("replace: %d %v", status, got)
	}
}

func TestPushPutRefusesNtfySh(t *testing.T) {
	w := pushSetup(t)
	w.money.Push.NtfyPublic = "https://vm-1.lnvps.cloud:8443"
	status, out := w.do("PUT", "/api/v1/push", pushBody("https://ntfy.sh/upAbc123?up=1", "unifiedpush"))
	if status != 400 || out["error"] != "ntfy_sh" {
		t.Fatalf("%d %v", status, out)
	}
	// Without a server ntfy of its own it is an ordinary endpoint.
	w.money.Push.NtfyPublic = ""
	if status, out = w.do("PUT", "/api/v1/push", pushBody("https://ntfy.sh/upAbc123?up=1", "unifiedpush")); status != 200 {
		t.Fatalf("%d %v", status, out)
	}
}

func TestPushPutRefusesPrivate(t *testing.T) {
	w := pushSetup(t)
	for _, ep := range []string{"https://192.168.1.5/x", "https://localhost/x", "http://push.example.com/x", "nonsense"} {
		status, out := w.do("PUT", "/api/v1/push", pushBody(ep, "unifiedpush"))
		if status != 400 || out["error"] != "bad_endpoint" {
			t.Errorf("%s: %d %v", ep, status, out)
		}
	}
	status, out := w.do("PUT", "/api/v1/push", pushBody("https://push.example.com/x", "webpush"))
	if status != 400 || out["error"] != "bad_transport" {
		t.Errorf("transport: %d %v", status, out)
	}
}

func TestPushPutBadKeys(t *testing.T) {
	w := pushSetup(t)
	good := pushBody("https://push.example.com/x", "unifiedpush")
	for name, mut := range map[string]func(map[string]any){
		"short p256dh": func(b map[string]any) { b["p256dh"] = b64u.EncodeToString(make([]byte, 64)) },
		"not a point":  func(b map[string]any) { b["p256dh"] = b64u.EncodeToString(append([]byte{4}, make([]byte, 64)...)) },
		"not base64":   func(b map[string]any) { b["p256dh"] = "!!!" },
		"auth 15":      func(b map[string]any) { b["auth"] = b64u.EncodeToString(make([]byte, 15)) },
		"auth empty":   func(b map[string]any) { b["auth"] = "" },
	} {
		b := map[string]any{}
		for k, v := range good {
			b[k] = v
		}
		mut(b)
		status, out := w.do("PUT", "/api/v1/push", b)
		if status != 400 || out["error"] != "bad_keys" {
			t.Errorf("%s: %d %v", name, status, out)
		}
	}
}

func TestPushDelete(t *testing.T) {
	w := pushSetup(t)
	w.do("PUT", "/api/v1/push", pushBody("https://push.example.com/x", "unifiedpush"))
	if status, _ := w.do("DELETE", "/api/v1/push", nil); status != 204 {
		t.Fatalf("delete %d", status)
	}
	if status, _ := w.do("DELETE", "/api/v1/push", nil); status != 204 {
		t.Errorf("delete again %d", status)
	}
	if _, out := w.do("GET", "/api/v1/push", nil); out["endpoint"] != nil {
		t.Errorf("still there: %v", out)
	}
	if status, out := w.do("POST", "/api/v1/push/test", nil); status != 404 {
		t.Errorf("test with none: %d %v", status, out)
	}
}

func TestPushTestDelivers(t *testing.T) {
	w := pushSetup(t)
	status := http.StatusCreated
	var posted int
	push := httptest.NewTLSServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		posted++
		if r.Header.Get("Content-Encoding") != "aes128gcm" || !strings.HasPrefix(r.Header.Get("Authorization"), "vapid ") {
			t.Errorf("headers %v", r.Header)
		}
		rw.WriteHeader(status)
	}))
	defer push.Close()
	w.money.Push.HTTP = &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	w.money.Push.Check = func(string) error { return nil } // the test server is on 127.0.0.1
	body := pushBody(push.URL+"/wpush/abc", "unifiedpush")
	// PUT refuses 127.0.0.1, so the endpoint goes in through the store.
	if s, out := w.do("PUT", "/api/v1/push", body); s != 400 {
		t.Fatalf("%d %v", s, out)
	}
	body["endpoint"] = push.URL + "/wpush/abc"
	if err := w.st.SetPushEndpoint(context.Background(), pushStoreEndpoint(w.keyID, body)); err != nil {
		t.Fatal(err)
	}
	s, out := w.do("POST", "/api/v1/push/test", nil)
	if s != 200 || out["delivered"] != true || posted != 1 {
		t.Fatalf("%d %v posted %d", s, out, posted)
	}
	if _, got := w.do("GET", "/api/v1/push", nil); got["endpoint"].(map[string]any)["deliveredAt"] == nil {
		t.Errorf("delivery not booked: %v", got)
	}
	status = http.StatusInternalServerError
	s, out = w.do("POST", "/api/v1/push/test", nil)
	if s != 502 || out["error"] != "push_failed" || out["detail"] == "" {
		t.Errorf("failure: %d %v", s, out)
	}
}

func pushStoreEndpoint(keyID string, body map[string]any) store.PushEndpoint {
	return store.PushEndpoint{KeyID: keyID, Endpoint: body["endpoint"].(string), P256dh: body["p256dh"].(string),
		Auth: body["auth"].(string), Transport: body["transport"].(string)}
}
