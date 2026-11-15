package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/renew"
	"github.com/boltcard/karto/server/internal/store"
)

// hostingRoutes: the VM's paid-until estimate, its sync from LNVPS, and
// Renew now.
func (a *api) hostingRoutes(v1 *http.ServeMux) {
	v1.HandleFunc("GET /api/v1/hosting", a.hostingStatus)
	v1.HandleFunc("PUT /api/v1/hosting", a.hostingSync)
	v1.HandleFunc("POST /api/v1/hosting/renew", a.renewNow)
}

func (a *api) hostingStatus(w http.ResponseWriter, r *http.Request) {
	s, err := a.money.Hosting.Status(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// hostingSync takes what the app read from LNVPS. Every field is required
// (a sync missing one is malformed, not a zero) but the phone's offset from
// UTC, which an older app doesn't send.
func (a *api) hostingSync(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Expires      *int64   `json:"expires"`
		SatPerDay    *float64 `json:"satPerDay"`
		VatOK        *bool    `json:"vatOk"`
		UTCOffsetMin *int     `json:"utcOffsetMin"` // optional: the phone's offset from UTC
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Expires == nil || req.SatPerDay == nil || req.VatOK == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed", "message": "expires, satPerDay and vatOk are all required"})
		return
	}
	if err := a.money.Hosting.Sync(r.Context(), renew.Sync{Expires: *req.Expires, SatPerDay: *req.SatPerDay, VatOK: *req.VatOK, UTCOffsetMin: req.UTCOffsetMin}); err != nil {
		writeError(w, err)
		return
	}
	a.hostingStatus(w, r)
}

// renewNow pays for days of the VM from hosting, once per request id, under
// SendWait like a send, and answers like one.
func (a *api) renewNow(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   string `json:"id"`
		Days int    `json:"days"`
	}
	body, ok := readBody(w, r, &req)
	if !ok {
		return
	}
	a.once(w, r, req.ID, body, func() (int, any) {
		m := a.money
		ctx, cancel := context.WithTimeout(r.Context(), m.SendWait)
		defer cancel()
		// As for a send: a retry after a restart answers from the payment made.
		ref := "request:" + req.ID
		if h, err := m.Store.HoldByRef(ctx, ref); err == nil {
			return sendAnswer(ledger.Outcome{Hold: h, Pending: h.State == store.HoldOpen})
		} else if !errors.Is(err, store.ErrNotFound) {
			return errorAnswer(err)
		}
		h, done, err := m.Hosting.RenewNow(ctx, ref, req.Days)
		if err != nil {
			return errorAnswer(err)
		}
		select {
		case o := <-done:
			return sendAnswer(o)
		case <-ctx.Done():
			return sendAnswer(ledger.Outcome{Hold: h, Pending: true})
		}
	})
}
