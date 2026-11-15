// Package bip353 reads a BIP353 name's payment instructions
// (bip-0353.mediawiki): the TXT record at user.user._bitcoin-payment.domain,
// a BIP21 URI that, for Send out, carries a BOLT12 offer (lno=).
//
// It asks two DNS-over-HTTPS services together (RFC 8484), Google's and
// Cloudflare's, and trusts their DNSSEC validation, their AD flag, only when
// both answer and agree. That is phoenixd's way (PayDnsAddress.kt, Google
// alone) with a second service, and it differs from BIP353, which says a
// wallet "MUST NOT trust a remote resolver to validate DNSSEC records on
// their behalf". A record whose own signature uses SHA-1 is refused.
package bip353

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	"github.com/boltcard/karto/server/internal/lnaddr"
)

// Services are the two DNS-over-HTTPS services asked, both always.
var Services = []string{"https://dns.google/dns-query", "https://cloudflare-dns.com/dns-query"}

var (
	ErrNone        = errors.New("bip353: no record")
	ErrNoOffer     = errors.New("bip353: the record has no offer")
	ErrRequires    = errors.New("bip353: the record has a req- parameter cardd doesn't understand")
	ErrSeveral     = errors.New("bip353: more than one payment record")
	ErrNotSigned   = errors.New("bip353: the record isn't signed")
	ErrBogus       = errors.New("bip353: the record failed its signature check")
	ErrWeak        = errors.New("bip353: the record is signed with SHA-1")
	ErrUnreachable = errors.New("bip353: a DNS service didn't answer")
	ErrDisagree    = errors.New("bip353: the DNS services gave different answers")
)

// Result is a name's payment instructions: the record's URI, and its offer.
type Result struct {
	URI, Offer string
}

// Resolver asks Services. Wait is the whole lookup's budget (4 s).
type Resolver struct {
	HTTP     *http.Client
	Services []string
	Wait     time.Duration
}

// New asks Services through lnaddr's client: HTTPS to public addresses only.
func New() *Resolver {
	return &Resolver{HTTP: lnaddr.New().HTTP, Services: Services, Wait: 4 * time.Second}
}

// Resolve reads user@domain's record. user and domain are lowercase ASCII
// (punycode for a name that isn't).
func (r *Resolver) Resolve(ctx context.Context, user, domain string) (Result, error) {
	name := user + ".user._bitcoin-payment." + domain + "."
	q, err := question(name)
	if err != nil {
		return Result{}, fmt.Errorf("bip353: %q can't be asked: %w", name, err)
	}
	ctx, cancel := context.WithTimeout(ctx, r.Wait)
	defer cancel()
	answers := make([]answer, len(r.Services))
	var wg sync.WaitGroup
	for i, svc := range r.Services {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers[i] = r.ask(ctx, svc, name, q)
		}()
	}
	wg.Wait()
	return combine(answers)
}

type kind int

// kindUnreachable is the zero value, so an answer nobody wrote fails closed.
const (
	kindUnreachable kind = iota
	kindRecord
	kindSeveral
	kindNotSigned
	kindNone
	kindBogus
)

// answer is what one service said.
type answer struct {
	kind kind
	uri  string
	weak bool // the record's RRSIG is SHA-1
}

// combine is the two answers' verdict: a doubt from
// either one wins, then agreement is needed.
func combine(as []answer) (Result, error) {
	if len(as) != 2 {
		return Result{}, ErrUnreachable
	}
	for _, k := range []struct {
		kind kind
		err  error
	}{{kindNotSigned, ErrNotSigned}, {kindBogus, ErrBogus}, {kindUnreachable, ErrUnreachable}} {
		for _, a := range as {
			if a.kind == k.kind {
				return Result{}, k.err
			}
		}
	}
	all := func(k kind) bool {
		for _, a := range as {
			if a.kind != k {
				return false
			}
		}
		return true
	}
	switch {
	case all(kindNone):
		return Result{}, ErrNone
	case all(kindSeveral):
		return Result{}, ErrSeveral
	case !all(kindRecord):
		return Result{}, ErrDisagree
	}
	for _, a := range as[1:] {
		if a.uri != as[0].uri {
			return Result{}, ErrDisagree
		}
	}
	for _, a := range as {
		if a.weak {
			return Result{}, ErrWeak
		}
	}
	if requires(as[0].uri) {
		return Result{}, ErrRequires
	}
	offer := lno(as[0].uri)
	if offer == "" {
		return Result{}, ErrNoOffer
	}
	return Result{URI: as[0].uri, Offer: offer}, nil
}

