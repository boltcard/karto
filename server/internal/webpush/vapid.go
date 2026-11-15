package webpush

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"strings"
	"time"
)

var b64 = base64.RawURLEncoding

// VAPID is the server's identity towards push services (RFC 8292).
type VAPID struct {
	Private *ecdsa.PrivateKey
}

// NewVAPID makes a fresh P-256 key.
func NewVAPID() (VAPID, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return VAPID{}, err
	}
	return VAPID{Private: k}, nil
}

// ParseVAPID reads what Marshal wrote.
func ParseVAPID(s string) (VAPID, error) {
	raw, err := b64.DecodeString(s)
	if err != nil {
		return VAPID{}, err
	}
	if len(raw) != 32 {
		return VAPID{}, errors.New("webpush: VAPID key must be 32 bytes")
	}
	ek, err := ecdh.P256().NewPrivateKey(raw)
	if err != nil {
		return VAPID{}, err
	}
	pub := ek.PublicKey().Bytes()
	k := &ecdsa.PrivateKey{D: new(big.Int).SetBytes(raw)}
	k.Curve = elliptic.P256()
	k.X = new(big.Int).SetBytes(pub[1:33])
	k.Y = new(big.Int).SetBytes(pub[33:65])
	return VAPID{Private: k}, nil
}

// Marshal is the base64url of the 32-byte private scalar.
func (v VAPID) Marshal() string {
	return b64.EncodeToString(v.Private.D.FillBytes(make([]byte, 32)))
}

// PublicKey is the base64url of the 65-byte uncompressed point, as push
// services and the UnifiedPush vapid extra want it.
func (v VAPID) PublicKey() string {
	return b64.EncodeToString(point(&v.Private.PublicKey))
}

func point(p *ecdsa.PublicKey) []byte {
	out := make([]byte, 65)
	out[0] = 4
	p.X.FillBytes(out[1:33])
	p.Y.FillBytes(out[33:65])
	return out
}

// audience is the endpoint's scheme://host[:port], no path.
func audience(endpoint string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("webpush: bad endpoint %q", endpoint)
	}
	return u.Scheme + "://" + u.Host, nil
}

// Header returns the Authorization value "vapid t=<ES256 JWT>, k=<key>".
func (v VAPID) Header(endpoint, subject string, exp time.Time) (string, error) {
	aud, err := audience(endpoint)
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(map[string]any{"aud": aud, "exp": exp.Unix(), "sub": subject})
	if err != nil {
		return "", err
	}
	signing := b64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`)) + "." + b64.EncodeToString(claims)
	digest := sha256.Sum256([]byte(signing))
	r, s, err := ecdsa.Sign(rand.Reader, v.Private, digest[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return "vapid t=" + signing + "." + b64.EncodeToString(sig) + ", k=" + v.PublicKey(), nil
}

// Verify checks a header made by Header: the key is wantKey, the signature
// holds, aud is wantAud, and exp is in the future but no more than 24 hours
// ahead (RFC 8292 section 2).
func Verify(header, wantAud string, wantKey string, now time.Time) error {
	rest, ok := strings.CutPrefix(header, "vapid ")
	if !ok {
		return errors.New("webpush: not a vapid header")
	}
	var token, key string
	for _, part := range strings.Split(rest, ",") {
		part = strings.TrimSpace(part)
		if v, ok := strings.CutPrefix(part, "t="); ok {
			token = v
		} else if v, ok := strings.CutPrefix(part, "k="); ok {
			key = v
		}
	}
	if token == "" || key == "" {
		return errors.New("webpush: vapid header lacks t or k")
	}
	if key != wantKey {
		return errors.New("webpush: wrong VAPID key")
	}
	raw, err := b64.DecodeString(key)
	if err != nil {
		return err
	}
	pub, err := ecdh.P256().NewPublicKey(raw)
	if err != nil {
		return fmt.Errorf("webpush: bad VAPID key: %w", err)
	}
	pb := pub.Bytes()
	pk := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(pb[1:33]), Y: new(big.Int).SetBytes(pb[33:65])}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return errors.New("webpush: malformed JWT")
	}
	hdr, err := b64.DecodeString(parts[0])
	if err != nil {
		return err
	}
	var h struct{ Alg string }
	if json.Unmarshal(hdr, &h) != nil || h.Alg != "ES256" {
		return errors.New("webpush: JWT is not ES256")
	}
	sig, err := b64.DecodeString(parts[2])
	if err != nil || len(sig) != 64 {
		return errors.New("webpush: bad JWT signature")
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(pk, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		return errors.New("webpush: JWT signature does not verify")
	}
	cb, err := b64.DecodeString(parts[1])
	if err != nil {
		return err
	}
	var c struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
	}
	if err := json.Unmarshal(cb, &c); err != nil {
		return err
	}
	if c.Aud != wantAud {
		return errors.New("webpush: wrong aud")
	}
	exp := time.Unix(c.Exp, 0)
	if !exp.After(now) {
		return errors.New("webpush: JWT expired")
	}
	if exp.After(now.Add(24 * time.Hour)) {
		return errors.New("webpush: JWT exp more than 24 hours ahead")
	}
	return nil
}
