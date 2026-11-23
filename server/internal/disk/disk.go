// Package disk watches the free space on the server's disk: cardd's data,
// phoenixd's and the snapshots all sit on the VM's one root filesystem (Docker
// named volumes), and phoenixd keeps a record of every invoice it has made with
// no way to delete them. Under LowBytes free it alerts the owner, under
// CriticalBytes at once and more often; GET /api/v1/server carries the reading
// so the wallet can say so and offer Rebuild server, which leaves phoenixd's
// records behind (deploy/install.sh wipe).
package disk

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/boltcard/karto/server/internal/alerts"
	"github.com/boltcard/karto/server/internal/store"
)

// Level is how full the disk is: None, Low or Critical.
type Level string

const (
	None     Level = ""
	Low      Level = "low"
	Critical Level = "critical"
)

// The levels' thresholds in free bytes (decimal, as the phones show them).
// A level, once reached, holds until free is 10 % above its threshold, so a
// disk hovering at one doesn't flicker the banner or repeat the alert.
const (
	LowBytes      int64 = 2_000_000_000
	CriticalBytes int64 = 500_000_000
)

const (
	// AlertHour is the phone's local hour from which the low alert goes, as hosting's.
	AlertHour = 9
	// CriticalEvery is the least time between two critical alerts while it holds.
	CriticalEvery = 6 * time.Hour
	// Every is how often the disk is looked at.
	Every = time.Hour

	keyOffset     = "hosting.utc_offset_min" // the phone's offset from UTC, minutes (renew keeps it)
	keyLowDay     = "disk.low_alert_day"     // the local day ("YYYY-MM-DD") the last low (or critical) alert was queued
	keyCriticalAt = "disk.critical_alert_at" // unix seconds of the last critical alert queued
)

// releaseAt is a threshold plus 10 %: where a level held lets go.
func releaseAt(threshold int64) int64 { return threshold + threshold/10 }

// NextLevel is the level for free bytes, given the last one (hysteresis).
func NextLevel(prev Level, free int64) Level {
	switch {
	case free < CriticalBytes, prev == Critical && free < releaseAt(CriticalBytes):
		return Critical
	case free < LowBytes, (prev == Low || prev == Critical) && free < releaseAt(LowBytes):
		return Low
	}
	return None
}

// Reading is the disk as last looked at. FreeableBytes is what a rebuild
// deletes (phoenixd's volume but its seed, and the snapshots), known only when
// both could be walked; RebuildHelps says whether free plus that clears the
// low level.
type Reading struct {
	FreeBytes, TotalBytes, FreeableBytes int64
	FreeableKnown, RebuildHelps          bool
	Level                                Level
}

// Freeable is the size of the regular files under phoenixDir and backupsDir,
// seed.dat left out (a rebuild keeps it); a dir that isn't there counts 0.
func Freeable(phoenixDir, backupsDir string) (int64, error) {
	var n int64
	for _, dir := range []string{phoenixDir, backupsDir} {
		err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				if path == dir && errors.Is(err, fs.ErrNotExist) {
					return filepath.SkipDir
				}
				return err
			}
			if !d.Type().IsRegular() || d.Name() == "seed.dat" {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			n += info.Size()
			return nil
		})
		if err != nil {
			return 0, err
		}
	}
	return n, nil
}

// StatFS is the free bytes a non-root process can still write and the
// filesystem's size, for the filesystem holding path.
func StatFS(path string) (free, total int64, err error) {
	var s syscall.Statfs_t
	if err := syscall.Statfs(path, &s); err != nil {
		return 0, 0, err
	}
	return int64(s.Bavail) * int64(s.Bsize), int64(s.Blocks) * int64(s.Bsize), nil
}

// Meta is the slice of the store the monitor keeps its alert times in; an
// unset key is store.ErrNotFound.
type Meta interface {
	GetMeta(ctx context.Context, key string) (string, error)
	SetMetas(ctx context.Context, kv map[string]string) error
}

// Sender queues an alert; false when its queue is full.
type Sender interface {
	Send(p alerts.Payload, urg alerts.Urgency) bool
}

// Monitor looks at the disk each Every and alerts. DataDir is cardd's data
// volume (statfs'd: the VM's root filesystem); PhoenixDir phoenixd's volume
// (mounted read-only) and BackupsDir the snapshots, walked for FreeableBytes.
type Monitor struct {
	DataDir, PhoenixDir, BackupsDir string
	Stat                            func(path string) (free, total int64, err error)
	Store                           Meta
	Alerts                          Sender // nil sends none
	Now                             func() time.Time
	Log                             *log.Logger

	mu   sync.Mutex
	last *Reading
	// The alert times as last queued, beside meta's: on a full disk meta can't
	// be written, and an hourly critical repeat is what this is for not doing.
	lowDay     string
	criticalAt time.Time
}

