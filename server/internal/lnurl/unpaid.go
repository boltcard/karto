package lnurl

import (
	"slices"
	"sync"
	"time"
)

// UnpaidCap bounds the invoices the public callbacks make that nobody pays.
// phoenixd keeps every invoice it makes for ever, paid or not (v0.9.2 never
// purges an expired one, and has no call to delete one), so the rate limit
// alone still lets a patient flood fill the server's disk: one a second is
// 86,400 rows a day. The cap counts the invoices made in the last window
// that haven't been paid, overall and per client, and refuses another past
// either. A paid invoice leaves the count at once, so real payers never use
// it up. The window is an invoice's life: an invoice nobody can pay any more
// holds no place, so a flood that fills the cap holds back payers only that
// long after it stops.
//
// A client that has brought KnownSat through its invoices in the last
// KnownFor is known: it has places strangers can't take (Known's Overall
// above Stranger's) and a larger share of its own, so payers who really pay
// (the owner's other wallet, a regular customer, a wallet's servers) get
// through while strangers fill the cap. The lane costs: a sat or two from
// each address would buy it otherwise. A known client refused at its own
// share is a stranger again.
//
// It is kept in memory: a restart forgets the count and the known clients,
// which a stranger can't cause, and at most doubles a window's rows when it
// happens. The day's sum is counted from a client's first payment in it, so
// a total split across a restart, or across that day's end, may fall short.
type UnpaidCap struct {
	l   CapLimits
	now func() time.Time

	mu       sync.Mutex
	made     map[string]unpaid // unpaid invoices by payment hash, kept for Keep
	reserved map[string]int    // invoices being made now, by client (Reserve, before Made or Release)
	known    map[string]*payer // what clients have brought, at most KnownMax of them
}

// Share is how many unpaid invoices a class of client may fill the cap to, and hold each.
type Share struct{ Overall, PerClient int }

// CapLimits are an UnpaidCap's numbers.
type CapLimits struct {
	Window          time.Duration // an invoice counts for this long after it is made
	Keep            time.Duration // and is kept this long, for Paid to find its client
	Stranger, Known Share
	KnownSat        int64 // brought within KnownFor, makes a client known for KnownFor
	KnownFor        time.Duration
	KnownMax        int // clients kept in the known table
}

// CapRefusal is why Reserve found no place.
type CapRefusal struct {
	Overall bool          // the whole cap for the client's class, not only its own share
	Known   bool          // the client was known when refused
	Retry   time.Duration // until a place should be free for it
}

type unpaid struct {
	at     time.Time
	client string
}

// payer is what a client has brought since since (towards the next KnownSat), and when its status ends.
type payer struct {
	since      time.Time
	sum        int64
	knownUntil time.Time
}

// NewUnpaidCap is a cap with limits l.
func NewUnpaidCap(l CapLimits, now func() time.Time) *UnpaidCap {
	return &UnpaidCap{l: l, now: now, made: map[string]unpaid{}, reserved: map[string]int{}, known: map[string]*payer{}}
}

// InvoiceUnpaidCap is cardd's: an invoice counts for its 10-minute life (kept
// 20 minutes, so a payment the 5-minute sweep credits still finds its
// client). Strangers may fill it to 50, 10 each: far beyond a personal
// server's abandoned payments, a crowd's included, and room for several
// payers behind one address. Clients that brought 1,000 sat in the last day
// may fill it to 75, 20 each. At most 10,800 rows a day in phoenixd's
// database, a few megabytes, 7,200 of them strangers'.
func InvoiceUnpaidCap(now func() time.Time) *UnpaidCap {
	return NewUnpaidCap(CapLimits{Window: invoiceExpiry, Keep: 20 * time.Minute,
		Stranger: Share{Overall: 50, PerClient: 10}, Known: Share{Overall: 75, PerClient: 20},
		KnownSat: 1000, KnownFor: 24 * time.Hour, KnownMax: 4096}, now)
}

