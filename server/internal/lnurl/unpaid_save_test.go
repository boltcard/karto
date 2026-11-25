package lnurl_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/lnurl"
)

// saved is a saved cap as the file holds it.
type saved struct {
	Version int `json:"version"`
	Known   []struct {
		Client string    `json:"client"`
		Since  time.Time `json:"since"`
		Sum    int64     `json:"sum"`
		Until  time.Time `json:"until"`
	} `json:"known"`
	Invoices []struct {
		Hash   string     `json:"hash"`
		At     time.Time  `json:"at"`
		Client string     `json:"client"`
		Lane   lnurl.Lane `json:"lane"`
	} `json:"invoices"`
}

func save(t *testing.T, c *lnurl.UnpaidCap) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := c.Save(&b); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func load(t *testing.T, c *lnurl.UnpaidCap, b []byte) {
	t.Helper()
	if err := c.Load(bytes.NewReader(b)); err != nil {
		t.Fatal(err)
	}
}

func decode(t *testing.T, b []byte) saved {
	t.Helper()
	var s saved
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func smallCap(at *time.Time) *lnurl.UnpaidCap {
	return capWith(at, lnurl.Share{Overall: 4, PerClient: 2}, lnurl.Share{Overall: 6, PerClient: 3}, 16)
}

func TestSaveAndLoadKeepKnownPayersAndInvoices(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := smallCap(&at)
	pay(t, c, "k", 1000)
	pay(t, c, "p", 400)
	makeN(t, c, "k", 2, lnurl.KnownLane)
	hs := make1(t, c, "s")
	b := save(t, c)
	if v := decode(t, b).Version; v != 1 {
		t.Fatalf("version %d", v)
	}

	at = at.Add(time.Minute)
	c2 := smallCap(&at)
	load(t, c2, b)
	if !known(c2, "k") {
		t.Fatal("k isn't known after a restart")
	}
	pay(t, c2, "p", 600)
	if !known(c2, "p") {
		t.Fatal("p's 400 before the restart didn't count")
	}
	make1(t, c2, "s")
	if _, ok, r := c2.Reserve("s"); ok || r.Overall {
		t.Fatalf("s's invoice before the restart didn't count: %v %+v", ok, r)
	}
	if _, lane := makeIn(t, c2, "k"); lane != lnurl.KnownLane {
		t.Fatal("k's third known place")
	}
	if _, lane := makeIn(t, c2, "k"); lane != lnurl.StrangerLane {
		t.Fatal("k's known invoices before the restart didn't count")
	}
	c2.Paid(hs, 1000)
	if !known(c2, "s") {
		t.Fatal("paying an invoice made before the restart didn't credit its client")
	}
}

func TestLoadDropsWhatRanOut(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := smallCap(&at)
	pay(t, c, "k", 1000)
	pay(t, c, "p", 400)
	make1(t, c, "a")
	b := save(t, c)
	at = at.Add(25 * time.Hour)
	c2 := smallCap(&at)
	load(t, c2, b)
	if s := decode(t, save(t, c2)); len(s.Known) != 0 || len(s.Invoices) != 0 {
		t.Fatalf("kept %+v", s)
	}
}

func TestLoadClampsWhatItReads(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	ts := func(d time.Duration) string { return at.Add(d).UTC().Format(time.RFC3339Nano) }
	var inv, known []string
	inv = append(inv, fmt.Sprintf(`{"hash":"future","at":%q,"client":"f","lane":1}`, ts(time.Hour)))
	inv = append(inv, fmt.Sprintf(`{"hash":"odd","at":%q,"client":"o","lane":7}`, ts(-time.Minute)))
	inv = append(inv, fmt.Sprintf(`{"hash":"twice","at":%q,"client":"d","lane":1}`, ts(-time.Minute)))
	inv = append(inv, fmt.Sprintf(`{"hash":"twice","at":%q,"client":"d","lane":1}`, ts(-2*time.Minute)))
	for i := 0; i < 500; i++ { // in the window, the known lane: only its newest 6 (Overall) stay
		inv = append(inv, fmt.Sprintf(`{"hash":"k%d","at":%q,"client":"x","lane":2}`, i, ts(-time.Duration(i)*time.Second)))
	}
	for i := 0; i < 50; i++ { // past the window but kept for a late payment: at most 6 again
		inv = append(inv, fmt.Sprintf(`{"hash":"late%d","at":%q,"client":"x","lane":2}`, i, ts(-15*time.Minute-time.Duration(i)*time.Second)))
	}
	known = append(known, fmt.Sprintf(`{"client":"ahead","since":%q,"sum":0,"until":%q}`, ts(time.Hour), ts(1000*time.Hour)))
	known = append(known, fmt.Sprintf(`{"client":"dup","since":%q,"sum":0,"until":%q}`, ts(-time.Hour), ts(time.Hour)))
	known = append(known, fmt.Sprintf(`{"client":"dup","since":%q,"sum":0,"until":%q}`, ts(-time.Hour), ts(2*time.Hour)))
	for i := 0; i < 5000; i++ {
		known = append(known, fmt.Sprintf(`{"client":"c%d","since":%q,"sum":10,"until":%q}`, i, ts(-time.Duration(i)*time.Second), ts(-time.Hour)))
	}
	file := `{"version":1,"saved":"` + ts(0) + `","known":[` + strings.Join(known, ",") + `],"invoices":[` + strings.Join(inv, ",") + `]}`

	c := smallCap(&at)
	load(t, c, []byte(file))
	s := decode(t, save(t, c))
	hashes := map[string]int{}
	inWindow, late := 0, 0
	for _, i := range s.Invoices {
		hashes[i.Hash]++
		switch {
		case i.Hash == "future" || i.Hash == "odd":
			t.Fatalf("kept %s", i.Hash)
		case strings.HasPrefix(i.Hash, "late"):
			late++
		case strings.HasPrefix(i.Hash, "k"):
			inWindow++
			if i.At.Before(at.Add(-5 * time.Second)) {
				t.Fatalf("kept an older one, %s at %v", i.Hash, i.At)
			}
		}
	}
	if hashes["twice"] != 1 || inWindow != 6 || late != 6 {
		t.Fatalf("twice %d, in the window %d, late %d", hashes["twice"], inWindow, late)
	}
	if len(s.Known) != 16 {
		t.Fatalf("%d clients kept, want 16", len(s.Known))
	}
	clients := map[string]int{}
	for _, k := range s.Known {
		clients[k.Client]++
		if k.Since.After(at) || k.Until.After(at.Add(24*time.Hour)) {
			t.Fatalf("%s not clamped: since %v until %v", k.Client, k.Since, k.Until)
		}
		if k.Client == "dup" && !k.Until.Equal(at.Add(2*time.Hour)) {
			t.Fatalf("dup kept the shorter status: %v", k.Until)
		}
	}
	if clients["dup"] != 1 || clients["ahead"] != 1 {
		t.Fatalf("the known clients first, each once: %v", clients)
	}
}

func TestLoadRejectsBadFiles(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	for _, f := range []string{"", "{", "[]", `{"version":2,"known":[],"invoices":[]}`, `{"known":[]}`} {
		c := smallCap(&at)
		pay(t, c, "k", 1000)
		if err := c.Load(strings.NewReader(f)); err == nil {
			t.Fatalf("%q loaded", f)
		}
		if known(c, "k") {
			t.Fatalf("%q: the cap isn't empty after a refused file", f)
		}
		make1(t, c, "a")
	}
}

// A saved sum is what a payer brought towards being known: never as much as being known takes, so a file can't make
// a payer known on its next sat, nor push the sum past what an int64 holds.
func TestLoadKeepsASumShortOfKnown(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	ts := func(d time.Duration) string { return at.Add(d).UTC().Format(time.RFC3339Nano) }
	file := fmt.Sprintf(`{"version":1,"known":[{"client":"big","since":%q,"sum":9223372036854775807,"until":%q}]}`, ts(-time.Hour), ts(time.Hour))
	c := smallCap(&at)
	load(t, c, []byte(file))
	s := decode(t, save(t, c))
	if len(s.Known) != 1 || s.Known[0].Sum != 999 {
		t.Fatalf("kept %+v, want a sum of 999", s.Known)
	}
}
