package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/testvec"
)

const cardID = "e07ce1279d980ecb892a81924b67bf18"

// backupOf is a snapshot of a database as cardd made it on VM 1009: a card
// with money on it, this phone's key revoked (a backup taken after another
// phone revoked it), another phone, the VM's meta and a restore before.
// before6b drops the cards' host column and limits in a currency,
// the photos' table, the point of sale's tables and the holds'
// offer, payment id, give-up time and reason, and the payers'
// notes and a line's via, as a backup from an older schema (version 3).
func backupOf(t *testing.T, before6b bool) []byte {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "cardd.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	v := testvec.Load(t).DeviceAuth
	st.SetMetas(ctx, map[string]string{
		"vm.id": "1009", "vm.host": "vm-1009.lnvps.cloud", "vm.ipv4": "45.67.89.10",
		"hosting.expires_est": "1790000000", "hosting.counted_hold": "12",
		"backup.recipient": testvec.Load(t).Phrase.BackupAgeRecipient,
		"restore.from":     "an older one", "restore.reconcile": "done", "restore.reconciled": "-5000 1780000000",
	})
	if _, err := st.ReserveCard(ctx, cardID, "Daily", "vm-1009.lnvps.cloud"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ActivateCard(ctx, cardID, 7); err != nil {
		t.Fatal(err)
	}
	st.Credit(ctx, store.Pool, 10_000_000, "h1", "")
	if err := st.Move(ctx, store.Pool, store.CardAccount(cardID), 4_000_000, ""); err != nil {
		t.Fatal(err)
	}
	st.AddDevice(ctx, store.Device{KeyID: v.KeyID, PublicKey: strings.ToLower(v.PublicKey), Name: "Pixel"})
	st.RevokeDevice(ctx, v.KeyID)
	st.AddDevice(ctx, store.Device{KeyID: "aaaaaaaaaaaaaaaa", PublicKey: "04aa", Name: "Other"})
	if !before6b {
		// The point of sale: a PoS phone, a sale of its still open, and the fee credit accounted for.
		st.AddDevice(ctx, store.Device{KeyID: "cccccccccccccccc", PublicKey: "04cc", Name: "Till 1", Role: store.RolePos})
		if _, err := st.NewSale(ctx, store.Sale{ID: "0a000000-0000-4000-8000-00000000000a", Device: "cccccccccccccccc", AmountMsat: 2_500_000,
			PaymentHash: "sale-hash", Invoice: "lnbc-sale", ExpiresAt: time.Now().Add(10 * time.Minute)}); err != nil {
			t.Fatal(err)
		}
		st.SetKeptFeeCredit(ctx, 4_321)
	}
	snap := filepath.Join(dir, "snapshot.db")
	if err := st.SnapshotTo(ctx, snap); err != nil {
		t.Fatal(err)
	}
	if before6b {
		sqlExec(t, snap, `DROP TABLE sales; DROP TABLE pos_codes; ALTER TABLE devices DROP COLUMN role;
			DROP TABLE card_photos; ALTER TABLE cards DROP COLUMN host;
			ALTER TABLE holds DROP COLUMN preimage; ALTER TABLE holds DROP COLUMN destination; ALTER TABLE holds DROP COLUMN description;
			ALTER TABLE holds DROP COLUMN comment; ALTER TABLE holds DROP COLUMN tx_id; ALTER TABLE ledger_tx DROP COLUMN comment;
			ALTER TABLE cards DROP COLUMN limit_currency; ALTER TABLE cards DROP COLUMN per_tap_minor; ALTER TABLE cards DROP COLUMN daily_minor;
			DROP INDEX holds_payment_id; ALTER TABLE holds DROP COLUMN offer; ALTER TABLE holds DROP COLUMN payment_id;
			ALTER TABLE holds DROP COLUMN gave_up_at; ALTER TABLE holds DROP COLUMN reason;
			DROP TABLE topup_notes; ALTER TABLE ledger_tx DROP COLUMN payer_note; DROP TABLE push_endpoints; DROP TABLE recent_removed;
			DROP INDEX holds_sale; ALTER TABLE holds DROP COLUMN sale_id; DROP TABLE refund_links; ALTER TABLE ledger_tx DROP COLUMN via; DROP INDEX ledger_entry_tx; PRAGMA user_version = 3`)
	}
	b, err := os.ReadFile(snap)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// sqlExec runs SQL on a database file directly.
func sqlExec(t *testing.T, path, query string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(query); err != nil {
		t.Fatal(err)
	}
}

// newVM is the new VM a test restores onto, as cardd restore's flags.
var newVM = []string{"-vm-id", "1003", "-vm-host", "vm-1003.lnvps.cloud", "-vm-ipv4", "45.67.89.170"}

// restoreArgs restores db onto newVM for the device vector's phone.
func restoreArgs(t *testing.T, db string, extra ...string) []string {
	args := append([]string{"restore", "-db", db, "-device", testvec.Load(t).DeviceAuth.PublicKey}, newVM...)
	return append(args, extra...)
}

// leftovers lists what is in dir besides the names given.
func leftovers(t *testing.T, dir string, keep ...string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var left []string
	for _, e := range entries {
		if !slices.Contains(keep, e.Name()) {
			left = append(left, e.Name())
		}
	}
	return left
}

// cardd restore puts a cardd-made backup in place as one file, migrated and
// prepared for the new VM.
func TestRestore(t *testing.T) {
	ctx := context.Background()
	v := testvec.Load(t).DeviceAuth
	for _, before6b := range []bool{false, true} {
		t.Run(fmt.Sprintf("before6b=%v", before6b), func(t *testing.T) {
			dir := t.TempDir()
			db := filepath.Join(dir, "cardd.db")
			var out bytes.Buffer
			// Upper case, as a phone might send it.
			args := append([]string{"restore", "-db", db, "-device", strings.ToUpper(v.PublicKey), "-from", "a1b2 3 1790000000"}, newVM...)
			if err := runWithStdin(args, bytes.NewReader(backupOf(t, before6b)), &out); err != nil {
				t.Fatal(err)
			}
			if left := leftovers(t, dir, "cardd.db"); left != nil {
				t.Fatalf("left beside it: %v", left)
			}
			st, err := store.Open(db)
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			if uv, err := st.UserVersion(ctx); err != nil || uv != store.SchemaVersion() {
				t.Fatalf("user_version %d %v", uv, err)
			}
			// Migrated before the new vm.host: the card keeps the host it points at.
			if c, err := st.GetCard(ctx, cardID); err != nil || c.State != store.StateActive || c.LastCounter != 7 || c.Host != "vm-1009.lnvps.cloud" {
				t.Fatalf("card %+v %v", c, err)
			}
			if b, _ := st.Balance(ctx, store.CardAccount(cardID)); b.EntriesMsat != 4_000_000 {
				t.Fatalf("card balance %+v", b)
			}
			meta, _ := st.ListMeta(ctx)
			want := map[string]string{
				"vm.id": "1003", "vm.host": "vm-1003.lnvps.cloud", "vm.ipv4": "45.67.89.170",
				"hosting.counted_hold": "12", "backup.recipient": testvec.Load(t).Phrase.BackupAgeRecipient,
				"restore.from": "a1b2 3 1790000000", "restore.reconcile": "pending",
			}
			if fmt.Sprint(meta) != fmt.Sprint(want) {
				t.Fatalf("meta %v, want %v", meta, want)
			}
			if d, err := st.GetDevice(ctx, v.KeyID); err != nil || d.RevokedAt != nil {
				t.Fatalf("this phone %+v %v", d, err)
			}
			if d, err := st.GetDevice(ctx, "aaaaaaaaaaaaaaaa"); err != nil || d.RevokedAt != nil {
				t.Fatalf("the other phone %+v %v", d, err)
			}
			// The point of sale: a backup from before it restores with every device an owner
			// and no sales; one with a PoS phone keeps the phone, and its open sale is expired.
			devices, _ := st.ListDevices(ctx)
			phones, sales, err := st.ShopCounts(ctx)
			if before6b {
				if err != nil || phones != 0 || sales != 0 || len(devices) != 2 || devices[0].Role != store.RoleOwner || devices[1].Role != store.RoleOwner {
					t.Fatalf("an old backup: %d phones, %d sales, %+v %v", phones, sales, devices, err)
				}
				return
			}
			if d, err := st.GetDevice(ctx, "cccccccccccccccc"); err != nil || d.Role != store.RolePos || d.RevokedAt != nil || phones != 1 {
				t.Fatalf("the PoS phone %+v %v, %d phones", d, err, phones)
			}
			if s, err := st.SaleByID(ctx, "0a000000-0000-4000-8000-00000000000a"); err != nil || s.State != store.SaleExpired {
				t.Fatalf("the sale that was open: %+v %v", s, err)
			}
		})
	}
}

// What isn't a good backup is refused, and nothing is left behind.
func TestRestoreRefusesABadBackup(t *testing.T) {
	good := backupOf(t, false)
	notCardd := filepath.Join(t.TempDir(), "other.db")
	sqlExec(t, notCardd, `CREATE TABLE notes (text TEXT)`)
	other, _ := os.ReadFile(notCardd)
	for name, b := range map[string][]byte{
		"truncated": good[:len(good)/2],
		"garbage":   bytes.Repeat([]byte("not a database "), 1000),
		"empty":     nil,
		"no meta":   other,
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			var out bytes.Buffer
			err := runWithStdin(restoreArgs(t, filepath.Join(dir, "cardd.db")), bytes.NewReader(b), &out)
			if err == nil || exitCode(err) != 1 {
				t.Fatalf("got %v (exit %d)", err, exitCode(err))
			}
			if left := leftovers(t, dir); left != nil {
				t.Fatalf("left behind: %v", left)
			}
		})
	}
}

