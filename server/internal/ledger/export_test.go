package ledger

import "context"

// UnsentGrace is unsentGrace, for the tests outside the package.
const UnsentGrace = unsentGrace

// FillLaterForTest runs fillLater, which Run calls after its first check
// and at every tick.
func (l *Ledger) FillLaterForTest(ctx context.Context) { l.fillLater(ctx) }

// FillingForTest reports whether a fillLater run is under way.
func (l *Ledger) FillingForTest() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.filling
}
