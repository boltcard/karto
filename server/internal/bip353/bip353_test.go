package bip353

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// fakeAnswer is what one fake DNS-over-HTTPS service answers.
type fakeAnswer struct {
	rcode dnsmessage.RCode
	ad    bool
	txts  []string // TXT records at the name asked (each one string)
	split bool     // the first TXT as two character-strings
	cname string   // the name asked is a CNAME to this; the TXTs are there
	ede   uint16   // an Extended DNS Error code, 0 for none
	alg   byte     // the TXT's RRSIG algorithm, 0 for none
	hang  bool     // never answers

	tc      bool   // the truncated flag
	other   bool   // answers a question for another name
	chain   int    // the name asked is this many CNAME hops from the TXTs
	loop    bool   // the name asked is a CNAME loop
	dup     bool   // two CNAMEs at the name asked
	foreign string // the TXTs sit at this name instead

	id     uint16            // added to the question's id in the answer
	opcode dnsmessage.OpCode // the answer's opcode
	qtype  dnsmessage.Type   // the question answered has this type instead
	qclass dnsmessage.Class  // the question answered has this class instead
	twoQ   bool              // the question is answered twice
	class  dnsmessage.Class  // the TXTs' class, if not IN
}

func service(t *testing.T, a fakeAnswer) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.hang {
			// The body is read first: the server notices a closed
			// connection, and so cancels r.Context(), only once it is.
			io.Copy(io.Discard, r.Body)
			<-r.Context().Done()
			return
		}
		if r.Method != "POST" || r.Header.Get("Content-Type") != "application/dns-message" {
			http.Error(w, "bad", 400)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var q dnsmessage.Message
		if err := q.Unpack(raw); err != nil || len(q.Questions) != 1 || q.Questions[0].Type != dnsmessage.TypeTXT {
			http.Error(w, "bad", 400)
			return
		}
		w.Header().Set("Content-Type", "application/dns-message")
		w.Write(reply(t, q, a))
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func chunks(s string) []string {
	var out []string
	for len(s) > 255 {
		out = append(out, s[:255])
		s = s[255:]
	}
	return append(out, s)
}

func reply(t *testing.T, q dnsmessage.Message, a fakeAnswer) []byte {
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: q.Header.ID + a.id, OpCode: a.opcode, Response: true, RecursionAvailable: true, RCode: a.rcode, AuthenticData: a.ad, Truncated: a.tc})
	b.StartQuestions()
	if a.other {
		q.Questions[0].Name = dnsmessage.MustNewName("other.user._bitcoin-payment.example.com.")
	}
	if a.qtype != 0 {
		q.Questions[0].Type = a.qtype
	}
	if a.qclass != 0 {
		q.Questions[0].Class = a.qclass
	}
	b.Question(q.Questions[0])
	if a.twoQ {
		b.Question(q.Questions[0])
	}
	txtClass := dnsmessage.ClassINET
	if a.class != 0 {
		txtClass = a.class
	}
	b.StartAnswers()
	owner := q.Questions[0].Name
	cname := func(from, to dnsmessage.Name) {
		b.CNAMEResource(dnsmessage.ResourceHeader{Name: from, Class: dnsmessage.ClassINET, TTL: 300}, dnsmessage.CNAMEResource{CNAME: to})
	}
	for i := 1; i <= a.chain; i++ {
		next := dnsmessage.MustNewName("c" + string(rune('0'+i)) + ".example.net.")
		cname(owner, next)
		owner = next
	}
	if a.loop {
		other := dnsmessage.MustNewName("loop.example.net.")
		cname(owner, other)
		cname(other, owner)
	}
	if a.dup {
		cname(owner, dnsmessage.MustNewName("d1.example.net."))
		cname(owner, dnsmessage.MustNewName("d2.example.net."))
	}
	if a.foreign != "" {
		owner = dnsmessage.MustNewName(a.foreign)
	}
	if a.cname != "" {
		target := dnsmessage.MustNewName(a.cname)
		b.CNAMEResource(dnsmessage.ResourceHeader{Name: owner, Class: dnsmessage.ClassINET, TTL: 300}, dnsmessage.CNAMEResource{CNAME: target})
		owner = target
	}
	for i, txt := range a.txts {
		// A character-string holds at most 255 bytes, and the offer is longer.
		strs := chunks(txt)
		if i == 0 && a.split {
			strs = append([]string{txt[:10]}, chunks(txt[10:])...)
		}
		b.TXTResource(dnsmessage.ResourceHeader{Name: owner, Class: txtClass, TTL: 300}, dnsmessage.TXTResource{TXT: strs})
	}
	if a.alg != 0 {
		data := make([]byte, 18)
		binary.BigEndian.PutUint16(data[0:2], uint16(dnsmessage.TypeTXT))
		data[2] = a.alg
		b.UnknownResource(dnsmessage.ResourceHeader{Name: owner, Type: dnsmessage.Type(46), Class: dnsmessage.ClassINET, TTL: 300}, dnsmessage.UnknownResource{Type: dnsmessage.Type(46), Data: data})
	}
	b.StartAdditionals()
	var rh dnsmessage.ResourceHeader
	rh.SetEDNS0(1232, dnsmessage.RCodeSuccess, true)
	opt := dnsmessage.OPTResource{}
	if a.ede != 0 {
		data := make([]byte, 2)
		binary.BigEndian.PutUint16(data, a.ede)
		opt.Options = []dnsmessage.Option{{Code: 15, Data: data}}
	}
	b.OPTResource(rh, opt)
	out, err := b.Finish()
	if err != nil {
		t.Fatal(err)
	}
	return out
}

