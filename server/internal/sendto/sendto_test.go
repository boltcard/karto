package sendto

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/bip353"
	"github.com/boltcard/karto/server/internal/lnaddr"
	"github.com/boltcard/karto/server/internal/phoenixd"
)

type offers map[string]phoenixd.Offer

func (o offers) DecodeOffer(_ context.Context, s string) (phoenixd.Offer, error) {
	if x, ok := o[s]; ok {
		return x, nil
	}
	return phoenixd.Offer{}, &phoenixd.RefusedError{Status: 400, Detail: "invalid offer"}
}

type names map[string]any // "user@domain" → bip353.Result or an error

func (n names) Resolve(_ context.Context, user, domain string) (bip353.Result, error) {
	switch v := n[user+"@"+domain].(type) {
	case bip353.Result:
		return v, nil
	case error:
		return bip353.Result{}, v
	}
	return bip353.Result{}, bip353.ErrNone
}

type payRequests map[string]lnaddr.PayRequest

func (p payRequests) PayRequest(_ context.Context, target string) (lnaddr.PayRequest, error) {
	if pr, ok := p[target]; ok {
		return pr, nil
	}
	user, domain, _ := strings.Cut(target, "@")
	return lnaddr.PayRequest{}, lnaddr.NoServerError(user, domain)
}

var now = time.Unix(1_800_000_000, 0)

func looker() *Looker {
	return &Looker{
		Offers: offers{
			"lno1free":     {Chain: "mainnet", Description: "Coffee", Issuer: "Ana's Café"},
			"lno1fixed":    {Chain: "mainnet", AmountMsat: 4_500_000, Description: "Flat white, large", Issuer: "Ana's Café"},
			"lno1usd":      {Chain: "mainnet", Currency: "USD"},
			"lno1testnet":  {Chain: "testnet3"},
			"lno1unknown":  {Chain: "unknown"},
			"lno1expired":  {Chain: "mainnet", ExpiresAt: now.Add(-time.Second).Unix()},
			"lno1partsat":  {Chain: "mainnet", AmountMsat: 1_000_500},
			"lno1phoenix":  {Chain: "mainnet"},
			"lno1phoenix2": {Chain: "mainnet"},
		},
		Names: names{
			"alice@phoenixwallet.me": bip353.Result{URI: "bitcoin:?lno=lno1phoenix", Offer: "lno1phoenix"},
			"bob@example.com":        bip353.ErrNone,
			"carol@example.com":      bip353.ErrNoOffer,
			"dan@example.com":        bip353.ErrSeveral,
			"eve@example.com":        bip353.ErrNotSigned,
			"fay@example.com":        bip353.ErrBogus,
			"gus@example.com":        bip353.ErrWeak,
			"hal@example.com":        bip353.ErrUnreachable,
			"ivy@example.com":        bip353.ErrDisagree,
			"jo@example.com":         bip353.ErrRequires,
		},
		Addresses: payRequests{"sam@getalby.com": {MinMsat: 1_000, MaxMsat: 2_000_000_000, Metadata: `[["text/plain","Sam's tips"]]`}},
		Now:       func() time.Time { return now },
	}
}

func TestLookingUp(t *testing.T) {
	l := looker()
	ctx := context.Background()
	cases := []struct {
		to   string
		want Answer
	}{
		{"lno1free", Answer{Kind: "offer", Offer: "lno1free", Description: "Coffee", Issuer: "Ana's Café"}},
		{"LIGHTNING:LNO1FIXED", Answer{Kind: "offer", Offer: "lno1fixed", AmountMsat: 4_500_000, Description: "Flat white, large", Issuer: "Ana's Café"}},
		{"₿alice@phoenixwallet.me", Answer{Kind: "offer", Offer: "lno1phoenix", Name: "₿alice@phoenixwallet.me"}},
		{"Alice@PhoenixWallet.me", Answer{Kind: "offer", Offer: "lno1phoenix", Name: "₿alice@phoenixwallet.me"}},
		{"sam@getalby.com", Answer{Kind: "payurl", To: "sam@getalby.com", MinMsat: 1_000, MaxMsat: 2_000_000_000, Description: "Sam's tips"}},
	}
	for _, c := range cases {
		got, err := l.Lookup(ctx, c.to)
		if err != nil || got != c.want {
			t.Errorf("%s: %+v %v, want %+v", c.to, got, err, c.want)
		}
	}
}

