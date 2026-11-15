// Package namecheck says whether cardd's own name has an IPv4 (A) record pointing at its VM. LNVPS has left
// some VMs' names with only an IPv6 record, and a phone on a network without IPv6 can't reach such a server by name;
// the wallet says so plainly. The check runs when the server's status is asked for, at most once an hour while the
// name is right and once every 5 minutes while it isn't, and nothing of it is stored.
package namecheck

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"
)

// ErrNoRecord is a lookup's answer for a name with no A record: it doesn't exist, or it has only other records.
var ErrNoRecord = errors.New("namecheck: no A record")

// LookupA is the name's IPv4 addresses, ErrNoRecord when it has none, or another error when the lookup failed.
type LookupA func(ctx context.Context, host string) ([]string, error)

// Result is what the wallet is told: IPv4 is "ok", "missing" or "other"; Got is the addresses found, for "other".
type Result struct {
	IPv4 string
	Got  []string
}

const (
	okFor    = time.Hour
	wrongFor = 5 * time.Minute
	wait     = 3 * time.Second
)

// Checker checks Host against IPv4 (meta vm.ipv4, written at install, restore and every Update server).
type Checker struct {
	Host   string
	IPv4   func(ctx context.Context) (string, error)
	Lookup LookupA
	Now    func() time.Time

	mu   sync.Mutex
	last *Result
	at   time.Time
	busy bool
}

// Result is the last result, looked up again first when it is too old: false while there is none (no vm.ipv4 yet,
// or every lookup so far failed). A lookup that fails keeps the last result; one under way is not asked twice.
func (c *Checker) Result(ctx context.Context) (Result, bool) {
	c.mu.Lock()
	if c.busy || (c.last != nil && c.Now().Sub(c.at) < c.freshFor(*c.last)) {
		defer c.mu.Unlock()
		return c.lastLocked()
	}
	c.busy = true
	c.mu.Unlock()

	r, ok := c.look(ctx)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.busy = false
	if ok {
		c.last, c.at = &r, c.Now()
	}
	return c.lastLocked()
}

func (c *Checker) lastLocked() (Result, bool) {
	if c.last == nil {
		return Result{}, false
	}
	return *c.last, true
}

func (c *Checker) freshFor(r Result) time.Duration {
	if r.IPv4 == "ok" {
		return okFor
	}
	return wrongFor
}

// look is one lookup's result, or false when there is nothing to compare with or the lookup failed.
func (c *Checker) look(ctx context.Context) (Result, bool) {
	want, err := c.IPv4(ctx)
	if err != nil || want == "" {
		return Result{}, false
	}
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	got, err := c.Lookup(ctx, c.Host)
	switch {
	case errors.Is(err, ErrNoRecord):
		return Result{IPv4: "missing"}, true
	case err != nil:
		return Result{}, false
	case slices.Contains(got, want) || !lnvpsName(c.Host):
		// A person's own name may be put behind a proxy on purpose: only LNVPS's own names must point here.
		return Result{IPv4: "ok"}, true
	default:
		return Result{IPv4: "other", Got: got}, true
	}
}

// lnvpsName reports whether host is one of LNVPS's names (vm-N.lnvps.cloud), in any case, with or without the
// trailing dot.
func lnvpsName(host string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSuffix(host, ".")), ".lnvps.cloud")
}
