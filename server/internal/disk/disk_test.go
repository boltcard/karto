package disk

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/boltcard/karto/server/internal/alerts"
	"github.com/boltcard/karto/server/internal/store"
)

func TestNextLevel(t *testing.T) {
	for _, c := range []struct {
		prev Level
		free int64
		want Level
	}{
		{None, 2_000_000_000, None},
		{None, 1_999_999_999, Low},
		{Low, 2_100_000_000, Low}, // held until 10 % above: no flicker at the threshold
		{Low, 2_200_000_000, None},
		{Low, 499_999_999, Critical},
		{None, 499_999_999, Critical},
		{Critical, 540_000_000, Critical},
		{Critical, 550_000_000, Low},
		{Critical, 2_100_000_000, Low},
		{Critical, 2_300_000_000, None},
	} {
		if got := NextLevel(c.prev, c.free); got != c.want {
			t.Errorf("NextLevel(%q, %d) = %q, want %q", c.prev, c.free, got, c.want)
		}
	}
}

func write(t *testing.T, path string, n int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, n), 0o644); err != nil {
		t.Fatal(err)
	}
}

// What a rebuild deletes: phoenixd's volume but its seed, and the snapshots.
func TestFreeable(t *testing.T) {
	dir := t.TempDir()
	phoenix, backups := filepath.Join(dir, "phoenix"), filepath.Join(dir, "backups")
	write(t, filepath.Join(phoenix, "phoenix.mainnet.sqlite"), 300)
	write(t, filepath.Join(phoenix, "seed.dat"), 12)
	write(t, filepath.Join(backups, "a.bak"), 100)
	if got, err := Freeable(phoenix, backups); err != nil || got != 400 {
		t.Fatalf("Freeable = %d, %v; want 400", got, err)
	}
	if got, err := Freeable(phoenix, filepath.Join(dir, "none")); err != nil || got != 300 {
		t.Fatalf("Freeable with no backups = %d, %v; want 300", got, err)
	}
}

// fakeMeta is the store's meta: a missing key is store.ErrNotFound, as the store's.
type fakeMeta struct {
	mu   sync.Mutex
	kv   map[string]string
	fail bool // SetMetas fails, as on a full disk
}

func (f *fakeMeta) GetMeta(_ context.Context, key string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	v, ok := f.kv[key]
	if !ok {
		return "", store.ErrNotFound
	}
	return v, nil
}

func (f *fakeMeta) SetMetas(_ context.Context, kv map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return errors.New("database or disk is full")
	}
	for k, v := range kv {
		f.kv[k] = v
	}
	return nil
}

type sent struct {
	p   alerts.Payload
	urg alerts.Urgency
}

// fakeSender records each alert with its urgency; full: its queue takes none.
type fakeSender struct {
	calls []sent
	full  bool
}

func (f *fakeSender) Send(p alerts.Payload, urg alerts.Urgency) bool {
	f.calls = append(f.calls, sent{p, urg})
	return !f.full
}

// world is a Monitor over an empty phoenix and backups dir, its disk's free
// bytes set by the test, at a clock the test moves.
type world struct {
	m       *Monitor
	meta    *fakeMeta
	sender  *fakeSender
	free    int64
	statErr error
	now     time.Time
}

const total = 10_700_000_000

func newWorld(t *testing.T) *world {
	t.Helper()
	dir := t.TempDir()
	w := &world{meta: &fakeMeta{kv: map[string]string{}}, sender: &fakeSender{}, free: 5_000_000_000,
		now: time.Date(2026, 11, 23, 10, 0, 0, 0, time.UTC)}
	w.m = &Monitor{DataDir: dir, PhoenixDir: filepath.Join(dir, "phoenix"), BackupsDir: filepath.Join(dir, "backups"),
		Stat: func(string) (int64, int64, error) {
			if w.statErr != nil {
				return 0, 0, w.statErr
			}
			return w.free, total, nil
		},
		Store: w.meta, Alerts: w.sender, Now: func() time.Time { return w.now }, Log: log.New(io.Discard, "", 0)}
	return w
}

func (w *world) check(at time.Time, free int64) {
	w.now, w.free = at, free
	w.m.Check(context.Background())
}

func day(d, hh, mm int) time.Time { return time.Date(2026, 11, 23+d, hh, mm, 0, 0, time.UTC) }