// The refusals' sentences, word for word.
func TestTheRefusalsWords(t *testing.T) {
	l := looker()
	cases := map[string]string{
		"₿bob@example.com":   "₿bob@example.com doesn't exist: example.com has no BIP353 record for bob.",
		"bob@example.com":    "bob@example.com doesn't exist: example.com has no BIP353 record or Lightning address server for bob.",
		"₿carol@example.com": "₿carol@example.com only takes on-chain payments, which Send out can't make.",
		"dan@example.com":    "example.com has more than one payment record for dan, so it can't be trusted.",
		"eve@example.com":    "example.com's record for eve isn't signed (DNSSEC), so it can't be trusted to say where money goes.",
		"fay@example.com":    "example.com's record for fay failed its signature check: it may have been tampered with.",
		"gus@example.com":    "example.com's record for gus is signed with SHA-1 or a short key, which BIP353 doesn't accept.",
		"hal@example.com":    "Couldn't check hal@example.com: Google's or Cloudflare's DNS service didn't answer. Try again.",
		"ivy@example.com":    "Google and Cloudflare gave different answers for ivy@example.com, so it can't be trusted. Try again later.",
		"jo@example.com":     "₿jo@example.com asks for something Send out doesn't support.",
		"lno1nonsense":       "That offer can't be read.",
		"lno1testnet":        "That offer is for testnet3: Send out can't pay it.",
		"lno1unknown":        "That offer is for another network: Send out can't pay it.",
		"lno1expired":        "This offer has expired.",
		"lno1usd":            "This offer is priced in USD: Send out can only pay offers priced in sats.",
		"lno1partsat":        "This offer asks for 1,000.5 sat: Send out pays whole sats only.",
		"a@b@c":              "That isn't a name that can be looked up.",
		"lnbc1somewhere":     "That isn't an offer, a name or a link.",
	}
	for to, want := range cases {
		_, err := l.Lookup(context.Background(), to)
		var r *Refusal
		if !errors.As(err, &r) || r.Sentence != want || !errors.Is(err, ErrRefused) {
			t.Errorf("%s: %v, want %q", to, err, want)
		}
	}
}

func TestPayingANameResolvesItAgain(t *testing.T) {
	l := looker()
	ctx := context.Background()
	if a, err := l.OfferToPay(ctx, "LNO1PHOENIX", "₿alice@phoenixwallet.me"); err != nil || a.Offer != "lno1phoenix" || a.Name != "₿alice@phoenixwallet.me" {
		t.Fatalf("same record: %+v %v", a, err)
	}
	_, err := l.OfferToPay(ctx, "lno1phoenix2", "₿alice@phoenixwallet.me")
	var r *Refusal
	if !errors.As(err, &r) || r.Sentence != "₿alice@phoenixwallet.me's record changed since it was looked up: look it up again." {
		t.Fatalf("changed: %v", err)
	}
	if _, err := l.OfferToPay(ctx, "lno1expired", ""); !errors.Is(err, ErrRefused) {
		t.Fatalf("an offer is checked again at Send: %v", err)
	}
}

func TestNames(t *testing.T) {
	cases := map[string]Name{
		"alice@example.com":     {User: "alice", Domain: "example.com"},
		"₿Alice@Example.COM":    {User: "alice", Domain: "example.com", BIP353Only: true},
		"bücher@bücher.example": {User: "xn--bcher-kva", Domain: "xn--bcher-kva.example"},
	}
	for s, want := range cases {
		if got, ok := ParseName(s); !ok || got != want {
			t.Errorf("%s: %+v %v", s, got, ok)
		}
	}
	for _, s := range []string{"alice", "@example.com", "alice@", "a@b@c", "alice@localhost"} {
		if _, ok := ParseName(s); ok {
			t.Errorf("%s read as a name", s)
		}
	}
}

type brokenAddresses struct{}

