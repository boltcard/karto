package alerts

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"
)

var (
	// ErrBadEndpoint: not an https URL of a public host (UnifiedPush
	// asks servers to refuse private addresses, against request forgery).
	ErrBadEndpoint = errors.New("alerts: not an endpoint alerts can be sent to")
	// ErrNtfySh: an ntfy.sh endpoint on a server with its own ntfy: the ntfy
	// app moved to its default server after Karto registered.
	ErrNtfySh = errors.New("alerts: an ntfy.sh endpoint on a server with its own ntfy")
)

// CheckEndpoint says whether alerts may be posted to raw: https, a host
// that isn't localhost or an IP literal of an address that isn't public
// (public), any port. ntfyPublic is the server's own ntfy URL, "" for none:
// with one, an ntfy.sh endpoint is ErrNtfySh, and one on ntfyPublic's origin
// need only be a UnifiedPush topic (ntfyTopic), whatever its host, as cardd
// posts it inside the stack with its token. A name that resolves to an
// address that isn't public is refused when dialled (guardedClient).
func CheckEndpoint(raw, ntfyPublic string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" {
		return fmt.Errorf("%w: not an https URL", ErrBadEndpoint)
	}
	// The server's own ntfy is posted inside the stack (Sender.route), never
	// at its public address, so only its topic is checked: a test stack's
	// host is localhost.
	if ntfyPublic != "" && sameOrigin(raw, ntfyPublic) {
		if _, ok := ntfyTopic(u); !ok {
			return fmt.Errorf("%w: not a topic of this server's ntfy", ErrBadEndpoint)
		}
		return nil
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return fmt.Errorf("%w: %s is this machine", ErrBadEndpoint, host)
	}
	if ip, err := netip.ParseAddr(host); err == nil && !public(ip) {
		return fmt.Errorf("%w: %s is not a public address", ErrBadEndpoint, host)
	}
	if host == "ntfy.sh" && ntfyPublic != "" {
		return ErrNtfySh
	}
	return nil
}

// topicPath is a UnifiedPush topic on ntfy: "up" and the random part.
var topicPath = regexp.MustCompile(`^/up[A-Za-z0-9_-]{1,64}$`)

// ntfyTopic is the path of an endpoint on the server's own ntfy, when it is
// a UnifiedPush topic: /up<1-64 of A-Za-z0-9_->, nothing escaped, the
// query exactly "up=1" (ntfy-android Util.kt:58), no user or fragment.
// cardd posts only such a path inside the stack, with its token.
func ntfyTopic(u *url.URL) (string, bool) {
	if u.User != nil || u.Fragment != "" || u.RawFragment != "" || u.RawQuery != "up=1" ||
		u.RawPath != "" || u.EscapedPath() != u.Path || !topicPath.MatchString(u.Path) {
		return "", false
	}
	return u.Path, true
}

func prefixes(ss ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(ss))
	for i, s := range ss {
		out[i] = netip.MustParsePrefix(s)
	}
	return out
}

// special are IANA's special-purpose ranges a push service never has
// (RFC 6890 and its registries), beyond the private ones netip knows.
var special = prefixes(
	"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15",
	"198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
	"100::/64", "2001:db8::/32", "fc00::/7",
)

var (
	nat64      = netip.MustParsePrefix("64:ff9b::/96")
	nat64Local = netip.MustParsePrefix("64:ff9b:1::/48")
	sixToFour  = netip.MustParsePrefix("2002::/16")
	teredo     = netip.MustParsePrefix("2001::/32")
)

// public is true only for a global unicast address outside the
// special-purpose ranges; an IPv6 address carrying an IPv4 one (NAT64,
// 6to4, Teredo) is public only if what it carries is.
func public(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	for _, p := range special {
		if p.Contains(ip) {
			return false
		}
	}
	b := ip.As16()
	v4 := func(a, b, c, d byte) bool { return public(netip.AddrFrom4([4]byte{a, b, c, d})) }
	switch {
	case !ip.Is6():
		return true
	case nat64.Contains(ip):
		return v4(b[12], b[13], b[14], b[15])
	case nat64Local.Contains(ip): // RFC 6052's /48 layout: bits 64-71 are zero
		return v4(b[6], b[7], b[9], b[10])
	case sixToFour.Contains(ip):
		return v4(b[2], b[3], b[4], b[5])
	case teredo.Contains(ip): // the server's address, and the client's, inverted
		return v4(b[4], b[5], b[6], b[7]) && v4(^b[12], ^b[13], ^b[14], ^b[15])
	}
	return true
}

// refusePrivate is a dialer's Control: it refuses a connection to an address
// that isn't public, whatever name led to it (DNS rebinding).
func refusePrivate(_, address string, _ syscall.RawConn) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return fmt.Errorf("alerts: dialling %q: %w", address, err)
	}
	if !public(ap.Addr()) {
		return fmt.Errorf("alerts: %s is not a public address", ap.Addr())
	}
	return nil
}

// sendTimeout bounds one POST, so a slow push service holds up the next
// alert for no longer than this.
const sendTimeout = 15 * time.Second

// noRedirects: a push service answers, it doesn't send us elsewhere.
func noRedirects(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// guardedClient posts to any endpoint but the server's own ntfy: no proxy,
// and a dialer that refuses private addresses.
func guardedClient() *http.Client {
	d := &net.Dialer{Timeout: 10 * time.Second, Control: refusePrivate}
	return &http.Client{
		Timeout:       sendTimeout,
		CheckRedirect: noRedirects,
		Transport: &http.Transport{
			DialContext:         d.DialContext,
			ForceAttemptHTTP2:   true,
			TLSHandshakeTimeout: 10 * time.Second,
			MaxIdleConns:        10,
			IdleConnTimeout:     90 * time.Second,
		},
	}
}

// internalClient posts to the server's own ntfy inside the stack, a private
// address by design.
func internalClient() *http.Client {
	return &http.Client{Timeout: sendTimeout, CheckRedirect: noRedirects}
}

// sameOrigin says whether two URLs have one scheme, host and port (the
// scheme's default when none is written).
func sameOrigin(a, b string) bool {
	ua, err := url.Parse(a)
	if err != nil {
		return false
	}
	ub, err := url.Parse(b)
	if err != nil {
		return false
	}
	return strings.EqualFold(ua.Scheme, ub.Scheme) && ua.Hostname() != "" &&
		strings.EqualFold(strings.TrimSuffix(ua.Hostname(), "."), strings.TrimSuffix(ub.Hostname(), ".")) &&
		port(ua) == port(ub)
}

func port(u *url.URL) string {
	if p := u.Port(); p != "" {
		return p
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		return "443"
	case "http":
		return "80"
	}
	return ""
}
