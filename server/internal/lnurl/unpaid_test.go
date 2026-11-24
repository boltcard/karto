package lnurl_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/lnurl"
)

// capAt is a cap with small numbers on a clock the test moves: strangers 4 overall and 2 each, known clients a
// lane of their own of 6 and 3 each, known after 1,000 sat in a day, at most 2 known clients kept.
func capAt(at *time.Time) *lnurl.UnpaidCap {
	return capWith(at, lnurl.Share{Overall: 4, PerClient: 2}, lnurl.Share{Overall: 6, PerClient: 3}, 2)
}

func capWith(at *time.Time, stranger, known lnurl.Share, knownMax int) *lnurl.UnpaidCap {
	return lnurl.NewUnpaidCap(lnurl.CapLimits{Window: 10 * time.Minute, Keep: 20 * time.Minute, Stranger: stranger, Known: known,
		KnownSat: 1000, KnownFor: 24 * time.Hour, KnownMax: knownMax}, func() time.Time { return *at })
}

var hashes int

// makeIn has c make an invoice for client, failing the test if there is no place; its hash and lane.
func makeIn(t *testing.T, c *lnurl.UnpaidCap, client string) (string, lnurl.Lane) {
	t.Helper()
	lane, ok, r := c.Reserve(client)
	if !ok {
		t.Fatalf("%s refused: %+v", client, r)
	}
	hashes++
	h := fmt.Sprintf("h%d", hashes)
	c.Made(client, lane, h)
	return h, lane
}

// make1 is makeIn's hash alone.
func make1(t *testing.T, c *lnurl.UnpaidCap, client string) string {
	t.Helper()
	h, _ := makeIn(t, c, client)
	return h
}

// makeN has client make n invoices, each in lane want.
func makeN(t *testing.T, c *lnurl.UnpaidCap, client string, n int, want lnurl.Lane) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, lane := makeIn(t, c, client); lane != want {
			t.Fatalf("%s's invoice %d in lane %d, want %d", client, i+1, lane, want)
		}
	}
}

// pay has client pay sat through an invoice of its own.
func pay(t *testing.T, c *lnurl.UnpaidCap, client string, sat int64) {
	t.Helper()
	c.Paid(make1(t, c, client), sat)
}

// known says whether client is judged as known: it is given a known place (the test leaves one free for it).
// The place is given back.
func known(c *lnurl.UnpaidCap, client string) bool {
	lane, ok, _ := c.Reserve(client)
	if ok {
		c.Release(client, lane)
	}
	return ok && lane == lnurl.KnownLane
}

func TestAStrangerIsRefusedAtTheStrangersShare(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capAt(&at)
	make1(t, c, "a")
	at = at.Add(time.Minute)
	make1(t, c, "a")
	at = at.Add(time.Minute)
	_, ok, r := c.Reserve("a")
	if ok || r.Overall || r.Known || r.Retry != 8*time.Minute {
		t.Fatalf("the third: %v %+v", ok, r)
	}
	if _, ok, _ := c.Reserve("b"); !ok {
		t.Fatal("another client")
	}
}

// Strangers filling their places take none of the known clients'; known clients filling theirs refuse the next
// known client as a whole, and it stays known.
func TestStrangersCantTakeKnownPlaces(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capWith(&at, lnurl.Share{Overall: 4, PerClient: 2}, lnurl.Share{Overall: 6, PerClient: 3}, 16)
	for _, k := range []string{"k1", "k2", "k3"} {
		pay(t, c, k, 1000)
	}
	for _, s := range []string{"s1", "s2"} {
		makeN(t, c, s, 2, lnurl.StrangerLane)
	}
	if _, ok, r := c.Reserve("s3"); ok || !r.Overall || r.Known {
		t.Fatalf("the fifth stranger: %v %+v", ok, r)
	}
	makeN(t, c, "k1", 3, lnurl.KnownLane)
	makeN(t, c, "k2", 3, lnurl.KnownLane)
	for i := 0; i < 2; i++ {
		if _, ok, r := c.Reserve("k3"); ok || !r.Overall || !r.Known {
			t.Fatalf("past the known lane, %d: %v %+v", i+1, ok, r)
		}
	}
	at = at.Add(10 * time.Minute)
	if !known(c, "k3") {
		t.Fatal("k3 lost its status to a full lane")
	}
}

// A known client whose own known places are full may take stranger places, as a stranger may; past both it is
// refused for its own share and is a stranger again.
func TestAKnownClientUsesStrangerPlacesWhenItsOwnAreFull(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capWith(&at, lnurl.Share{Overall: 50, PerClient: 10}, lnurl.Share{Overall: 25, PerClient: 5}, 16)
	pay(t, c, "k", 1000)
	makeN(t, c, "k", 5, lnurl.KnownLane)
	makeN(t, c, "k", 10, lnurl.StrangerLane)
	if _, ok, r := c.Reserve("k"); ok || r.Overall || !r.Known {
		t.Fatalf("the 16th: %v %+v", ok, r)
	}
	at = at.Add(10 * time.Minute)
	if known(c, "k") {
		t.Fatal("still known past its own share")
	}
}