// A backup from a newer cardd can't be migrated back: exit 6 tells the app.
func TestRestoreRefusesANewerSchema(t *testing.T) {
	snap := filepath.Join(t.TempDir(), "newer.db")
	os.WriteFile(snap, backupOf(t, false), 0o600)
	sqlExec(t, snap, fmt.Sprintf(`PRAGMA user_version = %d`, store.SchemaVersion()+1))
	b, _ := os.ReadFile(snap)
	dir := t.TempDir()
	var out bytes.Buffer
	err := runWithStdin(restoreArgs(t, filepath.Join(dir, "cardd.db")), bytes.NewReader(b), &out)
	if err == nil || !strings.Contains(err.Error(), "this backup is from a newer cardd: update the app first") || exitCode(err) != 6 {
		t.Fatalf("got %v (exit %d)", err, exitCode(err))
	}
	if left := leftovers(t, dir); left != nil {
		t.Fatalf("left behind: %v", left)
	}
}

// A repeat after a cut says so; a database that wasn't restored is never
// replaced (exit 7).
func TestRestoreOnlyIntoNoDatabase(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "cardd.db")
	var out bytes.Buffer
	if err := runWithStdin(restoreArgs(t, db), bytes.NewReader(backupOf(t, false)), &out); err != nil {
		t.Fatal(err)
	}
	// A cut can leave the temporary file: the repeat clears it.
	os.WriteFile(db+".restore", []byte("partial"), 0o600)
	out.Reset()
	if err := runWithStdin(restoreArgs(t, db), bytes.NewReader(backupOf(t, false)), &out); err != nil || out.String() != "already restored\n" {
		t.Fatalf("repeat: %q %v", out.String(), err)
	}
	if left := leftovers(t, dir, "cardd.db", "cardd.db-wal", "cardd.db-shm"); left != nil {
		t.Fatalf("left beside it: %v", left)
	}

	other := filepath.Join(t.TempDir(), "cardd.db")
	run([]string{"meta", "set", "-db", other, "vm.id", "1006"}, &out)
	for _, extra := range [][]string{nil, {"-fresh"}} {
		err := runWithStdin(restoreArgs(t, other, extra...), bytes.NewReader(backupOf(t, false)), &out)
		if err == nil || !strings.Contains(err.Error(), "a database is already there") || exitCode(err) != 7 {
			t.Fatalf("%v: got %v (exit %d)", extra, err, exitCode(err))
		}
	}
	out.Reset()
	run([]string{"meta", "get", "-db", other, "vm.id"}, &out)
	if out.String() != "1006\n" {
		t.Fatalf("the database there was changed: vm.id %q", out.String())
	}
}

