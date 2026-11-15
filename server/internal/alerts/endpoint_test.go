package alerts

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func TestCheckEndpoint(t *testing.T) {
	const ntfy = "https://vm-1.lnvps.cloud:8443"
	cases := []struct {
		raw, ntfy string
		ok        bool
		ntfySh    bool
	}{
		{"https://fcm.googleapis.com/fcm/send/x", ntfy, true, false},
		{"https://vm-1.lnvps.cloud:8443/upAbc?up=1", ntfy, true, false},
		{"https://ntfy.sh/upAbc?up=1", "", true, false}, // no ntfy of its own: the phone's choice
		{"https://8.8.8.8/push", ntfy, true, false},
		{"http://fcm.googleapis.com/fcm/send/x", ntfy, false, false},
		{"https://10.0.0.1/push", ntfy, false, false},
		{"https://192.168.1.5:8443/push", ntfy, false, false},
		{"https://172.16.0.9/push", ntfy, false, false},
		{"https://127.0.0.1/push", ntfy, false, false},
		{"https://[::1]/push", ntfy, false, false},
		{"https://[fd00::1]/push", ntfy, false, false},
		{"https://[::ffff:10.0.0.1]/push", ntfy, false, false},
		{"https://169.254.169.254/latest", ntfy, false, false},
		{"https://[fe80::1]/push", ntfy, false, false},
		{"https://0.0.0.0/push", ntfy, false, false},
		{"https://localhost/push", ntfy, false, false},
		{"https:///push", ntfy, false, false},
		{"not a url", ntfy, false, false},
		{"https://ntfy.sh/upAbc?up=1", ntfy, false, true},
		{"https://NTFY.SH./upAbc?up=1", ntfy, false, true},
		// The server's own ntfy: only a UnifiedPush topic.
		{"https://vm-1.lnvps.cloud:8443/up" + strings.Repeat("a", 64) + "?up=1", ntfy, true, false},
		{"https://vm-1.lnvps.cloud:8443/up" + strings.Repeat("a", 65) + "?up=1", ntfy, false, false},
		{"https://vm-1.lnvps.cloud:8443/upAbc/../v1/account?up=1", ntfy, false, false},
		{"https://vm-1.lnvps.cloud:8443/v1/account?up=1", ntfy, false, false},
		{"https://vm-1.lnvps.cloud:8443/up%2Fabc?up=1", ntfy, false, false},
		{"https://vm-1.lnvps.cloud:8443/upAbc?up=1&poll=1", ntfy, false, false},
		{"https://vm-1.lnvps.cloud:8443/upAbc", ntfy, false, false},
		{"https://vm-1.lnvps.cloud:8443/upAbc?up=1#x", ntfy, false, false},
		{"https://u:p@vm-1.lnvps.cloud:8443/upAbc?up=1", ntfy, false, false},
		{"https://vm-1.lnvps.cloud/v1/account", ntfy, true, false}, // :443 is cardd, not ntfy
		// The server's own ntfy is posted inside the stack, never dialled at its
		// public address, so a test stack's localhost is one too; nothing else on it.
		{"https://localhost:8443/upAbc?up=1", "https://localhost:8443", true, false},
		{"https://localhost:8443/v1/account?up=1", "https://localhost:8443", false, false},
		{"https://localhost/push", "https://localhost:8443", false, false},
		{"https://127.0.0.1:8443/upAbc?up=1", "https://localhost:8443", false, false},
	}
	for _, c := range cases {
		err := CheckEndpoint(c.raw, c.ntfy)
		if (err == nil) != c.ok {
			t.Errorf("CheckEndpoint(%q, %q) = %v, want ok %v", c.raw, c.ntfy, err, c.ok)
		}
		if errors.Is(err, ErrNtfySh) != c.ntfySh {
			t.Errorf("CheckEndpoint(%q, %q) = %v, want ErrNtfySh %v", c.raw, c.ntfy, err, c.ntfySh)
		}
		if err != nil && !c.ntfySh && !errors.Is(err, ErrBadEndpoint) {
			t.Errorf("CheckEndpoint(%q) = %v, want ErrBadEndpoint", c.raw, err)
		}
	}
}

func TestPublic(t *testing.T) {
	cases := map[string]bool{
		"8.8.8.8": true, "1.1.1.1": true, "2a00:1450:4009::200e": true, "::ffff:8.8.8.8": true,
		"10.0.0.1": false, "172.16.0.1": false, "192.168.1.1": false, "127.0.0.1": false, "169.254.169.254": false,
		"0.0.0.0": false, "0.1.2.3": false, "255.255.255.255": false, "224.0.0.1": false,
		"100.64.0.1": false, "100.127.255.254": false, "198.18.0.1": false, "198.19.255.1": false,
		"192.0.0.8": false, "192.0.2.1": false, "198.51.100.1": false, "203.0.113.1": false, "240.0.0.1": false,
		"::": false, "::1": false, "fe80::1": false, "ff02::1": false, "fc00::1": false, "fd12::1": false,
		"100::1": false, "2001:db8::1": false, "::ffff:10.0.0.1": false,
		// NAT64, 6to4 and Teredo carry an IPv4 address: public only if it is.
		"64:ff9b::808:808": true, "64:ff9b::a00:1": false, "64:ff9b::7f00:1": false,
		"64:ff9b:1:808:8:800::": true, "64:ff9b:1:a00:0:100::": false,
		"2002:808:808::1": true, "2002:a00:1::1": false, "2002:c0a8:101::1": false,
		"2001:0:808:808::f7f7:f7f7": true,  // server 8.8.8.8, client 8.8.8.8 inverted
		"2001:0:a00:1::f7f7:f7f7":   false, // server 10.0.0.1
		"2001:0:808:808::80ff:fefe": false, // client 127.0.1.1 inverted
	}
	for s, want := range cases {
		if got := public(netip.MustParseAddr(s)); got != want {
			t.Errorf("public(%s) = %v, want %v", s, got, want)
		}
	}
}

// The default client's dialer refuses a private address whatever name led
// to it (DNS rebinding): here, a loopback push service.
func TestGuardedClientRefusesPrivate(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("the guarded client reached a loopback address")
	}))
	defer srv.Close()
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, srv.URL, nil)
	_, err := guardedClient().Do(req)
	if err == nil || !strings.Contains(err.Error(), "not a public address") {
		t.Fatalf("err %v, want the dialer's refusal", err)
	}
}