const uri = "bitcoin:?lno=lno1zrxq8pjw7qjlm68mtp7e3yvxee4y5xrgjhhyf2fxhlphpckrvevh50u0qf70a6j2x2akrhazctejaaqr8y4qtzjtjzmfesay6mzr3s789uryuqsr8dpgfgxuk56vh7cl89769zdpdrkqwtypzhu2t8ehp73dqeeq65lsqvlx5pj8mw2kz54p4f6ct66stdfxz0df8nqq7svjjdjn2dv8sz28y7z07yg3vqyfyy8ywevqc8kzp36lhd5cqwlpkg8vdcqsfvz89axkmv5sgdysmwn95tpsct6mdercmz8jh2r82qqscrf6uc3tse5gw5sv5xjdfw8f6c"

func resolverFor(t *testing.T, a, b fakeAnswer) *Resolver {
	return &Resolver{HTTP: &http.Client{}, Services: []string{service(t, a), service(t, b)}, Wait: 2 * time.Second}
}

func TestBothServicesGiveTheSameSignedRecord(t *testing.T) {
	ok := fakeAnswer{ad: true, txts: []string{uri}, alg: 13}
	r := resolverFor(t, ok, ok)
	got, err := r.Resolve(context.Background(), "alice", "example.com")
	if err != nil || got.URI != uri || !strings.HasPrefix(got.Offer, "lno1zrxq8pjw") {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestTheRecordsShapesAndSignatures(t *testing.T) {
	cases := []struct {
		name string
		a    fakeAnswer
		want error
	}{
		{"several strings joined in order", fakeAnswer{ad: true, txts: []string{uri}, split: true, alg: 13}, nil},
		{"upper case scheme", fakeAnswer{ad: true, txts: []string{"BITCOIN:" + uri[len("bitcoin:"):]}, alg: 13}, nil},
		{"other TXT records skipped", fakeAnswer{ad: true, txts: []string{"v=spf1 -all", uri}, alg: 13}, nil},
		{"through a CNAME", fakeAnswer{ad: true, cname: "pay.example.net.", txts: []string{uri}, alg: 13}, nil},
		{"no such name", fakeAnswer{rcode: dnsmessage.RCodeNameError, ad: true}, ErrNone},
		{"no bitcoin record", fakeAnswer{ad: true, txts: []string{"v=spf1 -all"}}, ErrNone},
		{"an unsigned domain with no record", fakeAnswer{rcode: dnsmessage.RCodeNameError}, ErrNone},
		{"on-chain only", fakeAnswer{ad: true, txts: []string{"bitcoin:bc1qexample"}, alg: 13}, ErrNoOffer},
		{"a req- parameter", fakeAnswer{ad: true, txts: []string{uri + "&req-somethingnew=1"}, alg: 13}, ErrRequires},
		{"a req- parameter in upper case, on-chain only", fakeAnswer{ad: true, txts: []string{"bitcoin:bc1qexample?REQ-pop=x"}, alg: 13}, ErrRequires},
		{"two records", fakeAnswer{ad: true, txts: []string{uri, uri + "x"}, alg: 13}, ErrSeveral},
		{"not signed", fakeAnswer{txts: []string{uri}}, ErrNotSigned},
		{"bogus", fakeAnswer{rcode: dnsmessage.RCodeServerFailure, ede: 6}, ErrBogus},
		{"signature expired", fakeAnswer{rcode: dnsmessage.RCodeServerFailure, ede: 7}, ErrBogus},
		{"no zone key bit", fakeAnswer{rcode: dnsmessage.RCodeServerFailure, ede: 11}, ErrBogus},
		{"a stale answer is not DNSSEC's", fakeAnswer{rcode: dnsmessage.RCodeServerFailure, ede: 3}, ErrUnreachable},
		{"a plain SERVFAIL", fakeAnswer{rcode: dnsmessage.RCodeServerFailure}, ErrUnreachable},
		{"refused", fakeAnswer{rcode: dnsmessage.RCodeRefused}, ErrUnreachable},
		{"AD but no signature to check", fakeAnswer{ad: true, txts: []string{uri}}, ErrNotSigned},
		{"a truncated answer", fakeAnswer{ad: true, txts: []string{uri}, alg: 13, tc: true}, ErrUnreachable},
		{"an answer for another name", fakeAnswer{rcode: dnsmessage.RCodeNameError, other: true}, ErrUnreachable},
		{"a record for another name", fakeAnswer{ad: true, txts: []string{uri}, alg: 13, foreign: "other.example.com."}, ErrNone},
		{"a chain of eight CNAMEs", fakeAnswer{ad: true, txts: []string{uri}, alg: 13, chain: 8}, nil},
		{"a chain of nine CNAMEs", fakeAnswer{ad: true, txts: []string{uri}, alg: 13, chain: 9}, ErrUnreachable},
		{"a CNAME loop", fakeAnswer{ad: true, loop: true}, ErrUnreachable},
		{"two CNAMEs at one name", fakeAnswer{ad: true, dup: true}, ErrUnreachable},
		{"signed with RSASHA1", fakeAnswer{ad: true, txts: []string{uri}, alg: 5}, ErrWeak},
		{"signed with RSASHA1-NSEC3-SHA1", fakeAnswer{ad: true, txts: []string{uri}, alg: 7}, ErrWeak},
		// An answer must be to what was asked: our id (0), opcode 0, one
		// question, for that name's TXT in class IN.
		{"an answer with another id", fakeAnswer{ad: true, txts: []string{uri}, alg: 13, id: 1}, ErrUnreachable},
		{"an answer with another opcode", fakeAnswer{ad: true, txts: []string{uri}, alg: 13, opcode: 2}, ErrUnreachable},
		{"an answer to an A question", fakeAnswer{ad: true, txts: []string{uri}, alg: 13, qtype: dnsmessage.TypeA}, ErrUnreachable},
		{"an answer to a question in class CH", fakeAnswer{ad: true, txts: []string{uri}, alg: 13, qclass: dnsmessage.ClassCHAOS}, ErrUnreachable},
		{"an answer to two questions", fakeAnswer{ad: true, txts: []string{uri}, alg: 13, twoQ: true}, ErrUnreachable},
		{"a record in class CH is not one", fakeAnswer{ad: true, txts: []string{uri}, alg: 13, class: dnsmessage.ClassCHAOS}, ErrNone},
		// U+212A folds to 'k' in Unicode, never in DNS: not the name asked.
		{"an owner with the Kelvin sign", fakeAnswer{ad: true, txts: []string{uri}, alg: 13, foreign: "Kim.user._bitcoin-payment.example.com."}, ErrNone},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			user := "alice"
			if strings.Contains(c.name, "Kelvin") {
				user = "kim"
			}
			_, err := resolverFor(t, c.a, c.a).Resolve(context.Background(), user, "example.com")
			if !errors.Is(err, c.want) || (c.want == nil && err != nil) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}
}

func TestTheTwoServicesMustAgree(t *testing.T) {
	ok := fakeAnswer{ad: true, txts: []string{uri}, alg: 13}
	cases := []struct {
		name string
		a, b fakeAnswer
		want error
	}{
		{"a record and none", ok, fakeAnswer{rcode: dnsmessage.RCodeNameError, ad: true}, ErrDisagree},
		{"two different records", ok, fakeAnswer{ad: true, txts: []string{uri + "x"}, alg: 13}, ErrDisagree},
		{"one not signed", ok, fakeAnswer{txts: []string{uri}}, ErrNotSigned},
		{"one bogus", ok, fakeAnswer{rcode: dnsmessage.RCodeServerFailure, ede: 6}, ErrBogus},
		{"one down", ok, fakeAnswer{rcode: dnsmessage.RCodeServerFailure}, ErrUnreachable},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := resolverFor(t, c.a, c.b).Resolve(context.Background(), "alice", "example.com")
			if !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
			_, err = resolverFor(t, c.b, c.a).Resolve(context.Background(), "alice", "example.com")
			if !errors.Is(err, c.want) {
				t.Fatalf("the other way round: got %v, want %v", err, c.want)
			}
		})
	}
}

