package api

import "net/http"

// A card's photo: the JPEG travels as base64
// in the signed JSON, as every other body does.

func (a *api) setPhoto(w http.ResponseWriter, r *http.Request) {
	var req struct {
		JPEG string `json:"jpeg"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	tag, err := a.cards.SetPhoto(r.Context(), r.PathValue("id"), req.JPEG)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"photo": tag})
}

func (a *api) removePhoto(w http.ResponseWriter, r *http.Request) {
	if err := a.cards.RemovePhoto(r.Context(), r.PathValue("id")); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"photo": ""})
}

func (a *api) photo(w http.ResponseWriter, r *http.Request) {
	jpeg, tag, err := a.cards.Photo(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	// []byte marshals as standard base64.
	writeJSON(w, http.StatusOK, map[string]any{"jpeg": jpeg, "photo": tag})
}
