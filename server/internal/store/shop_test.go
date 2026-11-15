package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

// shopMoney puts msat in shop as a sale's transaction does, before the sales
// themselves exist.
func shopMoney(t *testing.T, s *Store, msat int64, ref string) {
	t.Helper()
	ctx := context.Background()
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		_, err := s.post(ctx, tx, s.now().Unix(), KindSale, ref, "a sale", Entry{World, -msat}, Entry{Shop, msat})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

// Migration 6 on a database the cardd before it
// wrote: every device there is an owner, the books are as they were, and the
// tables of the point of sale exist.
func TestMigrationSixOnASchemaFiveDatabase(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range migrations[:5] {
		if _, err := db.Exec(m); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`PRAGMA user_version = 5;
		INSERT INTO devices (key_id, public_key, name, created_at) VALUES ('b18b86ce1389e46d', '04aa', 'Pixel', 1), ('c18b86ce1389e46d', '04bb', 'Lost', 1);
		UPDATE devices SET revoked_at = 2 WHERE key_id = 'c18b86ce1389e46d';
		INSERT INTO cards (id, version, state, last_counter, name, created_at, updated_at) VALUES ('` + id + `', 1, 'active', 1, 'Old', 1, 1);
		INSERT INTO ledger_tx (id, kind, ref, note, created_at) VALUES (1, 'topup', 'h1', '', 1), (2, 'topup', 'h2', '', 1);
		INSERT INTO ledger_entry (tx_id, account, amount_msat) VALUES (1, 'world', -5000), (1, 'card:` + id + `', 5000), (2, 'world', -7000), (2, 'pool', 7000)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, _ := s.UserVersion(ctx); v != SchemaVersion() {
		t.Fatalf("user_version %d, want %d", v, SchemaVersion())
	}
	list, err := s.ListDevices(ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("devices: %v %v", list, err)
	}
	for _, d := range list {
		if d.Role != RoleOwner {
			t.Fatalf("device %s has role %q, want owner", d.KeyID, d.Role)
		}
	}
	if owed, err := s.OwedMsat(ctx); err != nil || owed != 12_000 {
		t.Fatalf("owed %d %v, want the 12,000 msat it held", owed, err)
	}
	phones, sales, err := s.ShopCounts(ctx)
	if err != nil || phones != 0 || sales != 0 {
		t.Fatalf("shop counts %d %d %v", phones, sales, err)
	}
	var codes int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM pos_codes`).Scan(&codes); err != nil || codes != 0 {
		t.Fatalf("pos_codes: %d %v", codes, err)
	}
}

// Shop holds the person's money: it is in what phoenixd must cover, it moves
// out like any account's, and nothing moves into it.
func TestShopIsThePersonsMoneyAndOnlySalesFillIt(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	if _, err := s.Credit(ctx, Pool, 10_000, "p", ""); err != nil {
		t.Fatal(err)
	}
	shopMoney(t, s, 4_000, "s1")
	if got := available(t, s, Shop); got != 4_000 {
		t.Fatalf("shop has %d", got)
	}
	if owed, _ := s.OwedMsat(ctx); owed != 14_000 {
		t.Fatalf("owed %d, want pool's 10,000 and shop's 4,000", owed)
	}
	if l, _ := s.LiabilitiesMsat(ctx); l != 14_000 {
		t.Fatalf("liabilities %d, want 14,000", l)
	}
	for _, to := range []Account{Pool, Hosting, card} {
		if err := s.Move(ctx, Shop, to, 1_000, ""); err != nil {
			t.Fatalf("shop to %s: %v", to, err)
		}
	}
	if got := available(t, s, Shop); got != 1_000 {
		t.Fatalf("shop has %d after three moves out", got)
	}
	if err := s.Move(ctx, Shop, Pool, 1_001, ""); !errors.Is(err, ErrInsufficient) {
		t.Fatalf("more than shop holds: %v", err)
	}
	for _, from := range []Account{Pool, card} {
		if err := s.Move(ctx, from, Shop, 500, ""); !errors.Is(err, ErrCannotReceive) {
			t.Fatalf("%s to shop: got %v, want ErrCannotReceive", from, err)
		}
	}
	// A top-up addressed to shop (there is no such address) goes to pool, as for any account that can't receive.
	if _, err := s.Credit(ctx, Shop, 300, "t", "odd"); err != nil {
		t.Fatal(err)
	}
	if got := available(t, s, Shop); got != 1_000 {
		t.Fatalf("a top-up reached shop: %d", got)
	}
	if owed, _ := s.OwedMsat(ctx); owed != 14_300 {
		t.Fatalf("owed %d, want 14,300", owed)
	}
}

// A phone restored from the phrase takes the server over from the other
// owners; the PoS phones stay paired, and a PoS phone can't
// be the one kept.
func TestRevokeOthersLeavesPoSPhones(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	for _, d := range []Device{
		{KeyID: "aaaaaaaaaaaaaaaa", PublicKey: "04aa", Name: "New phone"},
		{KeyID: "bbbbbbbbbbbbbbbb", PublicKey: "04bb", Name: "Lost phone", Role: RoleOwner},
		{KeyID: "cccccccccccccccc", PublicKey: "04cc", Name: "Till 1", Role: RolePos},
		{KeyID: "dddddddddddddddd", PublicKey: "04dd", Name: "Till 2", Role: RolePos},
	} {
		if err := s.AddDevice(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.RevokeDevice(ctx, "dddddddddddddddd"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RevokeOthers(ctx, "cccccccccccccccc"); !errors.Is(err, ErrConflict) {
		t.Fatalf("keeping a PoS phone: got %v, want ErrConflict", err)
	}
	n, err := s.RevokeOthers(ctx, "aaaaaaaaaaaaaaaa")
	if err != nil || n != 1 {
		t.Fatalf("revoked %d %v, want the one other owner", n, err)
	}
	want := map[string]bool{"aaaaaaaaaaaaaaaa": false, "bbbbbbbbbbbbbbbb": true, "cccccccccccccccc": false, "dddddddddddddddd": true}
	list, _ := s.ListDevices(ctx)
	for _, d := range list {
		if (d.RevokedAt != nil) != want[d.KeyID] {
			t.Fatalf("%s (%s): revoked %v, want %v", d.Name, d.Role, d.RevokedAt != nil, want[d.KeyID])
		}
	}
	if d, _ := s.GetDevice(ctx, "cccccccccccccccc"); d.Role != RolePos {
		t.Fatalf("Till 1 reads back as %q", d.Role)
	}
	if phones, _, _ := s.ShopCounts(ctx); phones != 1 {
		t.Fatalf("%d PoS phones, want the one not revoked", phones)
	}
}