func TestOneSlowServiceKeepsTheBudget(t *testing.T) {
	r := resolverFor(t, fakeAnswer{ad: true, txts: []string{uri}, alg: 13}, fakeAnswer{hang: true})
	r.Wait = 300 * time.Millisecond
	start := time.Now()
	_, err := r.Resolve(context.Background(), "alice", "example.com")
	if !errors.Is(err, ErrUnreachable) || time.Since(start) > time.Second {
		t.Fatalf("%v after %v", err, time.Since(start))
	}
}

func TestANameTooLongIsRefused(t *testing.T) {
	r := resolverFor(t, fakeAnswer{}, fakeAnswer{})
	if _, err := r.Resolve(context.Background(), strings.Repeat("a", 64), "example.com"); err == nil {
		t.Fatal("a label over 63 bytes was asked")
	}
}

func TestOneServiceIsNotEnough(t *testing.T) {
	ok := fakeAnswer{ad: true, txts: []string{uri}, alg: 13}
	r := &Resolver{HTTP: &http.Client{}, Services: []string{service(t, ok)}, Wait: 2 * time.Second}
	if _, err := r.Resolve(context.Background(), "alice", "example.com"); !errors.Is(err, ErrUnreachable) {
		t.Fatalf("got %v", err)
	}
	if _, err := combine(nil); !errors.Is(err, ErrUnreachable) {
		t.Fatalf("nothing answered: %v", err)
	}
}

