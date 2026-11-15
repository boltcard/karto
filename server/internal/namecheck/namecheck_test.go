package namecheck

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"
)

const ip = "45.67.89.83"

// fake is a lookup that answers what it is told and counts its calls.
type fake struct {
	mu    sync.Mutex
	calls int
	ips   []string
	err   error
	block chan struct{} // while set, a lookup waits for it to close
}

func (f *fake) lookup(ctx context.Context, host string) ([]string, error) {
	f.mu.Lock()
	f.calls++
	block, ips, err := f.block, f.ips, f.err
	f.mu.Unlock()
	if block != nil {
		<-block
	}
	return ips, err
}

func (f *fake) set(ips []string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ips, f.err = ips, err
}

func (f *fake) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }
func newClock() *clock                   { return &clock{t: time.Unix(1_790_000_000, 0)} }
func fixedIPv4(v string) func(context.Context) (string, error) {
	return func(context.Context) (string, error) { return v, nil }
}

func checker(host string, f *fake, c *clock) *Checker {
	return &Checker{Host: host, IPv4: fixedIPv4(ip), Lookup: f.lookup, Now: c.now}
}

func want(t *testing.T, c *Checker, wantRes Result, wantOK bool) {
	t.Helper()
	got, ok := c.Result(context.Background())
	if ok != wantOK || (ok && !reflect.DeepEqual(got, wantRes)) {
		t.Fatalf("Result() = %+v, %v; want %+v, %v", got, ok, wantRes, wantOK)
	}
}

func TestOK(t *testing.T) {
	f := &fake{ips: []string{"10.0.0.1", ip}}
	want(t, checker("vm-1009.lnvps.cloud", f, newClock()), Result{IPv4: "ok"}, true)
}

func TestMissing(t *testing.T) {
	f := &fake{err: ErrNoRecord}
	want(t, checker("vm-1005.lnvps.cloud", f, newClock()), Result{IPv4: "missing"}, true)
}

func TestOtherOnLnvps(t *testing.T) {
	f := &fake{ips: []string{"1.2.3.4"}}
	want(t, checker("vm-1005.lnvps.cloud", f, newClock()), Result{IPv4: "other", Got: []string{"1.2.3.4"}}, true)
	// Written with DNS's trailing dot or in capitals, it is still LNVPS's name.
	want(t, checker("VM-1005.LNVPS.cloud.", &fake{ips: []string{"1.2.3.4"}}, newClock()), Result{IPv4: "other", Got: []string{"1.2.3.4"}}, true)
}

func TestOtherOnOwnName(t *testing.T) {
	// A person's own name may be behind a proxy on purpose: it resolving elsewhere is no fault.
	f := &fake{ips: []string{"1.2.3.4"}}
	want(t, checker("pay.example.com", f, newClock()), Result{IPv4: "ok"}, true)
	// Not a name that merely ends in the same letters.
	want(t, checker("vm-1.notlnvps.cloud", &fake{ips: []string{"1.2.3.4"}}, newClock()), Result{IPv4: "ok"}, true)
}

func TestErrorKeepsLast(t *testing.T) {
	c := newClock()
	f := &fake{err: ErrNoRecord}
	ch := checker("vm-1005.lnvps.cloud", f, c)
	want(t, ch, Result{IPv4: "missing"}, true)
	c.advance(6 * time.Minute)
	f.set(nil, errors.New("SERVFAIL"))
	want(t, ch, Result{IPv4: "missing"}, true)
	if f.count() != 2 {
		t.Fatalf("lookups = %d, want 2 (the failed one asked)", f.count())
	}

	none := checker("vm-1005.lnvps.cloud", &fake{err: errors.New("timeout")}, newClock())
	want(t, none, Result{}, false)
}

func TestNoIPv4(t *testing.T) {
	for _, ipv4 := range []func(context.Context) (string, error){
		fixedIPv4(""),
		func(context.Context) (string, error) { return "", errors.New("not found") },
	} {
		f := &fake{ips: []string{ip}}
		ch := &Checker{Host: "vm-1005.lnvps.cloud", IPv4: ipv4, Lookup: f.lookup, Now: newClock().now}
		want(t, ch, Result{}, false)
		if f.count() != 0 {
			t.Fatalf("looked up %d times with no IPv4 to compare", f.count())
		}
	}
}

func TestCache(t *testing.T) {
	c := newClock()
	f := &fake{ips: []string{ip}}
	ch := checker("vm-1009.lnvps.cloud", f, c)
	want(t, ch, Result{IPv4: "ok"}, true)
	c.advance(59 * time.Minute)
	want(t, ch, Result{IPv4: "ok"}, true)
	if f.count() != 1 {
		t.Fatalf("ok re-asked within the hour: %d lookups", f.count())
	}
	c.advance(2 * time.Minute)
	want(t, ch, Result{IPv4: "ok"}, true)
	if f.count() != 2 {
		t.Fatalf("ok not re-asked after the hour: %d lookups", f.count())
	}

	c2 := newClock()
	f2 := &fake{err: ErrNoRecord}
	miss := checker("vm-1005.lnvps.cloud", f2, c2)
	want(t, miss, Result{IPv4: "missing"}, true)
	c2.advance(4 * time.Minute)
	want(t, miss, Result{IPv4: "missing"}, true)
	if f2.count() != 1 {
		t.Fatalf("missing re-asked within 5 minutes: %d lookups", f2.count())
	}
	c2.advance(2 * time.Minute)
	f2.set([]string{ip}, nil) // LNVPS added the record
	want(t, miss, Result{IPv4: "ok"}, true)
}

func TestOneAtATime(t *testing.T) {
	c := newClock()
	f := &fake{err: ErrNoRecord}
	ch := checker("vm-1005.lnvps.cloud", f, c)
	want(t, ch, Result{IPv4: "missing"}, true)
	c.advance(6 * time.Minute)
	block := make(chan struct{})
	f.mu.Lock()
	f.block = block
	f.mu.Unlock()
	done := make(chan struct{})
	go func() {
		ch.Result(context.Background())
		close(done)
	}()
	for f.count() < 2 {
		time.Sleep(time.Millisecond)
	}
	// A second ask while the first is under way gets the last result at once, without a lookup of its own.
	want(t, ch, Result{IPv4: "missing"}, true)
	if f.count() != 2 {
		t.Fatalf("lookups = %d, want 2", f.count())
	}
	close(block)
	<-done
}
