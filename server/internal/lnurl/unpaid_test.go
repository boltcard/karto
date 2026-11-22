package lnurl_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/lnurl"
)

// capAt is a cap with small numbers on a clock the test moves: strangers 4 overall and 2 each, known clients 6
// and 3, known after 1,000 sat in a day, at most 2 known clients kept.
func capAt(at *time.Time) *lnurl.UnpaidCap {
	return capWith(at, lnurl.Share{Overall: 4, PerClient: 2}, lnurl.Share{Overall: 6, PerClient: 3})
}

func capWith(at *time.Time, stranger, known lnurl.Share) *lnurl.UnpaidCap {
	return lnurl.NewUnpaidCap(lnurl.CapLimits{Window: 10 * time.Minute, Keep: 20 * time.Minute, Stranger: stranger, Known: known,
		KnownSat: 1000, KnownFor: 24 * time.Hour, KnownMax: 2}, func() time.Time { return *at })
}

var hashes int

// make has c make an invoice for client, failing the test if there is no place; its hash.
func make1(t *testing.T, c *lnurl.UnpaidCap, client string) string {
	t.Helper()
	if ok, r := c.Reserve(client); !ok {
		t.Fatalf("%s refused: %+v", client, r)
	}
	hashes++
	h := fmt.Sprintf("h%d", hashes)
	c.Made(client, h)
	return h
}

// pay has client pay sat through an invoice of its own.
func pay(t *testing.T, c *lnurl.UnpaidCap, client string, sat int64) {
	t.Helper()
	c.Paid(make1(t, c, client), sat)
}

// known says whether client is judged as known: it may hold a third unpaid invoice (a stranger's share is 2).
// The places it tries are given back.
func known(c *lnurl.UnpaidCap, client string) bool {
	n := 0
	defer func() {
		for ; n > 0; n-- {
			c.Release(client)
		}
	}()
	for n < 3 {
		if ok, _ := c.Reserve(client); !ok {
			return false
		}
		n++
	}
	return true
}

func TestAStrangerIsRefusedAtTheStrangersShare(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capAt(&at)
	make1(t, c, "a")
	at = at.Add(time.Minute)
	make1(t, c, "a")
	at = at.Add(time.Minute)
	ok, r := c.Reserve("a")
	if ok || r.Overall || r.Known || r.Retry != 8*time.Minute {
		t.Fatalf("the third: %v %+v", ok, r)
	}
	if ok, _ := c.Reserve("b"); !ok {
		t.Fatal("another client")
	}
}

func TestStrangersStopAtTheirOverallKnownClientsGoOn(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capAt(&at)
	pay(t, c, "k", 1000)
	for _, s := range []string{"s1", "s2", "s3", "s4"} {
		make1(t, c, s)
	}
	if ok, r := c.Reserve("s5"); ok || !r.Overall || r.Known {
		t.Fatalf("the fifth stranger: %v %+v", ok, r)
	}
	make1(t, c, "k")
	make1(t, c, "k")
	if ok, r := c.Reserve("k"); ok || !r.Overall || !r.Known {
		t.Fatalf("past the known lane: %v %+v", ok, r)
	}
}

// The wait is until enough places are free for this client, not until the oldest invoice leaves.
func TestTheWaitIsForEnoughPlacesNotTheOldest(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capWith(&at, lnurl.Share{Overall: 4, PerClient: 4}, lnurl.Share{Overall: 8, PerClient: 6})
	pay(t, c, "k", 1000)
	t0 := at
	for i := 0; i < 6; i++ {
		at = t0.Add(time.Duration(i) * time.Minute)
		make1(t, c, "k")
	}
	// 6 counted, a stranger's limit 4: 3 must leave, the 3rd oldest made at t0+2m.
	if ok, r := c.Reserve("x"); ok || !r.Overall || r.Retry != t0.Add(12*time.Minute).Sub(at) {
		t.Fatalf("a stranger: %v %+v", ok, r)
	}
}

func TestOnlyReservationsMeanASecond(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capWith(&at, lnurl.Share{Overall: 2, PerClient: 2}, lnurl.Share{Overall: 2, PerClient: 2})
	c.Reserve("a")
	c.Reserve("b")
	if ok, r := c.Reserve("c"); ok || !r.Overall || r.Retry != time.Second {
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
	if ok, _ := c.Reserve("z"); !ok {
		t.Fatal("z")
	}
	c.Release("z")
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
	c.Reserve("")
	c.Made("", "empty")
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

// A known client over its own share is a stranger again: it must bring 1,000 sat to be known. Its wait is a
// stranger's. A refusal by both limits doesn't demote.
func TestAKnownClientOverItsShareIsDemoted(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := capAt(&at)
	pay(t, c, "k", 1000)
	t0 := at
	for i := 0; i < 3; i++ {
		at = t0.Add(time.Duration(i) * time.Minute)
		make1(t, c, "k")
	}
	at = t0.Add(3 * time.Minute)
	// As a stranger it may hold 2: the 2nd oldest (t0+1m) must leave.
	if ok, r := c.Reserve("k"); ok || r.Overall || !r.Known || r.Retry != 8*time.Minute {
		t.Fatalf("over its share: %v %+v", ok, r)
	}
	if ok, r := c.Reserve("k"); ok || r.Known {
		t.Fatalf("after: %v %+v", ok, r)
	}

	at = t0.Add(time.Hour)
	pay(t, c, "j", 1000)
	for i := 0; i < 3; i++ {
		make1(t, c, "j")
	}
	pay(t, c, "i", 1000)
	for i := 0; i < 3; i++ {
		make1(t, c, "i")
	}
	for i := 0; i < 2; i++ {
		if ok, r := c.Reserve("j"); ok || !r.Overall || !r.Known {
			t.Fatalf("both limits, %d: %v %+v", i+1, ok, r)
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

// cardd's numbers: strangers 10 each and 50 in all, known clients 20 each and 75 in all, a wait of at most the
// invoice's 10 minutes.
func TestCarddsUnpaidCap(t *testing.T) {
	at := time.Unix(1_790_000_000, 0)
	c := lnurl.InvoiceUnpaidCap(func() time.Time { return at })
	short := func(r lnurl.CapRefusal) {
		t.Helper()
		if r.Retry <= 0 || r.Retry > 10*time.Minute {
			t.Fatalf("wait %v", r.Retry)
		}
	}
	pay(t, c, "k1", 1000)
	pay(t, c, "k2", 1000)
	for i := 0; i < 10; i++ {
		make1(t, c, "s0")
	}
	if ok, r := c.Reserve("s0"); ok || r.Overall {
		t.Fatalf("the 11th from one stranger: %v %+v", ok, r)
	} else {
		short(r)
	}
	for i := 1; i < 5; i++ {
		for j := 0; j < 10; j++ {
			make1(t, c, fmt.Sprintf("s%d", i))
		}
	}
	if ok, r := c.Reserve("s5"); ok || !r.Overall {
		t.Fatalf("the 51st: %v %+v", ok, r)
	} else {
		short(r)
	}
	for i := 0; i < 20; i++ {
		make1(t, c, "k1")
	}
	for i := 0; i < 5; i++ {
		make1(t, c, "k2")
	}
	if ok, r := c.Reserve("k2"); ok || !r.Overall || !r.Known {
		t.Fatalf("the 76th: %v %+v", ok, r)
	} else {
		short(r)
	}
}