// Phrase only: an empty database, prepared like a restored one.
func TestRestoreFresh(t *testing.T) {
	ctx := context.Background()
	v := testvec.Load(t).DeviceAuth
	dir := t.TempDir()
	db := filepath.Join(dir, "cardd.db")
	var out bytes.Buffer
	// stdin is never read.
	if err := runWithStdin(restoreArgs(t, db, "-fresh"), strings.NewReader("ignored"), &out); err != nil {
		t.Fatal(err)
	}
	if left := leftovers(t, dir, "cardd.db"); left != nil {
		t.Fatalf("left beside it: %v", left)
	}
	if info, _ := os.Stat(db); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode())
	}
	st, err := store.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	meta, _ := st.ListMeta(ctx)
	want := map[string]string{
		"vm.id": "1003", "vm.host": "vm-1003.lnvps.cloud", "vm.ipv4": "45.67.89.170",
		"restore.from": "phrase", "restore.reconcile": "pending",
	}
	if fmt.Sprint(meta) != fmt.Sprint(want) {
		t.Fatalf("meta %v", meta)
	}
	if cs, _ := st.ListCards(ctx); len(cs) != 0 {
		t.Fatalf("cards %v", cs)
	}
	if _, err := st.GetDevice(ctx, v.KeyID); err == nil {
		t.Fatal("a fresh database has this phone already: device add adds it")
	}
	out.Reset()
	if err := runWithStdin(restoreArgs(t, db, "-fresh"), nil, &out); err != nil || out.String() != "already restored\n" {
		t.Fatalf("repeat: %q %v", out.String(), err)
	}
}

