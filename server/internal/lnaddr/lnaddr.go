// Package lnaddr turns a Lightning address (user@domain) or an LNURL-pay URL
// into a bolt11 invoice for an amount, with LNURL-pay (LUD-06, LUD-16). cardd
// pays the invoice itself, so every payment has a payment hash before it
// leaves. The real resolver talks only to public addresses over https.
package lnaddr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

var ErrBadAddress = errors.New("lnaddr: can't get an invoice from this address")

var address = regexp.MustCompile(`^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}(:[0-9]+)?$`)

// IsAddress reports whether s looks like a Lightning address.
func IsAddress(s string) bool { return address.MatchString(strings.ToLower(s)) }

// IsPayURL reports whether s looks like an LNURL-pay URL (http or https; the
// resolver allows only its own scheme).
func IsPayURL(s string) bool {
	u, err := url.Parse(strings.TrimSpace(s))
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}

type Resolver struct {
	HTTP   *http.Client
	Scheme string // "https"; tests use "http"
	// PinHost, if set, is the one host (with its port, if any) the pay
	// request, every redirect and the callback must be on: a renewal pays
	// api.lnvps.net and nobody else.
	PinHost string
}

// Pinned is a copy of r that talks only to host.
func (r *Resolver) Pinned(host string) *Resolver {
	c := *r
	c.PinHost = host
	return &c
}

// onPinnedHost reports whether u may be asked: any host, or the pinned one.
func (r *Resolver) onPinnedHost(u *url.URL) bool {
	return r.PinHost == "" || strings.EqualFold(u.Host, r.PinHost)
}

// New is the resolver cardd uses: https only, and connections only to
// public addresses (checked when dialling, after DNS, so redirects are
// covered too).
func New() *Resolver {
	dialer := &net.Dialer{Timeout: 10 * time.Second, Control: dialPublicOnly}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	tr.DialContext = dialer.DialContext
	return &Resolver{HTTP: &http.Client{Timeout: 15 * time.Second, Transport: tr}, Scheme: "https"}
}

func cidr(s string) *net.IPNet {
	_, n, _ := net.ParseCIDR(s)
	return n
}

// Ranges that aren't the public internet, or that carry an IPv4 address
// inside IPv6 (which could be a private one): shared CGNAT space, "this
// network", NAT64, 6to4 and IPv4-compatible addresses; and IANA's other
// special-purpose ranges: IETF protocol
// assignments (192.0.0.0/24, and 2001::/23 with Teredo's 2001::/32, which
// carries an IPv4 address), documentation (192.0.2.0/24, 198.51.100.0/24,
// 203.0.113.0/24, 2001:db8::/32), benchmarking (198.18.0.0/15), reserved
// (240.0.0.0/4, broadcast's 255.255.255.255 among them), the deprecated 6to4
// relay anycast (192.88.99.0/24), discard (100::/64), local NAT64
// (64:ff9b:1::/48), the deprecated site-local fec0::/10 (Go's IsPrivate
// covers only fc00::/7), SRv6 SIDs (5f00::/16, RFC 9602) and the newer IPv6
// documentation prefix (3fff::/20, RFC 9637).
var notPublic = []*net.IPNet{
	cidr("100.64.0.0/10"), cidr("0.0.0.0/8"), cidr("64:ff9b::/96"), cidr("2002::/16"), cidr("::/96"),
	cidr("192.0.0.0/24"), cidr("192.0.2.0/24"), cidr("198.51.100.0/24"), cidr("203.0.113.0/24"), cidr("198.18.0.0/15"),
	cidr("240.0.0.0/4"), cidr("192.88.99.0/24"),
	cidr("2001::/23"), cidr("2001:db8::/32"), cidr("100::/64"), cidr("64:ff9b:1::/48"), cidr("fec0::/10"), cidr("5f00::/16"),
	cidr("3fff::/20"),
}