// An invoice being made holds its place in the lane it was given, and only there.
func TestReservationsCountInTheirLane(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capWith(&at, lnurl.Share{Overall: 50, PerClient: 10}, lnurl.Share{Overall: 25, PerClient: 5}, 16)
	for i := 1; i <= 6; i++ {
		pay(t, c, fmt.Sprintf("k%d", i), 1000)
	}
	for i := 1; i <= 4; i++ {
		makeN(t, c, fmt.Sprintf("k%d", i), 5, lnurl.KnownLane)
	}
	makeN(t, c, "k5", 4, lnurl.KnownLane)
	l5, ok, _ := c.Reserve("k5")
	if !ok || l5 != lnurl.KnownLane {
		t.Fatalf("k5's 5th: %v %v", l5, ok)
	}
	l6, ok, _ := c.Reserve("k6")
	if !ok || l6 != lnurl.StrangerLane {
		t.Fatalf("k6 beside a full known lane: %v %v", l6, ok)
	}
	c.Release("k6", l6)
	c.Release("k5", l5)
	if l, ok, _ := c.Reserve("k6"); !ok || l != lnurl.KnownLane {
		t.Fatalf("k6 after k5 gave its place back: %v %v", l, ok)
	}
}

// A known client refused by both lanes waits for the one that frees first.
func TestRetryIsTheSoonestLane(t *testing.T) {
	for _, knownFirst := range []bool{true, false} {
		at := time.Unix(1_790_000_000, 0)
		c := capWith(&at, lnurl.Share{Overall: 2, PerClient: 2}, lnurl.Share{Overall: 2, PerClient: 2}, 16)
		pay(t, c, "k1", 1000)
		pay(t, c, "k", 1000)
		t0 := at
		fill := []func(){func() { makeN(t, c, "k1", 2, lnurl.KnownLane) }, func() { makeN(t, c, "s", 2, lnurl.StrangerLane) }}
		if !knownFirst {
			fill[0], fill[1] = fill[1], fill[0]
		}
		fill[0]()
		at = t0.Add(3 * time.Minute)
		fill[1]()
		at = t0.Add(5 * time.Minute)
		if _, ok, r := c.Reserve("k"); ok || !r.Overall || !r.Known || r.Retry != 5*time.Minute {
			t.Fatalf("known lane filled first %v: %v %+v", knownFirst, ok, r)
		}
	}
}

func TestOnlyReservationsMeanASecond(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capWith(&at, lnurl.Share{Overall: 2, PerClient: 2}, lnurl.Share{Overall: 2, PerClient: 2}, 2)
	c.Reserve("a")
	c.Reserve("b")
	if _, ok, r := c.Reserve("c"); ok || !r.Overall || r.Retry != time.Second {
		t.Fatalf("%v %+v", ok, r)
	}
}

// A payment credited after the invoice left the count (the 5-minute sweep) still reaches its client; one
// after the invoice is no longer kept doesn't.
func TestALatePaymentStillMakesItsClientKnown(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capAt(&at)
	ha := make1(t, c, "a")
	hb := make1(t, c, "b")
	at = at.Add(15 * time.Minute)
	lz, ok, _ := c.Reserve("z")
	if !ok {
		t.Fatal("z")
	}
	c.Release("z", lz)
	c.Paid(ha, 1000)
	if !known(c, "a") {
		t.Fatal("a paid at 15 minutes is not known")
	}
	at = at.Add(6 * time.Minute)
	c.Paid(hb, 1000)
	if known(c, "b") {
		t.Fatal("b paid at 21 minutes is known")
	}
}

func TestPaidForAnUnknownHashChangesNothing(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capAt(&at)
	c.Paid("nope", 5000)
	c.Paid("nope", 5000)
	h := make1(t, c, "a")
	c.Paid(h, 600)
	c.Paid(h, 600) // a second credit of the same payment
	if known(c, "a") {
		t.Fatal("one payment of 600 counted twice")
	}
	l, _, _ := c.Reserve("")
	c.Made("", l, "empty")
	c.Paid("empty", 5000)
	if known(c, "") {
		t.Fatal("the empty client is known")
	}
}

func TestKnownNeedsAThousandSatInADay(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capAt(&at)
	pay(t, c, "a", 600)
	if known(c, "a") {
		t.Fatal("600 made a known")
	}
	pay(t, c, "a", 400)
	if !known(c, "a") {
		t.Fatal("1,000 in a day didn't")
	}
	pay(t, c, "b", 600)
	at = at.Add(25 * time.Hour)
	pay(t, c, "b", 400)
	if known(c, "b") {
		t.Fatal("600 and, a day later, 400 made b known")
	}
}

