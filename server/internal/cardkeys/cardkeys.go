// Package cardkeys derives Bolt Card keys from an issuer key, following
// boltcard docs/DETERMINISTIC.md.
package cardkeys

import (
	"encoding/binary"
	"fmt"

	"github.com/boltcard/karto/server/internal/cmac"
)

// Keys are one card's application keys plus its database ID.
type Keys struct {
	K0, K1, K2, K3, K4 []byte
	ID                 []byte
	CardKey            []byte
}

// K1 returns the PICCData encryption key, which is the same for every card.
func K1(issuer []byte) ([]byte, error) {
	return cmac.Sum(issuer, []byte{0x2d, 0x00, 0x3f, 0x77})
}

// ID returns PRF(IssuerKey, '2d003f7b' || UID), the only card identifier cardd stores.
func ID(issuer, uid []byte) ([]byte, error) {
	if len(uid) != 7 {
		return nil, fmt.Errorf("cardkeys: uid must be 7 bytes, got %d", len(uid))
	}
	return cmac.Sum(issuer, append([]byte{0x2d, 0x00, 0x3f, 0x7b}, uid...))
}

// Derive returns all keys for the card with this UID at this version.
func Derive(issuer, uid []byte, version uint32) (Keys, error) {
	if len(uid) != 7 {
		return Keys{}, fmt.Errorf("cardkeys: uid must be 7 bytes, got %d", len(uid))
	}
	msg := append([]byte{0x2d, 0x00, 0x3f, 0x75}, uid...)
	msg = binary.LittleEndian.AppendUint32(msg, version)
	cardKey, err := cmac.Sum(issuer, msg)
	if err != nil {
		return Keys{}, err
	}
	k := Keys{CardKey: cardKey}
	sub := func(tag byte) []byte {
		out, _ := cmac.Sum(cardKey, []byte{0x2d, 0x00, 0x3f, tag})
		return out
	}
	k.K0 = sub(0x76)
	k.K2 = sub(0x78)
	k.K3 = sub(0x79)
	k.K4 = sub(0x7a)
	if k.K1, err = K1(issuer); err != nil {
		return Keys{}, err
	}
	if k.ID, err = ID(issuer, uid); err != nil {
		return Keys{}, err
	}
	return k, nil
}
