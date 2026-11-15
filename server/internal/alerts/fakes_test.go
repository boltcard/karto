package alerts

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/webpush"
)

// fakeStore is the slice of the store the sender uses, in memory.
type fakeStore struct {
	mu        sync.Mutex
	lines     map[int64]posted
	cards     map[string]store.Card
	currency  string
	endpoints map[string]store.PushEndpoint
	delivered map[string]int
	failed    map[string][]string
	deleted   []string
	vapid     string
	// endpointsErr, when set, is what OwnerPushEndpoints fails with.
	endpointsErr error
}

type posted struct {
	line store.Line
	acct store.Account
}

func newFakeStore(t *testing.T) *fakeStore {
	t.Helper()
	k, err := webpush.NewVAPID()
	if err != nil {
		t.Fatal(err)
	}
	return &fakeStore{
		lines:     map[int64]posted{},
		cards:     map[string]store.Card{},
		endpoints: map[string]store.PushEndpoint{},
		delivered: map[string]int{},
		failed:    map[string][]string{},
		vapid:     k.Marshal(),
	}
}

func (f *fakeStore) PostedLine(_ context.Context, id int64) (store.Line, store.Account, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, ok := f.lines[id]
	if !ok {
		return store.Line{}, "", store.ErrNotFound
	}
	return p.line, p.acct, nil
}

func (f *fakeStore) GetCard(_ context.Context, id string) (store.Card, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.cards[id]
	if !ok {
		return store.Card{}, store.ErrNotFound
	}
	return c, nil
}

func (f *fakeStore) Currency(context.Context) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.currency, f.currency != "", nil
}

func (f *fakeStore) PushEndpointOf(_ context.Context, keyID string) (store.PushEndpoint, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e, ok := f.endpoints[keyID]
	if !ok {
		return store.PushEndpoint{}, store.ErrNotFound
	}
	return e, nil
}

func (f *fakeStore) OwnerPushEndpoints(context.Context) ([]store.PushEndpoint, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.endpointsErr != nil {
		return nil, f.endpointsErr
	}
	var out []store.PushEndpoint
	for _, e := range f.endpoints {
		out = append(out, e)
	}
	return out, nil
}

func (f *fakeStore) DeletePushEndpoint(_ context.Context, keyID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.endpoints, keyID)
	f.deleted = append(f.deleted, keyID)
	return nil
}

func (f *fakeStore) PushDelivered(_ context.Context, keyID string, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.delivered[keyID]++
	return nil
}

func (f *fakeStore) PushFailed(_ context.Context, keyID string, _ time.Time, why string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failed[keyID] = append(f.failed[keyID], why)
	return nil
}

func (f *fakeStore) VAPIDKey(context.Context) (string, error) { return f.vapid, nil }

func (f *fakeStore) post(id int64, acct store.Account, l store.Line) {
	f.mu.Lock()
	defer f.mu.Unlock()
	l.ID = id
	f.lines[id] = posted{l, acct}
}

func (f *fakeStore) counts(keyID string) (delivered, failed int, deleted bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, d := range f.deleted {
		if d == keyID {
			deleted = true
		}
	}
	return f.delivered[keyID], len(f.failed[keyID]), deleted
}

// phone is a push subscription's receiving end: its keys, to decrypt what
// was sent to it.
type phone struct {
	key  *ecdh.PrivateKey
	auth []byte
}

func newPhone(t *testing.T) phone {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	rand.Read(auth)
	return phone{k, auth}
}

func (p phone) endpoint(keyID, url string) store.PushEndpoint {
	b := base64.RawURLEncoding
	return store.PushEndpoint{KeyID: keyID, Endpoint: url, P256dh: b.EncodeToString(p.key.PublicKey().Bytes()), Auth: b.EncodeToString(p.auth), Transport: "unifiedpush"}
}

// open decrypts an aes128gcm body (RFC 8291) sent to p.
func (p phone) open(body []byte) ([]byte, error) {
	if len(body) < 21 {
		return nil, fmt.Errorf("body of %d bytes", len(body))
	}
	salt := body[:16]
	idlen := int(body[20])
	senderPub := body[21 : 21+idlen]
	record := body[21+idlen:]
	sp, err := ecdh.P256().NewPublicKey(senderPub)
	if err != nil {
		return nil, err
	}
	secret, err := p.key.ECDH(sp)
	if err != nil {
		return nil, err
	}
	info := append([]byte("WebPush: info\x00"), p.key.PublicKey().Bytes()...)
	info = append(info, senderPub...)
	ikm, _ := hkdf.Key(sha256.New, secret, p.auth, string(info), 32)
	cek, _ := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Key(sha256.New, ikm, salt, "Content-Encoding: nonce\x00", 12)
	blk, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(blk)
	plain, err := gcm.Open(nil, nonce, record, nil)
	if err != nil {
		return nil, err
	}
	i := bytes.LastIndexByte(plain, 0x02)
	if i != len(plain)-1 {
		return nil, fmt.Errorf("no last-record delimiter")
	}
	return plain[:i], nil
}
