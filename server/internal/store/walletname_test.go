package store

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// The wallet's name: kept in meta, "" until the wallet names itself,
// and stored trimmed.
func TestWalletNameStartsEmptyAndIsKept(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if got, err := s.WalletName(ctx); err != nil || got != "" {
		t.Fatalf("a new server's name: %q %v", got, err)
	}
	got, err := s.SetWalletName(ctx, "  Pixel 9a ")
	if err != nil || got != "Pixel 9a" {
		t.Fatalf("set: %q %v", got, err)
	}
	if got, _ := s.WalletName(ctx); got != "Pixel 9a" {
		t.Fatalf("read back: %q", got)
	}
	if got, _ := s.GetMeta(ctx, "wallet.name"); got != "Pixel 9a" {
		t.Fatalf("meta: %q", got)
	}
}

// The tills' rule, as cardd's: 1 to 24 characters, none a control or a mark
// that hides in a line or turns it round.
func TestWalletNameRefusals(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.SetWalletName(ctx, "Kept")
	for _, bad := range []string{"", "   ", strings.Repeat("a", 25), "a\u0007b", "a\u0085b", "a\u061cb", "a\u200bb", "a\u202eb", "a\u2066b", "a\ufeffb"} {
		if _, err := s.SetWalletName(ctx, bad); !errors.Is(err, ErrBadWalletName) {
			t.Errorf("%q: %v, want ErrBadWalletName", bad, err)
		}
	}
	if got, _ := s.WalletName(ctx); got != "Kept" {
		t.Fatalf("after the refusals: %q", got)
	}
	// Characters, not bytes.
	if got, err := s.SetWalletName(ctx, strings.Repeat("é", 24)); err != nil || got != strings.Repeat("é", 24) {
		t.Fatalf("24 é: %q %v", got, err)
	}
}
