package api

import (
	"os"
	"testing"
)

// TestAStackLookup asks the real stack's lookup (CARDD_STACK_URL) about real
// names, through Google and Cloudflare: a name known to be signed with an
// offer (CARDD_STACK_BIP353, default matt@mattcorallo.com, which both services
// answered with AD set and a bitcoin: record holding lno= on 2026-10-15), a
// domain whose DNSSEC is broken on purpose (both services give SERVFAIL with
// an extended DNS error, code 9, so the signature sentence is the one
// answered), and a name in a TLD that doesn't exist.
func TestAStackLookup(t *testing.T) {
	base := os.Getenv("CARDD_STACK_URL")
	if base == "" {
		t.Skip("CARDD_STACK_URL not set")
	}
	call := stackCaller(t, base)
	name := os.Getenv("CARDD_STACK_BIP353")
	if name == "" {
		name = "matt@mattcorallo.com"
	}
	if status, out := call("POST", "/api/v1/send/lookup", map[string]any{"to": "₿" + name}); status != 200 || out["kind"] != "offer" || out["name"] != "₿"+name {
		t.Fatalf("a signed name: %d %v", status, out)
	}
	if status, out := call("POST", "/api/v1/send/lookup", map[string]any{"to": "₿anyone@dnssec-failed.org"}); status != 400 ||
		out["message"] != "dnssec-failed.org's record for anyone failed its signature check: it may have been tampered with." {
		t.Fatalf("broken DNSSEC: %d %v", status, out)
	}
	if status, out := call("POST", "/api/v1/send/lookup", map[string]any{"to": "nobody@no-such-place.invalid"}); status != 400 ||
		out["message"] != "nobody@no-such-place.invalid doesn't exist: no-such-place.invalid has no BIP353 record or Lightning address server for nobody." {
		t.Fatalf("no such name: %d %v", status, out)
	}
}
