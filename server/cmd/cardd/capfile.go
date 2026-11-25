package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/boltcard/karto/server/internal/lnurl"
)

// shutdownWait is how long serve lets requests finish when it stops; held
// reads (a till waiting for a tap) don't, and are cut. The compose file gives
// cardd 30 s to stop, so the jobs and the save have the rest.
const shutdownWait = 3 * time.Second

// serve listens on s's two addresses, reads the unpaid cap's saved state,
// and serves until ctx ends or a listener fails. Then it lets requests
// finish (shutdownWait), stops the background jobs and waits for them, and
// saves the cap's state for the next start. An address it can't listen on
// ends it before the state is read, so a failed start keeps it.
func (s *server) serve(ctx context.Context, out io.Writer) error {
	pubL, err := net.Listen("tcp", s.addr)
	if err != nil {
		return err
	}
	hookL, err := net.Listen("tcp", s.webhookAddr)
	if err != nil {
		pubL.Close()
		return err
	}
	s.pubAddr, s.hookAddr = pubL.Addr(), hookL.Addr()
	loadCap(s.unpaid, s.capFile, s.log)

	// Not ctx's child: the jobs (the ledger's checks, the alert sender) carry
	// on until the requests have finished, and stop at stopRun below.
	runCtx, stopRun := context.WithCancel(context.Background())
	defer stopRun()
	ran := make(chan struct{})
	go func() {
		defer close(ran)
		s.run(runCtx)
	}()
	// The webhook port is only for phoenixd, inside the compose network;
	// Caddy proxies the public one.
	pub, hook := newHTTPServer(s.addr, s.public), newHTTPServer(s.webhookAddr, s.webhook)
	errs := make(chan error, 2)
	go func() { errs <- hook.Serve(hookL) }()
	go func() { errs <- pub.Serve(pubL) }()
	fmt.Fprintf(out, "cardd %s listening on %s (phoenixd webhook on %s)\n", version, s.addr, s.webhookAddr)
	close(s.ready)

	select {
	case <-ctx.Done():
		err = nil
	case err = <-errs:
	}
	wait, cancel := context.WithTimeout(context.Background(), shutdownWait)
	pub.Shutdown(wait)
	hook.Shutdown(wait)
	cancel()
	pub.Close()
	hook.Close()
	stopRun()
	<-ran
	if e := saveCap(s.unpaid, s.capFile); e != nil {
		s.log.Printf("unpaid cap: not saved: %v", e)
	}
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return err
}

// saveCap writes c's state to path, readable by cardd alone, through a temp
// file renamed into place once on disk.
func saveCap(c *lnurl.UnpaidCap, path string) error {
	tmp := path + ".tmp"
	os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if err := c.Save(f); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// loadCap reads the state saveCap wrote into c and deletes it, whether or
// not it could be read: payers' addresses stay on disk only while cardd is
// down. A temp file a killed save left goes too. One that can't be read is
// said in a line that holds nothing of it, and c starts empty.
func loadCap(c *lnurl.UnpaidCap, path string, logger *log.Logger) {
	os.Remove(path + ".tmp")
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err == nil {
		err = c.Load(f)
		f.Close()
	}
	if rmErr := os.Remove(path); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) {
		logger.Printf("unpaid cap: the saved state isn't deleted: %v", rmErr)
	}
	if err != nil {
		logger.Printf("unpaid cap: the saved state isn't used: %s", saidErr(err))
	}
}

// saidErr is what of a load's error may be logged: its kind, not the file's words.
func saidErr(err error) string {
	var pe *fs.PathError
	if errors.As(err, &pe) { // the path and why: nothing of the contents
		return err.Error()
	}
	return "it isn't a saved state this cardd reads"
}
