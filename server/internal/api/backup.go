package api

import (
	"io"
	"net/http"
	"strconv"

	"github.com/boltcard/karto/server/internal/backup"
)

// backupRoutes: the encrypted snapshots, for the phone to fetch.
func (a *api) backupRoutes(v1 *http.ServeMux) {
	v1.HandleFunc("GET /api/v1/backups", a.backupStatus)
	v1.HandleFunc("GET /api/v1/backups/{version}", a.backupFile)
}

// backupStatus answers the latest snapshot and records the phone's check-in.
func (a *api) backupStatus(w http.ResponseWriter, r *http.Request) {
	s, err := a.backups.CheckIn()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// backupFile serves one encrypted snapshot and records the download.
func (a *api) backupFile(w http.ResponseWriter, r *http.Request) {
	version, err := strconv.ParseInt(r.PathValue("version"), 10, 64)
	if err != nil {
		writeError(w, backup.ErrNoSnapshot)
		return
	}
	f, snap, err := a.backups.Open(version)
	if err != nil {
		writeError(w, err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(snap.Size, 10))
	io.Copy(w, f)
}
