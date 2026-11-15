package api

import (
	"strings"
	"testing"
)

// Send out's Recent list.

func recentOf(t *testing.T, w *moneyWorld) []any {
	t.Helper()
	status, out := w.do("GET", "/api/v1/send/recent", nil)
	if status != 200 {
		t.Fatalf("GET recent: %d %v", status, out)
	}
	list, ok := out["recent"].([]any)
	if !ok {
		t.Fatalf("recent is not a list: %v", out)
	}
	return list
}

func TestRecentEmpty(t *testing.T) {
	w := moneySetup(t)
	if list := recentOf(t, w); len(list) != 0 {
		t.Fatalf("recent: %v", list)
	}
}

func TestRecentAfterASendToAnAddress(t *testing.T) {
	w := moneySetup(t)
	if status, out := w.do("POST", "/api/v1/send", map[string]any{"id": "s", "to": "alice@pay.example.com", "amountMsat": 2_000_000}); status != 200 {
		t.Fatalf("send: %d %v", status, out)
	}
	list := recentOf(t, w)
	if len(list) != 1 {
		t.Fatalf("recent: %v", list)
	}
	e := list[0].(map[string]any)
	if e["to"] != "alice@pay.example.com" || e["shown"] != "alice@pay.example.com" {
		t.Fatalf("entry: %v", e)
	}
	if at, ok := e["paidAt"].(float64); !ok || at <= 0 {
		t.Fatalf("paidAt: %v", e)
	}
}

func TestRecentRemove(t *testing.T) {
	w := moneySetup(t)
	w.do("POST", "/api/v1/send", map[string]any{"id": "s", "to": "alice@pay.example.com", "amountMsat": 2_000_000})
	if status, out := w.do("DELETE", "/api/v1/send/recent", map[string]any{"to": "alice@pay.example.com"}); status != 204 {
		t.Fatalf("DELETE: %d %v", status, out)
	}
	if list := recentOf(t, w); len(list) != 0 {
		t.Fatalf("recent after removing: %v", list)
	}
}

func TestRecentRemoveMalformed(t *testing.T) {
	w := moneySetup(t)
	for _, body := range []map[string]any{{}, {"to": "  "}, {"to": strings.Repeat("a", 2001)}} {
		if status, out := w.do("DELETE", "/api/v1/send/recent", body); status != 400 || out["error"] != "malformed" {
			t.Fatalf("%v: %d %v", body, status, out)
		}
	}
}
