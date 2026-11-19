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
// that haven't been paid, and refuses another past max. A paid invoice
// leaves the count at once, so real payers never use it up.
//
// It is kept in memory: a restart forgets the count, which a stranger can't
// cause, and at most doubles a day's rows when it happens.
type UnpaidCap struct {
	max    int
	window time.Duration
	now    func() time.Time

	mu       sync.Mutex
	made     map[string]time.Time // unpaid invoices by payment hash, when made
	reserved int                  // invoices being made now (Reserve, before Made or Release)
}

// NewUnpaidCap allows max unpaid invoices made in the last window.
func NewUnpaidCap(max int, window time.Duration, now func() time.Time) *UnpaidCap {
	return &UnpaidCap{max: max, window: window, now: now, made: map[string]time.Time{}}
}

// InvoiceUnpaidCap is cardd's: 1,000 unpaid invoices a day, far beyond a
// personal server's abandoned payments, and about a megabyte of phoenixd's
// database a day at most, instead of the rate limit's 86,400 rows.
func InvoiceUnpaidCap(now func() time.Time) *UnpaidCap {
	return NewUnpaidCap(1000, 24*time.Hour, now)
}

// Reserve takes a place for an invoice about to be made; false, with how
// long until the oldest unpaid one leaves the count, when there is none.
// The caller then calls Made with the invoice's hash, or Release.
func (c *UnpaidCap) Reserve() (bool, time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	oldest := now
	for hash, at := range c.made {
		if !now.Before(at.Add(c.window)) {
			delete(c.made, hash)
		} else if at.Before(oldest) {
			oldest = at
		}
	}
	if len(c.made)+c.reserved >= c.max {
		return false, oldest.Add(c.window).Sub(now)
	}
	c.reserved++
	return true, 0
}

// Made fills a reserved place with the invoice phoenixd made.
func (c *UnpaidCap) Made(paymentHash string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reserved--
	c.made[paymentHash] = c.now()
}

// Release gives back a reserved place: no invoice was made.
func (c *UnpaidCap) Release() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reserved--
}

// Paid takes a paid invoice out of the count.
func (c *UnpaidCap) Paid(paymentHash string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.made, paymentHash)
}
