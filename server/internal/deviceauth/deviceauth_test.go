package deviceauth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/asn1"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/testvec"
)

func verifier(t *testing.T, now int64) (*Verifier, testvec.Vectors) {
	v := testvec.Load(t)
	pub, raw, err := ParsePublicKey(v.DeviceAuth.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if KeyID(raw) != v.DeviceAuth.KeyID {
		t.Fatalf("KeyID = %s, want %s", KeyID(raw), v.DeviceAuth.KeyID)
	}
	return &Verifier{
		Lookup: func(_ context.Context, id string) (*ecdsa.PublicKey, Role, error) {
			if id != v.DeviceAuth.KeyID {
				return nil, "", ErrUnknownDevice
			}
			return pub, Owner, nil
		},
		Now: func() time.Time { return time.Unix(now, 0) },
	}, v
}

func header(v testvec.Vectors) string {
	d := v.DeviceAuth
	return fmt.Sprintf("Device %s.%d.%s", d.KeyID, d.TS, d.SignatureDer)
}

func TestCanonicalMatchesVector(t *testing.T) {
	d := testvec.Load(t).DeviceAuth
	if got := Canonical(d.Method, d.Path, d.TS, []byte(d.Body)); got != d.Canonical {
		t.Fatalf("got %q, want %q", got, d.Canonical)
	}
}

func TestVerifyVector(t *testing.T) {
	ver, v := verifier(t, testvec.Load(t).DeviceAuth.TS)
	d := v.DeviceAuth
	id, role, err := ver.Verify(context.Background(), header(v), d.Method, d.Path, []byte(d.Body))
	if err != nil || id != d.KeyID || role != Owner {
		t.Fatalf("got %q %q %v", id, role, err)
	}
}

// The Android Keystore does not normalise S, so about half of a phone's
// signatures are "high-S". They are valid ECDSA and must verify.
func TestVerifyAcceptsHighS(t *testing.T) {
	ver, v := verifier(t, testvec.Load(t).DeviceAuth.TS)
	d := v.DeviceAuth
	var sig struct{ R, S *big.Int }
	if _, err := asn1.Unmarshal(testvec.Hex(t, d.SignatureDer), &sig); err != nil {
		t.Fatal(err)
	}
	sig.S = new(big.Int).Sub(elliptic.P256().Params().N, sig.S)
	high, err := asn1.Marshal(sig)
	if err != nil {
		t.Fatal(err)
	}
	header := fmt.Sprintf("Device %s.%d.%x", d.KeyID, d.TS, high)
	if _, _, err := ver.Verify(context.Background(), header, d.Method, d.Path, []byte(d.Body)); err != nil {
		t.Fatalf("high-S signature rejected: %v", err)
	}
}

func TestVerifyRejects(t *testing.T) {
	ts := testvec.Load(t).DeviceAuth.TS
	cases := []struct {
		name   string
		now    int64
		header func(testvec.Vectors) string
		body   func(string) string
		want   error
	}{
		{"skew exactly 60s is allowed", ts + 60, header, nil, nil},
		{"61s late", ts + 61, header, nil, ErrSkew},
		{"61s early", ts - 61, header, nil, ErrSkew},
		{"tampered body", ts, header, func(b string) string { return b + " " }, ErrBadSignature},
		{"no header", ts, func(testvec.Vectors) string { return "" }, nil, ErrMissing},
		{"wrong scheme", ts, func(v testvec.Vectors) string { return strings.Replace(header(v), "Device", "Bearer", 1) }, nil, ErrMissing},
		{"unknown key", ts, func(v testvec.Vectors) string {
			return strings.Replace(header(v), v.DeviceAuth.KeyID, "0000000000000000", 1)
		}, nil, ErrUnknownDevice},
		{"bad sig hex", ts, func(v testvec.Vectors) string { return header(v) + "zz" }, nil, ErrMissing},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ver, v := verifier(t, c.now)
			body := v.DeviceAuth.Body
			if c.body != nil {
				body = c.body(body)
			}
			_, _, err := ver.Verify(context.Background(), c.header(v), v.DeviceAuth.Method, v.DeviceAuth.Path, []byte(body))
			if !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}
}

func TestMiddleware(t *testing.T) {
	ver, v := verifier(t, testvec.Load(t).DeviceAuth.TS)
	d := v.DeviceAuth
	h := ver.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		fmt.Fprintf(w, "%s|%s", DeviceID(r.Context()), b)
	}))

	req := httptest.NewRequest(d.Method, d.Path, strings.NewReader(d.Body))
	req.Header.Set("Authorization", header(v))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || rec.Body.String() != d.KeyID+"|"+d.Body {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(d.Method, d.Path, strings.NewReader(d.Body))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("no header: got %d", rec.Code)
	}
}

