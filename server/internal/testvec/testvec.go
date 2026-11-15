// Package testvec loads the shared test vectors in testvectors/vectors.json.
package testvec

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type Vectors struct {
	Phrase struct {
		BackupAgeIdentity  string `json:"backupAgeIdentity"`
		BackupAgeRecipient string `json:"backupAgeRecipient"`
	} `json:"phrase"`
	Deterministic struct {
		IssuerKey string            `json:"issuerKey"`
		UID       string            `json:"uid"`
		Version   uint32            `json:"version"`
		Expected  map[string]string `json:"expected"`
	} `json:"deterministic"`
	Sun []struct {
		Name    string `json:"name"`
		K1      string `json:"k1"`
		K2      string `json:"k2"`
		P       string `json:"p"`
		C       string `json:"c"`
		UID     string `json:"uid"`
		Counter uint32 `json:"counter"`
	} `json:"sun"`
	DeviceAuth struct {
		PublicKey    string `json:"publicKey"`
		KeyID        string `json:"keyId"`
		Method       string `json:"method"`
		Path         string `json:"path"`
		TS           int64  `json:"ts"`
		Body         string `json:"body"`
		Canonical    string `json:"canonical"`
		SignatureDer string `json:"signatureDer"`
	} `json:"deviceAuth"`
}

// Load reads testvectors/vectors.json from the repository root.
func Load(t testing.TB) Vectors {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(file), "..", "..", "..", "testvectors", "vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v Vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return v
}

// Hex decodes s or fails the test.
func Hex(t testing.TB, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}