// publicIP reports whether ip is on the public internet: not this machine, a
// private or shared network, link-local, unspecified, multicast, or an IPv6
// address carrying an IPv4 one.
func publicIP(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast() {
		return false
	}
	for _, n := range notPublic {
		if n.Contains(ip) {
			return false
		}
	}
	return true
}

func dialPublicOnly(network, addr string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if !publicIP(net.ParseIP(host)) {
		return fmt.Errorf("%s is not a public address", host)
	}
	return nil
}

func (r *Resolver) getJSON(ctx context.Context, u string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return err
	}
	c := *r.HTTP
	c.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return errors.New("too many redirects")
		}
		if req.URL.Scheme != r.Scheme {
			return fmt.Errorf("redirected to %s", req.URL.Scheme)
		}
		if !r.onPinnedHost(req.URL) {
			return fmt.Errorf("redirected to %s", req.URL.Host)
		}
		return nil
	}
	resp, err := c.Do(req)
	if err != nil {
		return asNoAnswer(u, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return err
	}
	var e struct {
		Status, Reason string
	}
	if json.Unmarshal(raw, &e) == nil && e.Status == "ERROR" {
		return fmt.Errorf("the address's server says \"%s\"", remoteText(e.Reason))
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.Unmarshal(raw, out)
}

// noAnswer is a request that got no answer from its host, in words for a
// person: the network library's own ("dial tcp: lookup … on 127.0.0.11:53:
// no such host", with the whole URL) say nothing to one.
type noAnswer struct {
	host   string
	noHost bool // DNS has no such name: there is no server there at all
}

func (e *noAnswer) Error() string {
	if e.noHost {
		return e.host + " has no server to ask for one"
	}
	return e.host + "'s server can't be reached"
}

// asNoAnswer is err as a noAnswer when it is one: no such host, a
// connection refused or cut, no route, or no answer in time. Any other
// failure (a redirect cardd refuses, an address that isn't public, TLS)
// keeps its own words.
func asNoAnswer(u string, err error) error {
	inner := err
	var ue *url.Error
	if errors.As(err, &ue) {
		u, inner = ue.URL, ue.Err
	}
	host := u
	if p, perr := url.Parse(u); perr == nil && p.Hostname() != "" {
		host = p.Hostname()
	}
	var dns *net.DNSError
	if errors.As(inner, &dns) {
		return &noAnswer{host: host, noHost: dns.IsNotFound}
	}
	var ne net.Error
	timedOut := errors.Is(inner, context.DeadlineExceeded) || (errors.As(inner, &ne) && ne.Timeout())
	for _, cut := range []error{syscall.ECONNREFUSED, syscall.ECONNRESET, syscall.EHOSTUNREACH, syscall.ENETUNREACH} {
		if errors.Is(inner, cut) {
			timedOut = true
		}
	}
	if timedOut {
		return &noAnswer{host: host}
	}
	return err
}

// maxRemoteText is the most of a remote server's words cardd passes on, in characters.
const maxRemoteText = 200

// maxErrText is the most of an error about a remote server cardd passes on,
// in characters: Go's errors quote the whole URL, which the server chose.
const maxErrText = 250

// maxCallback is the longest callback URL taken, in bytes.
const maxCallback = 2048

// remoteText is a remote server's own words as cardd passes them on (the
// API's answer, the log, a renewal's problem kept in meta): valid UTF-8, no
// control or format characters (no line breaks, no bidi overrides), runs of
// space as one, at most 200 characters.
func remoteText(s string) string { return cleanText(s, maxRemoteText) }

// errText is an error about a remote server as cardd passes it on, cleaned
// like remoteText and cut at maxErrText characters (it may hold remoteText's
// labelled words, which fit).
func errText(err error) string { return cleanText(err.Error(), maxErrText) }

// MaxText and MaxLink are the most of an outside text and of a link cardd
// keeps: a payment's description and the address or link paid.
const (
	MaxText = maxRemoteText
	MaxLink = maxCallback
)

// Clean is remoteText's rule at any length: valid UTF-8, control and format
// characters (line breaks, bidi overrides) as spaces, runs of space as one,
// at most limit characters (then "…").
func Clean(s string, limit int) string { return cleanText(s, limit) }

// PlainText is a pay request's text/plain entry (LUD-06's metadata, a JSON
// array of [type, value] pairs), cleaned; "" without one.
func PlainText(metadata string) string {
	var pairs [][]any
	if json.Unmarshal([]byte(metadata), &pairs) != nil {
		return ""
	}
	for _, p := range pairs {
		if len(p) == 2 && p[0] == "text/plain" {
			if s, ok := p[1].(string); ok {
				return Clean(s, MaxText)
			}
		}
	}
	return ""
}

func cleanText(s string, limit int) string {
	clean := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return ' '
		}
		return r
	}, strings.ToValidUTF8(s, "\uFFFD"))
	text := strings.Join(strings.Fields(clean), " ")
	if runes := []rune(text); len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return text
}

