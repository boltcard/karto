package ratelimit

import (
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// clock is a test's time, moved by hand.
type clock struct{ t time.Time }

func (c *clock) now() time.Time       { return c.t }
func (c *clock) pass(d time.Duration) { c.t = c.t.Add(d) }
func newClock() *clock                { return &clock{t: time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)} }
func limiter(c *clock, max int) *Limiter {
	return New(Rate{5, 10 * time.Second}, Rate{60, time.Second}, max, c.now)
}

func takeN(t *testing.T, l *Limiter, client string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if ok, _ := l.Take(client); !ok {
			t.Fatalf("%s: take %d of %d refused", client, i+1, n)
		}
	}
}

func TestABurstThenRefused(t *testing.T) {
	c := newClock()
	l := limiter(c, 100)
	takeN(t, l, "a", 5)
	ok, retry := l.Take("a")
	if ok || retry != 10*time.Second {
		t.Fatalf("the 6th at once: %v, retry %v", ok, retry)
	}
}

func TestOneComesBackEveryInterval(t *testing.T) {
	c := newClock()
	l := limiter(c, 100)
	takeN(t, l, "a", 5)
	c.pass(9 * time.Second)
	if ok, retry := l.Take("a"); ok || retry != time.Second {
		t.Fatalf("after 9 s: %v, retry %v", ok, retry)
	}
	c.pass(time.Second)
	takeN(t, l, "a", 1)
	if ok, _ := l.Take("a"); ok {
		t.Fatal("a second one after 10 s")
	}
	// Idle long enough, the whole burst is back, and no more than it.
	c.pass(time.Hour)
	takeN(t, l, "a", 5)
	if ok, _ := l.Take("a"); ok {
		t.Fatal("more than the burst after an hour's rest")
	}
}

func TestClientsAreApart(t *testing.T) {
	c := newClock()
	l := limiter(c, 100)
	takeN(t, l, "a", 5)
	takeN(t, l, "b", 5)
	if ok, _ := l.Take("a"); ok {
		t.Fatal("a's 6th")
	}
}

func TestTheOverallCap(t *testing.T) {
	c := newClock()
	l := limiter(c, 100)
	for i := 0; i < 12; i++ {
		takeN(t, l, "c"+strconv.Itoa(i), 5) // 60, from twelve clients
	}
	ok, retry := l.Take("new")
	if ok || retry != time.Second {
		t.Fatalf("a 61st from a new client: %v, retry %v", ok, retry)
	}
	// A refusal by the overall cap costs the client nothing.
	c.pass(time.Second)
	takeN(t, l, "new", 1)
	if ok, _ := l.Take("new"); ok {
		t.Fatal("two in a second over the overall cap")
	}
	c.pass(4 * time.Second)
	takeN(t, l, "new", 4)
}

func TestARefusedClientCostsTheOthersNothing(t *testing.T) {
	c := newClock()
	l := limiter(c, 100)
	takeN(t, l, "a", 5)
	for i := 0; i < 1000; i++ {
		l.Take("a")
	}
	// Only a's 5 came off the overall 60.
	for i := 0; i < 11; i++ {
		takeN(t, l, "c"+strconv.Itoa(i), 5)
	}
	if ok, _ := l.Take("last"); ok {
		t.Fatal("over the overall cap")
	}
}

func TestTheClientsKeptAreCapped(t *testing.T) {
	c := newClock()
	l := limiter(c, 3)
	takeN(t, l, "a", 1)
	takeN(t, l, "b", 1)
	takeN(t, l, "c", 1)
	ok, retry := l.Take("d")
	if ok || retry != 10*time.Second || l.clientsKept() != 3 {
		t.Fatalf("a 4th client with 3 kept: %v, retry %v, %d kept", ok, retry, l.clientsKept())
	}
	// Ones already kept carry on.
	takeN(t, l, "a", 1)
	// Once a kept client's bucket is full again it is forgotten, and there is room.
	c.pass(10 * time.Second)
	takeN(t, l, "d", 1)
	if n := l.clientsKept(); n > 3 {
		t.Fatalf("%d kept", n)
	}
}

