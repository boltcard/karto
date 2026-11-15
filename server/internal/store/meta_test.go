package store

import (
	"context"
	"errors"
	"maps"
	"path/filepath"
	"sync"
	"testing"
)

func TestMeta(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if _, err := s.GetMeta(ctx, "vm.id"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing key: got %v", err)
	}
	if err := s.SetMeta(ctx, "vm.id", "1001"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMeta(ctx, "vm.id", "1002"); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	if err := s.SetMeta(ctx, "mailtm.address", "f6ygjrifabn6ne2s@uberip.com"); err != nil {
		t.Fatal(err)
	}
	if v, err := s.GetMeta(ctx, "vm.id"); err != nil || v != "1002" {
		t.Fatalf("get: %q %v", v, err)
	}
	all, err := s.ListMeta(ctx)
	if err != nil || len(all) != 2 || all["mailtm.address"] != "f6ygjrifabn6ne2s@uberip.com" {
		t.Fatalf("list: %v %v", all, err)
	}
	for _, bad := range []string{"", "VM.ID", "vm id", "a/b", "x;drop"} {
		if err := s.SetMeta(ctx, bad, "v"); !errors.Is(err, ErrBadMetaKey) {
			t.Errorf("SetMeta(%q) = %v, want ErrBadMetaKey", bad, err)
		}
	}
}

// cardd serve and a `cardd-ctl` command can open a brand-new database at the
// same moment; both must succeed and the schema must be applied once.
func TestConcurrentOpenOfNewDatabase(t *testing.T) {
	for round := 0; round < 5; round++ {
		path := filepath.Join(t.TempDir(), "cardd.db")
		var wg sync.WaitGroup
		errs := make(chan error, 8)
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				s, err := Open(path)
				if err != nil {
					errs <- err
					return
				}
				s.Close()
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Fatalf("round %d: %v", round, err)
		}
	}
}

// Two processes (two Store values) writing the same database must not fail
// with SQLITE_BUSY: transactions take the write lock up front.
func TestTwoStoresWriteConcurrently(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "cardd.db")
	a, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	var wg sync.WaitGroup
	errs := make(chan error, 200)
	for i := 0; i < 100; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			if _, err := a.ReserveCard(ctx, cardHex(i), "", ""); err != nil {
				errs <- err
			}
		}(i)
		go func(i int) {
			defer wg.Done()
			if err := b.SetMeta(ctx, "k", cardHex(i)); err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}

func cardHex(i int) string {
	const digits = "0123456789abcdef"
	b := []byte("00000000000000000000000000000000")
	b[30], b[31] = digits[i/16%16], digits[i%16]
	return string(b)
}

// The hosting estimate is written in one go: a bad key writes nothing.
func TestSetMetas(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if err := s.SetMetas(ctx, map[string]string{"hosting.expires_est": "1", "hosting.msat_per_day": "221395"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMetas(ctx, map[string]string{"hosting.expires_est": "2", "BAD KEY": "x"}); !errors.Is(err, ErrBadMetaKey) {
		t.Fatalf("bad key: %v", err)
	}
	all, _ := s.ListMeta(ctx)
	if len(all) != 2 || all["hosting.expires_est"] != "1" || all["hosting.msat_per_day"] != "221395" {
		t.Fatalf("%v", all)
	}
}

func TestDeleteMeta(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.SetMetas(ctx, map[string]string{"vm.id": "1009", "vm.ipv4": "45.67.89.10", "mailtm.address": "f6ygjrifabn6ne2s@uberip.com"})
	if err := s.DeleteMeta(ctx, "vm.id", "vm.ipv4", "vm.host"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteMeta(ctx); err != nil {
		t.Fatalf("no keys: %v", err)
	}
	if err := s.DeleteMeta(ctx, "mailtm.address", "BAD KEY"); !errors.Is(err, ErrBadMetaKey) {
		t.Fatalf("bad key: %v", err)
	}
	if all, _ := s.ListMeta(ctx); !maps.Equal(all, map[string]string{"mailtm.address": "f6ygjrifabn6ne2s@uberip.com"}) {
		t.Fatalf("%v", all)
	}
}