// The same signature twice, or the same one with s flipped to n-s (also
// valid), is refused the second time.
func TestVerifyRefusesAReplay(t *testing.T) {
	ver, v := verifier(t, testvec.Load(t).DeviceAuth.TS)
	seen := map[string]bool{}
	ver.Seen = func(_ context.Context, hash string, _ time.Time) (bool, error) {
		fresh := !seen[hash]
		seen[hash] = true
		return fresh, nil
	}
	d := v.DeviceAuth
	ctx := context.Background()
	if _, _, err := ver.Verify(ctx, header(v), d.Method, d.Path, []byte(d.Body)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ver.Verify(ctx, header(v), d.Method, d.Path, []byte(d.Body)); !errors.Is(err, ErrReplayed) {
		t.Fatalf("replay: %v", err)
	}
	var sig struct{ R, S *big.Int }
	asn1.Unmarshal(testvec.Hex(t, d.SignatureDer), &sig)
	sig.S = new(big.Int).Sub(elliptic.P256().Params().N, sig.S)
	flipped, _ := asn1.Marshal(sig)
	h := fmt.Sprintf("Device %s.%d.%x", d.KeyID, d.TS, flipped)
	if _, _, err := ver.Verify(ctx, h, d.Method, d.Path, []byte(d.Body)); !errors.Is(err, ErrReplayed) {
		t.Fatalf("flipped-s replay: %v", err)
	}
}

// A PoS phone is kept to the paths under /api/v1/pos/ by
// the middleware itself, before any handler is looked for: a route added
// anywhere else is closed to it without anyone remembering to close it.
func TestAPoSDeviceIsKeptToItsPrefix(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	raw, _ := key.PublicKey.Bytes()
	id := KeyID(raw)
	for _, role := range []Role{Pos, Owner} {
		ver := &Verifier{
			Lookup: func(context.Context, string) (*ecdsa.PublicKey, Role, error) { return &key.PublicKey, role, nil },
			Now:    time.Now,
		}
		reached := ""
		h := ver.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			reached = r.URL.Path + " as " + string(RoleOf(r.Context())) + " " + DeviceID(r.Context())
		}))
		call := func(method, path string) (int, string) {
			reached = ""
			ts := time.Now().Unix()
			digest := sha256.Sum256([]byte(Canonical(method, path, ts, nil)))
			sig, _ := ecdsa.SignASN1(rand.Reader, key, digest[:])
			req := httptest.NewRequest(method, "http://cardd"+path, nil)
			req.Header.Set("Authorization", fmt.Sprintf("Device %s.%d.%x", id, ts, sig))
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			return rec.Code, rec.Body.String()
		}
		for _, path := range []string{"/api/v1/pos/me", "/api/v1/pos/sales/1234"} {
			if code, _ := call("GET", path); code != 200 || reached != path+" as "+string(role)+" "+id {
				t.Fatalf("%s %s: %d, reached %q", role, path, code, reached)
			}
		}
		// Everything else: an owner passes, a PoS phone is stopped here.
		for _, path := range []string{"/api/v1/wallet", "/api/v1/move", "/api/v1/pos", "/api/v1/posx/me", "/api/v1/shop/phones",
			"/api/v1/pos/../wallet", "/api/v1/pos/./../backups/1", "/api/v1/pos//me", "/api/v1/not-a-route-yet"} {
			code, body := call("POST", path)
			if role == Owner {
				if code != 200 || reached == "" {
					t.Fatalf("owner %s: %d %q", path, code, body)
				}
				continue
			}
			if code != 403 || !strings.Contains(body, `"error":"not_allowed"`) || reached != "" {
				t.Fatalf("pos %s: %d %q, reached %q", path, code, body, reached)
			}
		}
	}
}
