// Package cards registers cards and verifies their taps.
package cards

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/boltcard/karto/server/internal/cardkeys"
	"github.com/boltcard/karto/server/internal/rates"
	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/sun"
)

var (
	ErrBadID       = errors.New("cards: id must be 32 lower-case hex characters")
	ErrUnknownCard = errors.New("cards: card not registered")
	ErrIDMismatch  = errors.New("cards: tap is from a different card")
	ErrCardReset   = errors.New("cards: card has been wiped")
	ErrNotActive   = errors.New("cards: card setup has not finished or it is being wiped")
	ErrBadName     = errors.New("cards: a name is one line of at most 40 characters")
	ErrFrozen      = errors.New("cards: card is frozen")
	// ErrNeedsCheck: restored from a backup, the card pays only once its
	// owner's phone has checked a tap of it (store.Card.NeedsCheck).
	ErrNeedsCheck = errors.New("cards: card needs its owner's check after a restore")
	ErrBadLimits  = errors.New("cards: limits are 1 to 2,000,000 sat, and the 24-hour limit is at least the per-tap one")
	ErrBadHost    = errors.New("cards: a host is a bare lower-case hostname such as vm-1.lnvps.cloud")
)

var (
	idPattern   = regexp.MustCompile(`^[0-9a-f]{32}$`)
	hostPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`)
)

// ValidHost accepts a bare lower-case DNS name: it is written onto cards as
// lnurlw://<host>/ln, so a scheme, port or path would break every card.
func ValidHost(host string) error {
	if len(host) > 253 || !hostPattern.MatchString(host) {
		return ErrBadHost
	}
	return nil
}

type Service struct {
	store  *store.Store
	issuer []byte
	k1     []byte
	host   string
}

func New(st *store.Store, issuer []byte, host string) (*Service, error) {
	k1, err := cardkeys.K1(issuer)
	if err != nil {
		return nil, err
	}
	return &Service{store: st, issuer: issuer, k1: k1, host: host}, nil
}

// LNURLW is the URL written onto every card, before p= and c=.
func (s *Service) LNURLW() string { return "lnurlw://" + s.host + "/ln" }

// Reserve picks the version to program the card with this id at, and names it.
func (s *Service) Reserve(ctx context.Context, id, name string) (store.Card, error) {
	if !idPattern.MatchString(id) {
		return store.Card{}, ErrBadID
	}
	name, err := cleanName(name)
	if err != nil {
		return store.Card{}, err
	}
	return s.store.ReserveCard(ctx, id, name, s.host)
}

func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > 40 || strings.ContainsAny(name, "\r\n") {
		return "", ErrBadName
	}
	return name, nil
}

// List returns every card, oldest first.
func (s *Service) List(ctx context.Context) ([]store.Card, error) { return s.store.ListCards(ctx) }

// Rename sets a card's name; a rename needs a non-empty one.
func (s *Service) Rename(ctx context.Context, id, name string) (store.Card, error) {
	if !idPattern.MatchString(id) {
		return store.Card{}, ErrBadID
	}
	name, err := cleanName(name)
	if err != nil {
		return store.Card{}, err
	}
	if name == "" {
		return store.Card{}, ErrBadName
	}
	return s.store.RenameCard(ctx, id, name)
}

// Wipe starts a wipe: the card can no longer spend, and its balance moves to pool.
func (s *Service) Wipe(ctx context.Context, id string) (store.Card, error) {
	if !idPattern.MatchString(id) {
		return store.Card{}, ErrBadID
	}
	return s.store.StartWipe(ctx, id)
}

// Wiped records that the phone reset the card's keys and cleared it.
func (s *Service) Wiped(ctx context.Context, id string) (store.Card, error) {
	if !idPattern.MatchString(id) {
		return store.Card{}, ErrBadID
	}
	return s.store.FinishWipe(ctx, id)
}

// SetHost records the host a card's URL points at, after the phone re-points it.
func (s *Service) SetHost(ctx context.Context, id, host string) (store.Card, error) {
	if !idPattern.MatchString(id) {
		return store.Card{}, ErrBadID
	}
	if err := ValidHost(host); err != nil {
		return store.Card{}, err
	}
	return s.store.SetCardHost(ctx, id, host)
}

// Tap is a verified tap.
type Tap struct {
	Card    store.Card
	Counter uint32
}

// decrypt opens p and names the card it came from; c is only parsed.
func (s *Service) decrypt(p, c string) (sun.PICC, []byte, string, error) {
	pb, cb, err := sun.ParseHex(p, c)
	if err != nil {
		return sun.PICC{}, nil, "", err
	}
	picc, err := sun.Decrypt(s.k1, pb)
	if err != nil {
		return sun.PICC{}, nil, "", err
	}
	idb, err := cardkeys.ID(s.issuer, picc.UID)
	if err != nil {
		return sun.PICC{}, nil, "", err
	}
	return picc, cb, hex.EncodeToString(idb), nil
}

// checkMAC checks c against the card's keys at version.
func (s *Service) checkMAC(picc sun.PICC, cb []byte, version uint32) error {
	keys, err := cardkeys.Derive(s.issuer, picc.UID, version)
	if err != nil {
		return err
	}
	return sun.Verify(keys.K2, picc, cb)
}

// verify decrypts p, finds the card and checks c. It does not touch the counter.
func (s *Service) verify(ctx context.Context, p, c string) (Tap, error) {
	picc, cb, id, err := s.decrypt(p, c)
	if err != nil {
		return Tap{}, err
	}
	card, err := s.store.GetCard(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return Tap{}, ErrUnknownCard
	}
	if err != nil {
		return Tap{}, err
	}
	if err := s.checkMAC(picc, cb, card.Version); err != nil {
		return Tap{}, err
	}
	return Tap{Card: card, Counter: picc.Counter}, nil
}

// Confirm checks the first tap after programming and activates the card.
// It proves the keys the phone wrote match the keys cardd derives.
func (s *Service) Confirm(ctx context.Context, id, p, c string) (store.Card, error) {
	if !idPattern.MatchString(id) {
		return store.Card{}, ErrBadID
	}
	tap, err := s.verify(ctx, p, c)
	if err != nil {
		return store.Card{}, err
	}
	if tap.Card.ID != id {
		return store.Card{}, ErrIDMismatch
	}
	if tap.Card.State != store.StateProgramming {
		return store.Card{}, fmt.Errorf("%w: card is %s", store.ErrConflict, tap.Card.State)
	}
	return s.store.ActivateCard(ctx, id, tap.Counter)
}

// Adopt adds back a card this server's issuer key programmed but its
// database doesn't know (a rebuild from the phrase alone). The tap is checked
// at the version the phone's search found, as Confirm checks one, and the
// card starts active at this tap's counter, so the tap can't be replayed. The
// UID and keys never leave the card and cardd. A card already known, in any
// state, is refused. Its host stays empty until the phone's re-point has
// rewritten its URL and set it, so it is listed for re-pointing meanwhile.
func (s *Service) Adopt(ctx context.Context, version uint32, name, p, c string) (store.Card, error) {
	name, err := cleanName(name)
	if err != nil {
		return store.Card{}, err
	}
	picc, cb, id, err := s.decrypt(p, c)
	if err != nil {
		return store.Card{}, err
	}
	if err := s.checkMAC(picc, cb, version); err != nil {
		return store.Card{}, err
	}
	return s.store.AdoptCard(ctx, id, version, name, picc.Counter, "")
}

// Check verifies a tap and moves the counter on ("tap to check"). It is the
// owner's phone's (device auth). For a card restored from a backup
// (NeedsCheck) it is the owner's check only when proved: the wallet had the
// card prove its key 0 in the same read, so the tap isn't a copy of one
// recorded after the backup. It then clears NeedsCheck: the counter is the
// card's own, and every tap recorded before it is refused as used. Unproved,
// such a card is ErrNeedsCheck and its counter stays; any other card is
// checked as before, proved or not.
func (s *Service) Check(ctx context.Context, p, c string, proved bool) (Tap, error) {
	tap, err := s.verify(ctx, p, c)
	if err != nil {
		return Tap{}, err
	}
	switch tap.Card.State {
	case store.StateActive, store.StateFrozen:
	case store.StateReset:
		return Tap{}, ErrCardReset
	default:
		return Tap{}, ErrNotActive
	}
	if tap.Card.NeedsCheck && !proved {
		return Tap{}, ErrNeedsCheck
	}
	advance := s.store.AdvanceCounter
	if proved {
		advance = s.store.CheckCounter
	}
	if err := advance(ctx, tap.Card.ID, tap.Counter); err != nil {
		return Tap{}, err
	}
	tap.Card.LastCounter = int64(tap.Counter)
	if proved {
		tap.Card.NeedsCheck = false
	}
	return tap, nil
}

// Peek verifies a tap like Spend does, without any state check and without
// moving the counter: the card, for a refusal's alert when spending is paused.
func (s *Service) Peek(ctx context.Context, p, c string) (Tap, error) {
	return s.verify(ctx, p, c)
}

// Spend checks a tap at a terminal (the first half of LNURL-withdraw): the
// SUN, that the card is active, and that the counter is above the last one
// seen. The counter moves on here, so a replayed p and c are refused. When
// the card is known and the tap is refused for its state or its counter
// (ErrFrozen, ErrCardReset, ErrNotActive, ErrNeedsCheck, store.ErrReplayed), the Tap still
// carries the card, as read before the counter moved, and the tap's counter,
// so the refusal can be alerted. Other errors give an empty Tap.
func (s *Service) Spend(ctx context.Context, p, c string) (Tap, error) {
	tap, err := s.verify(ctx, p, c)
	if err != nil {
		return Tap{}, err
	}
	switch tap.Card.State {
	case store.StateActive:
	case store.StateFrozen:
		return tap, ErrFrozen
	case store.StateReset:
		return tap, ErrCardReset
	default:
		return tap, ErrNotActive
	}
	// Restored from a backup: the counter may be behind the card's, so this
	// tap may be one recorded after the backup. It stays where it is.
	if tap.Card.NeedsCheck {
		return tap, ErrNeedsCheck
	}
	if err := s.store.AdvanceCounter(ctx, tap.Card.ID, tap.Counter); err != nil {
		if errors.Is(err, store.ErrReplayed) {
			return tap, err
		}
		return Tap{}, err
	}
	tap.Card.LastCounter = int64(tap.Counter)
	return tap, nil
}

// Freeze stops a card spending; it keeps its balance and still takes top-ups.
func (s *Service) Freeze(ctx context.Context, id string) (store.Card, error) {
	if !idPattern.MatchString(id) {
		return store.Card{}, ErrBadID
	}
	return s.store.FreezeCard(ctx, id)
}

// Unfreeze lets a frozen card spend again.
func (s *Service) Unfreeze(ctx context.Context, id string) (store.Card, error) {
	if !idPattern.MatchString(id) {
		return store.Card{}, ErrBadID
	}
	return s.store.UnfreezeCard(ctx, id)
}

// SetLimits sets a card's spending limits, in sat.
func (s *Service) SetLimits(ctx context.Context, id string, perTapSat, dailySat int64) (store.Card, error) {
	if !idPattern.MatchString(id) {
		return store.Card{}, ErrBadID
	}
	if perTapSat < 1 || dailySat < perTapSat || dailySat > maxLimitSat {
		return store.Card{}, ErrBadLimits
	}
	return s.store.SetLimits(ctx, id, perTapSat, dailySat)
}

// SetLimitsMinor sets a card's spending limits in a currency, in its minor
// units: the rules of sat
// limits in minor units, 1 to 10^10 and the day's at least the tap's, and,
// at cardd's rate now, neither over 2,000,000 sat, so the phone's problem
// line stays true. Any of the seven currencies: a limit keeps its own when
// the server's changes. With no rate: rates.ErrNoRate.
func (s *Service) SetLimitsMinor(ctx context.Context, id, currency string, perTapMinor, dailyMinor int64) (store.Card, error) {
	if !idPattern.MatchString(id) {
		return store.Card{}, ErrBadID
	}
	if !rates.Known(currency) {
		return store.Card{}, fmt.Errorf("%w: a limit's currency is one of %s", ErrBadLimits, strings.Join(rates.Currencies, ", "))
	}
	var price int64
	if s.store.Rate != nil {
		if p, ok := s.store.Rate(); ok {
			price = p.Per[currency]
		}
	}
	if price < 1 {
		return store.Card{}, rates.NoRate(currency, "set the limits in sat.")
	}
	if perTapMinor < 1 || dailyMinor < perTapMinor || dailyMinor > rates.MaxMinor ||
		rates.SatForMinor(dailyMinor, price, currency) > maxLimitSat {
		return store.Card{}, badLimitsIn{fmt.Sprintf("cards: limits are up to 2,000,000 sat (%s at today's rate), at least %s, and the 24-hour limit is at least the per-tap one",
			rates.MinorText(rates.MinorForSat(maxLimitSat, price, currency), currency), rates.MinorText(1, currency))}
	}
	return s.store.SetLimitsMinor(ctx, id, currency, perTapMinor, dailyMinor)
}

// LimitsSat is what a card's limits come to at a tap now, in whole sat
// (half up, as a sale is), as the phones are told them: sat limits as
// they are; limits in a currency at the last rate; 0 for those with no rate
// yet, as a tap is then refused.
func (s *Service) LimitsSat(c store.Card) (perTapSat, dailySat int64) {
	perTap, daily, _ := s.store.LimitsMsat(c)
	return perTap / 1000, daily / 1000
}

// maxLimitSat is the most a limit may be, in sat or converted.
const maxLimitSat = 2_000_000

// badLimitsIn is ErrBadLimits in its currency form: the sentence names the
// cap in the currency at cardd's rate.
type badLimitsIn struct{ sentence string }

func (e badLimitsIn) Error() string        { return e.sentence }
func (e badLimitsIn) Is(target error) bool { return target == ErrBadLimits }
