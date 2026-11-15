package alerts

import (
	"fmt"
	"sync"
	"time"
)

// Refusal alerts are limited per card: within 60 seconds of a
// refusal alert, further refusals update that notification instead of
// adding one; after 3 alerts in an hour, the rest of the hour comes as one
// summary at its end. Kept in memory only: a restart forgets it.
const (
	foldWindow    = 60 * time.Second
	alertsPerHour = 3
)

// fold is one card's refusals: the notification open for updates, the hour
// of alerts it is in, and the refusals held back for the hour's summary.
type fold struct {
	windowStart time.Time // when the open notification began: its tag
	windowEnd   time.Time // it takes updates until then
	hourEnd     time.Time // the end of the hour counted by alerts; zero for none
	alerts      int       // notifications started this hour
	count       int       // refusals in the open notification
	last        Refusal   // the latest of them
	held        int       // refusals held back for the summary
	heldLast    Refusal
	queued      bool // the open notification waits in the queue to be sent
	gen         int  // how many times the open notification was taken to send
}

// windowTag is the phone's notification tag for a card's refusals in the
// window that began at start; hourTag the hour's summary's, its own.
func windowTag(cardID string, start time.Time) string {
	return fmt.Sprintf("refused-%s-%d", cardID, start.Unix())
}

func hourTag(cardID string, end time.Time) string {
	return fmt.Sprintf("refused-%s-hour-%d", cardID, end.Unix())
}

// folds are every card's, under one lock taken briefly: Refused calls in
// from a terminal's request and must never wait.
type folds struct {
	mu    sync.Mutex
	cards map[string]*fold
}

// add counts a refusal. queue: the card's notification must be sent (it
// wasn't already waiting to be, so a pair at once sends one, counting
// both). summaryAt, when not zero, is when the hour's summary is due: the
// first refusal held back sets it.
func (f *folds) add(r Refusal) (queue bool, summaryAt time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cards == nil {
		f.cards = map[string]*fold{}
	}
	c := f.cards[r.CardID]
	if c == nil {
		c = &fold{}
		f.cards[r.CardID] = c
	}
	t := r.At
	if c.held == 0 && !c.hourEnd.IsZero() && !t.Before(c.hourEnd) {
		*c = fold{queued: c.queued} // the hour is over: start counting again
	}
	switch {
	case c.held > 0: // the summary is due; it counts this one too
		c.held++
		c.heldLast = r
		return false, time.Time{}
	case t.Before(c.windowEnd):
		c.count++
		c.last = r
	case c.alerts < alertsPerHour:
		if c.hourEnd.IsZero() {
			c.hourEnd = t.Add(time.Hour)
		}
		c.alerts++
		c.windowStart = t
		c.windowEnd = t.Add(foldWindow)
		c.count = 1
		c.last = r
	default:
		c.held = 1
		c.heldLast = r
		return false, c.hourEnd
	}
	if c.queued {
		return false, time.Time{}
	}
	c.queued = true
	return true, time.Time{}
}

// unqueue undoes add's queue when the queue had no room, so the next
// refusal tries again.
func (f *folds) unqueue(cardID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c := f.cards[cardID]; c != nil {
		c.queued = false
	}
}

// taken is a card's notification as taken to send.
type taken struct {
	last   Refusal
	count  int
	tag    string
	update bool // a later count of a notification already sent
	gen    int  // the open notification's generation; 0 for a summary
}

// take is what the card's open notification says now. False when nothing
// waits.
func (f *folds) take(cardID string) (taken, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.cards[cardID]
	if c == nil || !c.queued {
		return taken{}, false
	}
	c.queued = false
	c.gen++
	return taken{c.last, c.count, windowTag(cardID, c.windowStart), c.count > 1, c.gen}, true
}

// superseded says whether a newer count of the notification tagged tag than
// generation gen was taken to send since: a retry of gen is then dropped.
func (f *folds) superseded(cardID, tag string, gen int) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.cards[cardID]
	return gen > 0 && c != nil && windowTag(cardID, c.windowStart) == tag && c.gen > gen
}

// summary is the hour's summary, its count the refusals held back, and
// forgets the card's hour, so its next refusal is alerted at once. False
// when none were held.
func (f *folds) summary(cardID string) (taken, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.cards[cardID]
	if c == nil || c.held == 0 {
		return taken{}, false
	}
	t := taken{last: c.heldLast, count: c.held, tag: hourTag(cardID, c.hourEnd)}
	delete(f.cards, cardID)
	return t, true
}
