package lnaddr

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"unicode/utf8"
)

// resolver sends every request to srv, whatever the address's domain.
func resolver(srv *httptest.Server) *Resolver {
	tr := &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}}
	return &Resolver{HTTP: &http.Client{Transport: tr}, Scheme: "http"}
}

func TestInvoiceFromAnAddress(t *testing.T) {
	var gotAmount string
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/lnurlp/alice", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"tag":"payRequest","callback":"http://pay.example.com/cb?user=alice","minSendable":1000,"maxSendable":5000000,"metadata":"[]"}`))
	})
	mux.HandleFunc("GET /cb", func(w http.ResponseWriter, r *http.Request) {
		gotAmount = r.URL.Query().Get("amount")
		if r.URL.Query().Get("user") != "alice" {
			t.Errorf("callback lost its own query: %s", r.URL.RawQuery)
		}
		w.Write([]byte(`{"pr":"lnbc1fake","routes":[]}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	r := resolver(srv)
	pr, err := r.Invoice(context.Background(), " Alice@Pay.Example.com ", 2_000_000)
	if err != nil || pr != "lnbc1fake" || gotAmount != "2000000" {
		t.Fatalf("got %q %v (amount %s)", pr, err, gotAmount)
	}
	if _, err := r.Invoice(context.Background(), "alice@pay.example.com", 6_000_000); !errors.Is(err, ErrBadAddress) {
		t.Fatalf("over the max: %v", err)
	}
	if _, err := r.Invoice(context.Background(), "bob@pay.example.com", 2_000_000); !errors.Is(err, ErrBadAddress) {
		t.Fatalf("unknown user: %v", err)
	}
	if _, err := r.Invoice(context.Background(), "not an address", 2_000_000); !errors.Is(err, ErrBadAddress) {
		t.Fatalf("garbage: %v", err)
	}
}

func TestAnLNURLErrorIsPassedOn(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"ERROR","reason":"account closed"}`))
	}))
	defer srv.Close()
	_, err := resolver(srv).Invoice(context.Background(), "alice@pay.example.com", 2_000_000)
	if !errors.Is(err, ErrBadAddress) || err.Error() != `lnaddr: can't get an invoice from this address: the address's server says "account closed"` {
		t.Fatalf("got %v", err)
	}
}

// An address whose domain has no server, or one that doesn't answer, is said
// in plain words: never the network library's own (a BIP353 address from
// Phoenix, which has no web server, once got
// `Get "https://…/.well-known/lnurlp/…": dial tcp: lookup … on 127.0.0.11:53:
// no such host` on the Send out screen).
func TestAnAddressWithNoServerIsSaidPlainly(t *testing.T) {
	failing := func(err error) *Resolver {
		tr := &http.Transport{DialContext: func(context.Context, string, string) (net.Conn, error) { return nil, err }}
		return &Resolver{HTTP: &http.Client{Transport: tr}, Scheme: "http"}
	}
	noHost := &net.DNSError{Err: "no such host", Name: "nowhere.example.com", Server: "127.0.0.11:53", IsNotFound: true}
	for _, c := range []struct {
		r      *Resolver
		target string
		want   string
	}{
		{failing(noHost), "Alice@Nowhere.Example.com",
			"lnaddr: can't get an invoice from this address: nowhere.example.com has no Lightning address server for alice. If it is a ₿ address, update Karto Wallet; otherwise look it up again"},
		{failing(noHost), "http://nowhere.example.com/lnurlp/alice",
			"lnaddr: can't get an invoice from this address: nowhere.example.com has no server to ask for one"},
		{failing(&net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}), "alice@pay.example.com",
			"lnaddr: can't get an invoice from this address: pay.example.com's server can't be reached"},
		{failing(context.DeadlineExceeded), "alice@pay.example.com",
			"lnaddr: can't get an invoice from this address: pay.example.com's server can't be reached"},
	} {
		_, err := c.r.Invoice(context.Background(), c.target, 2_000_000)
		if !errors.Is(err, ErrBadAddress) || err.Error() != c.want {
			t.Fatalf("%s:\n got %v\nwant %s", c.target, err, c.want)
		}
		if strings.Contains(err.Error(), "dial") || strings.Contains(err.Error(), "127.0.0.11") || strings.Contains(err.Error(), "Get ") {
			t.Fatalf("%s: the network library's words reached the person: %v", c.target, err)
		}
	}
}

// A remote server's reason reaches the app and cardd's log: its own words, labelled, one line, cut short.
func TestAnLNURLErrorIsCleanedAndCut(t *testing.T) {
	reason := "line one\nline two\u202e\x07" + strings.Repeat("x", 60_000)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"status": "ERROR", "reason": reason})
	}))
	defer srv.Close()
	_, err := resolver(srv).Invoice(context.Background(), "alice@pay.example.com", 2_000_000)
	msg := err.Error()
	if !errors.Is(err, ErrBadAddress) || !strings.Contains(msg, `the address's server says "line one line two xxx`) || !strings.HasSuffix(msg, `…"`) {
		t.Fatalf("got %q", msg)
	}
	if strings.ContainsAny(msg, "\n\u202e\x07") || utf8.RuneCountInString(msg) > 300 {
		t.Fatalf("not cleaned or cut: %d runes", utf8.RuneCountInString(msg))
	}
}

