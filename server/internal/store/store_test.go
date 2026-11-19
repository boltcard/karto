package store

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "cardd.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

const id = "e07ce1279d980ecb892a81924b67bf18"

func TestReopenKeepsData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cardd.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReserveCard(context.Background(), id, "", ""); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.GetCard(context.Background(), id); err != nil {
		t.Fatalf("card lost after reopen: %v", err)
	}
}

func TestReserveVersions(t *testing.T) {
	ctx := context.Background()
	s := open(t)

	c, err := s.ReserveCard(ctx, id, "", "")
	if err != nil || c.Version != 0 || c.State != StateProgramming || c.LastCounter != -1 {
		t.Fatalf("new card: %+v %v", c, err)
	}
	// A retry while still programming keeps the same version.
	if c, _ = s.ReserveCard(ctx, id, "", ""); c.Version != 0 {
		t.Fatalf("retry changed version to %d", c.Version)
	}
	if _, err := s.ActivateCard(ctx, id, 3); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReserveCard(ctx, id, "", ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("reserving an active card: got %v, want ErrConflict", err)
	}
	// Simulate a finished wipe.
	if _, err := s.db.Exec(`UPDATE cards SET state = 'reset' WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	c, err = s.ReserveCard(ctx, id, "", "")
	if err != nil || c.Version != 1 || c.State != StateProgramming || c.LastCounter != -1 {
		t.Fatalf("after reset: %+v %v", c, err)
	}
}

func TestActivateNeedsProgramming(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if _, err := s.ActivateCard(ctx, id, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown card: got %v", err)
	}
	s.ReserveCard(ctx, id, "", "")
	c, err := s.ActivateCard(ctx, id, 1)
	if err != nil || c.State != StateActive || c.LastCounter != 1 {
		t.Fatalf("activate: %+v %v", c, err)
	}
	if _, err := s.ActivateCard(ctx, id, 2); !errors.Is(err, ErrConflict) {
		t.Fatalf("second activate: got %v, want ErrConflict", err)
	}
}

func TestAdvanceCounter(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.ReserveCard(ctx, id, "", "")
	s.ActivateCard(ctx, id, 5)
	if err := s.AdvanceCounter(ctx, id, 5); !errors.Is(err, ErrReplayed) {
		t.Fatalf("same counter: got %v", err)
	}
	if err := s.AdvanceCounter(ctx, id, 4); !errors.Is(err, ErrReplayed) {
		t.Fatalf("lower counter: got %v", err)
	}
	if err := s.AdvanceCounter(ctx, id, 6); err != nil {
		t.Fatal(err)
	}
	if err := s.AdvanceCounter(ctx, "00000000000000000000000000000000", 9); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown card: got %v", err)
	}
}

// Two terminals submitting the same tap at once: exactly one may win.
func TestAdvanceCounterRace(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.ReserveCard(ctx, id, "", "")
	s.ActivateCard(ctx, id, 1)
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok := 0
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.AdvanceCounter(ctx, id, 7); err == nil {
				mu.Lock()
				ok++
				mu.Unlock()
			} else if !errors.Is(err, ErrReplayed) {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if ok != 1 {
		t.Fatalf("%d requests succeeded, want exactly 1", ok)
	}
}

func TestDevices(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	d := Device{KeyID: "b18b86ce1389e46d", PublicKey: "04aa", Name: "Pixel"}
	if err := s.AddDevice(ctx, d); err != nil {
		t.Fatal(err)
	}
	if err := s.AddDevice(ctx, d); err == nil {
		t.Fatal("duplicate device accepted")
	}
	got, err := s.GetDevice(ctx, d.KeyID)
	if err != nil || got.Name != "Pixel" || got.RevokedAt != nil {
		t.Fatalf("get: %+v %v", got, err)
	}
	if err := s.RevokeDevice(ctx, d.KeyID); err != nil {
		t.Fatal(err)
	}
	if err := s.RevokeDevice(ctx, d.KeyID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second revoke: got %v", err)
	}
	if got, _ = s.GetDevice(ctx, d.KeyID); got.RevokedAt == nil {
		t.Fatal("device not marked revoked")
	}
	list, _ := s.ListDevices(ctx)
	if len(list) != 1 {
		t.Fatalf("list: %d devices", len(list))
	}
}

// A confirming tap older than one already seen must not move the counter back.
func TestActivateRejectsOlderCounter(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.ReserveCard(ctx, id, "", "")
	if err := s.AdvanceCounter(ctx, id, 5); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ActivateCard(ctx, id, 2); !errors.Is(err, ErrReplayed) {
		t.Fatalf("got %v, want ErrReplayed", err)
	}
	if c, _ := s.GetCard(ctx, id); c.LastCounter != 5 || c.State != StateProgramming {
		t.Fatalf("card changed: %+v", c)
	}
}

// Names, the card list and the wipe transitions.
func TestNamesListAndWipe(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if c, err := s.ReserveCard(ctx, id, "Daily", ""); err != nil || c.Name != "Daily" {
		t.Fatalf("reserve with a name: %+v %v", c, err)
	}
	// A retry without a name keeps it; a retry with one replaces it.
	if c, _ := s.ReserveCard(ctx, id, "", ""); c.Name != "Daily" {
		t.Fatalf("retry without a name: %q", c.Name)
	}
	if c, _ := s.ReserveCard(ctx, id, "Spare", ""); c.Name != "Spare" || c.Version != 0 {
		t.Fatalf("retry with a name: %+v", c)
	}
	other := "0123456789abcdef0123456789abcdef"
	if _, err := s.ReserveCard(ctx, other, "", ""); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListCards(ctx)
	if err != nil || len(list) != 2 || list[0].ID != id || list[1].ID != other {
		t.Fatalf("list: %+v %v", list, err)
	}
	if c, err := s.RenameCard(ctx, id, "Kids"); err != nil || c.Name != "Kids" {
		t.Fatalf("rename: %+v %v", c, err)
	}

	// Active, frozen and programming cards can start a wipe; every step can be repeated.
	if _, err := s.ActivateCard(ctx, id, 3); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if c, err := s.StartWipe(ctx, id); err != nil || c.State != StateWiping {
			t.Fatalf("start wipe #%d: %+v %v", i, c, err)
		}
	}
	if c, err := s.StartWipe(ctx, other); err != nil || c.State != StateWiping {
		t.Fatalf("wiping a card still programming: %+v %v", c, err)
	}
	for i := 0; i < 2; i++ {
		if c, err := s.FinishWipe(ctx, id); err != nil || c.State != StateReset || c.Version != 0 {
			t.Fatalf("finish wipe #%d: %+v %v", i, c, err)
		}
	}
	// A reset card can't start a wipe or be renamed; an unknown one is not found.
	if _, err := s.StartWipe(ctx, id); !errors.Is(err, ErrConflict) {
		t.Fatalf("wiping a reset card: got %v, want ErrConflict", err)
	}
	if _, err := s.RenameCard(ctx, id, "x"); !errors.Is(err, ErrConflict) {
		t.Fatalf("renaming a reset card: got %v, want ErrConflict", err)
	}
	if _, err := s.StartWipe(ctx, "ffffffffffffffffffffffffffffffff"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown card: got %v, want ErrNotFound", err)
	}
	// Programmed again at the next version, keeping its name unless given a new one.
	if c, _ := s.ReserveCard(ctx, id, "", ""); c.Version != 1 || c.Name != "Kids" || c.State != StateProgramming {
		t.Fatalf("reserve after a wipe: %+v", c)
	}
}

// Finishing a wipe that was never started is refused: the card could still hold money.
func TestFinishWipeNeedsWiping(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.ReserveCard(ctx, id, "", "")
	s.ActivateCard(ctx, id, 1)
	if _, err := s.FinishWipe(ctx, id); !errors.Is(err, ErrConflict) {
		t.Fatalf("got %v, want ErrConflict", err)
	}
}

// Each card keeps the host its URL points at: set when it is
// reserved, again on a retry and after a wipe.
func TestReserveSetsHost(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if c, err := s.ReserveCard(ctx, id, "", "vm-1009.lnvps.cloud"); err != nil || c.Host != "vm-1009.lnvps.cloud" {
		t.Fatalf("new card: %+v %v", c, err)
	}
	if c, _ := s.ReserveCard(ctx, id, "", "vm-1006.lnvps.cloud"); c.Host != "vm-1006.lnvps.cloud" || c.Version != 0 {
		t.Fatalf("retry: %+v", c)
	}
	s.ActivateCard(ctx, id, 1)
	s.StartWipe(ctx, id)
	s.FinishWipe(ctx, id)
	if c, _ := s.ReserveCard(ctx, id, "", "vm-1004.lnvps.cloud"); c.Host != "vm-1004.lnvps.cloud" || c.Version != 1 {
		t.Fatalf("after a wipe: %+v", c)
	}
	if list, _ := s.ListCards(ctx); len(list) != 1 || list[0].Host != "vm-1004.lnvps.cloud" {
		t.Fatalf("list: %+v", list)
	}
}

// A re-pointed card's host is set in any state but reset.
func TestSetCardHost(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	activeCard(t, s, id)
	if c, err := s.SetCardHost(ctx, id, "vm-1006.lnvps.cloud"); err != nil || c.Host != "vm-1006.lnvps.cloud" || c.State != StateActive {
		t.Fatalf("active: %+v %v", c, err)
	}
	s.FreezeCard(ctx, id)
	if c, err := s.SetCardHost(ctx, id, "vm-1004.lnvps.cloud"); err != nil || c.Host != "vm-1004.lnvps.cloud" || c.State != StateFrozen {
		t.Fatalf("frozen: %+v %v", c, err)
	}
	s.StartWipe(ctx, id)
	s.FinishWipe(ctx, id)
	if _, err := s.SetCardHost(ctx, id, "vm-1008.lnvps.cloud"); !errors.Is(err, ErrConflict) {
		t.Fatalf("reset: got %v, want ErrConflict", err)
	}
	if c, _ := s.GetCard(ctx, id); c.Host != "vm-1004.lnvps.cloud" {
		t.Fatalf("reset card's host changed: %+v", c)
	}
	if _, err := s.SetCardHost(ctx, "ffffffffffffffffffffffffffffffff", "vm-1008.lnvps.cloud"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown card: got %v, want ErrNotFound", err)
	}
}

// After a phrase-only rebuild a tapped card is added back as active at its
// version, with the tap's counter; a card already known is refused.
func TestAdoptCard(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	c, err := s.AdoptCard(ctx, id, 3, "Daily", 41, "vm-1006.lnvps.cloud")
	if err != nil || c.Version != 3 || c.State != StateActive || c.LastCounter != 41 || c.Name != "Daily" ||
		c.Host != "vm-1006.lnvps.cloud" || c.PerTapSat != 20000 {
		t.Fatalf("adopt: %+v %v", c, err)
	}
	// The tap that adopted it can't be replayed.
	if err := s.AdvanceCounter(ctx, id, 41); !errors.Is(err, ErrReplayed) {
		t.Fatalf("the adopting tap again: got %v, want ErrReplayed", err)
	}
	if _, err := s.AdoptCard(ctx, id, 4, "", 50, "vm-1006.lnvps.cloud"); !errors.Is(err, ErrConflict) {
		t.Fatalf("adopting a known card: got %v, want ErrConflict", err)
	}
	if c, _ := s.GetCard(ctx, id); c.Version != 3 || c.LastCounter != 41 {
		t.Fatalf("known card changed: %+v", c)
	}
}

// A database migrated to 12 by another branch's cardd, which numbered a
// different change 12, has no push_endpoints: Open refuses it, saying so,
// instead of revoke and restore failing on it later.
func TestOpenRefusesAnotherCarddsMigration12(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cardd.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DROP TABLE push_endpoints`); err != nil {
		t.Fatal(err)
	}
	if v, err := s.UserVersion(context.Background()); err != nil || v != SchemaVersion() {
		t.Fatalf("user_version %d, %v; want %d", v, err, SchemaVersion())
	}
	s.Close()
	s, err = Open(path)
	if err == nil {
		s.Close()
		t.Fatal("opened a database without push_endpoints")
	}
	if want := "the database's migration 12 is not this cardd's: it has no push_endpoints table"; err.Error() != want {
		t.Fatalf("err %q, want %q", err, want)
	}
}

// A database another build of cardd migrated to 13 has no recent_removed table.
func TestOpenRefusesAnotherCarddsMigration13(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cardd.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DROP TABLE recent_removed`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err == nil {
		s.Close()
		t.Fatal("opened a database without recent_removed")
	}
	if want := "the database's migration 13 is not this cardd's: it has no recent_removed table"; err.Error() != want {
		t.Fatalf("err %q, want %q", err, want)
	}
}

// A database another build of cardd migrated to 16 has no cards.needs_check column.
func TestOpenRefusesAnotherCarddsMigration16(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cardd.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`ALTER TABLE cards DROP COLUMN needs_check`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err == nil {
		s.Close()
		t.Fatal("opened a database without cards.needs_check")
	}
	if want := "the database's migration 16 is not this cardd's: it has no cards.needs_check column"; err.Error() != want {
		t.Fatalf("err %q, want %q", err, want)
	}
}