// question is a TXT query for name with EDNS0 and the DO bit, so the answer
// carries its RRSIGs. RFC 8484 asks for id 0.
func question(name string) ([]byte, error) {
	n, err := dnsmessage.NewName(name)
	if err != nil {
		return nil, err
	}
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		if label == "" || len(label) > 63 {
			return nil, errors.New("a label is empty or over 63 bytes")
		}
	}
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{RecursionDesired: true})
	b.EnableCompression()
	if err := b.StartQuestions(); err != nil {
		return nil, err
	}
	if err := b.Question(dnsmessage.Question{Name: n, Type: dnsmessage.TypeTXT, Class: dnsmessage.ClassINET}); err != nil {
		return nil, err
	}
	if err := b.StartAdditionals(); err != nil {
		return nil, err
	}
	var rh dnsmessage.ResourceHeader
	if err := rh.SetEDNS0(1232, dnsmessage.RCodeSuccess, true); err != nil {
		return nil, err
	}
	if err := b.OPTResource(rh, dnsmessage.OPTResource{}); err != nil {
		return nil, err
	}
	return b.Finish()
}

// ask is one service's answer, read.
func (r *Resolver) ask(ctx context.Context, service, name string, q []byte) answer {
	req, err := http.NewRequestWithContext(ctx, "POST", service, bytes.NewReader(q))
	if err != nil {
		return answer{kind: kindUnreachable}
	}
	req.Header.Set("Content-Type", "application/dns-message")
	req.Header.Set("Accept", "application/dns-message")
	resp, err := r.HTTP.Do(req)
	if err != nil {
		return answer{kind: kindUnreachable}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil || resp.StatusCode != http.StatusOK {
		return answer{kind: kindUnreachable}
	}
	return read(name, raw)
}

// typeRRSIG is DNS's RRSIG type, which dnsmessage leaves unknown.
const typeRRSIG = dnsmessage.Type(46)

// read sorts one service's answer.
func read(name string, raw []byte) answer {
	var p dnsmessage.Parser
	h, err := p.Start(raw)
	// A truncated answer may be missing the very record (a second one, the
	// SHA-1 signature) that would change the verdict. We sent id 0, opcode 0.
	if err != nil || !h.Response || h.Truncated || h.OpCode != 0 || h.ID != 0 {
		return answer{kind: kindUnreachable}
	}
	// It must answer what we asked: that one name, TXT, IN.
	asked, err := p.Question()
	if err != nil || asked.Type != dnsmessage.TypeTXT || asked.Class != dnsmessage.ClassINET ||
		asciiLower(asked.Name.String()) != asciiLower(name) {
		return answer{kind: kindUnreachable}
	}
	if _, err := p.Question(); !errors.Is(err, dnsmessage.ErrSectionDone) {
		return answer{kind: kindUnreachable}
	}
	type txt struct{ owner, text string }
	var txts []txt
	cnames := map[string]string{}
	sigAlgs := map[string][]byte{}
	for {
		ah, err := p.AnswerHeader()
		if errors.Is(err, dnsmessage.ErrSectionDone) {
			break
		}
		if err != nil {
			return answer{kind: kindUnreachable}
		}
		owner := asciiLower(ah.Name.String())
		if ah.Class != dnsmessage.ClassINET {
			if err := p.SkipAnswer(); err != nil {
				return answer{kind: kindUnreachable}
			}
			continue
		}
		switch ah.Type {
		case dnsmessage.TypeCNAME:
			c, err := p.CNAMEResource()
			if err != nil {
				return answer{kind: kindUnreachable}
			}
			if _, dup := cnames[owner]; dup {
				return answer{kind: kindUnreachable}
			}
			cnames[owner] = asciiLower(c.CNAME.String())
		case dnsmessage.TypeTXT:
			t, err := p.TXTResource()
			if err != nil {
				return answer{kind: kindUnreachable}
			}
			// BIP353 line 55: the strings joined in order, no separators.
			txts = append(txts, txt{owner, strings.Join(t.TXT, "")})
		case typeRRSIG:
			u, err := p.UnknownResource()
			if err != nil {
				return answer{kind: kindUnreachable}
			}
			// RRSIG RDATA: type covered (2 bytes), then the algorithm.
			if len(u.Data) >= 3 && binary.BigEndian.Uint16(u.Data[:2]) == uint16(dnsmessage.TypeTXT) {
				sigAlgs[owner] = append(sigAlgs[owner], u.Data[2])
			}
		default:
			if err := p.SkipAnswer(); err != nil {
				return answer{kind: kindUnreachable}
			}
		}
	}
	switch h.RCode {
	case dnsmessage.RCodeSuccess:
	case dnsmessage.RCodeNameError:
		return answer{kind: kindNone}
	case dnsmessage.RCodeServerFailure:
		if dnssecFailed(&p) {
			return answer{kind: kindBogus}
		}
		return answer{kind: kindUnreachable}
	default:
		return answer{kind: kindUnreachable}
	}
	// A DNAME comes with the CNAME it makes, so CNAMEs are enough to follow.
	// A chain that loops or runs past 8 hops is not a "no record".
	target := asciiLower(name)
	seen := map[string]bool{}
	for {
		next, ok := cnames[target]
		if !ok {
			break
		}
		if seen[target] || len(seen) >= 8 {
			return answer{kind: kindUnreachable}
		}
		seen[target] = true
		target = next
	}
	var records []string
	for _, t := range txts {
		// BIP353 line 53: records not starting "bitcoin:" (any case) are ignored.
		if t.owner == target && len(t.text) >= 8 && strings.EqualFold(t.text[:8], "bitcoin:") {
			records = append(records, t.text)
		}
	}
	switch {
	case len(records) == 0:
		return answer{kind: kindNone}
	case !h.AuthenticData:
		return answer{kind: kindNotSigned}
	case len(sigAlgs[target]) == 0:
		// AD but no signature to read: the SHA-1 rule can't be checked.
		return answer{kind: kindNotSigned}
	case len(records) > 1:
		return answer{kind: kindSeveral}
	}
	weak := false
	for _, alg := range sigAlgs[target] {
		weak = weak || alg == 5 || alg == 7 // RSASHA1, RSASHA1-NSEC3-SHA1
	}
	return answer{kind: kindRecord, uri: records[0], weak: weak}
}

// dnssecFailed is whether a SERVFAIL's Extended DNS Error (RFC 8914, option
// 15) says DNSSEC failed: codes 1 to 12, but 3 (a stale answer).
func dnssecFailed(p *dnsmessage.Parser) bool {
	if err := p.SkipAllAuthorities(); err != nil {
		return false
	}
	for {
		ah, err := p.AdditionalHeader()
		if err != nil {
			return false
		}
		if ah.Type != dnsmessage.TypeOPT {
			if err := p.SkipAdditional(); err != nil {
				return false
			}
			continue
		}
		opt, err := p.OPTResource()
		if err != nil {
			return false
		}
		for _, o := range opt.Options {
			if o.Code == 15 && len(o.Data) >= 2 {
				code := binary.BigEndian.Uint16(o.Data[:2])
				return code >= 1 && code <= 12 && code != 3
			}
		}
	}
}

// lno is a BIP21 URI's offer: its lno= parameter, key in any case.
func lno(uri string) string {
	_, query, _ := strings.Cut(uri, "?")
	offer, found := "", false
	for _, kv := range strings.Split(query, "&") {
		k, v, _ := strings.Cut(kv, "=")
		if strings.EqualFold(k, "lno") {
			s, err := url.QueryUnescape(v)
			if found || err != nil {
				return "" // twice, or unreadable: no offer rather than a guess
			}
			offer, found = s, true
		}
	}
	return offer
}

// requires is whether the URI has a req- parameter. BIP321 (which BIP353
// line 193 points to for parsing): a URI with a req- parameter the wallet
// doesn't understand "MUST be considered invalid". cardd understands none.
func requires(uri string) bool {
	_, query, _ := strings.Cut(uri, "?")
	for _, kv := range strings.Split(query, "&") {
		k, _, _ := strings.Cut(kv, "=")
		if d, err := url.QueryUnescape(k); err == nil {
			k = d // "%72eq-x" is req-x, as the app reads it
		}
		if len(k) >= 4 && strings.EqualFold(k[:4], "req-") {
			return true
		}
	}
	return false
}

// asciiLower folds A-Z only: DNS names compare that way, and Unicode folding
// (the Kelvin sign) would merge names DNS keeps apart.
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 'a' - 'A'
		}
	}
	return string(b)
}
