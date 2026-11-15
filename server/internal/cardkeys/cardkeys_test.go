package cardkeys

import (
	"encoding/hex"
	"testing"

	"github.com/boltcard/karto/server/internal/testvec"
)

func TestDeterministicVector(t *testing.T) {
	v := testvec.Load(t).Deterministic
	k, err := Derive(testvec.Hex(t, v.IssuerKey), testvec.Hex(t, v.UID), v.Version)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][]byte{"k0": k.K0, "k1": k.K1, "k2": k.K2, "k3": k.K3, "k4": k.K4, "id": k.ID, "cardKey": k.CardKey}
	for name, want := range v.Expected {
		if hex.EncodeToString(got[name]) != want {
			t.Errorf("%s: got %x, want %s", name, got[name], want)
		}
	}
}

func TestVersionChangesKeysButNotK1OrID(t *testing.T) {
	issuer := make([]byte, 16)
	uid := []byte{4, 1, 2, 3, 4, 5, 6}
	a, _ := Derive(issuer, uid, 0)
	b, _ := Derive(issuer, uid, 1)
	if hex.EncodeToString(a.K0) == hex.EncodeToString(b.K0) {
		t.Error("K0 should change with version")
	}
	if hex.EncodeToString(a.K1) != hex.EncodeToString(b.K1) || hex.EncodeToString(a.ID) != hex.EncodeToString(b.ID) {
		t.Error("K1 and ID must not depend on version")
	}
}

func TestRejectsBadUIDLength(t *testing.T) {
	if _, err := Derive(make([]byte, 16), make([]byte, 4), 0); err == nil {
		t.Fatal("expected error for 4-byte uid")
	}
}