// The server names its callback, and a Go error quotes the whole URL: a long
// one is refused, and an error's text is cut short before it reaches the app,
// the log or a renewal's problem.
func TestALongCallbackIsCutShort(t *testing.T) {
	var callback string
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/lnurlp/alice", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"tag": "payRequest", "callback": callback, "minSendable": 1000, "maxSendable": 5_000_000, "metadata": "[]"})
	})
	mux.HandleFunc("GET /cb", func(w http.ResponseWriter, r *http.Request) {
		conn, _, _ := w.(http.Hijacker).Hijack()
		conn.Close() // no answer: Go's error quotes the URL
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	callback = "http://pay.example.com/cb?x=" + strings.Repeat("a", 3_000)
	_, err := resolver(srv).Invoice(context.Background(), "alice@pay.example.com", 2_000_000)
	if !errors.Is(err, ErrBadAddress) || !strings.HasSuffix(err.Error(), "bad callback") {
		t.Fatalf("over 2 KiB: %v", err)
	}
	callback = "http://pay.example.com/cb?x=" + strings.Repeat("a", 1_900)
	_, err = resolver(srv).Invoice(context.Background(), "alice@pay.example.com", 2_000_000)
	if !errors.Is(err, ErrBadAddress) || !strings.Contains(err.Error(), "no invoice: ") || utf8.RuneCountInString(err.Error()) > 320 {
		t.Fatalf("not cut: %d runes: %v", utf8.RuneCountInString(err.Error()), err)
	}
}

// An LNURL-pay URL (a shop's or a donation QR's) resolves the same way as an
// address, and the pay request's metadata comes back for the description-hash
// check.
func TestInvoiceFromAPayURL(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /lnurlp/abc", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"tag":"payRequest","callback":"http://pay.example.com/cb","minSendable":1000,"maxSendable":5000000,"metadata":"[[\"text/plain\",\"Coffee\"]]"}`))
	})
	mux.HandleFunc("GET /cb", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"pr":"lnbc1shop"}`)) })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	res, err := resolver(srv).Resolve(context.Background(), "http://pay.example.com/lnurlp/abc", 2_000_000)
	if err != nil || res.PR != "lnbc1shop" || res.Metadata != `[["text/plain","Coffee"]]` {
		t.Fatalf("got %+v %v", res, err)
	}
	if _, err := resolver(srv).Resolve(context.Background(), "ftp://pay.example.com/lnurlp/abc", 2_000_000); !errors.Is(err, ErrBadAddress) {
		t.Fatalf("another scheme: %v", err)
	}
}

// Redirects stay on the resolver's scheme, three at most.
func TestRedirects(t *testing.T) {
	hops := 0
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/lnurlp/loop", func(w http.ResponseWriter, r *http.Request) {
		hops++
		http.Redirect(w, r, "/.well-known/lnurlp/loop", http.StatusFound)
	})
	mux.HandleFunc("GET /.well-known/lnurlp/away", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "ftp://pay.example.com/x", http.StatusFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	if _, err := resolver(srv).Invoice(context.Background(), "loop@pay.example.com", 2_000_000); !errors.Is(err, ErrBadAddress) || hops > 4 {
		t.Fatalf("redirect loop: %v after %d hops", err, hops)
	}
	if _, err := resolver(srv).Invoice(context.Background(), "away@pay.example.com", 2_000_000); !errors.Is(err, ErrBadAddress) {
		t.Fatalf("redirect to another scheme: %v", err)
	}
}

// The real resolver connects only to public addresses: not this machine,
// a private network, link-local or multicast, whatever DNS says.
func TestOnlyPublicAddresses(t *testing.T) {
	for addr, want := range map[string]bool{
		"8.8.8.8": true, "2606:4700::1111": true,
		"127.0.0.1": false, "::1": false, "10.1.2.3": false, "172.16.0.1": false, "192.168.1.205": false,
		"169.254.169.254": false, "fe80::1": false, "fd00::1": false, "0.0.0.0": false, "224.0.0.1": false, "100.64.0.1": false,
		"::ffff:127.0.0.1": false, "::ffff:10.0.0.1": false, "::ffff:8.8.8.8": true,
		"0.1.2.3": false, "64:ff9b::a00:1": false, "2002:a00:1::1": false, "::a00:1": false,
		// IANA's special-purpose ranges, and their public neighbours.
		"192.0.0.8": false, "192.0.2.1": false, "198.18.0.1": false, "198.19.255.255": false, "198.51.100.1": false,
		"203.0.113.1": false, "240.0.0.1": false, "255.255.255.255": false, "2001::1": false, "2001:db8::1": false,
		"100::1": false, "64:ff9b:1::1": false, "fec0::1": false, "5f00::1": false, "192.88.99.1": false,
		"3fff::1": false, "3fff:fff::1": false, "3fff:1000::1": true, // RFC 9637's documentation prefix, and past it
		"192.0.1.1": true, "198.20.0.1": true, "203.0.114.1": true, "2001:200::1": true,
	} {
		if got := publicIP(net.ParseIP(addr)); got != want {
			t.Errorf("%s: public %v, want %v", addr, got, want)
		}
	}
	_, err := New().Resolve(context.Background(), "https://127.0.0.1:1/.well-known/lnurlp/x", 1000)
	if !errors.Is(err, ErrBadAddress) || !strings.Contains(err.Error(), "not a public address") {
		t.Fatalf("loopback: %v", err)
	}
}

// A renewal pays LNVPS only: a resolver pinned to api.lnvps.net refuses a pay
// request, a redirect or a callback on any other host, before any invoice.
func TestAPinnedResolverStaysOnItsHost(t *testing.T) {
	const meta = `[[\"text/plain\",\"Extend VM 1009\"]]`
	payRequest := func(callback string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(`{"tag":"payRequest","callback":"` + callback + `","minSendable":100000,"maxSendable":1000000000,"metadata":"` + meta + `"}`))
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/lnurlp/1009", payRequest("http://api.lnvps.net/api/v1/vm/1009/renew-lnurlp"))
	mux.HandleFunc("GET /.well-known/lnurlp/same", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/.well-known/lnurlp/1009", http.StatusFound)
	})
	mux.HandleFunc("GET /.well-known/lnurlp/moved", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://evil.example.com/.well-known/lnurlp/1009", http.StatusFound)
	})
	mux.HandleFunc("GET /.well-known/lnurlp/away", payRequest("http://evil.example.com/cb"))
	mux.HandleFunc("GET /api/v1/vm/1009/renew-lnurlp", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"pr":"lnbc1renew","routes":[]}`))
	})
	mux.HandleFunc("GET /cb", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"pr":"lnbc1elsewhere","routes":[]}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	ctx := context.Background()
	open := resolver(srv)
	pinned := open.Pinned("api.lnvps.net")
	for _, target := range []string{"http://api.lnvps.net/.well-known/lnurlp/1009", "1009@api.lnvps.net", "http://API.lnvps.net/.well-known/lnurlp/same"} {
		res, err := pinned.Resolve(ctx, target, 221_000)
		if err != nil || res.PR != "lnbc1renew" || res.Metadata != `[["text/plain","Extend VM 1009"]]` {
			t.Fatalf("%s: %+v %v", target, res, err)
		}
	}
	for target, why := range map[string]string{
		"http://evil.example.com/.well-known/lnurlp/1009": "not on api.lnvps.net",
		"http://api.lnvps.net/.well-known/lnurlp/moved":   "redirected to evil.example.com",
		"http://api.lnvps.net/.well-known/lnurlp/away":    "callback not on api.lnvps.net",
	} {
		if _, err := pinned.Resolve(ctx, target, 221_000); !errors.Is(err, ErrBadAddress) || !strings.Contains(err.Error(), why) {
			t.Fatalf("%s: %v", target, err)
		}
	}
	// Pinning is a copy's: the resolver for sends still goes anywhere public.
	if res, err := open.Resolve(ctx, "http://api.lnvps.net/.well-known/lnurlp/away", 221_000); err != nil || res.PR != "lnbc1elsewhere" {
		t.Fatalf("unpinned: %+v %v", res, err)
	}
}

func TestPlainTextAndClean(t *testing.T) {
	for meta, want := range map[string]string{
		`[["text/plain","Coffee"],["text/identifier","a@b.c"]]`: "Coffee",
		`[["text/identifier","a@b.c"]]`:                         "",
		`not json`:                                              "",
		`[["text/plain","Two\nlines\u202e here"]]`:              "Two lines here",
	} {
		if got := PlainText(meta); got != want {
			t.Fatalf("PlainText(%q) = %q, want %q", meta, got, want)
		}
	}
	if got := Clean(strings.Repeat("é", 250), MaxText); len([]rune(got)) != MaxText+1 { // 200 and "…"
		t.Fatalf("Clean cut to %d characters", len([]rune(got)))
	}
}

// noHostTransport answers every request with "no such host".
type noHostTransport struct{}

func (noHostTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return nil, &net.DNSError{Err: "no such host", Name: req.URL.Hostname(), IsNotFound: true}
}

// An older app sends Phoenix's address by its plain name: the words say what to do.
func TestAnAddressWithNoServerSaysWhatToDo(t *testing.T) {
	r := &Resolver{HTTP: &http.Client{Transport: noHostTransport{}}, Scheme: "http"}
	_, err := r.Resolve(context.Background(), "alice@pay.example.com", 1_000_000)
	if err == nil || !strings.Contains(err.Error(), "If it is a ₿ address, update Karto Wallet; otherwise look it up again") || strings.Contains(err.Error(), "can't be paid yet") {
		t.Fatalf("%v", err)
	}
	if _, err := r.PayRequest(context.Background(), "alice@pay.example.com"); !NoServer(err) {
		t.Fatalf("PayRequest's no server: %v", err)
	}
}
