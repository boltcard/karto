package lnurl

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"time"
)

// savedCapVersion is the version of what Save writes; Load reads no other.
const savedCapVersion = 1

// savedCap is an UnpaidCap's state as Save writes it. Invoices being made
// aren't in it: they are given back or made within moments.
type savedCap struct {
	Version  int            `json:"version"`
	Saved    time.Time      `json:"saved"`
	Known    []savedPayer   `json:"known"`
	Invoices []savedInvoice `json:"invoices"`
}

type savedPayer struct {
	Client string    `json:"client"`
	Since  time.Time `json:"since"`
	Sum    int64     `json:"sum"`
	Until  time.Time `json:"until"`
}

type savedInvoice struct {
	Hash   string    `json:"hash"`
	At     time.Time `json:"at"`
	Client string    `json:"client"`
	Lane   Lane      `json:"lane"`
}

// savedCapMax bounds what Load reads: Save never writes near it.
const savedCapMax = 16 << 20

// Save writes the cap's state, its known clients and the invoices it still
// keeps, as JSON.
func (c *UnpaidCap) Save(w io.Writer) error {
	c.mu.Lock()
	now := c.now()
	s := savedCap{Version: savedCapVersion, Saved: now, Known: []savedPayer{}, Invoices: []savedInvoice{}}
	for client, p := range c.known {
		s.Known = append(s.Known, savedPayer{Client: client, Since: p.since, Sum: p.sum, Until: p.knownUntil})
	}
	for hash, u := range c.made {
		if now.Sub(u.at) < c.l.Keep {
			s.Invoices = append(s.Invoices, savedInvoice{Hash: hash, At: u.at, Client: u.client, Lane: u.lane})
		}
	}
	c.mu.Unlock()
	return json.NewEncoder(w).Encode(s)
}

// Load replaces the cap's state with what Save wrote. It keeps only what
// still counts and nothing a file could use to shut more places, or for
// longer, than the cap itself would: no invoice from after now, at most a
// lane's Overall of invoices in the window and as many again kept for late
// payments (the newest), no status past now plus KnownFor, at most KnownMax
// clients (as evict would keep them), each once. An unreadable file, or one
// of another version, leaves the cap empty.
func (c *UnpaidCap) Load(r io.Reader) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.made, c.known = map[string]unpaid{}, map[string]*payer{}
	var s savedCap
	if err := json.NewDecoder(io.LimitReader(r, savedCapMax)).Decode(&s); err != nil {
		return fmt.Errorf("unpaid cap: %w", err)
	}
	if s.Version != savedCapVersion {
		return errors.New("unpaid cap: version " + fmt.Sprint(s.Version) + " isn't " + fmt.Sprint(savedCapVersion))
	}
	now := c.now()
	c.loadInvoices(s.Invoices, now)
	c.loadKnown(s.Known, now)
	return nil
}

func (c *UnpaidCap) loadInvoices(in []savedInvoice, now time.Time) {
	type group struct {
		lane Lane
		late bool
	}
	groups := map[group][]savedInvoice{}
	seen := map[string]bool{}
	for _, i := range in {
		age := now.Sub(i.At)
		if i.Hash == "" || seen[i.Hash] || (i.Lane != StrangerLane && i.Lane != KnownLane) || age < 0 || age >= c.l.Keep {
			continue
		}
		seen[i.Hash] = true
		g := group{i.Lane, age >= c.l.Window}
		groups[g] = append(groups[g], i)
	}
	for g, is := range groups {
		slices.SortFunc(is, func(a, b savedInvoice) int { return b.At.Compare(a.At) })
		for _, i := range is[:min(len(is), c.share(g.lane).Overall)] {
			c.made[i.Hash] = unpaid{at: i.At, client: i.Client, lane: i.Lane}
		}
	}
}

func (c *UnpaidCap) loadKnown(in []savedPayer, now time.Time) {
	byClient := map[string]*payer{}
	for _, k := range in {
		p := &payer{since: k.Since, sum: max(k.Sum, 0), knownUntil: k.Until}
		if p.since.After(now) {
			p.since = now
		}
		if p.knownUntil.After(now.Add(c.l.KnownFor)) {
			p.knownUntil = now.Add(c.l.KnownFor)
		}
		if k.Client == "" || (!now.Before(p.knownUntil) && now.Sub(p.since) >= c.l.KnownFor) {
			continue
		}
		if q := byClient[k.Client]; q != nil && !keepsBefore(p, q, now) {
			continue
		}
		byClient[k.Client] = p
	}
	clients := make([]string, 0, len(byClient))
	for client := range byClient {
		clients = append(clients, client)
	}
	slices.SortFunc(clients, func(a, b string) int {
		if keepsBefore(byClient[a], byClient[b], now) {
			return -1
		}
		if keepsBefore(byClient[b], byClient[a], now) {
			return 1
		}
		return 0
	})
	for _, client := range clients[:min(len(clients), c.l.KnownMax)] {
		c.known[client] = byClient[client]
	}
}

// keepsBefore says whether a full table would keep p before q: the reverse of
// evict's order (a known client first, the one known longest; then the one
// whose day started last).
func keepsBefore(p, q *payer, now time.Time) bool {
	pk, qk := now.Before(p.knownUntil), now.Before(q.knownUntil)
	if pk != qk {
		return pk
	}
	if pk {
		return p.knownUntil.After(q.knownUntil)
	}
	return p.since.After(q.since)
}
