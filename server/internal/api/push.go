package api

import (
	"crypto/ecdh"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/boltcard/karto/server/internal/alerts"
	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/webpush"
)

// The push API: an owner phone registers where its alerts are
// pushed, reads how that stands and sends itself a test alert. PoS phones
// are held to /api/v1/pos/ by deviceauth, so only owners get here.

type pushEndpointJSON struct {
	Transport   string `json:"transport"`
	Origin      string `json:"origin"` // the endpoint's scheme, host and port; its path is a secret
	CreatedAt   int64  `json:"createdAt"`
	DeliveredAt *int64 `json:"deliveredAt"`
	FailedAt    *int64 `json:"failedAt"`
	Failure     string `json:"failure"`
	Failures    int    `json:"failures"`
}

type pushJSON struct {
	VAPIDPublicKey string            `json:"vapidPublicKey"`
	Ntfy           string            `json:"ntfy"`
	Endpoint       *pushEndpointJSON `json:"endpoint"`
}

func unixPtr(t *time.Time) *int64 {
	if t == nil {
		return nil
	}
	u := t.Unix()
	return &u
}

func (a *api) pushState(r *http.Request) (pushJSON, error) {
	ctx := r.Context()
	key, err := a.money.Store.VAPIDKey(ctx)
	if err != nil {
		return pushJSON{}, err
	}
	v, err := webpush.ParseVAPID(key)
	if err != nil {
		return pushJSON{}, err
	}
	out := pushJSON{VAPIDPublicKey: v.PublicKey(), Ntfy: a.money.Push.NtfyPublic}
	ep, err := a.money.Store.PushEndpointOf(ctx, deviceauth.DeviceID(ctx))
	if errors.Is(err, store.ErrNotFound) {
		return out, nil
	}
	if err != nil {
		return pushJSON{}, err
	}
	origin := ""
	if u, err := url.Parse(ep.Endpoint); err == nil {
		origin = u.Scheme + "://" + u.Host
	}
	out.Endpoint = &pushEndpointJSON{Transport: ep.Transport, Origin: origin, CreatedAt: ep.CreatedAt.Unix(),
		DeliveredAt: unixPtr(ep.DeliveredAt), FailedAt: unixPtr(ep.FailedAt), Failure: ep.Failure, Failures: ep.Failures}
	return out, nil
}

func (a *api) pushGet(w http.ResponseWriter, r *http.Request) {
	out, err := a.pushState(r)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func badPush(w http.ResponseWriter, code, msg string) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": code, "message": msg})
}

// pushKey reads a base64url key of n bytes (padding allowed) and returns it
// in the unpadded form the store keeps.
func pushKey(s string, n int) (string, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
	if err != nil || len(raw) != n {
		return "", false
	}
	return base64.RawURLEncoding.EncodeToString(raw), true
}

func (a *api) pushPut(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Endpoint  string `json:"endpoint"`
		P256dh    string `json:"p256dh"`
		Auth      string `json:"auth"`
		Transport string `json:"transport"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Transport != "unifiedpush" && in.Transport != "fcm" {
		badPush(w, "bad_transport", "transport must be unifiedpush or fcm")
		return
	}
	switch err := alerts.CheckEndpoint(in.Endpoint, a.money.Push.NtfyPublic); {
	case errors.Is(err, alerts.ErrNtfySh):
		badPush(w, "ntfy_sh", err.Error())
		return
	case err != nil:
		badPush(w, "bad_endpoint", err.Error())
		return
	}
	p256dh, ok1 := pushKey(in.P256dh, 65)
	if ok1 {
		_, err := ecdh.P256().NewPublicKey(mustDecode(p256dh))
		ok1 = err == nil
	}
	auth, ok2 := pushKey(in.Auth, 16)
	if !ok1 || !ok2 {
		badPush(w, "bad_keys", "p256dh must be a 65-byte P-256 point and auth 16 bytes, base64url")
		return
	}
	ctx := r.Context()
	if err := a.money.Store.SetPushEndpoint(ctx, store.PushEndpoint{KeyID: deviceauth.DeviceID(ctx),
		Endpoint: in.Endpoint, P256dh: p256dh, Auth: auth, Transport: in.Transport}); err != nil {
		writeError(w, err)
		return
	}
	a.pushGet(w, r)
}

func mustDecode(s string) []byte {
	b, _ := base64.RawURLEncoding.DecodeString(s)
	return b
}

func (a *api) pushDelete(w http.ResponseWriter, r *http.Request) {
	if err := a.money.Store.DeletePushEndpoint(r.Context(), deviceauth.DeviceID(r.Context())); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) pushTest(w http.ResponseWriter, r *http.Request) {
	err := a.money.Push.Test(r.Context(), deviceauth.DeviceID(r.Context()))
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, map[string]bool{"delivered": true})
	case errors.Is(err, store.ErrNotFound):
		writeError(w, err)
	default:
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "push_failed", "detail": err.Error()})
	}
}