// Reading is the last good reading; false before the first.
func (m *Monitor) Reading() (Reading, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.last == nil {
		return Reading{}, false
	}
	return *m.last, true
}

// Run checks at once, then each Every, until ctx ends.
func (m *Monitor) Run(ctx context.Context) {
	m.Check(ctx)
	t := time.NewTicker(Every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.Check(ctx)
		}
	}
}

// Check takes one reading and sends the alert it calls for. A statfs error
// keeps the last reading (and sends nothing); a walk error leaves what a
// rebuild frees unknown.
func (m *Monitor) Check(ctx context.Context) {
	free, total, err := m.Stat(m.DataDir)
	if err != nil {
		m.Log.Printf("disk: %v", err)
		return
	}
	m.mu.Lock()
	prev := None
	if m.last != nil {
		prev = m.last.Level
	}
	m.mu.Unlock()
	r := Reading{FreeBytes: free, TotalBytes: total, Level: NextLevel(prev, free)}
	if n, err := Freeable(m.PhoenixDir, m.BackupsDir); err != nil {
		m.Log.Printf("disk: what a rebuild frees: %v", err)
	} else {
		r.FreeableBytes, r.FreeableKnown = n, true
		r.RebuildHelps = free+n >= releaseAt(LowBytes)
	}
	m.mu.Lock()
	m.last = &r
	m.mu.Unlock()
	m.alert(ctx, r)
}

// alert sends low at most once a local day from AlertHour, critical at once and
// then at most each CriticalEvery; a critical one stands for that day's low.
// Times are kept, in meta and here, only once queued.
func (m *Monitor) alert(ctx context.Context, r Reading) {
	if m.Alerts == nil || r.Level == None {
		return
	}
	now := m.Now()
	local := now.UTC().Add(time.Duration(m.offsetMin(ctx)) * time.Minute)
	day := local.Format(time.DateOnly)
	lowDay, criticalAt := m.kept(ctx)
	urg := alerts.UrgencyNormal
	if r.Level == Critical {
		if !criticalAt.IsZero() && now.Sub(criticalAt) < CriticalEvery {
			return
		}
		urg = alerts.UrgencyHigh
	} else if local.Hour() < AlertHour || day == lowDay {
		return
	}
	if !m.Alerts.Send(alerts.DiskLow(r.FreeBytes, r.TotalBytes, string(r.Level), now), urg) {
		m.Log.Printf("alerts: queue full: the disk's alert not sent")
		return
	}
	kv := map[string]string{keyLowDay: day}
	m.mu.Lock()
	m.lowDay = day
	if r.Level == Critical {
		m.criticalAt = now
		kv[keyCriticalAt] = strconv.FormatInt(now.Unix(), 10)
	}
	m.mu.Unlock()
	if err := m.Store.SetMetas(ctx, kv); err != nil {
		m.Log.Printf("disk: keeping the alert's time: %v", err)
	}
}

// kept is the last low day and critical time, the later of meta's and memory's.
func (m *Monitor) kept(ctx context.Context) (string, time.Time) {
	m.mu.Lock()
	lowDay, criticalAt := m.lowDay, m.criticalAt
	m.mu.Unlock()
	if v, err := m.meta(ctx, keyLowDay); err == nil && v > lowDay {
		lowDay = v
	}
	if v, err := m.meta(ctx, keyCriticalAt); err == nil {
		if s, err := strconv.ParseInt(v, 10, 64); err == nil && time.Unix(s, 0).After(criticalAt) {
			criticalAt = time.Unix(s, 0)
		}
	}
	return lowDay, criticalAt
}

// offsetMin is the phone's offset from UTC as renew keeps it; 0 (UTC) when unset or unreadable.
func (m *Monitor) offsetMin(ctx context.Context) int {
	v, err := m.meta(ctx, keyOffset)
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < -720 || n > 840 {
		return 0
	}
	return n
}

// meta reads a key; an unset one is store.ErrNotFound, other errors are logged.
func (m *Monitor) meta(ctx context.Context, key string) (string, error) {
	v, err := m.Store.GetMeta(ctx, key)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		m.Log.Printf("disk: reading %s: %v", key, err)
	}
	return v, err
}
