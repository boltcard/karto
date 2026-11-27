package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/boltcard/karto/server/internal/lnurl"
	"github.com/boltcard/karto/server/internal/phoenixd/phoenixdtest"
)

// servedArgs are serveArgs listening on free ports, and the cap's file beside the database.
func servedArgs(t *testing.T, pdURL string) ([]string, string) {
	t.Helper()
	args := append(serveArgs(t, pdURL), "-addr", "127.0.0.1:0", "-webhook-addr", "127.0.0.1:0")
	return args, filepath.Join(filepath.Dir(args[1]), "unpaid-cap.json")
}

// serving is a cardd serve running until stop, which fails the test unless it ends, without error, within 5 s.
func serving(t *testing.T, args []string) (srv *server, stop func()) {
	t.Helper()
	srv, err := newServer(args)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- srv.serve(ctx, io.Discard) }()
	select {
	case <-srv.ready:
	case err := <-done:
		t.Fatalf("serve ended at its start: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("serve didn't start")
	}
	return srv, func() {
		t.Helper()
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("serve: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("serve didn't stop")
		}
		srv.cleanup()
	}
}

// cardd keeps the unpaid cap's state across a stop and start: in a file beside the database while it is down, read
// and deleted at the start.
func TestServeKeepsTheCapAcrossARestart(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	args, file := servedArgs(t, f.URL)
	srv, stop := serving(t, args)
	resp, err := http.Get("http://" + srv.pubAddr.String() + "/health")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("health: %v %v", resp, err)
	}
	resp.Body.Close()
	const client = "203.0.113.7"
	lane, ok, _ := srv.unpaid.Reserve(client)
	if !ok {
		t.Fatal("no place")
	}
	srv.unpaid.Made(client, lane, "hh")
	srv.unpaid.Paid("hh", 1000)
	stop()

	fi, err := os.Stat(file)
	if err != nil {
		t.Fatalf("not saved: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode().Perm())
	}
	srv, stop = serving(t, args)
	defer stop()
	if _, err := os.Stat(file); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the file is still there while cardd runs: %v", err)
	}
	if lane, ok, _ := srv.unpaid.Reserve(client); !ok || lane != lnurl.KnownLane {
		t.Fatalf("the client isn't known after a restart: %v %v", lane, ok)
	}
}

// A temp file a killed save left behind is removed at the start.
func TestServeRemovesALeftoverTemp(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	args, file := servedArgs(t, f.URL)
	if err := os.WriteFile(file+".tmp", []byte(`{"version":1,"known":[{"client":"203.0.113.9"`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, stop := serving(t, args)
	defer stop()
	if _, err := os.Stat(file + ".tmp"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the temp file is still there: %v", err)
	}
}

// A start that fails before serving leaves the saved state for the next.
func TestServeKeepsTheFileWhenStartFails(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer taken.Close()
	args, file := servedArgs(t, f.URL)
	args = append(args, "-addr", taken.Addr().String())
	if err := os.WriteFile(file, []byte("saved"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv, err := newServer(args)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.cleanup()
	if err := srv.serve(context.Background(), io.Discard); err == nil {
		t.Fatal("served on a taken port")
	}
	if b, err := os.ReadFile(file); err != nil || string(b) != "saved" {
		t.Fatalf("the saved state went: %q %v", b, err)
	}
}

// A file that can't be read is deleted, said in one line that holds nothing of it, and the cap starts empty.
func TestABadCapFileStartsEmpty(t *testing.T) {
	file := filepath.Join(t.TempDir(), "unpaid-cap.json")
	if err := os.WriteFile(file, []byte(`{"version":1,"known":[{"client":"203.0.113.9","sum":"x"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var said bytes.Buffer
	c := lnurl.InvoiceUnpaidCap(time.Now)
	loadCap(c, file, log.New(&said, "", 0))
	if _, err := os.Stat(file); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the bad file is still there: %v", err)
	}
	if n := strings.Count(said.String(), "\n"); n != 1 || strings.Contains(said.String(), "203.0.113") {
		t.Fatalf("said %q", said.String())
	}
	if lane, ok, _ := c.Reserve("203.0.113.9"); !ok || lane != lnurl.StrangerLane {
		t.Fatalf("%v %v", lane, ok)
	}
}

// A save that can't put its file in place leaves no temp file of payers' addresses behind.
func TestAFailedSaveLeavesNoTemp(t *testing.T) {
	file := filepath.Join(t.TempDir(), "unpaid-cap.json")
	if err := os.MkdirAll(filepath.Join(file, "in-the-way"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := saveCap(lnurl.InvoiceUnpaidCap(time.Now), file); err == nil {
		t.Fatal("saved over a directory")
	}
	if _, err := os.Stat(file + ".tmp"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the temp file is still there: %v", err)
	}
}

// The background jobs (the ledger's checks, the alert sender) run on until the requests being served at a stop
// have finished: a ledger check cut short at the signal would pause spending for the taps still in flight.
func TestServeStopsTheJobsAfterTheRequests(t *testing.T) {
	f := phoenixdtest.New()
	defer f.Close()
	args, _ := servedArgs(t, f.URL)
	srv, err := newServer(args)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.cleanup()
	jobs := make(chan context.Context, 1)
	srv.run = func(ctx context.Context) { jobs <- ctx; <-ctx.Done() }
	entered, release := make(chan struct{}), make(chan struct{})
	public := srv.public
	srv.public = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/hold" {
			public.ServeHTTP(w, r)
			return
		}
		close(entered)
		<-release
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- srv.serve(ctx, io.Discard) }()
	<-srv.ready
	runCtx := <-jobs
	go func() {
		if resp, err := http.Get("http://" + srv.pubAddr.String() + "/hold"); err == nil {
			resp.Body.Close()
		}
	}()
	<-entered
	cancel()
	time.Sleep(200 * time.Millisecond)
	if runCtx.Err() != nil {
		t.Error("the jobs stopped while a request was still being served")
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serve didn't stop")
	}
	if runCtx.Err() == nil {
		t.Error("the jobs were not stopped by the end of serve")
	}
}
