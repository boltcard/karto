// Package ratelimit holds back what anyone on the internet may ask cardd to do: a token bucket for each client
// and one over all of them, so that one client can't use up everyone's share and many can't flood the server.
// The map of clients is bounded, so the limiter itself can't be made to fill cardd's memory.
package ratelimit

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// Rate is a bucket's size: Burst may be taken at once, and one more comes back after each Every, up to Burst.
type Rate struct {
	Burst int
	Every time.Duration
}

// Limiter is a bucket per client (PerClient) and one for everyone (Overall). A bucket is kept as the time at which it
// is full again (the generic cell rate algorithm), so a client's is one time in a map, and one that is full again
// needn't be kept at all.
type Limiter struct {
	perClient, overall Rate
	maxClients         int
	now                func() time.Time

	mu      sync.Mutex
	all     time.Time
	clients map[string]time.Time
	swept   time.Time
	sweeps  int // for the tests
}

// New makes a limiter that keeps at most maxClients clients; now is the clock (time.Now when nil).
func New(perClient, overall Rate, maxClients int, now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	return &Limiter{perClient: perClient, overall: overall, maxClients: maxClients, now: now,
		clients: map[string]time.Time{}, swept: now()}
}

// Take takes one from client's bucket and one from everyone's, or neither: a request refused costs nothing, so a
// client asking on and on past its limit takes nothing from anyone else. When refused, retry is how long until it
// would be allowed.
//
// A client new to a limiter that already keeps maxClients is refused until some of them are full again and
// forgotten: by then the overall bucket is the limit anyway (it is smaller than maxClients clients' bursts).
func (l *Limiter) Take(client string) (ok bool, retry time.Duration) {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	// Clients full again are forgotten once in each burst's refill time, so the map shrinks after a flood; when
	// it is full, as often as one can be full again, and no more often, so a full map isn't walked per request.
	if now.Sub(l.swept) >= time.Duration(l.perClient.Burst)*l.perClient.Every {
		l.sweep(now)
	}
	full, known := l.clients[client]
	if !known && len(l.clients) >= l.maxClients {
		if now.Sub(l.swept) >= l.perClient.Every {
			l.sweep(now)
		}
		if len(l.clients) >= l.maxClients {
			return false, l.perClient.Every
		}
	}
	nextClient, waitClient := next(full, now, l.perClient)
	nextAll, waitAll := next(l.all, now, l.overall)
	if waitClient > 0 || waitAll > 0 {
		return false, max(waitClient, waitAll)
	}
	l.clients[client], l.all = nextClient, nextAll
	return true, 0
}

// next is when a bucket full again at full would be full again after one more is taken now, and how long to wait
// before it may be (0: now).
func next(full, now time.Time, r Rate) (time.Time, time.Duration) {
	if full.Before(now) {
		full = now
	}
	after := full.Add(r.Every)
	return after, max(0, after.Sub(now)-time.Duration(r.Burst)*r.Every)
}

func (l *Limiter) sweep(now time.Time) {
	for c, full := range l.clients {
		if !full.After(now) {
			delete(l.clients, c)
		}
	}
	l.swept = now
	l.sweeps++
}

func (l *Limiter) clientsKept() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.clients)
}

// ClientKey is who is asking, as Take counts clients: the last address in X-Forwarded-For, or the connection's
// own without one.
//
// Only Caddy reaches cardd (compose publishes no port of cardd's), and Caddy's reverse_proxy, with no
// trusted_proxies set, writes the address it accepted the connection from into X-Forwarded-For, after whatever
// the client wrote there if it keeps that at all: so the last address is Caddy's own reading and a client can't
// choose it. X-Real-IP is not read: Caddy passes it on as the client wrote it.
//
// An IPv6 client is counted by its /64: one machine usually has the whole of one, so its addresses in it are one
// client.
func ClientKey(r *http.Request) string {
	addr, ok := forwardedFor(r)
	if !ok {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			return "unknown"
		}
		if addr, err = netip.ParseAddr(host); err != nil {
			return "unknown"
		}
	}
	addr = addr.Unmap().WithZone("")
	if addr.Is6() {
		p, _ := addr.Prefix(64)
		return p.String()
	}
	return addr.String()
}

// forwardedFor is the last address in the request's X-Forwarded-For, if there is one there.
func forwardedFor(r *http.Request) (netip.Addr, bool) {
	lines := r.Header.Values("X-Forwarded-For")
	if len(lines) == 0 {
		return netip.Addr{}, false
	}
	last := lines[len(lines)-1]
	if i := strings.LastIndexByte(last, ','); i >= 0 {
		last = last[i+1:]
	}
	addr, err := netip.ParseAddr(strings.TrimSpace(last))
	return addr, err == nil
}
