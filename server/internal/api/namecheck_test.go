package api

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/namecheck"
)

// names is a Checker for vm-1005.lnvps.cloud at 45.67.89.83 whose lookup answers ips, or err.
func names(ips []string, err error) *namecheck.Checker {
	return &namecheck.Checker{
		Host:   "vm-1005.lnvps.cloud",
		IPv4:   func(context.Context) (string, error) { return "45.67.89.83", nil },
		Lookup: func(context.Context, string) ([]string, error) { return ips, err },
		Now:    time.Now,
	}
}

// The wallet says when the server's name has no IPv4 address: GET /api/v1/server carries dns once there is a
// result, and nothing before.
func TestServerDNSAbsent(t *testing.T) {
	w := moneySetup(t)
	if _, out := w.do("GET", "/api/v1/server", nil); hasKey(out, "dns") {
		t.Fatalf("no checker: %v", out)
	}
	w.money.Names = names(nil, errors.New("timeout")) // every lookup so far failed
	if _, out := w.do("GET", "/api/v1/server", nil); hasKey(out, "dns") {
		t.Fatalf("no result yet: %v", out)
	}
}

func TestServerDNSMissing(t *testing.T) {
	w := moneySetup(t)
	w.money.Names = names(nil, namecheck.ErrNoRecord)
	_, out := w.do("GET", "/api/v1/server", nil)
	if want := map[string]any{"ipv4": "missing"}; !reflect.DeepEqual(out["dns"], want) {
		t.Fatalf("dns = %v, want %v", out["dns"], want)
	}
}

func TestServerDNSOther(t *testing.T) {
	w := moneySetup(t)
	w.money.Names = names([]string{"1.2.3.4"}, nil)
	_, out := w.do("GET", "/api/v1/server", nil)
	if want := map[string]any{"ipv4": "other", "got": []any{"1.2.3.4"}}; !reflect.DeepEqual(out["dns"], want) {
		t.Fatalf("dns = %v, want %v", out["dns"], want)
	}
}
