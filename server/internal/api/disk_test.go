package api

import (
	"reflect"
	"testing"

	"github.com/boltcard/karto/server/internal/disk"
)

type fakeDisk struct {
	r  disk.Reading
	ok bool
}

func (f fakeDisk) Reading() (disk.Reading, bool) { return f.r, f.ok }

// The wallet says when the server's disk is nearly full: GET /api/v1/server carries disk once there is a reading.
func TestServerAnswerCarriesTheDisk(t *testing.T) {
	w := moneySetup(t)
	if _, out := w.do("GET", "/api/v1/server", nil); hasKey(out, "disk") {
		t.Fatalf("no monitor: %v", out)
	}
	w.money.Disk = fakeDisk{}
	if _, out := w.do("GET", "/api/v1/server", nil); hasKey(out, "disk") {
		t.Fatalf("no reading yet: %v", out)
	}
	w.money.Disk = fakeDisk{disk.Reading{FreeBytes: 1_400_000_000, TotalBytes: 10_700_000_000, FreeableBytes: 3_000_000_000,
		FreeableKnown: true, RebuildHelps: true, Level: disk.Low}, true}
	_, out := w.do("GET", "/api/v1/server", nil)
	want := map[string]any{"freeBytes": 1.4e9, "totalBytes": 1.07e10, "freeableBytes": 3e9, "rebuildHelps": true, "level": "low"}
	if !reflect.DeepEqual(out["disk"], want) {
		t.Fatalf("disk = %v, want %v", out["disk"], want)
	}
	// No level, and what a rebuild frees unknown: both left out.
	w.money.Disk = fakeDisk{disk.Reading{FreeBytes: 5e9, TotalBytes: 10_700_000_000}, true}
	_, out = w.do("GET", "/api/v1/server", nil)
	if want := map[string]any{"freeBytes": 5e9, "totalBytes": 1.07e10}; !reflect.DeepEqual(out["disk"], want) {
		t.Fatalf("disk = %v, want %v", out["disk"], want)
	}
}
