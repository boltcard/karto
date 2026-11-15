package sun

import (
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/boltcard/karto/server/internal/testvec"
)

func TestVectors(t *testing.T) {
	for _, v := range testvec.Load(t).Sun {
		t.Run(v.Name, func(t *testing.T) {
			p, c, err := ParseHex(strings.ToUpper(v.P), strings.ToUpper(v.C))
			if err != nil {
				t.Fatal(err)
			}
			picc, err := Decrypt(testvec.Hex(t, v.K1), p)
			if err != nil {
				t.Fatal(err)
			}
			if hex.EncodeToString(picc.UID) != v.UID || picc.Counter != v.Counter {
				t.Fatalf("got uid %x counter %d, want %s %d", picc.UID, picc.Counter, v.UID, v.Counter)
			}
			if err := Verify(testvec.Hex(t, v.K2), picc, c); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTamperedMACFails(t *testing.T) {
	v := testvec.Load(t).Sun[0]
	p, c, _ := ParseHex(v.P, v.C)
	c[0] ^= 1
	picc, _ := Decrypt(testvec.Hex(t, v.K1), p)
	if err := Verify(testvec.Hex(t, v.K2), picc, c); !errors.Is(err, ErrBadMAC) {
		t.Fatalf("got %v, want ErrBadMAC", err)
	}
}

func TestWrongK1IsNotOurs(t *testing.T) {
	v := testvec.Load(t).Sun[0]
	p, _, _ := ParseHex(v.P, v.C)
	wrong := make([]byte, 16)
	wrong[0] = 1
	if _, err := Decrypt(wrong, p); !errors.Is(err, ErrNotOurs) {
		t.Fatalf("got %v, want ErrNotOurs", err)
	}
}

func TestMalformedInput(t *testing.T) {
	for _, in := range [][2]string{
		{"ef963ff7828658a599f3041510671e", "94eed9ee65337086"},   // p too short
		{"ef963ff7828658a599f3041510671e88", "94eed9ee653370"},   // c too short
		{"zz963ff7828658a599f3041510671e88", "94eed9ee65337086"}, // not hex
		{"", ""},
	} {
		if _, _, err := ParseHex(in[0], in[1]); !errors.Is(err, ErrMalformed) {
			t.Errorf("ParseHex(%q, %q) = %v, want ErrMalformed", in[0], in[1], err)
		}
	}
}

func TestBuildRoundTrip(t *testing.T) {
	v := testvec.Load(t).Sun[1]
	p, c, err := Build(testvec.Hex(t, v.K1), testvec.Hex(t, v.K2), testvec.Hex(t, v.UID), v.Counter, [5]byte{1, 2, 3, 4, 5})
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(p) != v.P || hex.EncodeToString(c) != v.C {
		t.Fatalf("got p=%x c=%x, want %s %s", p, c, v.P, v.C)
	}
}
