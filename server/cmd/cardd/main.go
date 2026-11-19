// Command cardd is the Bolt Card server.
//
//	cardd serve -db cardd.db -addr :8080 -host vm-1.lnvps.cloud -issuer-key-file issuer.key \
//	    -phoenixd-url http://phoenixd:9740 -phoenixd-conf /phoenix/phoenix.conf -webhook-addr :8081
//	cardd device add -db cardd.db -pubkey <hex uncompressed P-256> -name "Pixel 8"
//	cardd device revoke -db cardd.db -key-id <id>
//	cardd device revoke-others -db cardd.db -keep <id>
//	cardd device list -db cardd.db
//	cardd meta set|get|list -db cardd.db [key [value]]
//	cardd keyfile write -path issuer.key < key-hex
//	cardd healthcheck -addr :8080
//	cardd ledger reconcile -db cardd.db -phoenixd-url http://phoenixd:9740 -phoenixd-conf /phoenix/phoenix.conf
//	cardd ledger holds -db cardd.db
//	cardd restore -db cardd.db -device <hex public key> -vm-id <id> -vm-host <host> -vm-ipv4 <ipv4> [-from TEXT] < backup.db
//	cardd restore -db cardd.db -device <hex public key> -vm-id <id> -vm-host <host> -vm-ipv4 <ipv4> -fresh
//	cardd backup now -db cardd.db
//
// Every -db, -addr, -host, -issuer-key-file, -phoenixd-url, -phoenixd-conf
// and -webhook-addr flag defaults to the CARDD_DB, CARDD_ADDR, CARDD_HOST,
// CARDD_ISSUER_KEY_FILE, CARDD_PHOENIXD_URL, CARDD_PHOENIXD_CONF and
// CARDD_WEBHOOK_ADDR environment variables, so the container and cardd-ctl
// need no arguments for them. CARDD_RESTORE_CHANNEL_WAIT (a Go duration,
// 30m when unset) is how long serve waits for a channel after a restore; the
// stack test shortens it. CARDD_RATES_MEMPOOL_URL, CARDD_RATES_COINBASE_URL
// and CARDD_RATES_KRAKEN_URL (-rates-mempool-url, -rates-coinbase-url,
// -rates-kraken-url) are where cardd asks the three sources of a bitcoin's
// price in each currency, their own when unset; the tests point them
// elsewhere.
package main

import (
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"github.com/boltcard/karto/server/internal/alerts"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/boltcard/karto/server/internal/api"
	"github.com/boltcard/karto/server/internal/backup"
	"github.com/boltcard/karto/server/internal/bip353"
	"github.com/boltcard/karto/server/internal/cards"
	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/lnaddr"
	"github.com/boltcard/karto/server/internal/lnurl"
	"github.com/boltcard/karto/server/internal/namecheck"
	"github.com/boltcard/karto/server/internal/phoenixd"
	"github.com/boltcard/karto/server/internal/rates"
	"github.com/boltcard/karto/server/internal/renew"
	"github.com/boltcard/karto/server/internal/sendto"
	"github.com/boltcard/karto/server/internal/store"
)

var version = "dev"

func main() {
	if err := runWithStdin(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "cardd:", err)
		os.Exit(exitCode(err))
	}
}

// errKeyMismatch: a different issuer key is already installed.
var errKeyMismatch = errors.New("refusing to replace it")

// errRevoked: `device add` for a key that was revoked.
var errRevoked = errors.New("generate a new key on the phone")

// exitCode is 3 when a different issuer key is already installed (the app
// reads that as "wrong recovery phrase", like install.sh seed), 5 when the
// phone's device key was revoked (retrying can't help), 6 when a backup is
// from a newer cardd, 7 when restore finds a database it didn't restore,
// else 1.
func exitCode(err error) int {
	switch {
	case errors.Is(err, errKeyMismatch):
		return 3
	case errors.Is(err, errRevoked):
		return 5
	case errors.Is(err, errNewerBackup):
		return 6
	case errors.Is(err, errDatabaseThere):
		return 7
	}
	return 1
}

