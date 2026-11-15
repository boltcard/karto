package api

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/store"
)

// photoJPEG is a 428×270 JPEG, as the phone makes one.
func photoJPEG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 428, 270))
	for y := 0; y < 270; y++ {
		for x := 0; x < 428; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 90, 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// The routes of a card's photo.
func TestPhotoRoutes(t *testing.T) {
	c := setup(t)
	ctx := context.Background()
	if status, _ := c.do("POST", "/api/v1/cards", map[string]string{"id": cardID, "name": "A"}); status != 200 {
		t.Fatalf("reserve: %d", status)
	}
	path := "/api/v1/cards/" + cardID + "/photo"
	if status, out := c.do("GET", path, nil); status != 404 || out["error"] != "not_found" {
		t.Fatalf("no photo yet: %d %v", status, out)
	}
	if status, out := c.do("GET", "/api/v1/cards", nil); status != 200 || out["cards"].([]any)[0].(map[string]any)["photo"] != "" {
		t.Fatalf("list without a photo: %d %v", status, out)
	}

	good := photoJPEG(t)
	b64 := base64.StdEncoding.EncodeToString(good)
	status, out := c.do("PUT", path, map[string]string{"jpeg": b64})
	if status != 200 || out["photo"] != store.PhotoTag(good) {
		t.Fatalf("put: %d %v", status, out)
	}
	if _, out := c.do("GET", "/api/v1/cards", nil); out["cards"].([]any)[0].(map[string]any)["photo"] != store.PhotoTag(good) {
		t.Fatalf("list: %v", out)
	}
	if status, out := c.do("GET", path, nil); status != 200 || out["jpeg"] != b64 || out["photo"] != store.PhotoTag(good) {
		t.Fatalf("get: %d %v", status, out["photo"])
	}

	if status, out := c.do("PUT", path, map[string]string{"jpeg": base64.StdEncoding.EncodeToString(good[:100])}); status != 400 || out["error"] != "bad_photo" {
		t.Fatalf("a bad photo: %d %v", status, out)
	}
	if status, out := c.do("PUT", path, map[string]string{"jpeg": b64, "extra": "x"}); status != 400 || out["error"] != "malformed" {
		t.Fatalf("an unknown field: %d %v", status, out)
	}
	const unknown = "00000000000000000000000000000009"
	if status, out := c.do("PUT", "/api/v1/cards/"+unknown+"/photo", map[string]string{"jpeg": b64}); status != 404 || out["error"] != "not_found" {
		t.Fatalf("an unknown card: %d %v", status, out)
	}

	if status, _ := c.do("DELETE", path, nil); status != 200 {
		t.Fatalf("delete: %d", status)
	}
	if status, _ := c.do("DELETE", path, nil); status != 200 {
		t.Fatalf("delete none: %d", status)
	}
	if status, _ := c.do("GET", path, nil); status != 404 {
		t.Fatalf("after delete: %d", status)
	}

	// A wiped card keeps its photo and refuses changes, as a rename.
	if status, _ := c.do("PUT", path, map[string]string{"jpeg": b64}); status != 200 {
		t.Fatal("put again")
	}
	if _, err := c.st.ActivateCard(ctx, cardID, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := c.st.StartWipe(ctx, cardID); err != nil {
		t.Fatal(err)
	}
	if _, err := c.st.FinishWipe(ctx, cardID); err != nil {
		t.Fatal(err)
	}
	if status, out := c.do("PUT", path, map[string]string{"jpeg": b64}); status != 409 || out["error"] != "conflict" {
		t.Fatalf("put on a wiped card: %d %v", status, out)
	}
	if status, out := c.do("DELETE", path, nil); status != 409 || out["error"] != "conflict" {
		t.Fatalf("delete on a wiped card: %d %v", status, out)
	}
	if status, _ := c.do("GET", path, nil); status != 200 {
		t.Fatalf("a wiped card's photo: %d", status)
	}
}

func vectorsPath() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "testvectors", "vectors.json")
}

// stackCaller signs requests to the docker stack (CARDD_STACK_URL, through
// Caddy) with the test vectors' device key, which the stack test has added.
func stackCaller(t *testing.T, base string) func(method, path string, body any) (int, map[string]any) {
	t.Helper()
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
	key, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), d)
	if err != nil {
		t.Fatal(err)
	}
	hc := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	call := func(method, path string, body any) (int, map[string]any) {
		t.Helper()
		var b []byte
		if body != nil {
			b, _ = json.Marshal(body)
		}
		req, _ := http.NewRequest(method, base+path, bytes.NewReader(b))
		ts := time.Now().Unix()
		digest := sha256.Sum256([]byte(deviceauth.Canonical(method, path, ts, b)))
		sig, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", fmt.Sprintf("Device %s.%d.%x", v.DeviceAuth.KeyID, ts, sig))
		resp, err := hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	return call
}

// The docker stack test (deploy/test/stack-test.sh) runs this against its
// cardd through Caddy, signed with the test vectors' device key, which the
// stack test has added: a card reserved, its photo set, listed and read back.
func TestAStackPhotoRoundTrip(t *testing.T) {
	base := os.Getenv("CARDD_STACK_URL")
	if base == "" {
		t.Skip("CARDD_STACK_URL not set")
	}
	call := stackCaller(t, base)
	const id = "a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7"
	if status, out := call("POST", "/api/v1/cards", map[string]string{"id": id, "name": "Stack"}); status != 200 {
		t.Fatalf("reserve: %d %v", status, out)
	}
	good := photoJPEG(t)
	b64 := base64.StdEncoding.EncodeToString(good)
	if status, out := call("PUT", "/api/v1/cards/"+id+"/photo", map[string]string{"jpeg": b64}); status != 200 || out["photo"] != store.PhotoTag(good) {
		t.Fatalf("put: %d %v", status, out)
	}
	_, out := call("GET", "/api/v1/cards", nil)
	found := false
	for _, c := range out["cards"].([]any) {
		if m := c.(map[string]any); m["id"] == id && m["photo"] == store.PhotoTag(good) {
			found = true
		}
	}
	if !found {
		t.Fatalf("the list has no photo for %s: %v", id, out)
	}
	if status, out := call("GET", "/api/v1/cards/"+id+"/photo", nil); status != 200 || out["jpeg"] != b64 {
		t.Fatalf("get: %d", status)
	}
}
