package api

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/backup"
	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/testvec"
)

// raw sends a signed GET and returns the reply's bytes.
func (c *client) raw(path string) (int, []byte) {
	c.t.Helper()
	req, _ := http.NewRequest("GET", c.srv.URL+path, nil)
	ts := time.Now().Unix()
	digest := sha256.Sum256([]byte(deviceauth.Canonical("GET", path, ts, nil)))
	sig, _ := ecdsa.SignASN1(rand.Reader, c.key, digest[:])
	req.Header.Set("Authorization", fmt.Sprintf("Device %s.%d.%x", c.keyID, ts, sig))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func TestBackupsAPI(t *testing.T) {
	ctx := context.Background()
	var snap *backup.Snapshotter
	c := setupWith(t, func(st *store.Store) *backup.Snapshotter {
		snap = &backup.Snapshotter{Store: st, Dir: filepath.Join(t.TempDir(), "backups"), Now: time.Now, Log: log.New(io.Discard, "", 0)}
		return snap
	})
	status, out := c.do("GET", "/api/v1/backups", nil)
	if status != 200 || out["latest"] != nil || len(out["installId"].(string)) != 32 || out["lastCheckIn"] != 0.0 {
		t.Fatalf("before a snapshot: %d %v", status, out)
	}
	c.st.SetMeta(ctx, "backup.recipient", testvec.Load(t).Phrase.BackupAgeRecipient)
	if made, err := snap.Take(ctx); !made || err != nil {
		t.Fatalf("take: %v %v", made, err)
	}
	_, out = c.do("GET", "/api/v1/backups", nil)
	if out["lastCheckIn"].(float64) < float64(time.Now().Unix()-5) {
		t.Fatalf("the check-in before wasn't recorded: %v", out)
	}
	latest := out["latest"].(map[string]any)
	if latest["version"] != 1.0 || out["recipient"] != testvec.Load(t).Phrase.BackupAgeRecipient || out["lastDownload"] != 0.0 {
		t.Fatalf("after a snapshot: %v", out)
	}
	status, file := c.raw("/api/v1/backups/1")
	sum := sha256.Sum256(file)
	if status != 200 || float64(len(file)) != latest["size"] || hex.EncodeToString(sum[:]) != latest["sha256"] {
		t.Fatalf("file: %d, %d bytes", status, len(file))
	}
	if _, out = c.do("GET", "/api/v1/backups", nil); out["lastDownload"].(float64) < float64(time.Now().Unix()-5) {
		t.Fatalf("no download recorded: %v", out)
	}
	for _, path := range []string{"/api/v1/backups/2", "/api/v1/backups/0", "/api/v1/backups/-1", "/api/v1/backups/x"} {
		if status, _ := c.raw(path); status != 404 {
			t.Fatalf("%s: %d", path, status)
		}
	}
	resp, _ := http.Get(c.srv.URL + "/api/v1/backups/1")
	if resp.StatusCode != 401 {
		t.Fatalf("unsigned: %d", resp.StatusCode)
	}
}
