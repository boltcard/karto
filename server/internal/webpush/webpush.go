// Package webpush encrypts push messages for a browser or UnifiedPush
// subscription (RFC 8291, aes128gcm) and signs them with VAPID (RFC 8292).
// Standard library only.
package webpush

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
)

// recordSize is the record size written in the header; one record holds the
// whole message, so the finished body never exceeds it.
const recordSize = 4096

// Subscription is what the phone registered: where to post, its P-256 public
// key (65-byte uncompressed point) and its 16-byte auth secret.
type Subscription struct {
	Endpoint string
	P256dh   []byte
	Auth     []byte
}

// Encrypt returns the RFC 8291 aes128gcm body for plaintext, with a random
// salt and a fresh sender key.
func Encrypt(sub Subscription, plaintext []byte) ([]byte, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	sender, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return encryptWith(sub, plaintext, salt, sender)
}

// encryptWith is Encrypt with the salt and sender key given, so the RFC's
// test vector can be checked.
func encryptWith(sub Subscription, plaintext, salt []byte, sender *ecdh.PrivateKey) ([]byte, error) {
	if len(sub.Auth) != 16 {
		return nil, errors.New("webpush: auth secret must be 16 bytes")
	}
	if len(salt) != 16 {
		return nil, errors.New("webpush: salt must be 16 bytes")
	}
	uaPub, err := ecdh.P256().NewPublicKey(sub.P256dh)
	if err != nil {
		return nil, fmt.Errorf("webpush: bad p256dh: %w", err)
	}
	secret, err := sender.ECDH(uaPub)
	if err != nil {
		return nil, err
	}
	asPub := sender.PublicKey().Bytes()

	info := append([]byte("WebPush: info\x00"), sub.P256dh...)
	info = append(info, asPub...)
	ikm, err := hkdf.Key(sha256.New, secret, sub.Auth, string(info), 32)
	if err != nil {
		return nil, err
	}
	cek, err := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, err
	}
	blk, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}

	// Header: salt, record size, key id length, key id (the sender key).
	body := make([]byte, 0, recordSize)
	body = append(body, salt...)
	body = binary.BigEndian.AppendUint32(body, recordSize)
	body = append(body, byte(len(asPub)))
	body = append(body, asPub...)

	// One record: the message, then the 0x02 last-record delimiter.
	if len(body)+len(plaintext)+1+gcm.Overhead() > recordSize {
		return nil, errors.New("webpush: message too long for one record")
	}
	record := append(append([]byte{}, plaintext...), 0x02)
	return gcm.Seal(body, nonce, record, nil), nil
}