func TestIdleClientsAreForgotten(t *testing.T) {
	c := newClock()
	l := limiter(c, 100)
	for i := 0; i < 50; i++ {
		takeN(t, l, "c"+strconv.Itoa(i), 1)
	}
	if n := l.clientsKept(); n != 50 {
		t.Fatalf("%d kept", n)
	}
	c.pass(time.Minute) // past a burst's refill: every bucket is full
	takeN(t, l, "late", 1)
	if n := l.clientsKept(); n != 1 {
		t.Fatalf("%d kept after a minute's quiet", n)
	}
}

func TestAFullMapIsNotSweptOnEveryRequest(t *testing.T) {
	c := newClock()
	l := limiter(c, 2)
	takeN(t, l, "a", 2)
	takeN(t, l, "b", 2)
	c.pass(10 * time.Second)
	// The map is full: one look for clients full again, and none is.
	if ok, _ := l.Take("c"); ok || l.sweeps != 1 {
		t.Fatalf("c: %v, %d sweeps", ok, l.sweeps)
	}
	for i := 0; i < 100; i++ {
		l.Take("x" + strconv.Itoa(i))
	}
	if l.sweeps != 1 {
		t.Fatalf("%d more sweeps for 100 new clients refused", l.sweeps-1)
	}
}

func TestClientKey(t *testing.T) {
	for _, tc := range []struct{ remote, xff, want string }{
		{"10.0.0.2:4321", "", "10.0.0.2"},
		{"172.18.0.5:4321", "203.0.113.7", "203.0.113.7"},
		// Caddy adds the address it saw last; what a client wrote before it is not believed.
		{"172.18.0.5:4321", "198.51.100.1, 203.0.113.7", "203.0.113.7"},
		{"172.18.0.5:4321", " 203.0.113.7 ", "203.0.113.7"},
		// An IPv6 client is its /64: one machine usually has the whole of one.
		{"172.18.0.5:4321", "2001:db8:1:2:aaaa::1", "2001:db8:1:2::/64"},
		{"172.18.0.5:4321", "2001:db8:1:2:bbbb::9", "2001:db8:1:2::/64"},
		{"172.18.0.5:4321", "::ffff:203.0.113.7", "203.0.113.7"},
		{"[2001:db8::5]:4321", "", "2001:db8::/64"},
		// Not an address: the connection's own.
		{"172.18.0.5:4321", "nonsense", "172.18.0.5"},
		{"pipe", "", "unknown"},
	} {
		r := httptest.NewRequest("GET", "/lnurlp/pool/cb", nil)
		r.RemoteAddr = tc.remote
		if tc.xff != "" {
			r.Header.Set("X-Forwarded-For", tc.xff)
		}
		if got := ClientKey(r); got != tc.want {
			t.Errorf("ClientKey(%q, %q) = %q, want %q", tc.remote, tc.xff, got, tc.want)
		}
	}
}

func TestClientKeyTakesTheLastHeaderLine(t *testing.T) {
	r := httptest.NewRequest("GET", "/lnurlp/pool/cb", nil)
	r.Header.Add("X-Forwarded-For", "198.51.100.1")
	r.Header.Add("X-Forwarded-For", "203.0.113.7")
	if got := ClientKey(r); got != "203.0.113.7" {
		t.Fatalf("ClientKey = %q", got)
	}
}

func TestClientKeyIgnoresXRealIP(t *testing.T) {
	// Caddy passes X-Real-IP through as the client wrote it.
	r := httptest.NewRequest("GET", "/lnurlp/pool/cb", nil)
	r.RemoteAddr = "172.18.0.5:4321"
	r.Header.Set("X-Forwarded-For", "203.0.113.7")
	r.Header.Set("X-Real-IP", "198.51.100.1")
	if got := ClientKey(r); got != "203.0.113.7" {
		t.Fatalf("ClientKey = %q", got)
	}
}
