package namecheck

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// answer is a DoH service that answers each A question with rcode and the records given (A, or AAAA when v6).
func answer(t *testing.T, rcode dnsmessage.RCode, a [][4]byte, aaaa [][16]byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var q dnsmessage.Message
		if r.Header.Get("Content-Type") != "application/dns-message" || q.Unpack(body) != nil || len(q.Questions) != 1 {
			http.Error(w, "bad question", http.StatusBadRequest)
			return
		}
		question := q.Questions[0]
		if question.Type != dnsmessage.TypeA {
			http.Error(w, "asked for the wrong type", http.StatusBadRequest)
			return
		}
		b := dnsmessage.NewBuilder(nil, dnsmessage.Header{Response: true, RCode: rcode, RecursionAvailable: true})
		_ = b.StartQuestions()
		_ = b.Question(question)
		_ = b.StartAnswers()
		for _, ip := range a {
			_ = b.AResource(dnsmessage.ResourceHeader{Name: question.Name, Class: dnsmessage.ClassINET, TTL: 300}, dnsmessage.AResource{A: ip})
		}
		for _, ip := range aaaa {
			_ = b.AAAAResource(dnsmessage.ResourceHeader{Name: question.Name, Class: dnsmessage.ClassINET, TTL: 300}, dnsmessage.AAAAResource{AAAA: ip})
		}
		msg, _ := b.Finish()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(msg)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func status(t *testing.T, code int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(code) }))
	t.Cleanup(srv.Close)
	return srv
}

func hanging(t *testing.T) *httptest.Server {
	t.Helper()
	stop := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-stop:
		}
	}))
	t.Cleanup(func() { close(stop); srv.Close() })
	return srv
}

func lookup(t *testing.T, services ...string) ([]string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return DoH(http.DefaultClient, services)(ctx, "vm-1005.lnvps.cloud")
}

func TestDoHAnswer(t *testing.T) {
	srv := answer(t, dnsmessage.RCodeSuccess, [][4]byte{{45, 67, 89, 83}, {10, 0, 0, 1}}, nil)
	got, err := lookup(t, srv.URL)
	if err != nil || !reflect.DeepEqual(got, []string{"45.67.89.83", "10.0.0.1"}) {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestDoHNameError(t *testing.T) {
	_, err := lookup(t, answer(t, dnsmessage.RCodeNameError, nil, nil).URL)
	if !errors.Is(err, ErrNoRecord) {
		t.Fatalf("NXDOMAIN: err = %v, want ErrNoRecord", err)
	}
}

func TestDoHOnlyIPv6(t *testing.T) {
	// What vm-1005.lnvps.cloud answers: the name is there, with an IPv6 address and no IPv4 one.
	srv := answer(t, dnsmessage.RCodeSuccess, nil, [][16]byte{{0x2a, 0x13, 0x02, 0xc0, 15: 1}})
	_, err := lookup(t, srv.URL)
	if !errors.Is(err, ErrNoRecord) {
		t.Fatalf("AAAA only: err = %v, want ErrNoRecord", err)
	}
}

func TestDoHSecondService(t *testing.T) {
	good := answer(t, dnsmessage.RCodeSuccess, [][4]byte{{45, 67, 89, 83}}, nil)
	for name, first := range map[string]*httptest.Server{"500": status(t, http.StatusInternalServerError), "hanging": hanging(t)} {
		start := time.Now()
		got, err := lookup(t, first.URL, good.URL)
		if err != nil || !reflect.DeepEqual(got, []string{"45.67.89.83"}) {
			t.Fatalf("first %s: got %v, %v", name, got, err)
		}
		if time.Since(start) > 2*time.Second {
			t.Fatalf("first %s: waited %v for the first service", name, time.Since(start))
		}
	}
}

func TestDoHNoneAnswers(t *testing.T) {
	_, err := lookup(t, status(t, http.StatusInternalServerError).URL, answer(t, dnsmessage.RCodeServerFailure, nil, nil).URL)
	if err == nil || errors.Is(err, ErrNoRecord) {
		t.Fatalf("err = %v, want a failure that isn't ErrNoRecord", err)
	}
}
