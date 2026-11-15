package webpush

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func dec(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Inputs and expected body are RFC 8291 section 5 and Appendix A.
func TestEncryptRFC8291Vector(t *testing.T) {
	plaintext := dec(t, "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24")
	if string(plaintext) != "When I grow up, I want to be a watermelon" {
		t.Fatalf("plaintext %q", plaintext)
	}
	sender, err := ecdh.P256().NewPrivateKey(dec(t, "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"))
	if err != nil {
		t.Fatal(err)
	}
	sub := Subscription{
		Endpoint: "https://push.example.net/push/abc",
		P256dh:   dec(t, "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
		Auth:     dec(t, "BTBZMqHH6r4Tts7J_aSIgg"),
	}
	salt := dec(t, "DGv6ra1nlYgDCS1FRnbzlw")
	body, err := encryptWith(sub, plaintext, salt, sender)
	if err != nil {
		t.Fatal(err)
	}
	want := "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
	if got := base64.RawURLEncoding.EncodeToString(body); got != want {
		t.Fatalf("body\n got %s\nwant %s", got, want)
	}
}

// decrypt is the receiver's side of RFC 8291, for the round trip.
func decrypt(t *testing.T, recv *ecdh.PrivateKey, auth, body []byte) []byte {
	t.Helper()
	salt := body[:16]
	idlen := int(body[20])
	senderPub := body[21 : 21+idlen]
	record := body[21+idlen:]
	sp, err := ecdh.P256().NewPublicKey(senderPub)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := recv.ECDH(sp)
	if err != nil {
		t.Fatal(err)
	}
	info := append([]byte("WebPush: info\x00"), recv.PublicKey().Bytes()...)
	info = append(info, senderPub...)
	prk, _ := hkdf.Extract(sha256.New, secret, auth)
	ikm, _ := hkdf.Expand(sha256.New, prk, string(info), 32)
	prk2, _ := hkdf.Extract(sha256.New, ikm, salt)
	cek, _ := hkdf.Expand(sha256.New, prk2, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Expand(sha256.New, prk2, "Content-Encoding: nonce\x00", 12)
	blk, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(blk)
	plain, err := gcm.Open(nil, nonce, record, nil)
	if err != nil {
		t.Fatal(err)
	}
	i := bytes.LastIndexByte(plain, 0x02)
	if i != len(plain)-1 {
		t.Fatalf("padding delimiter not last")
	}
	return plain[:i]
}

func TestEncryptRoundTrip(t *testing.T) {
	recv, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	rand.Read(auth)
	sub := Subscription{Endpoint: "https://push.example.net/x", P256dh: recv.PublicKey().Bytes(), Auth: auth}
	msg := []byte(`{"title":"hello"}`)
	body, err := Encrypt(sub, msg)
	if err != nil {
		t.Fatal(err)
	}
	if got := decrypt(t, recv, auth, body); !bytes.Equal(got, msg) {
		t.Fatalf("got %q", got)
	}
	big := bytes.Repeat([]byte("a"), 3993)
	body, err = Encrypt(sub, big)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) > 4096 {
		t.Fatalf("body %d bytes", len(body))
	}
	if got := decrypt(t, recv, auth, body); !bytes.Equal(got, big) {
		t.Fatal("big round trip differs")
	}
	if _, err := Encrypt(sub, bytes.Repeat([]byte("a"), 3994)); err == nil {
		t.Fatal("3994 bytes should be refused")
	}
}

func TestEncryptRejectsBadSubscription(t *testing.T) {
	if _, err := Encrypt(Subscription{P256dh: []byte{1, 2}, Auth: make([]byte, 16)}, []byte("x")); err == nil {
		t.Fatal("bad key accepted")
	}
	recv, _ := ecdh.P256().GenerateKey(rand.Reader)
	if _, err := Encrypt(Subscription{P256dh: recv.PublicKey().Bytes(), Auth: []byte{1}}, []byte("x")); err == nil {
		t.Fatal("bad auth accepted")
	}
}

func TestVAPIDHeaderVerifies(t *testing.T) {
	v, err := NewVAPID()
	if err != nil {
		t.Fatal(err)
	}
	other, _ := NewVAPID()
	now := time.Now()
	h, err := v.Header("https://fcm.googleapis.com/fcm/send/abc", "mailto:alerts@karto.invalid", now.Add(12*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	aud := "https://fcm.googleapis.com"
	if err := Verify(h, aud, v.PublicKey(), now); err != nil {
		t.Fatal(err)
	}
	if err := Verify(strings.Replace(h, ", k=", ",k=", 1), aud, v.PublicKey(), now); err != nil {
		t.Fatalf("no space: %v", err)
	}
	if Verify(h, "https://other.example", v.PublicKey(), now) == nil {
		t.Fatal("other aud accepted")
	}
	if Verify(h, aud, other.PublicKey(), now) == nil {
		t.Fatal("other key accepted")
	}
	if Verify(h, aud, v.PublicKey(), now.Add(13*time.Hour)) == nil {
		t.Fatal("expired accepted")
	}
	// A token signed by another key but claiming this key must fail.
	h2, _ := other.Header("https://fcm.googleapis.com/x", "mailto:a@b.invalid", now.Add(time.Hour))
	forged := h2[:strings.Index(h2, ", k=")] + ", k=" + v.PublicKey()
	if Verify(forged, aud, v.PublicKey(), now) == nil {
		t.Fatal("forged signature accepted")
	}
	// exp more than 24 h ahead is refused (RFC 8292).
	far, _ := v.Header("https://fcm.googleapis.com/x", "mailto:a@b.invalid", now.Add(25*time.Hour))
	if Verify(far, aud, v.PublicKey(), now) == nil {
		t.Fatal("exp > 24h accepted")
	}
	if Verify("bearer abc", aud, v.PublicKey(), now) == nil {
		t.Fatal("garbage accepted")
	}
}

func TestVAPIDHeaderAudKeepsPort(t *testing.T) {
	v, _ := NewVAPID()
	now := time.Now()
	h, _ := v.Header("http://127.0.0.1:8080/push/1", "mailto:a@b.invalid", now.Add(time.Hour))
	if err := Verify(h, "http://127.0.0.1:8080", v.PublicKey(), now); err != nil {
		t.Fatal(err)
	}
}

func TestVAPIDMarshalRoundTrip(t *testing.T) {
	v, _ := NewVAPID()
	w, err := ParseVAPID(v.Marshal())
	if err != nil {
		t.Fatal(err)
	}
	if w.PublicKey() != v.PublicKey() {
		t.Fatal("public key differs")
	}
	if _, err := ParseVAPID("AAAA"); err == nil {
		t.Fatal("short scalar accepted")
	}
}
