package backup_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"filippo.io/age"
	_ "modernc.org/sqlite"

	"github.com/boltcard/karto/server/internal/backup"
	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/testvec"
)

type world struct {
	st  *store.Store
	s   *backup.Snapshotter
	dir string
	now time.Time
}

// setup: a database with VM 1009 and the phrase vector's backup recipient.
func setup(t *testing.T) *world {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "cardd.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	st.SetMeta(ctx, "vm.id", "1009")
	st.SetMeta(ctx, "backup.recipient", testvec.Load(t).Phrase.BackupAgeRecipient)
	w := &world{st: st, dir: filepath.Join(dir, "backups"), now: time.Unix(1_791_000_000, 0)}
	w.s = w.snapshotter()
	return w
}

// snapshotter is a Snapshotter on w's database and directory, as cardd starts one.
func (w *world) snapshotter() *backup.Snapshotter {
	return &backup.Snapshotter{Store: w.st, Dir: w.dir, Now: func() time.Time { return w.now }, Log: log.New(io.Discard, "", 0)}
}

func (w *world) take(t *testing.T) bool {
	t.Helper()
	made, err := w.s.Take(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return made
}

func (w *world) status(t *testing.T) backup.Status {
	t.Helper()
	s, err := w.s.Status()
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// decrypt opens a snapshot file with the phrase vector's backup identity.
func decrypt(t *testing.T, encrypted []byte) []byte {
	t.Helper()
	id, err := age.ParseX25519Identity(testvec.Load(t).Phrase.BackupAgeIdentity)
	if err != nil {
		t.Fatal(err)
	}
	r, err := age.Decrypt(bytes.NewReader(encrypted), id)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return plain
}

// vmID reads meta vm.id from a decrypted snapshot.
func vmID(t *testing.T, plain []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "restored.db")
	os.WriteFile(path, plain, 0o600)
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var v string
	if err := db.QueryRow(`SELECT value FROM meta WHERE key = 'vm.id'`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func open(t *testing.T, s *backup.Snapshotter, version int64) []byte {
	t.Helper()
	f, _, err := s.Open(version)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	b, _ := io.ReadAll(f)
	return b
}

func TestASnapshotDecryptsWithThePhrasesBackupKey(t *testing.T) {
	w := setup(t)
	if !w.take(t) {
		t.Fatal("no snapshot")
	}
	s := w.status(t)
	if s.Latest == nil || s.Latest.Version != 1 || s.Latest.Created != w.now.Unix() || len(s.InstallID) != 32 ||
		s.Recipient != testvec.Load(t).Phrase.BackupAgeRecipient || s.Problem != "" {
		t.Fatalf("%+v %+v", s, s.Latest)
	}
	enc := open(t, w.s, 1)
	sum := sha256.Sum256(enc)
	if int64(len(enc)) != s.Latest.Size || hex.EncodeToString(sum[:]) != s.Latest.SHA256 {
		t.Fatalf("size %d sha %x, status %+v", len(enc), sum, s.Latest)
	}
	if got := vmID(t, decrypt(t, enc)); got != "1009" {
		t.Fatalf("vm.id %q", got)
	}
	// Only the encrypted file is left behind, with the state and the lock files.
	files, _ := filepath.Glob(filepath.Join(w.dir, "*"))
	for _, f := range files {
		if base := filepath.Base(f); base != "1.age" && base != "state.json" && base != ".lock" && base != ".state.lock" {
			t.Fatalf("left behind: %s", base)
		}
	}
}

func TestANewSnapshotOnlyWhenSomethingChanged(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.take(t)
	w.st.SeeSignature(ctx, "sig", time.Now().Add(time.Minute))
	if w.take(t) {
		t.Fatal("a snapshot with nothing changed")
	}
	w.st.SetMeta(ctx, "vm.host", "vm-1009.lnvps.cloud")
	w.now = w.now.Add(time.Hour)
	if !w.take(t) || w.status(t).Latest.Version != 2 || w.status(t).Latest.Created != w.now.Unix() {
		t.Fatalf("after a change: %+v", w.status(t).Latest)
	}
	// A new recipient is a change too: snapshots to the old one would be useless.
	other, _ := age.GenerateX25519Identity()
	w.st.SetMeta(ctx, "backup.recipient", other.Recipient().String())
	if !w.take(t) || w.status(t).Recipient != other.Recipient().String() {
		t.Fatalf("after a new recipient: %+v", w.status(t))
	}
}

func TestOnlyTheLast24AreKept(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	for i := range 30 {
		w.st.SetMeta(ctx, "test.n", strings.Repeat("x", i+1))
		w.take(t)
	}
	files, _ := filepath.Glob(filepath.Join(w.dir, "*.age"))
	if len(files) != 24 || w.status(t).Latest.Version != 30 {
		t.Fatalf("%d files, latest %+v", len(files), w.status(t).Latest)
	}
	if _, _, err := w.s.Open(6); !errors.Is(err, backup.ErrNoSnapshot) {
		t.Fatalf("version 6: %v", err)
	}
	open(t, w.s, 7)
}

func TestWithoutARecipientNoSnapshot(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.st.SetMeta(ctx, "backup.recipient", "")
	if w.take(t) {
		t.Fatal("a snapshot without a recipient")
	}
	if s := w.status(t); s.Latest != nil || !strings.Contains(s.Problem, "no backup key") {
		t.Fatalf("%+v", s)
	}
	w.st.SetMeta(ctx, "backup.recipient", "age1notakey")
	if w.take(t) || !strings.Contains(w.status(t).Problem, "isn't an age recipient") {
		t.Fatalf("%+v", w.status(t))
	}
	w.st.SetMeta(ctx, "backup.recipient", testvec.Load(t).Phrase.BackupAgeRecipient)
	if !w.take(t) || w.status(t).Problem != "" {
		t.Fatalf("%+v", w.status(t))
	}
}

// The install id and the version survive a restart; check-ins and downloads are recorded.
func TestTheStateSurvivesARestart(t *testing.T) {
	w := setup(t)
	w.take(t)
	before := w.status(t)
	w.now = w.now.Add(time.Minute)
	// CheckIn answers the check-in before it: none yet, then this one.
	if s, err := w.s.CheckIn(); err != nil || s.LastCheckIn != 0 || s.LastDownload != 0 {
		t.Fatalf("%+v %v", s, err)
	}
	if s, _ := w.s.Status(); s.LastCheckIn != w.now.Unix() {
		t.Fatalf("not recorded: %+v", s)
	}
	w.now = w.now.Add(time.Minute)
	open(t, w.s, 1)
	restarted := w.snapshotter()
	s, err := restarted.Status()
	if err != nil || s.InstallID != before.InstallID || s.Latest.Version != 1 || s.LastDownload != w.now.Unix() || s.LastCheckIn != w.now.Add(-time.Minute).Unix() {
		t.Fatalf("%+v %v", s, err)
	}
	if _, _, err := restarted.Open(0); !errors.Is(err, backup.ErrNoSnapshot) {
		t.Fatalf("version 0: %v", err)
	}
}

// Run takes a snapshot within a tick of the recipient arriving, as after an
// install, whose meta step comes after cardd starts.
func TestRunSnapshotsSoonAfterTheRecipientArrives(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	w.st.SetMeta(ctx, "backup.recipient", "")
	w.s.Tick = 10 * time.Millisecond
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go w.s.Run(ctx)
	time.Sleep(50 * time.Millisecond)
	w.st.SetMeta(context.Background(), "backup.recipient", testvec.Load(t).Phrase.BackupAgeRecipient)
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if s, _ := w.s.Status(); s.Latest != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no snapshot after the recipient arrived")
		}
	}
}

// A state file that won't parse (truncated by a power cut) starts fresh and is kept aside.
func TestAStateFileThatWontParseStartsFresh(t *testing.T) {
	for name, content := range map[string]string{"garbage": "{", "empty": ""} {
		t.Run(name, func(t *testing.T) {
			w := setup(t)
			os.MkdirAll(w.dir, 0o700)
			os.WriteFile(filepath.Join(w.dir, "state.json"), []byte(content), 0o600)
			if !w.take(t) {
				t.Fatal("no snapshot")
			}
			s := w.status(t)
			if s.Latest == nil || s.Latest.Version != 1 || len(s.InstallID) != 32 || s.Problem != "" {
				t.Fatalf("%+v", s)
			}
			bad, err := os.ReadFile(filepath.Join(w.dir, "state.json.bad"))
			if err != nil || string(bad) != content {
				t.Fatalf("bad file: %q %v", bad, err)
			}
		})
	}
}

// make deploy-test copies the stack's snapshots out and runs this with
// CARDD_BACKUP_TEST_FILE set: each must open with the phrase vector's backup
// key. With CARDD_BACKUP_TEST_PLAIN set it also writes the database there,
// for the stack test to restore as the phone would.
func TestAStackSnapshotDecrypts(t *testing.T) {
	path := os.Getenv("CARDD_BACKUP_TEST_FILE")
	if path == "" {
		t.Skip("CARDD_BACKUP_TEST_FILE not set")
	}
	enc, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	plain := decrypt(t, enc)
	if got := vmID(t, plain); got != "1001" {
		t.Fatalf("vm.id %q", got)
	}
	if out := os.Getenv("CARDD_BACKUP_TEST_PLAIN"); out != "" {
		if err := os.WriteFile(out, plain, 0o600); err != nil {
			t.Fatal(err)
		}
		// The stack's books owe nothing, and a restore that owes nothing with
		// no channel is set at once: 1 sat in pool makes the copy's restore
		// wait for a channel, as one with money does.
		if os.Getenv("CARDD_BACKUP_TEST_OWE") != "" {
			st, err := store.Open(out)
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			if _, err := st.Credit(context.Background(), store.Pool, 1_000, "the stack test's", ""); err != nil {
				t.Fatal(err)
			}
			if err := st.Checkpoint(context.Background()); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// `cardd backup now` takes a snapshot from a second process, beside cardd
// serve's Snapshotter: two Snapshotters on one Dir, each with its own store,
// never write the same version, and a check-in meanwhile loses no snapshot.
func TestTwoSnapshottersNeverWriteTheSameVersion(t *testing.T) {
	ctx := context.Background()
	w := setup(t)
	st2, err := store.Open(filepath.Join(filepath.Dir(w.dir), "cardd.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()
	other := w.snapshotter()
	other.Store = st2
	var made atomic.Int64
	var wg sync.WaitGroup
	for i, s := range []*backup.Snapshotter{w.s, other} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range 10 {
				s.Store.SetMeta(ctx, "test.n", fmt.Sprintf("%d-%d", i, j))
				if ok, err := s.Take(ctx); err != nil {
					t.Error(err)
				} else if ok {
					made.Add(1)
				}
				if _, err := s.CheckIn(); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	latest := w.status(t).Latest
	if latest == nil || latest.Version != made.Load() {
		t.Fatalf("%d snapshots made, latest %+v", made.Load(), latest)
	}
	sum := sha256.Sum256(open(t, w.s, latest.Version))
	if hex.EncodeToString(sum[:]) != latest.SHA256 {
		t.Fatalf("version %d's file isn't the one state.json describes", latest.Version)
	}
}
