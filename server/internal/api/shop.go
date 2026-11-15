package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/store"
)

// The shop as its owner manages it: pairing codes and the
// PoS phones. None of this is under deviceauth.PosPrefix, so no PoS phone
// reaches it.

// posCodeLifetime is how long a pairing code is good for.
const posCodeLifetime = 10 * time.Minute

func (a *api) shopRoutes(v1 *http.ServeMux) {
	v1.HandleFunc("POST /api/v1/shop/codes", a.newPosCode)
	v1.HandleFunc("DELETE /api/v1/shop/codes", a.dropPosCodes)
	v1.HandleFunc("GET /api/v1/shop/phones", a.posPhones)
	v1.HandleFunc("PATCH /api/v1/shop/phones/{keyId}", a.renamePosPhone)
	v1.HandleFunc("DELETE /api/v1/shop/phones/{keyId}", a.removePosPhone)
}

// codeHash is what cardd keeps of a pairing code.
func codeHash(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

var posCodePattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// newPosCode opens a pairing code for a phone to be called name: 16 random
// bytes, shown once, of which cardd keeps only the hash.
func (a *api) newPosCode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	b := make([]byte, 16)
	rand.Read(b)
	code := hex.EncodeToString(b)
	expires := time.Now().Add(posCodeLifetime)
	if err := a.money.Store.NewPosCode(r.Context(), codeHash(code), req.Name, expires); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"code": code, "expires": expires.Unix()})
}

func (a *api) dropPosCodes(w http.ResponseWriter, r *http.Request) {
	if err := a.money.Store.DropPosCodes(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// posPair is the one call a phone makes before it is a device: public, with
// no device signature, the code its only credential. Every failure of the
// code answers alike.
func (a *api) posPair(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code      string `json:"code"`
		PublicKey string `json:"publicKey"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed", "message": err.Error()})
		return
	}
	if !posCodePattern.MatchString(req.Code) {
		writeError(w, store.ErrBadCode)
		return
	}
	_, raw, err := deviceauth.ParsePublicKey(strings.ToLower(strings.TrimSpace(req.PublicKey)))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed", "message": err.Error()})
		return
	}
	d, err := a.money.Store.PairPos(r.Context(), codeHash(req.Code), deviceauth.KeyID(raw), hex.EncodeToString(raw))
	if err != nil {
		writeError(w, err)
		return
	}
	// In the log for the day a phone the person doesn't recognise is in the list.
	a.money.logf("shop: paired PoS phone %s as %q", d.KeyID, d.Name)
	// The wallet's name, so the till shows whose it is from its first screen; a failure to read it costs the
	// till nothing but the name, which its next read of /pos/me brings.
	wallet, _ := a.money.Store.WalletName(r.Context())
	writeJSON(w, http.StatusCreated, map[string]any{"keyId": d.KeyID, "name": d.Name, "wallet": wallet})
}

func (a *api) posPhones(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	list, err := a.money.Store.PosPhones(ctx)
	if err != nil {
		writeError(w, err)
		return
	}
	phones := []map[string]any{}
	for _, p := range list {
		j := map[string]any{"keyId": p.KeyID, "name": p.Name, "created": p.CreatedAt.Unix(), "sales": p.Sales}
		if p.LastSale != nil {
			j["lastSale"] = p.LastSale.Unix()
		}
		phones = append(phones, j)
	}
	out := map[string]any{"phones": phones}
	// When the server was last restored: a phone paired before it may be one
	// the person had removed after the backup was made.
	at, restored, err := a.money.Store.RestoredAt(ctx)
	if err != nil {
		writeError(w, err)
		return
	}
	if restored {
		out["restored"] = at.Unix()
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *api) renamePosPhone(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	id := r.PathValue("keyId")
	if err := a.money.Store.RenamePosPhone(r.Context(), id, req.Name); err != nil {
		writeError(w, err)
		return
	}
	d, err := a.money.Store.GetDevice(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	a.money.logf("shop: PoS phone %s renamed %q", d.KeyID, d.Name)
	writeJSON(w, http.StatusOK, map[string]any{"keyId": d.KeyID, "name": d.Name})
}

func (a *api) removePosPhone(w http.ResponseWriter, r *http.Request) {
	if err := a.money.Store.RevokePosPhone(r.Context(), r.PathValue("keyId")); err != nil {
		writeError(w, err)
		return
	}
	a.money.logf("shop: PoS phone %s removed", r.PathValue("keyId"))
	w.WriteHeader(http.StatusNoContent)
}