func run(args []string, out io.Writer) error {
	return runWithStdin(args, os.Stdin, out)
}

func runWithStdin(args []string, stdin io.Reader, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: cardd serve|device|meta|keyfile|healthcheck|ledger|restore|backup ...")
	}
	switch args[0] {
	case "serve":
		srv, err := newServer(args[1:])
		if err != nil {
			return err
		}
		defer srv.cleanup()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go srv.run(ctx)
		errs := make(chan error, 2)
		// The webhook port is only for phoenixd, inside the compose network;
		// Caddy proxies the public one.
		go func() { errs <- newHTTPServer(srv.webhookAddr, srv.webhook).ListenAndServe() }()
		go func() { errs <- newHTTPServer(srv.addr, srv.public).ListenAndServe() }()
		fmt.Fprintf(out, "cardd %s listening on %s (phoenixd webhook on %s)\n", version, srv.addr, srv.webhookAddr)
		return <-errs
	case "device":
		return device(args[1:], out)
	case "meta":
		return meta(args[1:], out)
	case "keyfile":
		return keyfile(args[1:], stdin)
	case "healthcheck":
		return healthcheck(args[1:])
	case "ledger":
		return ledgerCmd(args[1:], out)
	case "restore":
		return restore(args[1:], stdin, out)
	case "backup":
		return backupCmd(args[1:], out)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

// server is everything `cardd serve` runs.
type server struct {
	public, webhook   http.Handler
	addr, webhookAddr string
	run               func(ctx context.Context) // the ledger's checks, the top-up sweep, the renewal job, the snapshots and the rate
	cleanup           func()
	store             *store.Store
	renewer           *renew.Renewer
	ledger            *ledger.Ledger
	rates             *rates.Source
}

// newServer parses serve flags and builds the handlers.
func newServer(args []string) (*server, error) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	dbPath := fs.String("db", env("CARDD_DB", "cardd.db"), "SQLite database path")
	addr := fs.String("addr", env("CARDD_ADDR", ":8080"), "listen address")
	host := fs.String("host", env("CARDD_HOST", ""), "public hostname written onto cards, e.g. vm-1.lnvps.cloud")
	keyFile := fs.String("issuer-key-file", env("CARDD_ISSUER_KEY_FILE", ""), "file holding the 16-byte issuer key as hex")
	pdURL := fs.String("phoenixd-url", env("CARDD_PHOENIXD_URL", "http://phoenixd:9740"), "phoenixd's HTTP API")
	pdConf := fs.String("phoenixd-conf", env("CARDD_PHOENIXD_CONF", "/phoenix/phoenix.conf"), "phoenixd's phoenix.conf (http-password, webhook-secret)")
	webhookAddr := fs.String("webhook-addr", env("CARDD_WEBHOOK_ADDR", ":8081"), "listen address for phoenixd's webhook (not public)")
	mempoolURL := fs.String("rates-mempool-url", env("CARDD_RATES_MEMPOOL_URL", rates.DefaultURLs.Mempool), "where to ask mempool.space's prices of a bitcoin")
	coinbaseURL := fs.String("rates-coinbase-url", env("CARDD_RATES_COINBASE_URL", rates.DefaultURLs.Coinbase), "where to ask Coinbase's exchange rates for a bitcoin")
	krakenURL := fs.String("rates-kraken-url", env("CARDD_RATES_KRAKEN_URL", rates.DefaultURLs.Kraken), "where to ask Kraken's tickers of a bitcoin")
	ntfyPublic := fs.String("ntfy-public", env("CARDD_NTFY_PUBLIC", ""), "the server's own ntfy, as phones reach it (https://<host>:8443); empty: none (alerts)")
	ntfyInternal := fs.String("ntfy-internal", env("CARDD_NTFY_INTERNAL", ""), "the same ntfy as cardd reaches it inside the stack (http://ntfy)")
	ntfyToken := fs.String("ntfy-token", env("CARDD_NTFY_TOKEN", ""), "cardd's access token for ntfy")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if *host == "" {
		return nil, errors.New("-host is required")
	}
	if err := cards.ValidHost(*host); err != nil {
		return nil, fmt.Errorf("-host %q: %w", *host, err)
	}
	var restoreWait time.Duration
	if v := os.Getenv("CARDD_RESTORE_CHANNEL_WAIT"); v != "" {
		var err error
		if restoreWait, err = time.ParseDuration(v); err != nil || restoreWait <= 0 {
			return nil, fmt.Errorf("CARDD_RESTORE_CHANNEL_WAIT %q: a duration such as 30m is needed", v)
		}
	}
	issuer, err := readIssuerKey(*keyFile)
	if err != nil {
		return nil, err
	}
	conf, err := phoenixd.ReadConf(*pdConf)
	if err != nil {
		return nil, err
	}
	st, err := store.Open(*dbPath)
	if err != nil {
		return nil, err
	}
	if err := st.TidyAtStart(context.Background()); err != nil {
		st.Close()
		return nil, err
	}
	svc, err := cards.New(st, issuer, *host)
	if err != nil {
		st.Close()
		return nil, err
	}
	logger := log.New(os.Stderr, "", log.LstdFlags)
	pd := phoenixd.New(*pdURL, conf.HTTPPassword)
	l := ledger.New(st, pd, logger)
	ln := &lnurl.Server{Cards: svc, Store: st, Ledger: l, Invoices: pd, Host: *host, Log: logger, Now: time.Now, QuickLook: 2 * time.Second,
		Limit: lnurl.InvoiceLimit(time.Now)}
	sweep := func(ctx context.Context) error { return ln.Sweep(ctx, 0) }
	l.Liquidity, l.Sweep = pd.Liquidity, sweep
	l.BooksSet = booksSet(ln, func(msg string) { logger.Print(msg) })
	if restoreWait > 0 {
		l.RestoreWait = restoreWait
	}
	auth := &deviceauth.Verifier{Lookup: lookup(st), Now: time.Now, Seen: st.SeeSignature}
	addresses := lnaddr.New()
	// Send out's lookup: offers through phoenixd, BIP353 names through Google
	// and Cloudflare (both must agree), LNURL as before.
	looker := &sendto.Looker{Offers: pd, Names: bip353.New(), Addresses: addresses, Now: time.Now}
	// Renewals pay the VM's LNVPS Lightning address, on api.lnvps.net only.
	renewer := &renew.Renewer{Store: st, Ledger: l, Resolver: addresses, Decoder: pd, LNVPS: "https://api.lnvps.net", Now: time.Now, Log: logger}
	money := &api.Money{Store: st, Ledger: l, Liquidity: pd.Liquidity, Invoices: pd, SaleGap: time.Second, Addresses: addresses, Lookup: looker, Host: *host,
		SendWait: 25 * time.Second, ResolveWait: 10 * time.Second, Log: logger,
		Sweep: sweep, Hosting: renewer,
		// Whether this server's name has an IPv4 address pointing here, asked of the same public DNS
		// services as BIP353's, so it is what phones out there see.
		Names: &namecheck.Checker{Host: *host, IPv4: func(ctx context.Context) (string, error) { return st.GetMeta(ctx, "vm.ipv4") },
			Lookup: namecheck.DoH(addresses.HTTP, bip353.Services), Now: time.Now}}
	// phoenixd's webhook rings a till's held read of a sale at its payment;
	// the store rings the held reads of an account's history, and of the
	// wallet, as a change to the books commits.
	money.Bell = api.NewBell()
	ln.Paid, st.Changed = money.Bell.Paid, money.Bell.Changed
	// A bitcoin's price, the middle of mempool.space's, Coinbase's and
	// Kraken's, and kept in rates.json beside the database, not in it: a
	// backup is a new version whenever the database changes, and the rate
	// changes every 5 minutes. The phones read it from the API, a tap's
	// limits in a currency from the store's hook, which also logs the rate a
	// tap was checked at.
	urls := rates.URLs{Mempool: *mempoolURL, Coinbase: *coinbaseURL, Kraken: *krakenURL}
	src := rates.New(urls, filepath.Join(filepath.Dir(*dbPath), "rates.json"), &http.Client{}, time.Now, logger)
	money.Prices, st.Rate, st.Log = src.Last, src.Last, logger
	// Alerts to the owner's phones: a committed payment from the
	// store's hook, a refused tap from the LNURL server's. Both only queue.
	sender := &alerts.Sender{Store: st, Prices: src.Last, Log: logger,
		NtfyPublic: *ntfyPublic, NtfyInternal: *ntfyInternal, NtfyToken: *ntfyToken}
	st.Posted = sender.Posted
	ln.Refused = func(r lnurl.Refusal) {
		sender.Refused(alerts.Refusal{CardID: r.CardID, Reason: alerts.RefusalReason(r.Reason), AmountMsat: r.AmountMsat, At: r.At})
	}
	money.Push = sender
	renewer.Alerts = sender // hosting's daily low-funding alert
	// Snapshots next to the database: /data/backups in the container.
	snaps := &backup.Snapshotter{Store: st, Dir: filepath.Join(filepath.Dir(*dbPath), "backups"), Now: time.Now, Log: logger}
	public := api.New(svc, auth, version, st, money, snaps)
	ln.Routes(public)
	webhook := http.NewServeMux()
	webhook.Handle("POST /phoenixd", ln.Webhook(conf.WebhookSecret))
	return &server{
		public: public, webhook: webhook, addr: *addr, webhookAddr: *webhookAddr,
		run: func(ctx context.Context) {
			go ln.RunSweep(ctx)
			go renewer.Run(ctx, l.Checked())
			go snaps.Run(ctx)
			go src.Run(ctx)
			go sender.Run(ctx)
			l.Run(ctx)
		},
		cleanup: func() { st.Close() },
		store:   st,
		renewer: renewer,
		ledger:  l,
		rates:   src,
	}, nil
}