func TestCheckStatErrorKeepsTheLastReading(t *testing.T) {
	w := newWorld(t)
	w.statErr = errors.New("statfs: no such file")
	w.m.Check(context.Background())
	if _, ok := w.m.Reading(); ok {
		t.Fatal("a reading before any good statfs")
	}
	if len(w.sender.calls) != 0 {
		t.Fatalf("alerts with no reading: %v", w.sender.calls)
	}
	w.statErr = nil
	w.check(day(0, 10, 0), 1_500_000_000)
	w.statErr = errors.New("statfs: input/output error")
	w.check(day(0, 11, 0), 100)
	r, ok := w.m.Reading()
	if !ok || r.FreeBytes != 1_500_000_000 || r.TotalBytes != total || r.Level != Low {
		t.Fatalf("Reading after an error = %+v, %v; want the last good one", r, ok)
	}
}

func TestRebuildHelps(t *testing.T) {
	w := newWorld(t)
	write(t, filepath.Join(w.m.PhoenixDir, "phoenix.mainnet.sqlite"), 1000)
	// Freeable is the files' size: the test sets free so that free + 1,000 B lands either side of 2.2 GB.
	w.check(day(0, 10, 0), 2_200_000_000-1001)
	if r, _ := w.m.Reading(); !r.FreeableKnown || r.FreeableBytes != 1000 || r.RebuildHelps {
		t.Fatalf("just under: %+v; want freeable 1000 and no help", r)
	}
	w.check(day(0, 11, 0), 2_200_000_000-1000)
	if r, _ := w.m.Reading(); !r.RebuildHelps {
		t.Fatalf("at 2.2 GB with the rebuild: %+v; want it to help", r)
	}
}

func TestFreeableUnknownWhenTheWalkFails(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads any directory")
	}
	w := newWorld(t)
	// A directory cardd's user can't read (phoenixd's volume is another user's): the walk fails.
	write(t, filepath.Join(w.m.PhoenixDir, "sub", "x"), 10)
	if err := os.Chmod(filepath.Join(w.m.PhoenixDir, "sub"), 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(filepath.Join(w.m.PhoenixDir, "sub"), 0o755) })
	w.check(day(0, 10, 0), 1_500_000_000)
	if r, ok := w.m.Reading(); !ok || r.FreeableKnown || r.RebuildHelps || r.Level != Low {
		t.Fatalf("Reading = %+v, %v; want low with freeable unknown", r, ok)
	}
}

func TestLowAlertOncePerLocalDayFrom9(t *testing.T) {
	w := newWorld(t)
	w.meta.kv["hosting.utc_offset_min"] = "60"
	w.check(day(0, 7, 30), 1_400_000_000) // 08:30 local
	if len(w.sender.calls) != 0 {
		t.Fatalf("before 09:00 local: %v", w.sender.calls)
	}
	w.check(day(0, 8, 5), 1_400_000_000) // 09:05 local
	if len(w.sender.calls) != 1 {
		t.Fatalf("at 09:05 local: %d alerts, want 1", len(w.sender.calls))
	}
	if c := w.sender.calls[0]; c.urg != alerts.UrgencyNormal || c.p.Kind != "disk" || c.p.Level != "low" || c.p.FreeBytes != 1_400_000_000 || c.p.TotalBytes != total || c.p.Tag != "disk-low" {
		t.Fatalf("low alert = %+v", c)
	}
	if w.meta.kv["disk.low_alert_day"] != "2026-11-23" {
		t.Fatalf("low day kept = %q", w.meta.kv["disk.low_alert_day"])
	}
	w.check(day(0, 10, 0), 1_400_000_000)
	if len(w.sender.calls) != 1 {
		t.Fatalf("again the same day: %d alerts", len(w.sender.calls))
	}
	w.check(day(1, 8, 0), 1_400_000_000) // the next day, 09:00 local
	if len(w.sender.calls) != 2 {
		t.Fatalf("the next day: %d alerts, want 2", len(w.sender.calls))
	}
}

func TestNoOffsetUsesUTC(t *testing.T) {
	w := newWorld(t)
	w.check(day(0, 8, 30), 1_400_000_000)
	if len(w.sender.calls) != 0 {
		t.Fatalf("08:30 UTC with no offset: %v", w.sender.calls)
	}
	w.check(day(0, 9, 0), 1_400_000_000)
	if len(w.sender.calls) != 1 {
		t.Fatalf("09:00 UTC with no offset: %d alerts, want 1", len(w.sender.calls))
	}
}

