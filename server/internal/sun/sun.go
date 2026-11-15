// Package sun decrypts and checks the p= and c= values an NTAG424 Bolt Card
// writes into its URL on every tap (NXP AN12196, Secure Unique NFC).
package sun

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/boltcard/karto/server/internal/cmac"
)

var (
	// ErrNotOurs means p= did not decrypt to PICCData under our K1: the card
	// belongs to another service, or the value is garbage.
	ErrNotOurs = errors.New("sun: card not issued by this server")
	// ErrBadMAC means c= does not match.
	ErrBadMAC = errors.New("sun: bad mac")
	// ErrMalformed means p= or c= has the wrong length or is not hex.
	ErrMalformed = errors.New("sun: malformed p or c")
)

// PICC is the decrypted PICCData.
type PICC struct {
	UID     []byte // 7 bytes
	Counter uint32 // 24-bit SDM read counter
}

// ParseHex decodes p (32 hex chars) and c (16 hex chars). Cards write
// upper-case hex, so case is ignored.
func ParseHex(p, c string) (pb, cb []byte, err error) {
	pb, err1 := hex.DecodeString(strings.ToLower(p))
	cb, err2 := hex.DecodeString(strings.ToLower(c))
	if err1 != nil || err2 != nil || len(pb) != 16 || len(cb) != 8 {
		return nil, nil, ErrMalformed
	}
	return pb, cb, nil
}

// Decrypt decrypts p with K1 (AES-128-CBC, zero IV) and checks the PICCData tag.
func Decrypt(k1, p []byte) (PICC, error) {
	if len(p) != 16 {
		return PICC{}, ErrMalformed
	}
	block, err := aes.NewCipher(k1)
	if err != nil {
		return PICC{}, fmt.Errorf("sun: %w", err)
	}
	d := make([]byte, 16)
	cipher.NewCBCDecrypter(block, make([]byte, 16)).CryptBlocks(d, p)
	if d[0] != 0xc7 {
		return PICC{}, ErrNotOurs
	}
	return PICC{
		UID:     append([]byte(nil), d[1:8]...),
		Counter: uint32(d[8]) | uint32(d[9])<<8 | uint32(d[10])<<16,
	}, nil
}

// MAC computes the 8-byte SUN MAC for this UID and counter under K2.
func MAC(k2, uid []byte, counter uint32) ([]byte, error) {
	sv2 := []byte{0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80}
	sv2 = append(sv2, uid...)
	sv2 = append(sv2, byte(counter), byte(counter>>8), byte(counter>>16))
	session, err := cmac.Sum(k2, sv2)
	if err != nil {
		return nil, err
	}
	full, err := cmac.Sum(session, nil)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 8)
	for i := range out {
		out[i] = full[2*i+1]
	}
	return out, nil
}

// Verify checks c against the MAC for this PICCData under K2.
func Verify(k2 []byte, picc PICC, c []byte) error {
	want, err := MAC(k2, picc.UID, picc.Counter)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare(want, c) != 1 {
		return ErrBadMAC
	}
	return nil
}

// Build produces the p and c a card with these keys would write for this
// counter. random fills PICCData bytes 11..15. Used by tests and fakes.
func Build(k1, k2, uid []byte, counter uint32, random [5]byte) (p, c []byte, err error) {
	d := []byte{0xc7}
	d = append(d, uid...)
	d = append(d, byte(counter), byte(counter>>8), byte(counter>>16))
	d = append(d, random[:]...)
	block, err := aes.NewCipher(k1)
	if err != nil {
		return nil, nil, err
	}
	p = make([]byte, 16)
	cipher.NewCBCEncrypter(block, make([]byte, 16)).CryptBlocks(p, d)
	c, err = MAC(k2, uid, counter)
	return p, c, err
}