// booksSet is what the ledger calls once the books have been set to
// phoenixd's balance: the fee credit cardd has accounted for is set to
// phoenixd's too.
// It tells the person, through say, when it couldn't: phoenixd's channel
// isn't up, so its figure can't be trusted yet; cardd's count is forgotten
// then, and taken afresh at the first 5-minute check with the channel up.
func booksSet(ln *lnurl.Server, say func(string)) func(context.Context) {
	return func(ctx context.Context) {
		reset, err := ln.ResetFeeCredit(ctx)
		switch {
		case err != nil:
			say(fmt.Sprintf("fee credit: %v", err))
		case !reset:
			say("fee credit: phoenixd's channel isn't up, so its figure can't be trusted yet: the count cardd keeps is forgotten, and the next 5-minute check with the channel up takes phoenixd's; until then payments are credited in full")
		}
	}
}

// ledgerCmd is `cardd ledger reconcile`, the way out when spending is paused
// because the books and phoenixd disagree: it books the difference to pool,
// refusing while a payment is in progress. The running cardd sees the books
// add up at its next check, within a minute. After a restore it refuses until
// the restore's own reconcile has set the books.
func ledgerCmd(args []string, out io.Writer) error {
	if len(args) > 0 && args[0] == "holds" {
		return ledgerHolds(args[1:], out)
	}
	if len(args) == 0 || args[0] != "reconcile" {
		return errors.New("usage: cardd ledger reconcile|holds")
	}
	fs := flag.NewFlagSet("ledger reconcile", flag.ContinueOnError)
	dbPath := fs.String("db", env("CARDD_DB", "cardd.db"), "SQLite database path")
	pdURL := fs.String("phoenixd-url", env("CARDD_PHOENIXD_URL", "http://phoenixd:9740"), "phoenixd's HTTP API")
	pdConf := fs.String("phoenixd-conf", env("CARDD_PHOENIXD_CONF", "/phoenix/phoenix.conf"), "phoenixd's phoenix.conf")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	conf, err := phoenixd.ReadConf(*pdConf)
	if err != nil {
		return err
	}
	st, err := store.Open(*dbPath)
	if err != nil {
		return err
	}
	defer st.Close()
	pd := phoenixd.New(*pdURL, conf.HTTPPassword)
	logger := log.New(io.Discard, "", 0)
	l := ledger.New(st, pd, logger)
	// Top-ups whose webhook was missed are credited first.
	ln := &lnurl.Server{Store: st, Invoices: pd, Log: logger, Now: time.Now}
	l.BooksSet = booksSet(ln, func(msg string) { fmt.Fprintln(out, msg) })
	diff, err := l.Correct(context.Background(), func(ctx context.Context) error { return ln.Sweep(ctx, 0) })
	if err != nil {
		return err
	}
	if diff == 0 {
		fmt.Fprintln(out, "The books add up: nothing to set.")
	} else {
		fmt.Fprintf(out, "Booked %+d msat to pool; spending starts again within a minute.\n", diff)
	}
	return nil
}

