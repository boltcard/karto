// Package sendto is Send out's lookup: what a pasted, typed or
// scanned destination will pay, read before Check: a BOLT12 offer (decoded
// by phoenixd and checked here, as phoenixd's payoffer checks nothing), a
// BIP353 name (its record from bip353), or a Lightning address or LNURL-pay
// link's pay request. Every refusal is a Refusal whose Error is the
// person's sentence.
package sendto

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"

	"golang.org/x/net/idna"

	"github.com/boltcard/karto/server/internal/bip353"
	"github.com/boltcard/karto/server/internal/lnaddr"
	"github.com/boltcard/karto/server/internal/phoenixd"
)

// ErrRefused is every Refusal: cardd's API answers it bad_destination.
var ErrRefused = errors.New("sendto: refused")

// Refusal is why a destination can't be paid, as the person reads it.
type Refusal struct{ Sentence string }

func (r *Refusal) Error() string        { return r.Sentence }
func (r *Refusal) Is(target error) bool { return target == ErrRefused }

func refuse(format string, args ...any) error {
	return &Refusal{Sentence: fmt.Sprintf(format, args...)}
}

// Answer is what a destination will pay. Kind "offer": Offer, and Name for
// one a BIP353 name gave ("₿user@domain"), AmountMsat when the offer fixes it
// (0: the person chooses), Description and Issuer (either may be "").
// Kind "payurl": To (the address or link), MinMsat, MaxMsat, Description.
type Answer struct {
	Kind, Offer, Name, To, Description, Issuer string
	AmountMsat, MinMsat, MaxMsat               int64
}

// Looker looks destinations up.
type Looker struct {
	Offers interface {
		DecodeOffer(ctx context.Context, offer string) (phoenixd.Offer, error)
	}
	Names interface {
		Resolve(ctx context.Context, user, domain string) (bip353.Result, error)
	}
	Addresses interface {
		PayRequest(ctx context.Context, target string) (lnaddr.PayRequest, error)
	}
	Now func() time.Time
}

// IsOffer is whether s is a BOLT12 offer (lno1…, any case, lightning: or not).
func IsOffer(s string) bool { return strings.HasPrefix(strings.ToLower(bare(s)), "lno1") }

func bare(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 10 && strings.EqualFold(s[:10], "lightning:") {
		s = s[10:]
	}
	return s
}

// Lookup reads what to will pay.
func (l *Looker) Lookup(ctx context.Context, to string) (Answer, error) {
	s := bare(to)
	switch {
	case IsOffer(s):
		return l.offer(ctx, cleanOffer(s), "")
	case lnaddr.IsPayURL(s):
		// A link comes first: its query may hold an "@".
		return l.payURL(ctx, s, s)
	case strings.Contains(s, "@"):
		n, ok := ParseName(s)
		if !ok {
			return Answer{}, refuse("That isn't a name that can be looked up.")
		}
		return l.name(ctx, n)
	}
	return Answer{}, refuse("That isn't an offer, a name or a link.")
}

// OfferToPay is the offer Send pays: with a name, the name's
// record read again, which must still give this offer; without, the offer
// decoded and checked again.
func (l *Looker) OfferToPay(ctx context.Context, offer, name string) (Answer, error) {
	offer = cleanOffer(offer)
	if name == "" {
		return l.offer(ctx, offer, "")
	}
	n, ok := ParseName(name)
	if !ok {
		return Answer{}, refuse("That isn't a name that can be looked up.")
	}
	n.BIP353Only = true
	res, err := l.Names.Resolve(ctx, n.User, n.Domain)
	if err != nil {
		return Answer{}, nameRefusal(n, err)
	}
	if !sameOffer(res.Offer, offer) {
		return Answer{}, refuse("%s's record changed since it was looked up: look it up again.", n.Shown())
	}
	return l.offer(ctx, cleanOffer(res.Offer), n.Shown())
}

// sameOffer: BOLT12's bech32 has no checksum and ignores case, and a long
// offer may be split with "+" and white space; the same offer reads the same
// once those are taken out.
func sameOffer(a, b string) bool { return cleanOffer(a) == cleanOffer(b) }

// cleanOffer is an offer lowercase, without "lightning:", "+" or white space:
// the form phoenixd is asked to read and the app is given.
func cleanOffer(s string) string {
	return strings.ToLower(strings.Join(strings.FieldsFunc(bare(s), func(r rune) bool { return r == '+' || unicode.IsSpace(r) }), ""))
}

func (l *Looker) name(ctx context.Context, n Name) (Answer, error) {
	res, err := l.Names.Resolve(ctx, n.User, n.Domain)
	switch {
	case err == nil:
		return l.offer(ctx, cleanOffer(res.Offer), n.Shown())
	case errors.Is(err, bip353.ErrNone) && !n.BIP353Only:
		a, err := l.payURL(ctx, n.Plain(), n.Plain())
		if lnaddr.NoServer(err) {
			return Answer{}, refuse("%s doesn't exist: %s has no BIP353 record or Lightning address server for %s.", n.Plain(), n.Domain, n.User)
		}
		return a, err
	}
	return Answer{}, nameRefusal(n, err)
}