func TestCriticalAlertAtOnceThenEvery6h(t *testing.T) {
	w := newWorld(t)
	w.check(day(0, 10, 0), 1_400_000_000) // low, sent
	w.check(day(0, 11, 0), 400_000_000)   // critical: at once, though low went today
	if len(w.sender.calls) != 2 || w.sender.calls[1].urg != alerts.UrgencyHigh || w.sender.calls[1].p.Level != "critical" {
		t.Fatalf("after critical: %+v", w.sender.calls)
	}
	w.check(day(0, 13, 0), 400_000_000)
	if len(w.sender.calls) != 2 {
		t.Fatalf("2 h later: %d alerts, want 2", len(w.sender.calls))
	}
	w.check(day(0, 17, 0), 400_000_000)
	if len(w.sender.calls) != 3 {
		t.Fatalf("6 h later: %d alerts, want 3", len(w.sender.calls))
	}
	w.check(day(0, 18, 0), 600_000_000) // back to low the same day: no new low
	if len(w.sender.calls) != 3 {
		t.Fatalf("back to low that day: %d alerts, want 3", len(w.sender.calls))
	}
}

// A critical alert sent before any low that day stands for the day's low too.
func TestCriticalFirstCountsAsTheDaysLow(t *testing.T) {
	w := newWorld(t)
	w.check(day(0, 2, 0), 400_000_000) // critical at 02:00: sent at any hour
	if len(w.sender.calls) != 1 {
		t.Fatalf("critical at 02:00: %d alerts, want 1", len(w.sender.calls))
	}
	w.check(day(0, 10, 0), 600_000_000)
	if len(w.sender.calls) != 1 {
		t.Fatalf("low after a critical that day: %d alerts, want 1", len(w.sender.calls))
	}
}

func TestAlertNotKeptWhenQueueFull(t *testing.T) {
	w := newWorld(t)
	w.sender.full = true
	w.check(day(0, 10, 0), 1_400_000_000)
	if _, ok := w.meta.kv["disk.low_alert_day"]; ok {
		t.Fatal("day kept though the queue refused it")
	}
	w.sender.full = false
	w.check(day(0, 11, 0), 1_400_000_000)
	if len(w.sender.calls) != 2 || w.meta.kv["disk.low_alert_day"] != "2026-11-23" {
		t.Fatalf("after the queue frees: %d calls, day %q", len(w.sender.calls), w.meta.kv["disk.low_alert_day"])
	}
}

// On a full disk the meta write fails too: the Monitor's own memory stops an hourly repeat.
func TestCriticalNotRepeatedHourlyWhenMetaCantBeWritten(t *testing.T) {
	w := newWorld(t)
	w.meta.fail = true
	w.check(day(0, 10, 0), 100_000_000)
	w.check(day(0, 11, 0), 100_000_000)
	if len(w.sender.calls) != 1 {
		t.Fatalf("with meta unwritable: %d alerts in two hours, want 1", len(w.sender.calls))
	}
}

func TestNoAlertWithRoom(t *testing.T) {
	w := newWorld(t)
	w.check(day(0, 10, 0), 5_000_000_000)
	if len(w.sender.calls) != 0 {
		t.Fatalf("alerts with 5 GB free: %v", w.sender.calls)
	}
	if r, ok := w.m.Reading(); !ok || r.Level != None {
		t.Fatalf("Reading = %+v, %v", r, ok)
	}
}

// The hourly tick lands a little early or late: the sixth hour's critical alert still goes.
func TestCriticalRepeatsOnTheSixthHourlyTick(t *testing.T) {
	w := newWorld(t)
	w.check(day(0, 10, 0).Add(500*time.Millisecond), 400_000_000)
	w.check(day(0, 16, 0), 400_000_000) // 6 h less half a second later
	if len(w.sender.calls) != 2 {
		t.Fatalf("on the sixth tick: %d alerts, want 2", len(w.sender.calls))
	}
}

// goneFS lists a file that is gone by the time it is looked at, as a snapshot's temp file renamed mid-walk.
type goneFS struct{ fstest.MapFS }

type goneEntry struct{ fs.DirEntry }

func (goneEntry) Info() (fs.FileInfo, error) { return nil, fs.ErrNotExist }

func (g goneFS) ReadDir(name string) ([]fs.DirEntry, error) {
	es, err := g.MapFS.ReadDir(name)
	for i, e := range es {
		if e.Name() == "snap.tmp" {
			es[i] = goneEntry{e}
		}
	}
	return es, err
}

func TestFreeableSkipsAFileGoneMidWalk(t *testing.T) {
	fsys := goneFS{fstest.MapFS{"a.bak": {Data: make([]byte, 100)}, "snap.tmp": {Data: make([]byte, 50)}}}
	if got, err := freeableIn(fsys); err != nil || got != 100 {
		t.Fatalf("freeableIn = %d, %v; want 100 (the gone file skipped)", got, err)
	}
}