// ledgerHolds is `cardd ledger holds`: the payments in progress, one line
// each (id, account, kind, amount in msat, opened), touching nothing.
// install.sh recovery-check refuses while there are any, as reconcile does.
func ledgerHolds(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("ledger holds", flag.ContinueOnError)
	dbPath := fs.String("db", env("CARDD_DB", "cardd.db"), "SQLite database path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return errors.New("usage: cardd ledger holds")
	}
	st, err := store.Open(*dbPath)
	if err != nil {
		return err
	}
	defer st.Close()
	holds, err := st.OpenHolds(context.Background())
	if err != nil {
		return err
	}
	for _, h := range holds {
		fmt.Fprintf(out, "%d\t%s\t%s\t%d\t%s\n", h.ID, h.Account, h.Kind, h.AmountMsat, h.CreatedAt.UTC().Format(time.RFC3339))
	}
	return nil
}

func readIssuerKey(path string) ([]byte, error) {
	if path == "" {
		return nil, errors.New("-issuer-key-file is required")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	key, err := hex.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(key) != 16 {
		return nil, fmt.Errorf("%s: issuer key must be 32 hex characters", path)
	}
	return key, nil
}

// lookup adapts the store's devices table to deviceauth.
func lookup(st *store.Store) deviceauth.Lookup {
	return func(ctx context.Context, keyID string) (*ecdsa.PublicKey, deviceauth.Role, error) {
		d, err := st.GetDevice(ctx, keyID)
		if errors.Is(err, store.ErrNotFound) || (err == nil && d.RevokedAt != nil) {
			return nil, "", deviceauth.ErrUnknownDevice
		}
		if err != nil {
			return nil, "", err
		}
		pub, _, err := deviceauth.ParsePublicKey(d.PublicKey)
		return pub, deviceauth.Role(d.Role), err
	}
}

func device(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: cardd device add|revoke|revoke-others|list")
	}
	fs := flag.NewFlagSet("device "+args[0], flag.ContinueOnError)
	dbPath := fs.String("db", env("CARDD_DB", "cardd.db"), "SQLite database path")
	pubkey := fs.String("pubkey", "", "hex uncompressed P-256 public key (add)")
	name := fs.String("name", "", "device name (add)")
	keyID := fs.String("key-id", "", "device key id (revoke)")
	keep := fs.String("keep", "", "the device key id to keep (revoke-others)")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	st, err := store.Open(*dbPath)
	if err != nil {
		return err
	}
	defer st.Close()
	ctx := context.Background()
	switch args[0] {
	case "add":
		_, raw, err := deviceauth.ParsePublicKey(strings.ToLower(strings.TrimSpace(*pubkey)))
		if err != nil {
			return err
		}
		if *name == "" {
			return errors.New("-name is required")
		}
		id := deviceauth.KeyID(raw)
		// Idempotent, so onboarding can retry it; a revoked key stays revoked.
		existing, err := st.GetDevice(ctx, id)
		switch {
		case err == nil && existing.RevokedAt != nil:
			return fmt.Errorf("device %s was revoked; %w", id, errRevoked)
		case err == nil:
		case errors.Is(err, store.ErrNotFound):
			if err := st.AddDevice(ctx, store.Device{KeyID: id, PublicKey: hex.EncodeToString(raw), Name: *name}); err != nil {
				return err
			}
		default:
			return err
		}
		fmt.Fprintln(out, id)
		return nil
	case "revoke":
		return st.RevokeDevice(ctx, *keyID)
	case "revoke-others":
		// A restore onto a new phone: every other owner loses access; PoS phones stay.
		n, err := st.RevokeOthers(ctx, *keep)
		if err != nil {
			return err
		}
		fmt.Fprintln(out, n)
		return nil
	case "list":
		ds, err := st.ListDevices(ctx)
		if err != nil {
			return err
		}
		for _, d := range ds {
			status := "active"
			if d.RevokedAt != nil {
				status = "revoked " + d.RevokedAt.UTC().Format(time.RFC3339)
			}
			// An owner's line is as it always was (scripts compare it); a PoS phone's says so.
			if d.Role != store.RoleOwner {
				status += "\t" + string(d.Role)
			}
			fmt.Fprintf(out, "%s\t%s\t%s\n", d.KeyID, d.Name, status)
		}
		return nil
	default:
		return fmt.Errorf("unknown device command %q", args[0])
	}
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func newHTTPServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
}

