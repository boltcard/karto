package api

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/store"
)

// A top-up's payer's note in the API: payerNote on history and on a
// line, absent when there is none, never set by the person's PATCH.

// noted credits pool with a payer's note, as a paid LNURL-pay invoice would.
func (w *moneyWorld) noted(ref, note string, msat int64) {
	w.t.Helper()
	ctx := context.Background()
	if err := w.st.SaveTopupNote(ctx, ref, note); err != nil {
		w.t.Fatal(err)
	}
	if done, err := w.st.CreditMoving(ctx, store.Pool, msat, 0, ref, "received", store.FeeCreditMove{}); !done || err != nil {
		w.t.Fatalf("credit: %v %v", done, err)
	}
}

func newestOf(w *moneyWorld, acct string) map[string]any {
	w.t.Helper()
	_, out := w.do("GET", "/api/v1/accounts/"+acct+"/history?limit=1", nil)
	return out["transactions"].([]any)[0].(map[string]any)
}

func TestALinesPayerNoteInTheAPI(t *testing.T) {
	w := moneySetup(t)
	old := newestOf(w, "pool")
	if hasKey(old, "payerNote") {
		t.Fatalf("a line with no payer's note: %v", old)
	}
	w.noted("h1", "thanks for the talk", 2_000_000)
	tx := newestOf(w, "pool")
	if tx["payerNote"] != "thanks for the talk" {
		t.Fatalf("history: %v", tx)
	}
	_, line := w.do("GET", fmt.Sprintf("/api/v1/accounts/pool/transactions/%d", int64(tx["id"].(float64))), nil)
	if line["payerNote"] != "thanks for the talk" {
		t.Fatalf("line: %v", line)
	}
}

func TestThePersonsNoteLeavesThePayersAlone(t *testing.T) {
	w := moneySetup(t)
	w.noted("h1", "refund, order 1043", 2_000_000)
	path := fmt.Sprintf("/api/v1/accounts/pool/transactions/%d", int64(newestOf(w, "pool")["id"].(float64)))
	status, out := w.do("PATCH", path, map[string]any{"comment": "from the meetup"})
	if status != 200 || out["comment"] != "from the meetup" || out["payerNote"] != "refund, order 1043" {
		t.Fatalf("PATCH: %d %v", status, out)
	}
	if status, out := w.do("PATCH", path, map[string]any{"comment": "x", "payerNote": "y"}); status != 400 || out["error"] != "malformed" {
		t.Fatalf("PATCH with payerNote: %d %v", status, out)
	}
	if _, line := w.do("GET", path, nil); line["payerNote"] != "refund, order 1043" || line["comment"] != "from the meetup" {
		t.Fatalf("after: %v", line)
	}
}

// A held read answered by the credit has the note in its row: no extra
// round trip for it.
func TestAHeldHistoryReadCarriesThePayerNote(t *testing.T) {
	w := moneySetup(t)
	w.money.Bell, w.money.HeldRecheck = NewBell(), 20*time.Second
	w.st.Changed = w.money.Bell.Changed
	first := int64(newestOf(w, "pool")["id"].(float64))
	answer := make(chan map[string]any, 1)
	go func() {
		_, body := w.do("GET", fmt.Sprintf("/api/v1/accounts/pool/history?after=%d&wait=10", first), nil)
		answer <- body
	}()
	time.Sleep(200 * time.Millisecond)
	w.noted("h2", "float for Saturday", 5_000_000)
	select {
	case body := <-answer:
		txs := body["transactions"].([]any)
		if row := txs[0].(map[string]any); row["payerNote"] != "float for Saturday" {
			t.Fatalf("held answer: %v", body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the held read wasn't answered")
	}
}
