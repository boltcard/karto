// Package backup takes cardd's snapshots: hourly,
// only when something changed, a consistent copy of cardd.db encrypted with
// age to the backup public key in meta backup.recipient. The VM never holds
// the private half, so it can't read its own backups. The phone fetches them
// through the API.
package backup

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"filippo.io/age"

	"github.com/boltcard/karto/server/internal/store"
)

// ErrNoSnapshot: there is no snapshot with that version (any more).
var ErrNoSnapshot = errors.New("backup: no such snapshot")

// Snapshot is one encrypted snapshot.
type Snapshot struct {
	Version int64  `json:"version"`
	Created int64  `json:"created"` // unix seconds
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"` // of the encrypted file
}

// Status is what GET /api/v1/backups answers.
type Status struct {
	// InstallID is made once, at the first snapshot: versions restart with it
	// (a lost state file, a rebuilt VM), so the phone tells snapshots apart by both.
	InstallID string    `json:"installId"`
	Recipient string    `json:"recipient"` // the one the latest snapshot was encrypted to
	Latest    *Snapshot `json:"latest"`
	// LastCheckIn is the check-in before this one, from CheckIn: the asking
	// phone can then tell whether any phone checked for a day (unix seconds; 0 never).
	LastCheckIn  int64  `json:"lastCheckIn"`
	LastDownload int64  `json:"lastDownload"` // unix seconds; 0 never
	Problem      string `json:"problem"`      // why the last attempt made no snapshot, or ""
}

// state is Status as kept in Dir/state.json, with the plaintext's hash.
type state struct {
	Status
	PlainSHA256 string `json:"plainSha256"`
}

// Snapshotter takes and keeps the snapshots.
type Snapshotter struct {
	Store *store.Store
	Dir   string // /data/backups
	Now   func() time.Time
	Log   *log.Logger
	Keep  int           // snapshots kept: 0 means 24
	Tick  time.Duration // how often Run looks: 0 means a minute
	// Limit bounds a snapshot's VACUUM INTO, which holds the store's one
	// connection: 0 means a minute.
	Limit time.Duration

	// Within a process the mutexes, across processes (cardd serve and
	// `cardd backup now`) flocks on Dir/.lock and Dir/.state.lock.
	take sync.Mutex // one snapshot at a time
	mu   sync.Mutex // the state file
}

const recipientKey = "backup.recipient"

func (s *Snapshotter) keep() int {
	if s.Keep > 0 {
		return s.Keep
	}
	return 24
}

// load reads the state, making the install id the first time.
func (s *Snapshotter) load() (state, error) {
	var st state
	raw, err := os.ReadFile(filepath.Join(s.Dir, "state.json"))
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return st, err
	default:
		if err := json.Unmarshal(raw, &st); err != nil {
			// A truncated file (a power cut) must not stop backups for good:
			// keep it aside and start fresh, as for a lost state file.
			s.Log.Printf("backup: state.json doesn't parse (%v): kept as state.json.bad, starting fresh", err)
			if err := os.Rename(filepath.Join(s.Dir, "state.json"), filepath.Join(s.Dir, "state.json.bad")); err != nil {
				return state{}, err
			}
			st = state{}
		}
	}
	if st.InstallID == "" {
		b := make([]byte, 16)
		rand.Read(b)
		st.InstallID = hex.EncodeToString(b)
	}
	return st, nil
}

// save writes the state atomically.
func (s *Snapshotter) save(st state) error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	raw, _ := json.Marshal(st)
	tmp := filepath.Join(s.Dir, "state.json.tmp")
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(raw)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.Dir, "state.json"))
}

// lock takes an exclusive flock on Dir/name; closing the file releases it.
func (s *Snapshotter) lock(name string) (*os.File, error) {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(s.Dir, name), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// update changes the state under the locks.
func (s *Snapshotter) update(change func(*state)) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, err := s.lock(".state.lock")
	if err != nil {
		return Status{}, err
	}
	defer l.Close()
	st, err := s.load()
	if err != nil {
		return Status{}, err
	}
	change(&st)
	if err := s.save(st); err != nil {
		return Status{}, err
	}
	return st.Status, nil
}

// Status is the latest snapshot and the last fetches.
func (s *Snapshotter) Status() (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.load()
	return st.Status, err
}

// CheckIn records a phone asking for the status (GET /backups) and returns
// the status as it was before, with the previous check-in.
func (s *Snapshotter) CheckIn() (Status, error) {
	now := s.Now().Unix()
	var before Status
	_, err := s.update(func(st *state) {
		before = st.Status
		st.LastCheckIn = now
	})
	return before, err
}

func (s *Snapshotter) file(version int64) string {
	return filepath.Join(s.Dir, strconv.FormatInt(version, 10)+".age")
}