func meta(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: cardd meta set|get|list [-db PATH] [key [value]]")
	}
	fs := flag.NewFlagSet("meta "+args[0], flag.ContinueOnError)
	dbPath := fs.String("db", env("CARDD_DB", "cardd.db"), "SQLite database path")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	rest := fs.Args()
	st, err := store.Open(*dbPath)
	if err != nil {
		return err
	}
	defer st.Close()
	ctx := context.Background()
	switch {
	case args[0] == "set" && len(rest) == 2:
		return st.SetMeta(ctx, rest[0], rest[1])
	case args[0] == "get" && len(rest) == 1:
		v, err := st.GetMeta(ctx, rest[0])
		if err != nil {
			return fmt.Errorf("meta %s: %w", rest[0], err)
		}
		fmt.Fprintln(out, v)
		return nil
	case args[0] == "list" && len(rest) == 0:
		all, err := st.ListMeta(ctx)
		if err != nil {
			return err
		}
		keys := make([]string, 0, len(all))
		for k := range all {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(out, "%s\t%s\n", k, all[k])
		}
		return nil
	default:
		return errors.New("usage: cardd meta set KEY VALUE | get KEY | list")
	}
}

// keyfile writes the issuer key read from stdin. It is idempotent, and it
// never replaces a different key: every programmed card depends on it.
func keyfile(args []string, stdin io.Reader) error {
	if len(args) == 0 || args[0] != "write" {
		return errors.New("usage: cardd keyfile write -path FILE < key-hex")
	}
	fs := flag.NewFlagSet("keyfile write", flag.ContinueOnError)
	path := fs.String("path", env("CARDD_ISSUER_KEY_FILE", ""), "where to write the key")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if *path == "" {
		return errors.New("-path is required")
	}
	raw, err := io.ReadAll(io.LimitReader(stdin, 1024))
	if err != nil {
		return err
	}
	key := strings.ToLower(strings.TrimSpace(string(raw)))
	if b, err := hex.DecodeString(key); err != nil || len(b) != 16 {
		return errors.New("issuer key must be 32 hex characters")
	}
	if existing, err := readIssuerKey(*path); err == nil {
		if hex.EncodeToString(existing) == key {
			return nil
		}
		return fmt.Errorf("%s holds a different issuer key; %w", *path, errKeyMismatch)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	tmp := *path + ".tmp"
	if err := os.WriteFile(tmp, []byte(key+"\n"), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, *path)
}

// healthcheck is the container's HEALTHCHECK: the image has no curl.
func healthcheck(args []string) error {
	fs := flag.NewFlagSet("healthcheck", flag.ContinueOnError)
	addr := fs.String("addr", env("CARDD_ADDR", ":8080"), "address cardd listens on")
	if err := fs.Parse(args); err != nil {
		return err
	}
	_, port, err := net.SplitHostPort(*addr)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/health")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("health: HTTP %d", resp.StatusCode)
	}
	return nil
}