// Result is an invoice from a pay request, with the request's metadata
// (whose sha256 the invoice's description hash should be).
type Result struct {
	PR       string
	Metadata string
}

// Invoice asks the address's server for an invoice of amountMsat.
func (r *Resolver) Invoice(ctx context.Context, addr string, amountMsat int64) (string, error) {
	res, err := r.Resolve(ctx, addr, amountMsat)
	return res.PR, err
}

// PayRequest is what an address's or LNURL-pay link's server says it takes
// (LUD-06), read before any invoice: Send out's lookup.
type PayRequest struct {
	MinMsat, MaxMsat int64
	Metadata         string
	// CommentAllowed is LUD-12's limit on a payer's comment, in characters;
	// 0 when the request allows none (absent, or not a whole number).
	CommentAllowed int
	callback       string
}

// commentLimit reads LUD-12's commentAllowed leniently: anything but a
// non-negative whole number (absent, null, a string, a fraction) is 0, so an
// odd value never breaks a payment that sends no comment.
func commentLimit(raw json.RawMessage) int {
	// A bare JSON number only: Go's json.Number also takes a quoted one.
	if len(raw) == 0 || raw[0] < '0' || raw[0] > '9' {
		return 0
	}
	v, err := strconv.ParseInt(string(raw), 10, 32)
	if err != nil || v < 0 {
		return 0
	}
	return int(v)
}

// PayRequest reads a Lightning address's or LNURL-pay link's pay request. A
// domain with no server at all is NoServer(err).
func (r *Resolver) PayRequest(ctx context.Context, target string) (PayRequest, error) {
	target = strings.TrimSpace(target)
	var payURL string
	switch {
	case IsAddress(target):
		user, domain, _ := strings.Cut(strings.ToLower(target), "@")
		payURL = r.Scheme + "://" + domain + "/.well-known/lnurlp/" + url.PathEscape(user)
	case IsPayURL(target):
		if u, _ := url.Parse(target); u.Scheme != r.Scheme {
			return PayRequest{}, fmt.Errorf("%w: only %s links", ErrBadAddress, r.Scheme)
		}
		payURL = target
	default:
		return PayRequest{}, fmt.Errorf("%w: %q is not a Lightning address or LNURL-pay link", ErrBadAddress, target)
	}
	if u, err := url.Parse(payURL); err != nil || !r.onPinnedHost(u) {
		return PayRequest{}, fmt.Errorf("%w: not on %s", ErrBadAddress, r.PinHost)
	}
	var pr struct {
		Tag         string `json:"tag"`
		Callback    string `json:"callback"`
		MinSendable int64  `json:"minSendable"`
		MaxSendable int64  `json:"maxSendable"`
		Metadata    string `json:"metadata"`
		// LUD-12, read leniently (commentLimit).
		CommentAllowed json.RawMessage `json:"commentAllowed"`
	}
	if err := r.getJSON(ctx, payURL, &pr); err != nil {
		var none *noAnswer
		if errors.As(err, &none) && none.noHost && IsAddress(target) {
			user, domain, _ := strings.Cut(strings.ToLower(target), "@")
			return PayRequest{}, &noServer{domain: domain, user: user}
		}
		return PayRequest{}, fmt.Errorf("%w: %s", ErrBadAddress, errText(err))
	}
	if pr.Tag != "payRequest" || pr.Callback == "" {
		return PayRequest{}, fmt.Errorf("%w: not a pay request", ErrBadAddress)
	}
	return PayRequest{MinMsat: pr.MinSendable, MaxMsat: pr.MaxSendable, Metadata: pr.Metadata, CommentAllowed: commentLimit(pr.CommentAllowed), callback: pr.Callback}, nil
}

