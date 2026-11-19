package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"maps"
	"path/filepath"
	"testing"
	"time"
)

// oldDatabase makes a database as an older cardd wrote it (user_version
// 3), with one active card and, unless vmHost is empty, meta vm.host.
func oldDatabase(t *testing.T, vmHost string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, m := range migrations[:3] {
		if _, err := db.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`PRAGMA user_version = 3`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO cards (id, version, state, last_counter, name, created_at, updated_at)
		VALUES (?, 2, 'active', 7, 'Daily', 1, 1)`, id); err != nil {
		t.Fatal(err)
	}
	if vmHost != "" {
		if _, err := db.Exec(`INSERT INTO meta (key, value, updated_at) VALUES ('vm.host', ?, 1)`, vmHost); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

// A backup from an older schema (version 3), opened by cardd restore, is migrated: its
// cards take the database's own vm.host, the host their URLs point at.
func TestMigrationFillsCardHostFromVMHost(t *testing.T) {
	ctx := context.Background()
	for _, vmHost := range []string{"vm-1009.lnvps.cloud", ""} {
		s, err := Open(oldDatabase(t, vmHost))
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		if c, err := s.GetCard(ctx, id); err != nil || c.Host != vmHost || c.Version != 2 || c.LastCounter != 7 {
			t.Fatalf("vm.host %q: %+v %v", vmHost, c, err)
		}
		if v, err := s.UserVersion(ctx); err != nil || v != SchemaVersion() {
			t.Fatalf("vm.host %q: user_version %d %v, want %d", vmHost, v, err, SchemaVersion())
		}
	}
}

func TestANewDatabaseIsAtTheSchemaVersion(t *testing.T) {
	if v, err := open(t).UserVersion(context.Background()); err != nil || v != SchemaVersion() {
		t.Fatalf("user_version %d %v, want %d", v, err, SchemaVersion())
	}
}

// The new VM a test restores onto.
var newVM = RestoredVM{ID: "1003", Host: "vm-1003.lnvps.cloud", IPv4: "45.67.89.170"}

// cardd restore prepares the restored database: the old VM's
// facts give way to the new VM's, so its first snapshot names it; hosting
// state goes, except the last renewal hold counted, so it isn't counted
// again; the restore is marked pending and the last one's state cleared; the
// restoring phone's key works again, and the other phones are left for
// revoke-others.
func TestPrepareRestored(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.SetMetas(ctx, map[string]string{
		"vm.id": "1009", "vm.host": "vm-1009.lnvps.cloud", "vm.ipv4": "45.67.89.10",
		"hosting.expires_est": "1790000000", "hosting.msat_per_day": "221395", "hosting.counted_hold": "12",
		"restore.from": "a1b2 3 1780000000", "restore.reconcile": "done", "restore.reconciled": "-5000 1780000000",
		"restore.waiting_since": "1780000000",
		"mailtm.address":        "f6ygjrifabn6ne2s@uberip.com",
		"wallet.name":           "Pixel 9a",
	})
	phone := Device{KeyID: "b18b86ce1389e46d", PublicKey: "04aa", Name: "Pixel"}
	old := Device{KeyID: "0123456789abcdef", PublicKey: "04bb", Name: "Old phone"}
	gone := Device{KeyID: "fedcba9876543210", PublicKey: "04cc", Name: "Lost phone"}
	for _, d := range []Device{phone, old, gone} {
		s.AddDevice(ctx, d)
	}
	s.RevokeDevice(ctx, phone.KeyID)
	s.RevokeDevice(ctx, gone.KeyID)

	if err := s.PrepareRestored(ctx, "c3d4 7 1790000000", phone.PublicKey, newVM); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"vm.id": "1003", "vm.host": "vm-1003.lnvps.cloud", "vm.ipv4": "45.67.89.170",
		"hosting.counted_hold": "12",
		"restore.from":         "c3d4 7 1790000000",
		"restore.reconcile":    "pending",
		"mailtm.address":       "f6ygjrifabn6ne2s@uberip.com",
		"wallet.name":          "Pixel 9a",
	}
	if all, _ := s.ListMeta(ctx); !maps.Equal(all, want) {
		t.Fatalf("meta: %v", all)
	}
	for _, d := range []struct {
		keyID   string
		revoked bool
	}{{phone.KeyID, false}, {old.KeyID, false}, {gone.KeyID, true}} {
		if got, _ := s.GetDevice(ctx, d.keyID); (got.RevokedAt != nil) != d.revoked {
			t.Errorf("%s: revoked at %v", d.keyID, got.RevokedAt)
		}
	}

	// Phrase only: an empty database, which doesn't know the phone.
	s = open(t)
	if err := s.PrepareRestored(ctx, "phrase", phone.PublicKey, newVM); err != nil {
		t.Fatal(err)
	}
	want = map[string]string{
		"vm.id": "1003", "vm.host": "vm-1003.lnvps.cloud", "vm.ipv4": "45.67.89.170",
		"restore.from": "phrase", "restore.reconcile": "pending",
	}
	if all, _ := s.ListMeta(ctx); !maps.Equal(all, want) {
		t.Fatalf("phrase only: %v", all)
	}

	// A VM not named in full is refused, and nothing changes.
	s = open(t)
	s.SetMetas(ctx, map[string]string{"vm.id": "1009", "hosting.expires_est": "1790000000"})
	for _, vm := range []RestoredVM{{Host: newVM.Host, IPv4: newVM.IPv4}, {ID: newVM.ID, IPv4: newVM.IPv4}, {ID: newVM.ID, Host: newVM.Host}} {
		if err := s.PrepareRestored(ctx, "phrase", phone.PublicKey, vm); err == nil {
			t.Fatalf("%+v: no error", vm)
		}
	}
	if all, _ := s.ListMeta(ctx); !maps.Equal(all, map[string]string{"vm.id": "1009", "hosting.expires_est": "1790000000"}) {
		t.Fatalf("changed by a refused restore: %v", all)
	}
}

// The books are set after a restore once, from the state the ledger saw, in
// one transaction with the record of it, and never with a payment in progress.
func TestSetRestoreBooks(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	at := time.Unix(1790000600, 0)
	if err := s.SetRestoreBooks(ctx, "pending", 5_000, "restore", at, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("no restore: %v", err)
	}
	s.PrepareRestored(ctx, "phrase", "", newVM)
	s.SetMeta(ctx, "restore.waiting_since", "1790000000")
	s.Credit(ctx, Pool, 10_000, "p", "")
	h, err := s.OpenHold(ctx, HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 1_000, PaymentHash: "aa", Invoice: "lnbc1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetRestoreBooks(ctx, "pending", 5_000, "restore", at, false); !errors.Is(err, ErrPaymentInProgress) {
		t.Fatalf("with a payment in progress: %v", err)
	}
	s.ReleaseHold(ctx, h.ID)
	if err := s.SetRestoreBooks(ctx, "no_channel", 5_000, "restore", at, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("from another state: %v", err)
	}
	if err := s.SetRestoreBooks(ctx, "pending", -5_000, "restore", at, false); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"vm.id": "1003", "vm.host": "vm-1003.lnvps.cloud", "vm.ipv4": "45.67.89.170",
		"restore.from": "phrase", "restore.reconcile": "done", "restore.reconciled": "-5000 1790000600",
	}
	if all, _ := s.ListMeta(ctx); !maps.Equal(all, want) {
		t.Fatalf("meta: %v", all)
	}
	if err := s.SetRestoreBooks(ctx, "pending", -5_000, "restore", at, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("again: %v", err)
	}
	if b, _ := s.Balance(ctx, Pool); b.EntriesMsat != 5_000 {
		t.Fatalf("pool %+v", b)
	}
	// A channel still to come: remembered once, booked once more.
	s = open(t)
	s.PrepareRestored(ctx, "phrase", "", newVM)
	if err := s.SetRestoreBooks(ctx, "channel_later", 1_000, "restore", at, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("channel_later before done: %v", err)
	}
	if err := s.SetRestoreBooks(ctx, "pending", 0, "restore", at, false); err != nil {
		t.Fatal(err)
	}
	if err := s.SetRestoreBooks(ctx, "channel_later", 1_000, "restore", at, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("channel_later without the key: %v", err)
	}
	s = open(t)
	s.PrepareRestored(ctx, "phrase", "", newVM)
	if err := s.SetRestoreBooks(ctx, "pending", 0, "restore", at, true); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.GetMeta(ctx, "restore.channel_later"); v != "1" {
		t.Fatalf("channel_later %q", v)
	}
	// The late channel's books, an hour on, keep the time the books were first set: the app counts from it.
	if err := s.SetRestoreBooks(ctx, "channel_later", 2_000, "restore", at.Add(time.Hour), false); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.GetMeta(ctx, "restore.reconciled"); v != fmt.Sprintf("2000 %d", at.Unix()) {
		t.Fatalf("restore.reconciled %q", v)
	}
	if _, err := s.GetMeta(ctx, "restore.channel_later"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("key kept: %v", err)
	}
	if err := s.SetRestoreBooks(ctx, "channel_later", 2_000, "restore", at, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("channel_later twice: %v", err)
	}
	if b, _ := s.Balance(ctx, Pool); b.EntriesMsat != 2_000 {
		t.Fatalf("pool %+v", b)
	}
	// Nothing to book: the record only.
	s = open(t)
	s.PrepareRestored(ctx, "phrase", "", newVM)
	if err := s.SetRestoreBooks(ctx, "pending", 0, "restore", at, false); err != nil {
		t.Fatal(err)
	}
	if txs, _ := s.History(ctx, Pool, 0, 10); len(txs) != 0 {
		t.Fatalf("booked %+v", txs)
	}
}

// A restore and the point of sale: the PoS phones are as
// the backup has them, a removed one stays removed even if its key is the
// one given, a sale still open is expired (its invoice was the old
// phoenixd's), and the fee credit cardd had accounted for is forgotten: the
// rebuilt server's phoenixd may be a new node.
func TestPrepareRestoredAndThePointOfSale(t *testing.T) {
	ctx := context.Background()
	s, now := tills(t)
	wallet := Device{KeyID: "b18b86ce1389e46d", PublicKey: "04aa", Name: "Pixel"}
	s.AddDevice(ctx, wallet)
	s.RevokeDevice(ctx, wallet.KeyID)
	if err := s.RevokePosPhone(ctx, till2); err != nil {
		t.Fatal(err)
	}
	sale(t, s, saleA, till1, 1_000_000)
	paid(t, s, saleA, 1_000_000)
	sale(t, s, saleB, till1, 2_000_000)
	s.CancelSale(ctx, saleB, till1)
	*now = now.Add(time.Minute)
	sale(t, s, saleC, till1, 3_000_000) // still open when the backup was made
	s.SetKeptFeeCredit(ctx, 4_321)
	s.NewPosCode(ctx, "code-hash", "Till 3", now.Add(10*time.Minute))

	// The removed PoS phone's key given as the restoring phone's brings nothing back.
	if err := s.PrepareRestored(ctx, "c3d4 7 1790000000", "04"+till2, newVM); err != nil {
		t.Fatal(err)
	}
	if err := s.PrepareRestored(ctx, "c3d4 7 1790000000", wallet.PublicKey, newVM); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]struct {
		role    Role
		revoked bool
	}{wallet.KeyID: {RoleOwner, false}, till1: {RolePos, false}, till2: {RolePos, true}} {
		if d, err := s.GetDevice(ctx, id); err != nil || d.Role != want.role || (d.RevokedAt != nil) != want.revoked {
			t.Fatalf("%s: %+v %v", id, d, err)
		}
	}
	for id, want := range map[string]SaleState{saleA: SalePaid, saleB: SaleCancelled, saleC: SaleExpired} {
		if got, err := s.SaleByID(ctx, id); err != nil || got.State != want {
			t.Fatalf("%s: %q %v, want %q", id, got.State, err, want)
		}
	}
	if _, known, err := s.KeptFeeCredit(ctx); err != nil || known {
		t.Fatalf("the kept fee credit after a restore: known %v %v", known, err)
	}
	if got := available(t, s, Shop); got != 1_000_000 {
		t.Fatalf("shop %d", got)
	}
	if at, ok, _ := s.RestoredAt(ctx); !ok || !at.Equal(*now) {
		t.Fatalf("restored at %v %v", at, ok)
	}
}

// A restored database's cards are as the backup had them: their counters
// may be behind the cards', so taps recorded after the backup would pass.
// cardd restore marks every card that could spend again (active or frozen)
// as needing a check, which only its owner's phone gives; a card being set
// up, wiped or being wiped is left alone, since it can't spend.
func TestPrepareRestoredMarksCardsForACheck(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	const active, frozen, programming, wiping, reset = "a0", "f0", "p0", "w0", "r0"
	for _, c := range []string{active, frozen, programming, wiping, reset} {
		if _, err := s.ReserveCard(ctx, c, "", "vm-1009.lnvps.cloud"); err != nil {
			t.Fatal(err)
		}
		if c != programming {
			if _, err := s.ActivateCard(ctx, c, 4); err != nil {
				t.Fatal(err)
			}
		}
	}
	s.FreezeCard(ctx, frozen)
	s.StartWipe(ctx, wiping)
	s.StartWipe(ctx, reset)
	s.FinishWipe(ctx, reset)
	if c, _ := s.GetCard(ctx, active); c.NeedsCheck {
		t.Fatal("a card needs a check before any restore")
	}
	if err := s.PrepareRestored(ctx, "c3d4 7 1790000000", "04aa", newVM); err != nil {
		t.Fatal(err)
	}
	for c, want := range map[string]bool{active: true, frozen: true, programming: false, wiping: false, reset: false} {
		got, err := s.GetCard(ctx, c)
		if err != nil || got.NeedsCheck != want {
			t.Errorf("%s: %+v %v, want needs a check %v", c, got, err, want)
		}
	}
	// The states and counters themselves are as the backup had them.
	if c, _ := s.GetCard(ctx, frozen); c.State != StateFrozen || c.LastCounter != 4 {
		t.Fatalf("frozen: %+v", c)
	}
}

// The owner's check clears the mark and moves the counter to the card's: a
// tap at or below the counter the server has is refused, and leaves the mark.
func TestCheckCounterClearsTheMark(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.ReserveCard(ctx, id, "", "vm-1009.lnvps.cloud")
	s.ActivateCard(ctx, id, 4)
	if err := s.PrepareRestored(ctx, "backup", "04aa", newVM); err != nil {
		t.Fatal(err)
	}
	// A tap's counter is never moved on for it, however far on (cards.Service.Spend refuses it first).
	if err := s.AdvanceCounter(ctx, id, 40); !errors.Is(err, ErrConflict) {
		t.Fatalf("a tap's counter: %v", err)
	}
	if err := s.CheckCounter(ctx, id, 4); !errors.Is(err, ErrReplayed) {
		t.Fatalf("the backup's own counter: %v", err)
	}
	if c, _ := s.GetCard(ctx, id); !c.NeedsCheck || c.LastCounter != 4 {
		t.Fatalf("after a refused check: %+v", c)
	}
	if err := s.CheckCounter(ctx, id, 30); err != nil {
		t.Fatal(err)
	}
	if c, _ := s.GetCard(ctx, id); c.NeedsCheck || c.LastCounter != 30 {
		t.Fatalf("after the check: %+v", c)
	}
	if err := s.CheckCounter(ctx, "nope", 31); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown card: %v", err)
	}
}

// A card wiped and added again has new keys: the taps recorded before are
// another version's, so it starts without the mark.
func TestReserveAfterResetClearsTheMark(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.ReserveCard(ctx, id, "", "vm-1009.lnvps.cloud")
	s.ActivateCard(ctx, id, 4)
	if err := s.PrepareRestored(ctx, "backup", "04aa", newVM); err != nil {
		t.Fatal(err)
	}
	s.StartWipe(ctx, id)
	s.FinishWipe(ctx, id)
	c, err := s.ReserveCard(ctx, id, "", newVM.Host)
	if err != nil || c.NeedsCheck || c.Version != 1 {
		t.Fatalf("re-added: %+v %v", c, err)
	}
	if c, err := s.ActivateCard(ctx, id, 1); err != nil || c.NeedsCheck {
		t.Fatalf("activated: %+v %v", c, err)
	}
}