// nameRefusal is a name's record's fault in words. A name
// shows its ₿ where it was typed with one or where its record is verified.
func nameRefusal(n Name, err error) error {
	shown := n.Plain()
	if n.BIP353Only {
		shown = n.Shown()
	}
	switch {
	case errors.Is(err, bip353.ErrNone):
		return refuse("%s doesn't exist: %s has no BIP353 record for %s.", shown, n.Domain, n.User)
	case errors.Is(err, bip353.ErrNoOffer):
		return refuse("%s only takes on-chain payments, which Send out can't make.", n.Shown())
	case errors.Is(err, bip353.ErrRequires):
		return refuse("%s asks for something Send out doesn't support.", n.Shown())
	case errors.Is(err, bip353.ErrSeveral):
		return refuse("%s has more than one payment record for %s, so it can't be trusted.", n.Domain, n.User)
	case errors.Is(err, bip353.ErrNotSigned):
		return refuse("%s's record for %s isn't signed (DNSSEC), so it can't be trusted to say where money goes.", n.Domain, n.User)
	case errors.Is(err, bip353.ErrBogus):
		return refuse("%s's record for %s failed its signature check: it may have been tampered with.", n.Domain, n.User)
	case errors.Is(err, bip353.ErrWeak):
		return refuse("%s's record for %s is signed with SHA-1 or a short key, which BIP353 doesn't accept.", n.Domain, n.User)
	case errors.Is(err, bip353.ErrDisagree):
		return refuse("Google and Cloudflare gave different answers for %s, so it can't be trusted. Try again later.", n.Plain())
	}
	return refuse("Couldn't check %s: Google's or Cloudflare's DNS service didn't answer. Try again.", n.Plain())
}

func (l *Looker) offer(ctx context.Context, offer, name string) (Answer, error) {
	o, err := l.Offers.DecodeOffer(ctx, offer)
	var refused *phoenixd.RefusedError
	switch {
	case errors.As(err, &refused) && refused.Status == 400:
		return Answer{}, refuse("That offer can't be read.")
	case refused != nil:
		// Any other refusal (a 401: cardd's password) is phoenixd failing,
		// not the offer: answered as phoenixd unreachable, never a 500.
		return Answer{}, fmt.Errorf("%w: %v", phoenixd.ErrUnreachable, err)
	case err != nil:
		return Answer{}, err // phoenixd unreachable, as it is
	}
	if err := CheckOffer(o, l.Now()); err != nil {
		return Answer{}, err
	}
	return Answer{Kind: "offer", Offer: offer, Name: name, AmountMsat: o.AmountMsat,
		Description: lnaddr.Clean(o.Description, lnaddr.MaxText), Issuer: lnaddr.Clean(o.Issuer, lnaddr.MaxText)}, nil
}

// CheckOffer refuses what phoenixd's payoffer would pay without asking: an
// offer on another chain, expired, priced in a currency, or for part of a sat.
func CheckOffer(o phoenixd.Offer, now time.Time) error {
	switch {
	case o.Chain != "mainnet":
		net := o.Chain
		if net != "testnet3" && net != "testnet4" && net != "regtest" {
			net = "another network"
		}
		return refuse("That offer is for %s: Send out can't pay it.", net)
	case o.ExpiresAt != 0 && !time.Unix(o.ExpiresAt, 0).After(now):
		return refuse("This offer has expired.")
	case o.Currency != "":
		return refuse("This offer is priced in %s: Send out can only pay offers priced in sats.", o.Currency)
	case o.AmountMsat%1000 != 0:
		return refuse("This offer asks for %s sat: Send out pays whole sats only.", satText(o.AmountMsat))
	}
	return nil
}

// satText is msat as sats with thousands' commas and only the decimals it
// needs: 1000500 → "1,000.5".
func satText(msat int64) string {
	whole := strconv.FormatInt(msat/1000, 10)
	for i := len(whole) - 3; i > 0; i -= 3 {
		whole = whole[:i] + "," + whole[i:]
	}
	frac := strings.TrimRight(fmt.Sprintf("%03d", msat%1000), "0")
	if frac == "" {
		return whole
	}
	return whole + "." + frac
}

func (l *Looker) payURL(ctx context.Context, target, shown string) (Answer, error) {
	pr, err := l.Addresses.PayRequest(ctx, target)
	if err != nil {
		return Answer{}, err // lnaddr's bad_address, as at Send today
	}
	return Answer{Kind: "payurl", To: shown, MinMsat: pr.MinMsat, MaxMsat: pr.MaxMsat, Description: lnaddr.PlainText(pr.Metadata)}, nil
}

// Name is user@domain as BIP353 asks for it: lowercase, punycode.
type Name struct {
	User, Domain string
	BIP353Only   bool // typed with ₿: no LNURL fallback
}

func (n Name) Plain() string { return n.User + "@" + n.Domain }
func (n Name) Shown() string { return "₿" + n.Plain() }

// ParseName reads user@domain, with or without ₿ in front (BIP353 line 77:
// the ₿ isn't part of the DNS name). The domain needs a dot.
func ParseName(s string) (Name, bool) {
	s = strings.TrimSpace(s)
	n := Name{}
	if rest, ok := strings.CutPrefix(s, "₿"); ok {
		s, n.BIP353Only = rest, true
	}
	user, domain, ok := strings.Cut(s, "@")
	if !ok || user == "" || domain == "" || strings.Contains(domain, "@") || !strings.Contains(domain, ".") {
		return Name{}, false
	}
	u, err1 := idna.Lookup.ToASCII(strings.ToLower(domain))
	// The user part is a DNS label too: punycode for one that isn't ASCII.
	l, err2 := idna.Punycode.ToASCII(strings.ToLower(user))
	if err1 != nil || err2 != nil || !dnsLabels(l) || !dnsLabels(u) ||
		len(l)+len(".user._bitcoin-payment.")+len(u)+1 > 253 {
		return Name{}, false
	}
	n.User, n.Domain = l, u
	return n, true
}

// dnsLabels is whether s is dot-separated DNS labels BIP353 can ask for: each
// 1 to 63 letters, digits, "_", "+" or "-" (no empty label, no trailing dot).
func dnsLabels(s string) bool {
	for _, label := range strings.Split(s, ".") {
		if label == "" || len(label) > 63 {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '+' || c == '-') {
				return false
			}
		}
	}
	return true
}
