package lnaddr

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A refund's note to the customer: LUD-12's comment, sent only when
// the pay request allows one, in words fitted to its limit by the caller.

// commentServer answers alice's pay request with allowed as its commentAllowed (raw JSON; "" leaves it out) and
// keeps the callback's query.
func commentServer(t *testing.T, allowed string, got *map[string][]string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/lnurlp/alice", func(w http.ResponseWriter, r *http.Request) {
		extra := ""
		if allowed != "" {
			extra = `,"commentAllowed":` + allowed
		}
		w.Write([]byte(`{"tag":"payRequest","callback":"http://pay.example.com/cb","minSendable":1000,"maxSendable":5000000,"metadata":"[]"` + extra + `}`))
	})
	mux.HandleFunc("GET /cb", func(w http.ResponseWriter, r *http.Request) {
		*got = r.URL.Query()
		w.Write([]byte(`{"pr":"lnbc1fake","routes":[]}`))
	})
	return httptest.NewServer(mux)
}

func TestACommentIsSentWhenAllowed(t *testing.T) {
	var got map[string][]string
	srv := commentServer(t, "32", &got)
	defer srv.Close()
	asked := -1
	res, err := resolver(srv).ResolveWithComment(context.Background(), "alice@pay.example.com", 2_000_000, func(limit int) string {
		asked = limit
		return "Refund from Pixel 9a"
	})
	if err != nil || res.PR != "lnbc1fake" || asked != 32 || got["comment"][0] != "Refund from Pixel 9a" {
		t.Fatalf("%+v %v asked %d query %v", res, err, asked, got)
	}
}

// No commentAllowed (LUD-12: none allowed): the words aren't asked for, and no comment goes.
func TestNoCommentWhenNoneIsAllowed(t *testing.T) {
	for _, allowed := range []string{"", "0", "null", `"140"`, "140.5", "-3"} {
		var got map[string][]string
		srv := commentServer(t, allowed, &got)
		res, err := resolver(srv).ResolveWithComment(context.Background(), "alice@pay.example.com", 2_000_000, func(int) string {
			t.Errorf("commentAllowed %s: words asked for", allowed)
			return "x"
		})
		srv.Close()
		if err != nil || res.PR != "lnbc1fake" || got["comment"] != nil {
			t.Fatalf("commentAllowed %s: %+v %v %v", allowed, res, err, got)
		}
	}
}

// An odd commentAllowed doesn't break the callers that send no comment (renewals, Send out's lookup, sends).
func TestAnOddCommentAllowedLeavesOtherCallersWorking(t *testing.T) {
	for _, allowed := range []string{"null", `"140"`, "140.0", "true", "{}"} {
		var got map[string][]string
		srv := commentServer(t, allowed, &got)
		pr, err := resolver(srv).Invoice(context.Background(), "alice@pay.example.com", 2_000_000)
		srv.Close()
		if err != nil || pr != "lnbc1fake" || got["comment"] != nil {
			t.Fatalf("commentAllowed %s: %q %v %v", allowed, pr, err, got)
		}
	}
}

// Words that come back empty (the limit too small for any) send no comment.
func TestEmptyWordsSendNoComment(t *testing.T) {
	var got map[string][]string
	srv := commentServer(t, "3", &got)
	defer srv.Close()
	if _, err := resolver(srv).ResolveWithComment(context.Background(), "alice@pay.example.com", 2_000_000, func(int) string { return "" }); err != nil || got["comment"] != nil {
		t.Fatalf("%v %v", err, got)
	}
}
