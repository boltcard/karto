// Package deviceauth checks the signature every app request carries:
//
//	Authorization: Device <key id>.<unix ts>.<hex DER ECDSA P-256 signature>
//
// signed over Canonical(method, path, ts, body) with SHA-256.
//
// A device is an owner (a phone running Karto Wallet) or a PoS phone,
// and the middleware keeps a PoS phone to the paths under
// PosPrefix.
package deviceauth

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
)

const (
	MaxSkew     = 60 * time.Second
	MaxBodySize = 1 << 20
)

var (
	ErrMissing       = errors.New("deviceauth: missing or malformed Authorization header")
	ErrSkew          = errors.New("deviceauth: timestamp outside allowed window")
	ErrUnknownDevice = errors.New("deviceauth: unknown or revoked device")
	ErrBadSignature  = errors.New("deviceauth: bad signature")
	ErrReplayed      = errors.New("deviceauth: this signature was already used")
)

// Canonical is the exact string a device signs. path is the request URI
// (path plus ?query if present).
func Canonical(method, path string, ts int64, body []byte) string {
	sum := sha256.Sum256(body)
	return fmt.Sprintf("%s\n%s\n%d\n%s", method, path, ts, hex.EncodeToString(sum[:]))
}

// KeyID is the first 16 hex characters of SHA-256 of the uncompressed public key.
func KeyID(uncompressed []byte) string {
	sum := sha256.Sum256(uncompressed)
	return hex.EncodeToString(sum[:])[:16]
}

// ParsePublicKey parses a hex uncompressed P-256 point (65 bytes, 0x04 prefix).
func ParsePublicKey(hexKey string) (*ecdsa.PublicKey, []byte, error) {
	raw, err := hex.DecodeString(hexKey)
	if err != nil {
		return nil, nil, fmt.Errorf("public key: %w", err)
	}
	pub, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), raw)
	if err != nil {
		return nil, nil, fmt.Errorf("public key: %w", err)
	}
	return pub, raw, nil
}

// Role is what a device may call: an Owner everything, a Pos phone only the
// paths under PosPrefix.
type Role string

const (
	Owner Role = "owner"
	Pos   Role = "pos"
)

// PosPrefix is where a PoS phone's routes live. The rule is the path's
// prefix, checked here before any handler is looked for, so a route added
// anywhere else under /api/v1/ is closed to PoS phones without anyone having
// to remember to close it (Go's ServeMux can't list its routes, so a list
// kept route by route couldn't be proved complete).
const PosPrefix = "/api/v1/pos/"

// Lookup returns the public key and the role for a key id, or
// ErrUnknownDevice if the device is unknown or revoked.
type Lookup func(ctx context.Context, keyID string) (*ecdsa.PublicKey, Role, error)

// Seen records a signature's hash until expires and reports whether it was
// new (store.Store.SeeSignature).
type Seen func(ctx context.Context, hash string, expires time.Time) (bool, error)

type Verifier struct {
	Lookup Lookup
	Now    func() time.Time
	// Seen, if set, refuses a signature that was already accepted:
	// each one is remembered for twice MaxSkew, longer than its
	// timestamp stays acceptable.
	Seen Seen
}

// replayKey identifies a signature however it is encoded: (r, s) and
// (r, n-s) are both valid, and cardd accepts high-S (the Keystore makes
// them), so s is folded to its low form before hashing.
func replayKey(keyID string, sig []byte) (string, error) {
	var rs struct{ R, S *big.Int }
	if _, err := asn1.Unmarshal(sig, &rs); err != nil {
		return "", ErrMissing
	}
	n := elliptic.P256().Params().N
	if rs.S.Cmp(new(big.Int).Rsh(n, 1)) > 0 {
		rs.S = new(big.Int).Sub(n, rs.S)
	}
	h := sha256.New()
	h.Write([]byte(keyID))
	h.Write(rs.R.FillBytes(make([]byte, 32)))
	h.Write(rs.S.FillBytes(make([]byte, 32)))
	return hex.EncodeToString(h.Sum(nil)), nil
}

type ctxKey struct{}

// device is who the middleware authenticated.
type device struct {
	id   string
	role Role
}

// DeviceID returns the key id the middleware authenticated.
func DeviceID(ctx context.Context) string {
	d, _ := ctx.Value(ctxKey{}).(device)
	return d.id
}

// RoleOf returns the role of the device the middleware authenticated.
func RoleOf(ctx context.Context) Role {
	d, _ := ctx.Value(ctxKey{}).(device)
	return d.role
}

// Verify checks one request whose body has already been read, and returns
// the device's key id and role.
func (v *Verifier) Verify(ctx context.Context, header, method, path string, body []byte) (string, Role, error) {
	rest, ok := strings.CutPrefix(header, "Device ")
	if !ok {
		return "", "", ErrMissing
	}
	parts := strings.Split(rest, ".")
	if len(parts) != 3 {
		return "", "", ErrMissing
	}
	ts, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return "", "", ErrMissing
	}
	sig, err := hex.DecodeString(parts[2])
	if err != nil {
		return "", "", ErrMissing
	}
	now := v.Now()
	if d := now.Sub(time.Unix(ts, 0)); d > MaxSkew || d < -MaxSkew {
		return "", "", ErrSkew
	}
	pub, role, err := v.Lookup(ctx, parts[0])
	if err != nil {
		return "", "", err
	}
	digest := sha256.Sum256([]byte(Canonical(method, path, ts, body)))
	if !ecdsa.VerifyASN1(pub, digest[:], sig) {
		return "", "", ErrBadSignature
	}
	if v.Seen != nil {
		key, err := replayKey(parts[0], sig)
		if err != nil {
			return "", "", err
		}
		fresh, err := v.Seen(ctx, key, now.Add(2*MaxSkew))
		if err != nil {
			return "", "", err
		}
		if !fresh {
			return "", "", ErrReplayed
		}
	}
	return parts[0], role, nil
}

// allowed reports whether a device of this role may call urlPath at all.
// Only an owner is let past by default: any role but Owner is held to
// PosPrefix, and to a path that is already clean, so no "..", "." or doubled
// slash can lead out of the prefix whatever a later handler makes of it.
func allowed(role Role, urlPath string) bool {
	if role == Owner {
		return true
	}
	return strings.HasPrefix(urlPath, PosPrefix) && path.Clean(urlPath) == urlPath
}

// Middleware rejects unauthenticated requests with 401 and a JSON error, and
// a PoS phone's request for anything outside PosPrefix with 403.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBodySize))
		if err != nil {
			http.Error(w, `{"error":"body_too_large"}`, http.StatusRequestEntityTooLarge)
			return
		}
		id, role, err := v.Verify(r.Context(), r.Header.Get("Authorization"), r.Method, r.URL.RequestURI(), body)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprintf(w, `{"error":"unauthorized","message":%q}`, err.Error())
			return
		}
		if !allowed(role, r.URL.Path) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			io.WriteString(w, `{"error":"not_allowed","message":"a PoS phone can't do this"}`)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, device{id, role})))
	})
}
