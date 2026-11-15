package main

import (
	"bytes"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMetaCommands(t *testing.T) {
	db := filepath.Join(t.TempDir(), "cardd.db")
	var out bytes.Buffer
	if err := run([]string{"meta", "set", "-db", db, "vm.id", "1001"}, &out); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"meta", "set", "-db", db, "mailtm.address", "abc123def456@example.com"}, &out); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := run([]string{"meta", "get", "-db", db, "vm.id"}, &out); err != nil || out.String() != "1001\n" {
		t.Fatalf("get: %q %v", out.String(), err)
	}
	out.Reset()
	run([]string{"meta", "list", "-db", db}, &out)
	if out.String() != "mailtm.address\tabc123def456@example.com\nvm.id\t1001\n" {
		t.Fatalf("list: %q", out.String())
	}
	if err := run([]string{"meta", "get", "-db", db, "nope"}, &out); err == nil {
		t.Fatal("missing key: no error")
	}
	if err := run([]string{"meta", "set", "-db", db, "Bad Key", "x"}, &out); err == nil {
		t.Fatal("bad key accepted")
	}
	if err := run([]string{"meta", "set", "-db", db, "only.key"}, &out); err == nil {
		t.Fatal("missing value accepted")
	}
}

// Flags fall back to CARDD_* environment variables, so the container needs
// no command-line arguments and `cardd-ctl` commands find the database.
func TestEnvDefaults(t *testing.T) {
	db := filepath.Join(t.TempDir(), "env.db")
	t.Setenv("CARDD_DB", db)
	var out bytes.Buffer
	if err := run([]string{"meta", "set", "vm.id", "7"}, &out); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(db); err != nil {
		t.Fatalf("CARDD_DB not used: %v", err)
	}
}

func TestKeyfileWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "issuer.key")
	const key = "866a12e42e31a09aa8ca4f25a02e999e"
	write := func(stdin string) error {
		return runWithStdin([]string{"keyfile", "write", "-path", path}, strings.NewReader(stdin), &bytes.Buffer{})
	}
	if err := write(key + "\n"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("file mode: %v %v", info, err)
	}
	if got, _ := os.ReadFile(path); string(got) != key+"\n" {
		t.Fatalf("content %q", got)
	}
	if err := write(strings.ToUpper(key)); err != nil {
		t.Fatalf("same key again (any case): %v", err)
	}
	err = write("00000000000000000000000000000001")
	if err == nil || !strings.Contains(err.Error(), "refusing to replace") {
		t.Fatalf("different key: got %v", err)
	}
	// install.sh issuer-key passes this through: 3 means "a different key is
	// already there" (wrong phrase), anything else is worth a retry.
	if code := exitCode(err); code != 3 {
		t.Fatalf("exit code for a different key = %d, want 3", code)
	}
	if code := exitCode(errors.New("docker hiccup")); code != 1 {
		t.Fatalf("exit code for other errors = %d, want 1", code)
	}
	if got, _ := os.ReadFile(path); string(got) != key+"\n" {
		t.Fatalf("key was replaced: %q", got)
	}
	for _, bad := range []string{"", "866a", strings.Repeat("z", 32)} {
		p := filepath.Join(dir, "bad.key")
		if err := runWithStdin([]string{"keyfile", "write", "-path", p}, strings.NewReader(bad), &bytes.Buffer{}); err == nil {
			t.Errorf("accepted %q", bad)
		}
		if _, err := os.Stat(p); err == nil {
			t.Errorf("wrote a file for %q", bad)
		}
	}
}

func TestServerTimeouts(t *testing.T) {
	srv := newHTTPServer(":0", http.NotFoundHandler())
	if srv.ReadHeaderTimeout == 0 || srv.ReadTimeout == 0 || srv.WriteTimeout == 0 || srv.IdleTimeout == 0 {
		t.Fatalf("missing timeouts: %+v", srv)
	}
}

func TestHealthcheckCommand(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"ok":true}`)) })
	go http.Serve(ln, mux)
	if err := run([]string{"healthcheck", "-addr", ln.Addr().String()}, &bytes.Buffer{}); err != nil {
		t.Fatalf("healthy server: %v", err)
	}
	ln.Close()
	time.Sleep(10 * time.Millisecond)
	if err := run([]string{"healthcheck", "-addr", ln.Addr().String()}, &bytes.Buffer{}); err == nil {
		t.Fatal("closed server reported healthy")
	}
}
