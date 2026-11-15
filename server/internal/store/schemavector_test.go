package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func schemaVectorPath() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "testvectors", "schema.json")
}

// testvectors/schema.json is the schema version the app pins, to refuse a
// backup from a newer cardd before restoring it. CARDD_WRITE_SCHEMA=1 writes
// it; every run checks it still matches, so a new migration can't ship
// without the app's pin moving too.
func TestSchemaVector(t *testing.T) {
	if os.Getenv("CARDD_WRITE_SCHEMA") == "1" {
		raw, _ := json.MarshalIndent(map[string]int{"schema": SchemaVersion()}, "", "  ")
		if err := os.WriteFile(schemaVectorPath(), append(raw, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(schemaVectorPath())
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Schema int `json:"schema"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if v.Schema != SchemaVersion() {
		t.Fatalf("testvectors/schema.json says %d, the schema is %d: write it with CARDD_WRITE_SCHEMA=1", v.Schema, SchemaVersion())
	}
}
