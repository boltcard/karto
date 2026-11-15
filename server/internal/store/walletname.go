package store

import (
	"context"
	"errors"
	"strings"
)

// ErrBadWalletName means a wallet's name is empty, longer than 24
// characters, or holds a character that can't be seen.
var ErrBadWalletName = errors.New("store: a wallet's name is 1 to 24 characters, none of them hidden")

// hidden is a mark that hides in a line or turns it round: Karto PoS refuses
// a name with one (app/src/cardd/names.ts NOT_IN_A_NAME), so cardd does too.
func hidden(r rune) bool {
	return r == 0x061c || (r >= 0x200b && r <= 0x200f) || (r >= 0x2028 && r <= 0x202e) ||
		(r >= 0x2060 && r <= 0x2069) || r == 0xfeff
}

// CleanName trims a name and checks it as a till does: a PoS phone's rule
// (phoneName: 1 to 24 characters, no control character) and no hidden mark.
func CleanName(name string) (string, bool) {
	name, err := phoneName(name)
	if err != nil || strings.ContainsFunc(name, hidden) {
		return "", false
	}
	return name, true
}

// WalletName is the name the wallet gave itself, which its tills show beside
// their own: meta's "wallet.name",
// so in every backup and kept by a restore; "" until it is named.
func (s *Store) WalletName(ctx context.Context) (string, error) {
	name, err := s.GetMeta(ctx, "wallet.name")
	if errors.Is(err, ErrNotFound) {
		return "", nil
	}
	return name, err
}

// SetWalletName names the wallet and gives back the name as kept: trimmed.
func (s *Store) SetWalletName(ctx context.Context, name string) (string, error) {
	name, ok := CleanName(name)
	if !ok {
		return "", ErrBadWalletName
	}
	return name, s.SetMeta(ctx, "wallet.name", name)
}
