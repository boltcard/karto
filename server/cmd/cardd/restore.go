package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/boltcard/karto/server/internal/backup"
	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/store"
)

// errNewerBackup: the backup's schema is newer than this cardd's.
var errNewerBackup = errors.New("this backup is from a newer cardd: update the app first")

// errDatabaseThere: restore never replaces a database it didn't restore.
var errDatabaseThere = errors.New("a database is already there")

// vmID is an LNVPS VM id as -vm-id takes it: digits only.
var vmID = regexp.MustCompile(`^[0-9]+$`)

// restore is `cardd restore`, run by
// install.sh before cardd first starts: it puts the backup read from stdin
// (or, with -fresh, an empty database) at -db, migrated, and prepared for
// the new VM named by -vm-id, -vm-host and -vm-ipv4. It works on a file beside -db and moves it into place only if
// no database is there, so a repeat after a cut says "already restored".
func restore(args []string, stdin io.Reader, out io.Writer) error {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	dbPath := fs.String("db", env("CARDD_DB", "cardd.db"), "SQLite database path")
	device := fs.String("device", "", "the restoring phone's hex uncompressed P-256 public key")
	fresh := fs.Bool("fresh", false, "no backup (phrase only): an empty database, stdin unread")
	from := fs.String("from", "", `the backup restored, for meta restore.from (default "backup", or "phrase" with -fresh)`)
	var vm store.RestoredVM
	fs.StringVar(&vm.ID, "vm-id", "", "the new VM's LNVPS id, for meta vm.id")
	fs.StringVar(&vm.Host, "vm-host", "", "the new VM's hostname, for meta vm.host")
	fs.StringVar(&vm.IPv4, "vm-ipv4", "", "the new VM's IPv4 address, for meta vm.ipv4")
	if err := fs.Parse(args); err != nil {
		return err
	}
	_, raw, err := deviceauth.ParsePublicKey(strings.ToLower(strings.TrimSpace(*device)))
	if err != nil {
		return fmt.Errorf("-device: %w", err)
	}
	if !vmID.MatchString(vm.ID) {
		return fmt.Errorf("-vm-id %q: want the VM's number", vm.ID)
	}
	if vm.Host == "" || vm.IPv4 == "" {
		return errors.New("-vm-host and -vm-ipv4 are required")
	}
	if *from == "" {
		*from = "backup"
		if *fresh {
			*from = "phrase"
		}
	}
	ctx := context.Background()
	tmp := *dbPath + ".restore"
	// Whatever happens, nothing is left beside -db: a cut's leftovers go
	// first, and once the file is moved into place only strays remain.
	removeDB(tmp)
	defer removeDB(tmp)
	if _, err := os.Stat(*dbPath); err == nil {
		return alreadyRestored(ctx, *dbPath, out)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if !*fresh {
		_, err = io.Copy(f, stdin)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if !*fresh {
		if err := checkBackup(ctx, tmp); err != nil {
			return err
		}
	}
	st, err := store.Open(tmp)
	if err != nil {
		return err
	}
	err = st.PrepareRestored(ctx, *from, hex.EncodeToString(raw), vm)
	if err == nil {
		err = st.Checkpoint(ctx)
	}
	if cerr := st.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	// Nothing else writes -db yet: cardd hasn't started.
	return os.Rename(tmp, *dbPath)
}

// alreadyRestored answers a restore when a database is there: fine if a
// restore put it there, refused otherwise.
func alreadyRestored(ctx context.Context, path string, out io.Writer) error {
	st, err := store.Open(path)
	if err != nil {
		return err
	}
	defer st.Close()
	if _, err := st.GetMeta(ctx, "restore.from"); errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("%s: %w", path, errDatabaseThere)
	} else if err != nil {
		return err
	}
	fmt.Fprintln(out, "already restored")
	return nil
}

// checkBackup checks that path is a whole cardd database that this cardd can
// migrate.
func checkBackup(ctx context.Context, path string) error {
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		return err
	}
	defer db.Close()
	var check string
	if err := db.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&check); err != nil {
		return fmt.Errorf("the backup isn't a whole database: %w", err)
	}
	if check != "ok" {
		return fmt.Errorf("the backup isn't a whole database: %s", check)
	}
	var tables int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).Scan(&tables); err != nil {
		return err
	}
	if tables == 0 {
		return errors.New("the backup isn't a cardd database: it has no meta table")
	}
	var v int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	if v > store.SchemaVersion() {
		return fmt.Errorf("%w (its schema is %d, this cardd's %d)", errNewerBackup, v, store.SchemaVersion())
	}
	return nil
}

// removeDB removes a database file with its write-ahead log and shared memory.
func removeDB(path string) {
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		os.Remove(p)
	}
}

// backupCmd is `cardd backup now`, the final snapshot of a server being
// retired, run through cardd-ctl beside cardd serve:
// a snapshot now if anything changed since the last, and the latest as JSON.
func backupCmd(args []string, out io.Writer) error {
	if len(args) == 0 || args[0] != "now" {
		return errors.New("usage: cardd backup now")
	}
	fs := flag.NewFlagSet("backup now", flag.ContinueOnError)
	dbPath := fs.String("db", env("CARDD_DB", "cardd.db"), "SQLite database path")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	st, err := store.Open(*dbPath)
	if err != nil {
		return err
	}
	defer st.Close()
	// The same directory as serve's, so versions go on from its.
	snaps := &backup.Snapshotter{Store: st, Dir: filepath.Join(filepath.Dir(*dbPath), "backups"), Now: time.Now, Log: log.New(io.Discard, "", 0)}
	if _, err := snaps.Take(context.Background()); err != nil {
		return err
	}
	s, err := snaps.Status()
	if err != nil {
		return err
	}
	// A problem means the latest, if any, is older than the database now.
	if s.Problem != "" {
		return fmt.Errorf("no snapshot: %s", s.Problem)
	}
	if s.Latest == nil {
		return errors.New("no snapshot")
	}
	return json.NewEncoder(out).Encode(struct {
		Version int64 `json:"version"`
		Created int64 `json:"created"`
	}{s.Latest.Version, s.Latest.Created})
}
