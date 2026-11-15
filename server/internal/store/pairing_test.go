package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

// clock gives s a clock the test moves.
func clock(s *Store) *time.Time {
	now := time.Unix(1_790_000_000, 0)
	s.now = func() time.Time { return now }
	return &now
}

// A pairing code: one is open at a time, it lasts until
// its expiry, and it pairs one phone, once.
func TestAPosCodePairsOnePhoneOnce(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	now := clock(s)
	if err := s.NewPosCode(ctx, "hash-1", "Till 1", now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	// A second code replaces the first.
	if err := s.NewPosCode(ctx, "hash-2", "Till 1", now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PairPos(ctx, "hash-1", "aaaaaaaaaaaaaaaa", "04aa"); !errors.Is(err, ErrBadCode) {
		t.Fatalf("the replaced code: got %v, want ErrBadCode", err)
	}
	if _, err := s.PairPos(ctx, "hash-0", "aaaaaaaaaaaaaaaa", "04aa"); !errors.Is(err, ErrBadCode) {
		t.Fatalf("an unknown code: got %v", err)
	}
	*now = now.Add(10 * time.Minute) // its last second
	d, err := s.PairPos(ctx, "hash-2", "aaaaaaaaaaaaaaaa", "04aa")
	if err != nil || d.Role != RolePos || d.Name != "Till 1" || d.KeyID != "aaaaaaaaaaaaaaaa" || d.RevokedAt != nil {
		t.Fatalf("paired %+v %v", d, err)
	}
	if got, _ := s.GetDevice(ctx, "aaaaaaaaaaaaaaaa"); got.Role != RolePos || got.PublicKey != "04aa" {
		t.Fatalf("stored %+v", got)
	}
	if _, err := s.PairPos(ctx, "hash-2", "bbbbbbbbbbbbbbbb", "04bb"); !errors.Is(err, ErrBadCode) {
		t.Fatalf("the code a second time: got %v, want ErrBadCode", err)
	}
	// One that ran out, and one that was dropped.
	s.NewPosCode(ctx, "hash-3", "Till 2", now.Add(10*time.Minute))
	*now = now.Add(10*time.Minute + time.Second)
	if _, err := s.PairPos(ctx, "hash-3", "bbbbbbbbbbbbbbbb", "04bb"); !errors.Is(err, ErrBadCode) {
		t.Fatalf("a code past its time: got %v, want ErrBadCode", err)
	}
	s.NewPosCode(ctx, "hash-4", "Till 2", now.Add(10*time.Minute))
	if err := s.DropPosCodes(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PairPos(ctx, "hash-4", "bbbbbbbbbbbbbbbb", "04bb"); !errors.Is(err, ErrBadCode) {
		t.Fatalf("a dropped code: got %v, want ErrBadCode", err)
	}
	if list, _ := s.ListDevices(ctx); len(list) != 1 {
		t.Fatalf("%d devices, want the one that paired", len(list))
	}
}

// Whose key may pair: a new one; a removed PoS phone's, which is that phone
// again; never an owner's or a paired PoS phone's, and then the code is
// still good. A device's role never changes.
func TestWhoseKeyMayPair(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	now := clock(s)
	s.AddDevice(ctx, Device{KeyID: "0000000000000001", PublicKey: "0401", Name: "Wallet"})
	s.AddDevice(ctx, Device{KeyID: "0000000000000002", PublicKey: "0402", Name: "Lost wallet"})
	s.RevokeDevice(ctx, "0000000000000002")
	s.AddDevice(ctx, Device{KeyID: "0000000000000003", PublicKey: "0403", Name: "Till 1", Role: RolePos})
	s.AddDevice(ctx, Device{KeyID: "0000000000000004", PublicKey: "0404", Name: "Till 2", Role: RolePos})
	*now = now.Add(time.Hour)
	s.RevokeDevice(ctx, "0000000000000004")
	if err := s.NewPosCode(ctx, "hash", "Stall", now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	for _, known := range []string{"0000000000000001", "0000000000000002", "0000000000000003"} {
		if _, err := s.PairPos(ctx, "hash", known, "04"+known[14:]); !errors.Is(err, ErrKeyKnown) {
			t.Fatalf("%s: got %v, want ErrKeyKnown", known, err)
		}
	}
	for id, want := range map[string]Role{"0000000000000001": RoleOwner, "0000000000000002": RoleOwner, "0000000000000003": RolePos} {
		if d, _ := s.GetDevice(ctx, id); d.Role != want || (d.RevokedAt != nil) != (id == "0000000000000002") {
			t.Fatalf("%s changed: %+v", id, d)
		}
	}
	// A phone renamed to the code's name since the code was made: refused, the code still good.
	if err := s.RenamePosPhone(ctx, "0000000000000003", "Stall"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PairPos(ctx, "hash", "0000000000000009", "0409"); !errors.Is(err, ErrNameTaken) {
		t.Fatalf("a name taken since the code was made: got %v, want ErrNameTaken", err)
	}
	if err := s.RenamePosPhone(ctx, "0000000000000003", "Till 1"); err != nil {
		t.Fatal(err)
	}
	// The removed PoS phone pairs again with the same code: the same device, under the code's name, its first pairing's date kept.
	d, err := s.PairPos(ctx, "hash", "0000000000000004", "0404")
	if err != nil || d.Name != "Stall" || d.Role != RolePos || d.RevokedAt != nil || !d.CreatedAt.Equal(now.Add(-time.Hour)) {
		t.Fatalf("paired again: %+v %v", d, err)
	}
	if list, _ := s.ListDevices(ctx); len(list) != 4 {
		t.Fatalf("%d devices, want the same four", len(list))
	}
}

// A PoS phone's name: 1 to 24 characters after trimming, and not the name of
// a PoS phone that isn't removed.
func TestPosNames(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	now := clock(s)
	exp := now.Add(10 * time.Minute)
	s.AddDevice(ctx, Device{KeyID: "0000000000000001", PublicKey: "0401", Name: "Till 1", Role: RolePos})
	s.AddDevice(ctx, Device{KeyID: "0000000000000002", PublicKey: "0402", Name: "Old till", Role: RolePos})
	s.RevokeDevice(ctx, "0000000000000002")
	s.AddDevice(ctx, Device{KeyID: "0000000000000003", PublicKey: "0403", Name: "Wallet"})
	for _, bad := range []string{"", "   ", "1234567890123456789012345", "Till\n2"} {
		if err := s.NewPosCode(ctx, "h", bad, exp); !errors.Is(err, ErrBadPhoneName) {
			t.Fatalf("%q: got %v, want ErrBadPhoneName", bad, err)
		}
	}
	if err := s.NewPosCode(ctx, "h", "Till 1", exp); !errors.Is(err, ErrNameTaken) {
		t.Fatalf("a paired phone's name: got %v, want ErrNameTaken", err)
	}
	// A removed phone's name, an owner's name and a 24-character one are free; the name is kept trimmed.
	for _, ok := range []string{"Old till", "Wallet", "123456789012345678901234", "  Stall  "} {
		if err := s.NewPosCode(ctx, "h", ok, exp); err != nil {
			t.Fatalf("%q: %v", ok, err)
		}
	}
	if d, err := s.PairPos(ctx, "h", "0000000000000009", "0409"); err != nil || d.Name != "Stall" {
		t.Fatalf("paired %+v %v", d, err)
	}
}

// The PoS phones as Karto Wallet lists them, renamed and removed; an owner
// is never one of them.
func TestPosPhonesRenameAndRemove(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	now := clock(s)
	s.AddDevice(ctx, Device{KeyID: "0000000000000001", PublicKey: "0401", Name: "Wallet"})
	s.AddDevice(ctx, Device{KeyID: "0000000000000003", PublicKey: "0403", Name: "Till 1", Role: RolePos})
	*now = now.Add(time.Minute)
	s.AddDevice(ctx, Device{KeyID: "0000000000000002", PublicKey: "0402", Name: "Till 2", Role: RolePos})
	phones, err := s.PosPhones(ctx)
	if err != nil || len(phones) != 2 || phones[0].Name != "Till 1" || phones[1].Name != "Till 2" || phones[0].Sales != 0 || phones[0].LastSale != nil ||
		!phones[1].CreatedAt.Equal(*now) {
		t.Fatalf("phones: %+v %v", phones, err)
	}
	if err := s.RenamePosPhone(ctx, "0000000000000003", "Till 2"); !errors.Is(err, ErrNameTaken) {
		t.Fatalf("another phone's name: got %v", err)
	}
	if err := s.RenamePosPhone(ctx, "0000000000000003", " Till 1 "); err != nil {
		t.Fatalf("its own name: %v", err)
	}
	if err := s.RenamePosPhone(ctx, "0000000000000003", ""); !errors.Is(err, ErrBadPhoneName) {
		t.Fatalf("no name: got %v", err)
	}
	if err := s.RenamePosPhone(ctx, "0000000000000003", "Front"); err != nil {
		t.Fatal(err)
	}
	for _, notAPhone := range []string{"0000000000000001", "ffffffffffffffff"} {
		if err := s.RenamePosPhone(ctx, notAPhone, "X"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("rename %s: got %v, want ErrNotFound", notAPhone, err)
		}
		if err := s.RevokePosPhone(ctx, notAPhone); !errors.Is(err, ErrNotFound) {
			t.Fatalf("remove %s: got %v, want ErrNotFound", notAPhone, err)
		}
	}
	if err := s.RevokePosPhone(ctx, "0000000000000002"); err != nil {
		t.Fatal(err)
	}
	if err := s.RevokePosPhone(ctx, "0000000000000002"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed twice: got %v", err)
	}
	if err := s.RenamePosPhone(ctx, "0000000000000002", "Back"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("renaming a removed phone: got %v", err)
	}
	phones, _ = s.PosPhones(ctx)
	if len(phones) != 1 || phones[0].Name != "Front" {
		t.Fatalf("after: %+v", phones)
	}
	if d, _ := s.GetDevice(ctx, "0000000000000001"); d.RevokedAt != nil || d.Name != "Wallet" {
		t.Fatalf("the owner changed: %+v", d)
	}
}

// When the server was last restored, for the PoS phones page's note.
func TestRestoredAt(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	now := clock(s)
	if _, ok, err := s.RestoredAt(ctx); err != nil || ok {
		t.Fatalf("never restored: %v %v", ok, err)
	}
	s.SetMeta(ctx, "restore.from", "backup 12")
	if at, ok, err := s.RestoredAt(ctx); err != nil || !ok || !at.Equal(*now) {
		t.Fatalf("restored: %v %v %v", at, ok, err)
	}
}
