package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func snapshotVectorPath(name string) string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "testvectors", name)
}

// snapshotSummary is what the app reads from a snapshot before a rebuild
// restores it (app/src/backup/summary.ts): the total as OwedMsat works it
// out, and changed, the time of the database's last write.
type snapshotSummary struct {
	VMID        string `json:"vmId"`
	UserVersion int    `json:"userVersion"`
	Cards       int    `json:"cards"`
	TotalMsat   int64  `json:"totalMsat"`
	Changed     int64  `json:"changed"`
}

// writeSnapshotVector writes the snapshot cardd would take of a small
// database, its clock a minute on at each step: active cards, one being
// added and one reset after its wipe, money in cards, pool, hosting and shop, a
// settled spend (its fee and world legs aren't the person's), an open hold,
// a card's photo, and last a hosting sync. It returns the time of that last write.
func writeSnapshotVector(t *testing.T, path string) int64 {
	t.Helper()
	ctx := context.Background()
	s := open(t)
	step := time.Unix(1_790_000_000, 0)
	s.now = func() time.Time { step = step.Add(time.Minute); return step }
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	const a, b, c, d = "a0000000000000000000000000000001", "b0000000000000000000000000000002", "c0000000000000000000000000000003", "d0000000000000000000000000000004"
	must(s.SetMetas(ctx, map[string]string{"vm.id": "1004", "vm.host": "vm-1004.lnvps.cloud"}))
	for _, id := range []string{a, b, c} {
		activeCard(t, s, id)
	}
	_, err := s.ReserveCard(ctx, d, "New", "vm-1004.lnvps.cloud") // still programming
	must(err)
	_, err = s.Credit(ctx, CardAccount(a), 5_000_000, "hash-a", "")
	must(err)
	_, err = s.Credit(ctx, CardAccount(b), 3_000_000, "hash-b", "")
	must(err)
	_, err = s.Credit(ctx, CardAccount(c), 2_000_000, "hash-c", "")
	must(err)
	_, err = s.CreditMoving(ctx, Hosting, 1_500_000, 21_411_000, "hash-h", "received 1500 sat after 21411000 msat of channel fees", FeeCreditMove{}) // a three-leg top-up
	must(err)
	must(s.inTx(ctx, func(tx *sql.Tx) error { // a sale's 700 sat in shop
		_, err := s.post(ctx, tx, s.now().Unix(), KindSale, "hash-s", "a sale", Entry{World, -700_000}, Entry{Shop, 700_000})
		return err
	}))
	_, err = s.StartWipe(ctx, c) // its 2,000 sat to pool
	must(err)
	_, err = s.FinishWipe(ctx, c)
	must(err)
	h, err := s.OpenHold(ctx, HoldRequest{Account: CardAccount(a), Kind: KindSpend, AmountMsat: 400_000, FeeBudgetMsat: 5_000, PaymentHash: "pay-a"})
	must(err)
	_, err = s.SettleHold(ctx, h.ID, 1_234)
	must(err)
	_, err = s.Credit(ctx, Pool, 2_000_000, "hash-p", "")
	must(err)
	hs, err := s.OpenHold(ctx, HoldRequest{Account: Pool, Kind: KindSend, AmountMsat: 300_000, FeeBudgetMsat: 5_000, PaymentHash: "pay-p", Invoice: "lnbc1payp",
		About: HoldAbout{Destination: "alice@example.com", Description: "Coffee", Comment: "with Sam"}}) // what a payment was, in a backup
	must(err)
	_, err = s.SettleHoldWithProof(ctx, hs.ID, 1_000, strings.Repeat("cd", 32))
	must(err)
	_, err = s.OpenHold(ctx, HoldRequest{Account: CardAccount(b), Kind: KindSpend, AmountMsat: 1_000_000, FeeBudgetMsat: 10_000, PaymentHash: "pay-b"})
	must(err)
	_, err = s.SetPhoto(ctx, a, []byte{0xff, 0xd8, 0xff, 0xd9}) // the smallest JPEG-shaped bytes: the store doesn't decode
	must(err)
	must(s.SetMeta(ctx, "hosting.synced_at", "1790000000"))
	os.Remove(path)
	must(s.SnapshotTo(ctx, path))
	return step.Unix()
}

// summarize reads a snapshot with the store's own functions: what the app's
// SQL must agree with. Opening migrates, so it reads a copy, and the
// schema version from before.
func summarize(t *testing.T, path string) snapshotSummary {
	t.Helper()
	ctx := context.Background()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cp := filepath.Join(t.TempDir(), "copy.db")
	if err := os.WriteFile(cp, b, 0o600); err != nil {
		t.Fatal(err)
	}
	var out snapshotSummary
	raw, err := sql.Open("sqlite", "file:"+cp+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	err = raw.QueryRow(`PRAGMA user_version`).Scan(&out.UserVersion)
	raw.Close()
	if err != nil {
		t.Fatal(err)
	}
	s, err := Open(cp)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if out.VMID, err = s.GetMeta(ctx, "vm.id"); err != nil {
		t.Fatal(err)
	}
	cards, err := s.ListCards(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cards {
		if c.State != StateReset {
			out.Cards++
		}
	}
	if out.TotalMsat, err = s.OwedMsat(ctx); err != nil {
		t.Fatal(err)
	}
	return out
}

// testvectors/snapshot.db is a snapshot cardd made, and snapshot.json what
// cardd's own functions read from it (changed is the time of its last
// write); the app's summary SQL is tested against both.
// CARDD_WRITE_SNAPSHOT=1 writes them; every run checks the summary still
// holds and the database has this cardd's schema, so the app's SQL is
// always tried on the schema it will meet.
func TestSnapshotVector(t *testing.T) {
	if os.Getenv("CARDD_WRITE_SNAPSHOT") == "1" {
		changed := writeSnapshotVector(t, snapshotVectorPath("snapshot.db"))
		sum := summarize(t, snapshotVectorPath("snapshot.db"))
		sum.Changed = changed
		raw, _ := json.MarshalIndent(sum, "", "  ")
		if err := os.WriteFile(snapshotVectorPath("snapshot.json"), append(raw, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(snapshotVectorPath("snapshot.json"))
	if err != nil {
		t.Fatal(err)
	}
	var want snapshotSummary
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	got := summarize(t, snapshotVectorPath("snapshot.db"))
	got.Changed = want.Changed
	if got != want {
		t.Fatalf("testvectors/snapshot.db reads as %+v, snapshot.json says %+v: write them with CARDD_WRITE_SNAPSHOT=1", got, want)
	}
	if got.UserVersion != SchemaVersion() {
		t.Fatalf("testvectors/snapshot.db has schema %d, this cardd's is %d: write it again with CARDD_WRITE_SNAPSHOT=1", got.UserVersion, SchemaVersion())
	}
}