// Reserve takes a place for an invoice about to be made for client; false,
// with why, when there is none. The caller then calls Made with the
// invoice's hash, or Release.
func (c *UnpaidCap) Reserve(client string) (bool, CapRefusal) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	var all, mine []time.Time // when the counted invoices were made, all and this client's
	for hash, u := range c.made {
		age := now.Sub(u.at)
		if age >= c.l.Keep {
			delete(c.made, hash)
			continue
		}
		if age >= c.l.Window {
			continue
		}
		all = append(all, u.at)
		if u.client == client {
			mine = append(mine, u.at)
		}
	}
	reserved, reservedMine := 0, c.reserved[client]
	for _, n := range c.reserved {
		reserved += n
	}
	known := c.isKnown(client, now)
	share := c.l.Stranger
	if known {
		share = c.l.Known
	}
	overall := len(all)+reserved >= share.Overall
	own := len(mine)+reservedMine >= share.PerClient
	if !overall && !own {
		c.reserved[client]++
		return true, CapRefusal{}
	}
	r := CapRefusal{Overall: overall, Known: known}
	if !overall && known {
		// Over its own share alone: a stranger again, and its wait is a stranger's.
		delete(c.known, client)
		share = c.l.Stranger
		if len(all)+reserved >= share.Overall {
			r.Retry = c.wait(all, reserved, share.Overall, now)
		}
	}
	if overall {
		r.Retry = c.wait(all, reserved, share.Overall, now)
	}
	if len(mine)+reservedMine >= share.PerClient {
		r.Retry = max(r.Retry, c.wait(mine, reservedMine, share.PerClient, now))
	}
	return false, r
}

// wait is how long until a set of counted invoices made at made, with
// reserved more being made, is under limit: until the one that brings it
// there leaves the count, or a second when invoices being made hold the
// places (they are made or given back within moments).
func (c *UnpaidCap) wait(made []time.Time, reserved, limit int, now time.Time) time.Duration {
	k := len(made) + reserved - limit + 1
	if k > len(made) {
		return time.Second
	}
	slices.SortFunc(made, func(a, b time.Time) int { return a.Compare(b) })
	return made[k-1].Add(c.l.Window).Sub(now)
}

func (c *UnpaidCap) isKnown(client string, now time.Time) bool {
	p := c.known[client]
	return p != nil && now.Before(p.knownUntil)
}

// Made fills client's reserved place with the invoice phoenixd made.
func (c *UnpaidCap) Made(client, paymentHash string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.unreserve(client)
	c.made[paymentHash] = unpaid{at: c.now(), client: client}
}

// Release gives back client's reserved place: no invoice was made.
func (c *UnpaidCap) Release(client string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.unreserve(client)
}

func (c *UnpaidCap) unreserve(client string) {
	if c.reserved[client]--; c.reserved[client] <= 0 {
		delete(c.reserved, client)
	}
}

// Paid takes a paid invoice out of the count, and adds what it brought
// (sat) to its client's day. A hash the cap didn't make, or no longer keeps,
// changes nothing: sales and the sweeps' repeats come here too.
func (c *UnpaidCap) Paid(paymentHash string, sat int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	u, ok := c.made[paymentHash]
	if !ok {
		return
	}
	delete(c.made, paymentHash)
	now := c.now()
	if u.client == "" || now.Sub(u.at) >= c.l.Keep {
		return
	}
	p := c.known[u.client]
	if p == nil {
		if len(c.known) >= c.l.KnownMax {
			c.evict(now)
		}
		p = &payer{since: now}
		c.known[u.client] = p
	}
	if now.Sub(p.since) >= c.l.KnownFor {
		p.since, p.sum = now, 0
	}
	// Each KnownSat brought makes it known for KnownFor from then, and the
	// count starts again: a payer who keeps paying stays known, a sat more
	// renews nothing.
	if p.sum += sat; p.sum >= c.l.KnownSat {
		p.knownUntil = now.Add(c.l.KnownFor)
		p.since, p.sum = now, 0
	}
}

// evict drops one client from the full known table: the one that started
// its day longest ago among those not known, or, when all are, the one whose
// status ends first. Payers of a sat can't push known clients out.
func (c *UnpaidCap) evict(now time.Time) {
	var drop string
	var dropKnown bool
	var at time.Time
	for client, p := range c.known {
		k := now.Before(p.knownUntil)
		when := p.since
		if k {
			when = p.knownUntil
		}
		if drop == "" || (dropKnown && !k) || (dropKnown == k && when.Before(at)) {
			drop, dropKnown, at = client, k, when
		}
	}
	delete(c.known, drop)
}