// Open opens a kept snapshot's encrypted file and records the download.
func (s *Snapshotter) Open(version int64) (*os.File, Snapshot, error) {
	if version <= 0 {
		return nil, Snapshot{}, ErrNoSnapshot
	}
	f, err := os.Open(s.file(version))
	if errors.Is(err, os.ErrNotExist) {
		return nil, Snapshot{}, ErrNoSnapshot
	}
	if err != nil {
		return nil, Snapshot{}, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, Snapshot{}, err
	}
	now := s.Now().Unix()
	if _, err := s.update(func(st *state) { st.LastDownload = now }); err != nil {
		f.Close()
		return nil, Snapshot{}, err
	}
	return f, Snapshot{Version: version, Size: info.Size()}, nil
}

// Take makes a snapshot if something changed since the last one, or the
// recipient did, and reports whether it made one. A missing or bad
// recipient, or a failed snapshot, is recorded as the problem.
func (s *Snapshotter) Take(ctx context.Context) (bool, error) {
	s.take.Lock()
	defer s.take.Unlock()
	l, err := s.lock(".lock")
	if err != nil {
		return false, err
	}
	defer l.Close()
	problem := func(text string) (bool, error) {
		s.Log.Printf("backup: %s", text)
		_, err := s.update(func(st *state) { st.Problem = text })
		return false, err
	}
	recipient, err := s.Store.GetMeta(ctx, recipientKey)
	if errors.Is(err, store.ErrNotFound) || (err == nil && recipient == "") {
		return problem("no backup key yet (meta backup.recipient): Update server writes it")
	}
	if err != nil {
		return false, err
	}
	rcpt, err := age.ParseX25519Recipient(recipient)
	if err != nil {
		return problem(fmt.Sprintf("the backup key %q isn't an age recipient", recipient))
	}
	made, err := s.snapshot(ctx, recipient, rcpt)
	if err != nil {
		return problem(fmt.Sprintf("the last snapshot failed: %v", err))
	}
	return made, nil
}

// removePlain removes the plain copy with the files SQLite keeps beside it:
// a journal left by a cut must never be rolled into the next copy.
func removePlain(plain string) {
	for _, p := range []string{plain, plain + "-journal", plain + "-wal", plain + "-shm"} {
		os.Remove(p)
	}
}

func (s *Snapshotter) snapshot(ctx context.Context, recipient string, rcpt age.Recipient) (bool, error) {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return false, err
	}
	plain := filepath.Join(s.Dir, "snapshot.db.tmp")
	removePlain(plain) // left by a crash
	defer removePlain(plain)
	limit := s.Limit
	if limit <= 0 {
		limit = time.Minute
	}
	vctx, cancel := context.WithTimeout(ctx, limit)
	err := s.Store.SnapshotTo(vctx, plain)
	cancel()
	if err != nil {
		return false, err
	}
	plainSum, err := hashFile(plain)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	st, err := s.load()
	s.mu.Unlock()
	if err != nil {
		return false, err
	}
	if st.Latest != nil && st.PlainSHA256 == plainSum && st.Recipient == recipient {
		_, err := s.update(func(st *state) { st.Problem = "" })
		return false, err
	}
	version := int64(1)
	if st.Latest != nil {
		version = st.Latest.Version + 1
	}
	size, sum, err := encrypt(plain, s.file(version), rcpt)
	if err != nil {
		return false, err
	}
	snap := Snapshot{Version: version, Created: s.Now().Unix(), Size: size, SHA256: sum}
	if _, err := s.update(func(st *state) {
		st.Latest, st.Recipient, st.PlainSHA256, st.Problem = &snap, recipient, plainSum, ""
	}); err != nil {
		return false, err
	}
	for v := version - int64(s.keep()); v > 0; v-- {
		if err := os.Remove(s.file(v)); errors.Is(err, os.ErrNotExist) {
			break
		}
	}
	s.Log.Printf("backup: snapshot %d, %d bytes", version, size)
	return true, nil
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// encrypt writes plain's contents to dst encrypted to rcpt, atomically, and
// returns the encrypted size and SHA-256.
func encrypt(plain, dst string, rcpt age.Recipient) (int64, string, error) {
	in, err := os.Open(plain)
	if err != nil {
		return 0, "", err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, "", err
	}
	defer os.Remove(tmp)
	h := sha256.New()
	counted := &counter{w: io.MultiWriter(out, h)}
	w, err := age.Encrypt(counted, rcpt)
	if err == nil {
		_, err = io.Copy(w, in)
	}
	if err == nil {
		err = w.Close()
	}
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, dst)
	}
	return counted.n, hex.EncodeToString(h.Sum(nil)), err
}

type counter struct {
	w io.Writer
	n int64
}

func (c *counter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// Run takes a snapshot at start, then looks every Tick: until the first
// snapshot exists (the recipient arrives after cardd starts), and after
// that once an hour.
func (s *Snapshotter) Run(ctx context.Context) {
	every := s.Tick
	if every <= 0 {
		every = time.Minute
	}
	var last time.Time
	try := func() {
		last = time.Now()
		if _, err := s.Take(ctx); err != nil {
			s.Log.Printf("backup: %v", err)
		}
	}
	try()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if st, err := s.Status(); err != nil || st.Latest == nil || time.Since(last) >= time.Hour {
				try()
			}
		}
	}
}
