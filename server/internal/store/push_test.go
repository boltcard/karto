package store

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"
)

const (
	owner1 = "aaaaaaaaaaaaaaaa"
	owner2 = "bbbbbbbbbbbbbbbb"
)

// owners opens a store with two owner phones.
func owners(t *testing.T) *Store {
	t.Helper()
	s := open(t)
	for _, k := range []string{owner1, owner2} {
		if err := s.AddDevice(context.Background(), Device{KeyID: k, PublicKey: "04" + k, Name: k}); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

func endpointFor(k string) PushEndpoint {
	return PushEndpoint{KeyID: k, Endpoint: "https://push.example/" + k, P256dh: "p-" + k, Auth: "a-" + k, Transport: "webpush"}
}

func setEndpoint(t *testing.T, s *Store, k string) {
	t.Helper()
	if err := s.SetPushEndpoint(context.Background(), endpointFor(k)); err != nil {
		t.Fatal(err)
	}
}

func TestPushEndpointUpsertAndRead(t *testing.T) {
	ctx := context.Background()
	s := owners(t)
	clock(s)
	if _, err := s.PushEndpointOf(ctx, owner1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("none yet: %v", err)
	}
	setEndpoint(t, s, owner1)
	got, err := s.PushEndpointOf(ctx, owner1)
	if err != nil || got.Endpoint != "https://push.example/"+owner1 || got.P256dh != "p-"+owner1 || got.Auth != "a-"+owner1 ||
		got.Transport != "webpush" || got.CreatedAt.IsZero() || got.DeliveredAt != nil || got.FailedAt != nil || got.Failures != 0 {
		t.Fatalf("read: %+v %v", got, err)
	}
	// A failure, then the phone sets a new endpoint: the record starts again.
	s.PushFailed(ctx, owner1, s.now(), "gone")
	e := endpointFor(owner1)
	e.Endpoint = "https://push.example/new"
	if err := s.SetPushEndpoint(ctx, e); err != nil {
		t.Fatal(err)
	}
	got, _ = s.PushEndpointOf(ctx, owner1)
	if got.Endpoint != "https://push.example/new" || got.Failures != 0 || got.Failure != "" || got.FailedAt != nil {
		t.Fatalf("upsert: %+v", got)
	}
	setEndpoint(t, s, owner2)
	all, err := s.OwnerPushEndpoints(ctx)
	if err != nil || len(all) != 2 {
		t.Fatalf("owners: %+v %v", all, err)
	}
	if err := s.DeletePushEndpoint(ctx, owner1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PushEndpointOf(ctx, owner1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted: %v", err)
	}
	if err := s.DeletePushEndpoint(ctx, owner1); err != nil {
		t.Fatalf("deleting none: %v", err)
	}
}

func TestPushEndpointRefusesRevokedDevice(t *testing.T) {
	ctx := context.Background()
	s := owners(t)
	if err := s.SetPushEndpoint(ctx, endpointFor("cccccccccccccccc")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown device: %v", err)
	}
	if err := s.RevokeDevice(ctx, owner1); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPushEndpoint(ctx, endpointFor(owner1)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked device: %v", err)
	}
}

func TestRevokeDeviceDeletesEndpoint(t *testing.T) {
	ctx := context.Background()
	s := owners(t)
	setEndpoint(t, s, owner1)
	setEndpoint(t, s, owner2)
	if err := s.RevokeDevice(ctx, owner1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PushEndpointOf(ctx, owner1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked phone's endpoint: %v", err)
	}
	if _, err := s.PushEndpointOf(ctx, owner2); err != nil {
		t.Fatalf("the other's: %v", err)
	}
}

func TestRevokeOthersDeletesEndpoints(t *testing.T) {
	ctx := context.Background()
	s := owners(t)
	setEndpoint(t, s, owner1)
	setEndpoint(t, s, owner2)
	if _, err := s.RevokeOthers(ctx, owner1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PushEndpointOf(ctx, owner2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked phone's endpoint: %v", err)
	}
	if _, err := s.PushEndpointOf(ctx, owner1); err != nil {
		t.Fatalf("the kept phone's: %v", err)
	}
}

func TestPrepareRestoredDeletesEndpointsKeepsVAPID(t *testing.T) {
	ctx := context.Background()
	s := owners(t)
	setEndpoint(t, s, owner1)
	before, err := s.VAPIDKey(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PrepareRestored(ctx, "backup", "04"+owner1, RestoredVM{ID: "1", Host: "h", IPv4: "1.2.3.4"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PushEndpointOf(ctx, owner1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("endpoint after restore: %v", err)
	}
	if after, err := s.VAPIDKey(ctx); err != nil || after != before {
		t.Fatalf("VAPID key changed: %v", err)
	}
}

func TestVAPIDKeyMadeOnce(t *testing.T) {
	s := open(t)
	keys := make([]string, 8)
	var wg sync.WaitGroup
	for i := range keys {
		wg.Add(1)
		go func() {
			defer wg.Done()
			k, err := s.VAPIDKey(context.Background())
			if err != nil {
				t.Error(err)
			}
			keys[i] = k
		}()
	}
	wg.Wait()
	for _, k := range keys {
		if k == "" || k != keys[0] {
			t.Fatalf("keys differ: %q", keys)
		}
	}
	if again, _ := s.VAPIDKey(context.Background()); again != keys[0] {
		t.Fatal("a later call made another key")
	}
}

// postedIDs makes the store collect the calls of Posted.
func postedIDs(s *Store) *[][]int64 {
	var calls [][]int64
	s.Posted = func(ids []int64) { calls = append(calls, ids) }
	return &calls
}

func TestPostedOncePerTransaction(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	calls := postedIDs(s)
	if done, err := s.CreditMoving(ctx, card, 50_000, 0, "r1", "", FeeCreditMove{}); err != nil || !done {
		t.Fatalf("credit: %v %v", done, err)
	}
	if len(*calls) != 1 || len((*calls)[0]) != 1 {
		t.Fatalf("after a credit: %v", *calls)
	}
	// The same ref again is a no-op: nothing posted.
	if done, _ := s.CreditMoving(ctx, card, 50_000, 0, "r1", "", FeeCreditMove{}); done {
		t.Fatal("a ref posted twice")
	}
	if len(*calls) != 1 {
		t.Fatalf("after a no-op: %v", *calls)
	}
	// A settle above the fee budget books a fee-adjust and the spend: both in one call.
	s.Credit(ctx, Pool, 10_000, "p", "")
	*calls = nil
	h, err := s.OpenHold(ctx, HoldRequest{Account: card, Kind: KindSpend, AmountMsat: 49_000, FeeBudgetMsat: 500, PaymentHash: "1", Invoice: "lnbc"})
	if err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 {
		t.Fatalf("opening a hold posted: %v", *calls)
	}
	if _, err := s.SettleHold(ctx, h.ID, 3_000); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || len((*calls)[0]) != 2 {
		t.Fatalf("after a settle with a fee-adjust: %v", *calls)
	}
	// Settling again is a no-op.
	s.SettleHold(ctx, h.ID, 3_000)
	if len(*calls) != 1 {
		t.Fatalf("a second settle posted: %v", *calls)
	}
}

func TestPostedNotCalledOnRollback(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	card := activeCard(t, s, id)
	calls := postedIDs(s)
	boom := errors.New("boom")
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if _, err := s.post(ctx, tx, 1, KindTopup, "x", "", Entry{card, 1000}, Entry{World, -1000}); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) || len(*calls) != 0 {
		t.Fatalf("%v %v", err, *calls)
	}
	// Nothing is left over for the next transaction.
	if _, err := s.Credit(ctx, card, 1000, "y", ""); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || len((*calls)[0]) != 1 {
		t.Fatalf("next: %v", *calls)
	}
}

func TestPushDeliveredResetsFailures(t *testing.T) {
	ctx := context.Background()
	s := owners(t)
	setEndpoint(t, s, owner1)
	at := time.Unix(1_800_000_000, 0)
	s.PushFailed(ctx, owner1, at, "502")
	s.PushFailed(ctx, owner1, at.Add(time.Minute), "503")
	e, _ := s.PushEndpointOf(ctx, owner1)
	if e.Failures != 2 || e.Failure != "503" || e.FailedAt == nil || !e.FailedAt.Equal(at.Add(time.Minute)) {
		t.Fatalf("failed: %+v", e)
	}
	if err := s.PushDelivered(ctx, owner1, at.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	e, _ = s.PushEndpointOf(ctx, owner1)
	if e.Failures != 0 || e.Failure != "" || e.DeliveredAt == nil || !e.DeliveredAt.Equal(at.Add(time.Hour)) {
		t.Fatalf("delivered: %+v", e)
	}
	if err := s.PushDelivered(ctx, "cccccccccccccccc", at); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown: %v", err)
	}
}

func TestPostedLineTopupCardAndSale(t *testing.T) {
	ctx := context.Background()
	s, _ := tills(t)
	card := activeCard(t, s, id)
	calls := postedIDs(s)
	s.Credit(ctx, card, 70_000, "t1", "")
	l, acct, err := s.PostedLine(ctx, (*calls)[0][0])
	if err != nil || acct != card || l.Kind != KindTopup || l.AmountMsat != 70_000 || l.Payment == nil || l.Payment.Hash != "t1" {
		t.Fatalf("top-up: %+v %v %v", l, acct, err)
	}
	*calls = nil
	sale(t, s, saleA, till1, 2_500_000)
	paid(t, s, saleA, 2_500_000)
	l, acct, err = s.PostedLine(ctx, (*calls)[0][0])
	if err != nil || acct != Shop || l.Kind != KindSale || l.AmountMsat != 2_500_000 {
		t.Fatalf("sale: %+v %v %v", l, acct, err)
	}
	if _, _, err := s.PostedLine(ctx, 99999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no such id: %v", err)
	}
}
