// Package cmac implements AES-128 CMAC (NIST SP 800-38B, RFC 4493).
package cmac

import (
	"crypto/aes"
	"fmt"
)

// Sum returns the 16-byte AES-CMAC of msg under a 16-byte key.
func Sum(key, msg []byte) ([]byte, error) {
	if len(key) != 16 {
		return nil, fmt.Errorf("cmac: key must be 16 bytes, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	l := make([]byte, 16)
	block.Encrypt(l, l)
	k1 := shift(l)
	k2 := shift(k1)

	n := (len(msg) + 15) / 16
	last := make([]byte, 16)
	if n > 0 && len(msg)%16 == 0 {
		copy(last, msg[(n-1)*16:])
		xor(last, k1)
	} else {
		if n == 0 {
			n = 1
		}
		rest := msg[(n-1)*16:]
		copy(last, rest)
		last[len(rest)] = 0x80
		xor(last, k2)
	}
	x := make([]byte, 16)
	for i := 0; i < n-1; i++ {
		xor(x, msg[i*16:(i+1)*16])
		block.Encrypt(x, x)
	}
	xor(x, last)
	block.Encrypt(x, x)
	return x, nil
}

// shift doubles b in GF(2^128): left shift by one bit, then XOR 0x87 if the top bit was set.
func shift(b []byte) []byte {
	r := make([]byte, 16)
	for i := 0; i < 16; i++ {
		r[i] = b[i] << 1
		if i < 15 {
			r[i] |= b[i+1] >> 7
		}
	}
	if b[0]&0x80 != 0 {
		r[15] ^= 0x87
	}
	return r
}

func xor(dst, src []byte) {
	for i := range dst {
		dst[i] ^= src[i]
	}
}