func (brokenAddresses) PayRequest(context.Context, string) (lnaddr.PayRequest, error) {
	return lnaddr.PayRequest{}, errors.New("lnaddr: the server can't be reached")
}

// namesNeverAsked fails the test if a link is ever looked up as a name.
type namesNeverAsked struct{ t *testing.T }

func (n namesNeverAsked) Resolve(_ context.Context, user, domain string) (bip353.Result, error) {
	n.t.Errorf("a link was looked up as a name: %s@%s", user, domain)
	return bip353.Result{}, bip353.ErrNone
}

func TestALinkIsNeverAName(t *testing.T) {
	l := looker()
	l.Names = namesNeverAsked{t}
	l.Addresses = payRequests{
		"https://pay.example.com/P":          {MinMsat: 1_000, MaxMsat: 5_000},
		"https://pay.example.com/P?a=b@c.io": {MinMsat: 1_000, MaxMsat: 5_000},
	}
	for _, link := range []string{"https://pay.example.com/P", "https://pay.example.com/P?a=b@c.io"} {
		got, err := l.Lookup(context.Background(), link)
		if err != nil || got.Kind != "payurl" || got.To != link {
			t.Errorf("%s: %+v %v", link, got, err)
		}
	}
}

func TestAnUnaskableNameIsUnreadable(t *testing.T) {
	l := looker()
	long := strings.Repeat("a", 64)
	for _, s := range []string{"alice@example..com", ".a@x.com", "a.@x.com", "alice@example.com.", "a/b@example.com", "a b@example.com",
		"alice@https://example.com", long + "@example.com", "a@" + long + ".com", "a@" + strings.Repeat(strings.Repeat("b", 60)+".", 4) + "com"} {
		_, err := l.Lookup(context.Background(), s)
		var r *Refusal
		if !errors.As(err, &r) || r.Sentence != "That isn't a name that can be looked up." {
			t.Errorf("%q: %v", s, err)
		}
	}
}

func TestAnAddressServerDownIsNotARefusal(t *testing.T) {
	l := looker()
	l.Names = names{} // ErrNone
	l.Addresses = brokenAddresses{}
	_, err := l.Lookup(context.Background(), "zed@example.com")
	if err == nil || errors.Is(err, ErrRefused) {
		t.Fatalf("%v", err)
	}
}

func TestSendingWhenTheRecordFailsNow(t *testing.T) {
	l := looker()
	l.Names = names{"alice@phoenixwallet.me": bip353.ErrBogus}
	_, err := l.OfferToPay(context.Background(), "lno1phoenix", "₿alice@phoenixwallet.me")
	var r *Refusal
	if !errors.As(err, &r) || r.Sentence != "phoenixwallet.me's record for alice failed its signature check: it may have been tampered with." {
		t.Fatalf("%v", err)
	}
}

func TestOffersAreCleaned(t *testing.T) {
	if !sameOffer("LNO1\n+ phoenix", "lno1phoenix") || sameOffer("lno1phoenix", "lno1phoenix2") {
		t.Fatal("sameOffer")
	}
	l := looker()
	got, err := l.Lookup(context.Background(), "lightning:LNO1FIXED+\n  ")
	if err != nil || got.Offer != "lno1fixed" {
		t.Fatalf("%+v %v", got, err)
	}
}

type otherRefusal struct{ offers }

func (otherRefusal) DecodeOffer(context.Context, string) (phoenixd.Offer, error) {
	return phoenixd.Offer{}, &phoenixd.RefusedError{Status: 401, Detail: "bad password"}
}

func TestOnlyA400MeansUnreadable(t *testing.T) {
	l := looker()
	l.Offers = otherRefusal{}
	_, err := l.Lookup(context.Background(), "lno1free")
	if err == nil || errors.Is(err, ErrRefused) {
		t.Fatalf("%v", err)
	}
	// phoenixd refusing for another reason is phoenixd failing, not the
	// offer: the API answers it phoenixd_unreachable, never a 500.
	if !errors.Is(err, phoenixd.ErrUnreachable) {
		t.Fatalf("a 401 isn't phoenixd unreachable: %v", err)
	}
}
