package api

import "net/http"

// setWalletName names the wallet (5):
// the end of setup, Settings, or the ask on the next start. Owner only, as
// every route outside /api/v1/pos/ is. The bell rings as for the currency, so
// the wallet's other phones hear of it at once; its tills read it with their
// next /pos/me.
func (a *api) setWalletName(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	// A name is 24 characters: anything near 4 KiB isn't one.
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if !readJSON(w, r, &req) {
		return
	}
	name, err := a.money.Store.SetWalletName(r.Context(), req.Name)
	if err != nil {
		writeError(w, err)
		return
	}
	a.money.Bell.Changed(nil)
	writeJSON(w, http.StatusOK, map[string]any{"name": name})
}