// The phone and the new VM are named in full before anything is read, so the
// first snapshot names the new VM (one taken before the install's meta step
// had no vm.id).
func TestRestoreNeedsTheDeviceAndTheVM(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "cardd.db")
	var out bytes.Buffer
	for _, device := range []string{"", "04abcd"} {
		args := append([]string{"restore", "-db", db, "-fresh", "-device", device}, newVM...)
		if err := runWithStdin(args, nil, &out); err == nil {
			t.Fatalf("-device %q accepted", device)
		}
	}
	device := testvec.Load(t).DeviceAuth.PublicKey
	for _, vm := range [][]string{
		{"-vm-id", "", "-vm-host", "vm-1003.lnvps.cloud", "-vm-ipv4", "45.67.89.170"},
		{"-vm-id", "20x", "-vm-host", "vm-1003.lnvps.cloud", "-vm-ipv4", "45.67.89.170"},
		{"-vm-id", "1003", "-vm-host", "", "-vm-ipv4", "45.67.89.170"},
		{"-vm-id", "1003", "-vm-host", "vm-1003.lnvps.cloud", "-vm-ipv4", ""},
	} {
		for _, fresh := range [][]string{{"-fresh"}, nil} {
			args := append(append([]string{"restore", "-db", db, "-device", device}, vm...), fresh...)
			if err := runWithStdin(args, bytes.NewReader(backupOf(t, false)), &out); err == nil {
				t.Fatalf("%v accepted", args[5:])
			}
		}
	}
	if left := leftovers(t, dir); left != nil {
		t.Fatalf("left behind: %v", left)
	}
}

// cardd backup now: the final snapshot of a server being retired, beside
// cardd serve's own.
func TestBackupNow(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "cardd.db")
	var out bytes.Buffer
	run([]string{"meta", "set", "-db", db, "backup.recipient", ""}, &out)
	err := run([]string{"backup", "now", "-db", db}, &out)
	if err == nil || !strings.Contains(err.Error(), "no backup key yet") {
		t.Fatalf("without a recipient: %v", err)
	}
	run([]string{"meta", "set", "-db", db, "backup.recipient", testvec.Load(t).Phrase.BackupAgeRecipient}, &out)
	for i, want := range []int64{1, 1, 2} {
		if i == 2 {
			run([]string{"meta", "set", "-db", db, "vm.id", "1009"}, &out)
		}
		out.Reset()
		if err := run([]string{"backup", "now", "-db", db}, &out); err != nil {
			t.Fatal(err)
		}
		var got struct{ Version, Created int64 }
		if err := json.Unmarshal(out.Bytes(), &got); err != nil || got.Version != want || got.Created == 0 {
			t.Fatalf("take %d: %q %v", i+1, out.String(), err)
		}
		if _, err := os.Stat(filepath.Join(dir, "backups", fmt.Sprintf("%d.age", want))); err != nil {
			t.Fatal(err)
		}
	}
}
