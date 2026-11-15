package backup_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"filippo.io/age"

	"github.com/boltcard/karto/server/internal/testvec"
)

// ageVectors are files encrypted by filippo.io/age to the phrase vector's
// backup recipient, which the app's own age decryption must open:
// empty, short, one byte over a 64 KiB chunk, and
// exactly two chunks. The plaintext's byte i is i % 251.
type ageVectors struct {
	Recipient string `json:"recipient"`
	Files     []struct {
		Length int    `json:"length"`
		SHA256 string `json:"sha256"`
		Age    string `json:"age"` // base64
	} `json:"files"`
}

func pattern(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i % 251)
	}
	return b
}

func ageVectorsPath() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "testvectors", "age.json")
}

// CARDD_WRITE_AGE_VECTORS=1 writes testvectors/age.json (age encryption is
// randomised, so the file is made once); every run checks it opens here too.
func TestAgeVectors(t *testing.T) {
	v := testvec.Load(t).Phrase
	if os.Getenv("CARDD_WRITE_AGE_VECTORS") == "1" {
		rcpt, err := age.ParseX25519Recipient(v.BackupAgeRecipient)
		if err != nil {
			t.Fatal(err)
		}
		out := ageVectors{Recipient: v.BackupAgeRecipient}
		for _, n := range []int{0, 15, 65537, 131072} {
			var buf bytes.Buffer
			w, _ := age.Encrypt(&buf, rcpt)
			w.Write(pattern(n))
			w.Close()
			sum := sha256.Sum256(pattern(n))
			out.Files = append(out.Files, struct {
				Length int    `json:"length"`
				SHA256 string `json:"sha256"`
				Age    string `json:"age"`
			}{n, hex.EncodeToString(sum[:]), base64.StdEncoding.EncodeToString(buf.Bytes())})
		}
		raw, _ := json.MarshalIndent(out, "", "  ")
		if err := os.WriteFile(ageVectorsPath(), append(raw, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(ageVectorsPath())
	if err != nil {
		t.Fatal(err)
	}
	var vs ageVectors
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatal(err)
	}
	id, _ := age.ParseX25519Identity(v.BackupAgeIdentity)
	if vs.Recipient != v.BackupAgeRecipient || len(vs.Files) != 4 {
		t.Fatalf("%s, %d files", vs.Recipient, len(vs.Files))
	}
	for _, f := range vs.Files {
		enc, _ := base64.StdEncoding.DecodeString(f.Age)
		r, err := age.Decrypt(bytes.NewReader(enc), id)
		if err != nil {
			t.Fatal(err)
		}
		plain, _ := io.ReadAll(r)
		if !bytes.Equal(plain, pattern(f.Length)) {
			t.Fatalf("%d bytes: wrong plaintext", f.Length)
		}
	}
}