// noServer: an address whose domain has no server to ask. Likely as not a
// BIP353 address (a DNS record pointing to an offer, as Phoenix gives),
// which an app with Send out's lookup pays.
type noServer struct{ domain, user string }

func (e *noServer) Error() string {
	return fmt.Sprintf("%s: %s has no Lightning address server for %s. If it is a ₿ address, update Karto Wallet; otherwise look it up again",
		ErrBadAddress, e.domain, e.user)
}
func (e *noServer) Is(target error) bool { return target == ErrBadAddress }

// NoServer is whether err is an address's domain having no server at all.
func NoServer(err error) bool {
	var n *noServer
	return errors.As(err, &n)
}

// NoServerError is the error PayRequest gives for user@domain with no
// server, for tests elsewhere.
func NoServerError(user, domain string) error { return &noServer{domain: domain, user: user} }

// Resolve gets an invoice of amountMsat from a Lightning address or an
// LNURL-pay URL.
func (r *Resolver) Resolve(ctx context.Context, target string, amountMsat int64) (Result, error) {
	return r.ResolveWithComment(ctx, target, amountMsat, nil)
}

// ResolveWithComment is Resolve with LUD-12's comment: when the pay request
// allows one, words(limit) gives it, fitted to limit characters by the
// caller; "" (or a nil words) sends none.
func (r *Resolver) ResolveWithComment(ctx context.Context, target string, amountMsat int64, words func(limit int) string) (Result, error) {
	pr, err := r.PayRequest(ctx, target)
	if err != nil {
		return Result{}, err
	}
	if amountMsat < pr.MinMsat || amountMsat > pr.MaxMsat {
		return Result{}, fmt.Errorf("%w: it takes %d to %d sat", ErrBadAddress, pr.MinMsat/1000, pr.MaxMsat/1000)
	}
	cb, err := url.Parse(pr.callback)
	if err != nil || cb.Scheme != r.Scheme || len(pr.callback) > maxCallback {
		return Result{}, fmt.Errorf("%w: bad callback", ErrBadAddress)
	}
	if !r.onPinnedHost(cb) {
		return Result{}, fmt.Errorf("%w: callback not on %s", ErrBadAddress, r.PinHost)
	}
	q := cb.Query()
	q.Set("amount", strconv.FormatInt(amountMsat, 10))
	if words != nil && pr.CommentAllowed > 0 {
		if c := words(pr.CommentAllowed); c != "" && utf8.RuneCountInString(c) <= pr.CommentAllowed {
			q.Set("comment", c)
		}
	}
	cb.RawQuery = q.Encode()
	var inv struct {
		PR string `json:"pr"`
	}
	if err := r.getJSON(ctx, cb.String(), &inv); err != nil || inv.PR == "" {
		if err == nil {
			return Result{}, fmt.Errorf("%w: no invoice", ErrBadAddress)
		}
		return Result{}, fmt.Errorf("%w: no invoice: %s", ErrBadAddress, errText(err))
	}
	return Result{PR: inv.PR, Metadata: pr.Metadata}, nil
}