func TestKnownStatusLastsADay(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capAt(&at)
	t0 := at
	pay(t, c, "a", 1000)
	at = t0.Add(23*time.Hour + 59*time.Minute)
	pay(t, c, "a", 1) // already over: doesn't lengthen it
	if !known(c, "a") {
		t.Fatal("not known within the day")
	}
	at = t0.Add(24*time.Hour + time.Second)
	if known(c, "a") {
		t.Fatal("still known a day on")
	}
}

// A known client over its own share in every lane it may use is a stranger again: it must bring 1,000 sat to be
// known. Its wait is a stranger's. A refusal because the known lane is full as a whole doesn't demote.
func TestAKnownClientOverItsShareIsDemoted(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capAt(&at)
	pay(t, c, "k", 1000)
	t0 := at
	for i := 0; i < 5; i++ {
		at = t0.Add(time.Duration(i) * time.Minute)
		make1(t, c, "k")
	}
	at = t0.Add(5 * time.Minute)
	// 3 known places (t0..t0+2m) and 2 stranger ones (t0+3m, t0+4m). As a stranger it may hold 2: the oldest
	// stranger one (t0+3m) must leave.
	if _, ok, r := c.Reserve("k"); ok || r.Overall || !r.Known || r.Retry != 8*time.Minute {
		t.Fatalf("over its share: %v %+v", ok, r)
	}
	if _, ok, r := c.Reserve("k"); ok || r.Known {
		t.Fatalf("after: %v %+v", ok, r)
	}

	at = t0.Add(time.Hour)
	pay(t, c, "j", 1000)
	pay(t, c, "i", 1000)
	makeN(t, c, "j", 3, lnurl.KnownLane)
	makeN(t, c, "i", 3, lnurl.KnownLane)
	makeN(t, c, "s1", 2, lnurl.StrangerLane)
	makeN(t, c, "s2", 2, lnurl.StrangerLane)
	for i := 0; i < 2; i++ {
		if _, ok, r := c.Reserve("j"); ok || !r.Overall || !r.Known {
			t.Fatalf("the known lane full, %d: %v %+v", i+1, ok, r)
		}
	}
}

// A full table drops a client that isn't known before one that is, then the known one known longest.
func TestTheKnownTableKeepsKnownClients(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capAt(&at)
	pay(t, c, "k", 1000)
	at = at.Add(time.Second)
	pay(t, c, "p1", 1)
	at = at.Add(time.Second)
	pay(t, c, "p2", 1)
	if !known(c, "k") {
		t.Fatal("one-sat payers pushed a known client out")
	}
	at = at.Add(time.Second)
	pay(t, c, "m", 1000)
	at = at.Add(time.Second)
	pay(t, c, "n", 1000)
	if known(c, "k") || !known(c, "m") || !known(c, "n") {
		t.Fatalf("all known: k %v m %v n %v", known(c, "k"), known(c, "m"), known(c, "n"))
	}
}

// cardd's numbers: strangers 10 each and 50 in all; known clients 5 each and 25 in all in their own lane; a wait
// of at most the invoice's 10 minutes.
func TestCarddsUnpaidCap(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := lnurl.InvoiceUnpaidCap(func() time.Time { return at })
	short := func(r lnurl.CapRefusal) {
		t.Helper()
		if r.Retry <= 0 || r.Retry > 10*time.Minute {
			t.Fatalf("wait %v", r.Retry)
		}
	}
	for i := 1; i <= 6; i++ {
		pay(t, c, fmt.Sprintf("k%d", i), 1000)
	}
	makeN(t, c, "s0", 10, lnurl.StrangerLane)
	if _, ok, r := c.Reserve("s0"); ok || r.Overall {
		t.Fatalf("the 11th from one stranger: %v %+v", ok, r)
	} else {
		short(r)
	}
	for i := 1; i < 5; i++ {
		makeN(t, c, fmt.Sprintf("s%d", i), 10, lnurl.StrangerLane)
	}
	if _, ok, r := c.Reserve("s5"); ok || !r.Overall {
		t.Fatalf("the 51st: %v %+v", ok, r)
	} else {
		short(r)
	}
	for i := 1; i <= 5; i++ {
		makeN(t, c, fmt.Sprintf("k%d", i), 5, lnurl.KnownLane)
	}
	if _, ok, r := c.Reserve("k6"); ok || !r.Overall || !r.Known {
		t.Fatalf("the 26th known: %v %+v", ok, r)
	} else {
		short(r)
	}
}

// A payer who keeps paying stays known: each further 1,000 sat renews the day.
func TestARegularPayerStaysKnown(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capAt(&at)
	t0 := at
	pay(t, c, "a", 2000)
	at = t0.Add(23 * time.Hour)
	pay(t, c, "a", 2000)
	at = t0.Add(24*time.Hour + time.Second)
	if !known(c, "a") {
		t.Fatal("2,000 sat a day after 2,000 sat: a stranger")
	}
	at = t0.Add(47*time.Hour + time.Second)
	if known(c, "a") {
		t.Fatal("still known a day after its last 1,000")
	}
}
