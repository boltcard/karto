package store

import (
	"context"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Recent is one address on Send out's Recent list.
type Recent struct {
	To     string    // what Send out's field gets
	Shown  string    // what the row shows
	PaidAt time.Time // the history line's time (phoenixd's when known), else when cardd settled it
}

// RecentSends lists the addresses Pool's settled sends went to, newest
// payment first: one entry per address (case aside), none the person
// removed since its last payment, none on ownHost, then at most limit.
func (s *Store) RecentSends(ctx context.Context, ownHost string, limit int) ([]Recent, error) {
	removed := map[string]int64{}
	rows, err := s.db.QueryContext(ctx, `SELECT target, removed_at FROM recent_removed`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var k string
		var at int64
		if err := rows.Scan(&k, &at); err != nil {
			rows.Close()
			return nil, err
		}
		removed[k] = at
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.db.QueryContext(ctx, `SELECT h.destination, h.description, h.offer, h.resolved_at, COALESCE(t.created_at, h.resolved_at)
		FROM holds h LEFT JOIN ledger_tx t ON t.id = h.tx_id
		WHERE h.account = ? AND h.kind = ? AND h.state = 'settled' AND (h.destination != '' OR h.offer != '')`, Pool, KindSend)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type entry struct {
		Recent
		resolved int64
	}
	byKey := map[string]*entry{}
	for rows.Next() {
		var dest, desc, offer string
		var resolved, paid int64
		if err := rows.Scan(&dest, &desc, &offer, &resolved, &paid); err != nil {
			return nil, err
		}
		to, shown := recentEntry(dest, desc, offer)
		key := strings.ToLower(to)
		e := byKey[key]
		if e == nil {
			e = &entry{resolved: resolved}
			byKey[key] = e
		}
		e.resolved = max(e.resolved, resolved)
		if e.To == "" || paid > e.PaidAt.Unix() {
			e.To, e.Shown, e.PaidAt = to, shown, time.Unix(paid, 0)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var out []entry
	for key, e := range byKey {
		if at, ok := removed[key]; ok && at >= e.resolved {
			continue
		}
		if onHost(e.To, ownHost) {
			continue
		}
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].PaidAt.Equal(out[j].PaidAt) {
			return out[i].PaidAt.After(out[j].PaidAt)
		}
		return out[i].resolved > out[j].resolved
	})
	list := []Recent{}
	for _, e := range out {
		if len(list) == limit {
			break
		}
		list = append(list, e.Recent)
	}
	return list, nil
}

// RemoveRecent takes to off the Recent list until it is paid again.
func (s *Store) RemoveRecent(ctx context.Context, to string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO recent_removed (target, removed_at) VALUES (?, ?)
		ON CONFLICT (target) DO UPDATE SET removed_at = excluded.removed_at`, strings.ToLower(strings.TrimSpace(to)), s.now().Unix())
	return err
}

// recentEntry is what a send's hold gives the list: a ₿ name's
// offer is the name without its ₿ (looked up afresh each time, and still
// falling back to LNURL as when it was typed plain); any other offer is the
// offer itself (its destination is only a label); else the address or link.
// A raw offer's destination may be its own description (api's
// offerDestination), text the offer's maker chose: one equal to the
// description is never taken for a name, however it looks.
func recentEntry(dest, desc, offer string) (to, shown string) {
	if offer == "" {
		return dest, dest
	}
	if name, ok := bitcoinName(dest); ok && dest != desc {
		return name, dest
	}
	return offer, shortOffer(offer)
}

// bitcoinName reads "₿user@domain" as sendto.ParseName's rule does, loosely
// (a name, an @, a domain with a dot), so an offer's description that only
// starts with ₿ isn't taken for one. Not sendto itself: store would then
// depend on phoenixd's client.
func bitcoinName(d string) (string, bool) {
	rest, ok := strings.CutPrefix(d, "₿")
	if !ok {
		return "", false
	}
	user, domain, ok := strings.Cut(rest, "@")
	if !ok || user == "" || strings.ContainsAny(rest, " \t") || !strings.Contains(domain, ".") || strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") {
		return "", false
	}
	return rest, true
}

// shortOffer is an offer as a row shows it: lno1, four characters, …, the last four.
func shortOffer(o string) string {
	rest, ok := strings.CutPrefix(o, "lno1")
	if !ok || len(rest) <= 12 {
		return o
	}
	return "lno1" + rest[:4] + "…" + rest[len(rest)-4:]
}

// onHost reports whether to is on this server's own host (an address or a link).
func onHost(to, ownHost string) bool {
	own := strings.ToLower(ownHost)
	if h, _, ok := strings.Cut(own, ":"); ok {
		own = h
	}
	if own == "" {
		return false
	}
	var host string
	if u, err := url.Parse(to); err == nil && u.Scheme != "" && u.Host != "" {
		host = u.Hostname()
	} else if _, d, ok := strings.Cut(to, "@"); ok {
		host = d
		if h, _, ok := strings.Cut(host, ":"); ok {
			host = h
		}
	}
	return strings.ToLower(host) == own
}
