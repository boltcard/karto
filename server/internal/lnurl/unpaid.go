package lnurl

import (
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
// it up. The window is short, so a flood that fills the cap holds back real
// payers only that long after it stops; the share per client means one
// address alone can't fill it.
//
// It is kept in memory: a restart forgets the count, which a stranger can't
// cause, and at most doubles a window's rows when it happens.
type UnpaidCap struct {
	max, perClient int
	window         time.Duration
	now            func() time.Time

	mu       sync.Mutex
	made     map[string]unpaid // unpaid invoices by payment hash
	reserved map[string]int    // invoices being made now, by client (Reserve, before Made or Release)
}

type unpaid struct {
	at     time.Time
	client string
}

// NewUnpaidCap allows max unpaid invoices made in the last window, perClient of them for any one client.
func NewUnpaidCap(max, perClient int, window time.Duration, now func() time.Time) *UnpaidCap {
	return &UnpaidCap{max: max, perClient: perClient, window: window, now: now, made: map[string]unpaid{}, reserved: map[string]int{}}
}

// InvoiceUnpaidCap is cardd's: 300 unpaid invoices an hour, 30 of them per
// client. Far beyond a personal server's abandoned payments, even a crowd's;
// at most 7,200 rows a day in phoenixd's database, a few megabytes, instead
// of the rate limit's 86,400; and a flood that fills it blocks top-ups for an
// hour at most once it stops.
func InvoiceUnpaidCap(now func() time.Time) *UnpaidCap {
	return NewUnpaidCap(300, 30, time.Hour, now)
}

// Reserve takes a place for an invoice about to be made for client; false,
// with how long until a place should be free, when there is none: overall
// true when the whole cap is full (every payer is turned away), false when
// only client's share is. The caller then calls Made with the invoice's
// hash, or Release.
func (c *UnpaidCap) Reserve(client string) (ok, overall bool, retry time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	var oldest, oldestMine time.Time // the oldest unpaid invoice, overall and this client's
	mine := c.reserved[client]
	reserved := 0
	for _, n := range c.reserved {
		reserved += n
	}
	for hash, u := range c.made {
		if !now.Before(u.at.Add(c.window)) {
			delete(c.made, hash)
			continue
		}
		if oldest.IsZero() || u.at.Before(oldest) {
			oldest = u.at
		}
		if u.client == client {
			mine++
			if oldestMine.IsZero() || u.at.Before(oldestMine) {
				oldestMine = u.at
			}
		}
	}
	free := func(from time.Time) time.Duration {
		if from.IsZero() {
			return time.Second // only invoices being made right now hold the places
		}
		return from.Add(c.window).Sub(now)
	}
	if len(c.made)+reserved >= c.max {
		return false, true, free(oldest)
	}
	if mine >= c.perClient {
		return false, false, free(oldestMine)
	}
	c.reserved[client]++
	return true, false, 0
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

// Paid takes a paid invoice out of the count.
func (c *UnpaidCap) Paid(paymentHash string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.made, paymentHash)
}