func TestLnoTakesOneOffer(t *testing.T) {
	for uri, want := range map[string]string{
		"bitcoin:?lno=abc":          "abc",
		"bitcoin:?amount=1&LNO=abc": "abc",
		"bitcoin:?lno=a&lno=a":      "",
		"bitcoin:?lno=a&LNO=b":      "",
		"bitcoin:?lno=%zz":          "",
		"bitcoin:bc1qexample":       "",
	} {
		if got := lno(uri); got != want {
			t.Errorf("%s: %q, want %q", uri, got, want)
		}
	}
}

func TestRequiresIsAnyReqParameter(t *testing.T) {
	for uri, want := range map[string]bool{
		"bitcoin:?lno=abc":                  false,
		"bitcoin:?lno=abc&req-pop=x":        true,
		"bitcoin:?Req-Anything&lno=abc":     true,
		"bitcoin:?request=1&lno=abc":        false,
		"bitcoin:?%72eq-x=1&lno=abc":        true,
		"bitcoin:?lno=abc&pop=x":            false,
		"bitcoin:bc1qexample":               false,
		"bitcoin:bc1qexample?label=req-pop": false,
	} {
		if got := requires(uri); got != want {
			t.Errorf("%s: %v, want %v", uri, got, want)
		}
	}
}
