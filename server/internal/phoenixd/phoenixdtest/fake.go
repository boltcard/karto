// Package phoenixdtest is a fake phoenixd for cardd's tests: the same HTTP
// routes and JSON as phoenixd v0.9.2, with invoices any test can make, payments
// a test receives on purpose, and payments whose outcome a test chooses.
package phoenixdtest

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	Password      = "test-password"
	WebhookSecret = "test-webhook-secret"
)

// Outcome is what a payinvoice does.
type Outcome struct {
	Fail    bool  // the payment fails
	FeeMsat int64 // the routing fee when it succeeds
	Hang    bool  // payinvoice doesn't answer until Release; the payment stays pending
	// Unrecorded, with Hang: phoenixd has taken the request but has no record
	// of the payment yet (outgoingbyhash answers 404) until Release.
	Unrecorded bool
	// Refuse: payinvoice answers HTTP 400, as phoenixd does for a bad request; nothing is sent.
	Refuse bool
}

type invoice struct {
	amountMsat  int64
	hash        string
	externalID  string
	description string
	descHash    string
	chain       string // "" is mainnet
	created     time.Time
	expiry      int64
	paid        bool
	receivedSat int64
	feesMsat    int64
	completedMs int64
}

type outgoing struct {
	id           string // phoenixd's paymentId, a UUID
	hash         string // "" for an on-chain payment
	subType      string // "lightning", or "splice_out" for an on-chain one
	paid, failed bool
	feesMsat     int64
	amountMsat   int64 // what is paid: the invoice's amount, or the amount given for one without
	createdMs    int64
	completedMs  int64  // 0 while it is on its way
	preimage     string // set once paid, as phoenixd's record has it
}

// newOutgoing is a payment phoenixd has just taken up.
func newOutgoing(hash string, amountMsat int64) *outgoing {
	h := randomHex(16)
	return &outgoing{id: h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], hash: hash, subType: "lightning",
		amountMsat: amountMsat, createdMs: time.Now().UnixMilli()}
}

// json is the payment as phoenixd's outgoing routes give it: sent in whole
// sats of amount + fee, rounded down; fees in msat, 0 until paid.
func (o *outgoing) json() map[string]any {
	out := map[string]any{"subType": o.subType, "paymentId": o.id, "isPaid": o.paid, "fees": o.feesMsat,
		"sent": (o.amountMsat + o.feesMsat) / 1000, "createdAt": o.createdMs, "completedAt": nil, "paymentHash": nil}
	if o.hash != "" {
		out["paymentHash"] = o.hash
	}
	if o.paid || o.failed {
		out["completedAt"] = o.completedMs
	}
	out["preimage"] = nil
	if o.paid {
		out["preimage"] = o.preimage
	}
	return out
}

// OfferOutcome is what a payoffer does. The zero value succeeds, fee 0.
type OfferOutcome struct {
	// Fail: no invoice came back; payoffer answers this reason with no hash
	// (lightning-kmp's texts: "no response to the invoice request", …).
	Fail string
	// FailPaid: the invoice came, the payment failed (a record, failed).
	FailPaid bool
	// EarlyFail: payment_failed with a hash and no record, as
	// lightning-kmp's early refusals (OutgoingPaymentHandler.kt:104-128).
	EarlyFail bool
	FeeMsat   int64
	// Hang: payoffer doesn't answer until ReleaseOffer; the payment stays
	// pending. With Unrecorded, no record exists until then (the invoice fetch).
	Hang, Unrecorded bool
	Refuse           bool // HTTP 400: nothing sent
}

type offer struct {
	amountMsat                           int64
	description, issuer, currency, chain string
	expiresAt                            int64
	outcome                              OfferOutcome
	release                              chan struct{}
	pending                              *outgoing // the last payoffer's payment, until it ends
	payments                             []string  // hashes, oldest first
}

// Fake is a running fake phoenixd.
type Fake struct {
	*httptest.Server
	mu           sync.Mutex
	invoices     map[string]*invoice // by bolt11
	byHash       map[string]*invoice
	offers       map[string]*offer
	outgoing     map[string]*outgoing
	outcomes     map[string]Outcome // by payment hash; default: succeed, fee 0
	release      map[string]chan struct{}
	calls        map[string]int // requests served, by path
	BalanceSat   int64
	FeeCreditSat int64
	Channel      bool
	ChannelState string // the channel's state when Channel is set: "Normal" if empty
	InboundSat   int64  // the channel's room: 1,900,000 unless a test sets it
	// FeeCreditDelay is how long after a set-aside payment's webhook is sent
	// the fee credit shows it: phoenixd's figure moves only when ACINQ has
	// confirmed it, a round trip after phoenixd has reported the payment.
	// 20 ms unless a test sets it. With no WebhookURL nobody is told of the
	// payment, and the figure moves at once.
	FeeCreditDelay time.Duration
	WebhookURL     string // where payment_received goes, if set
	Down           bool   // every call fails as if phoenixd were unreachable
	// MissingRoute: requests whose path starts with it get a plain 404, as a
	// phoenixd without that route would answer.
	MissingRoute string
	// Broken: requests whose path starts with it get HTTP 500, as a phoenixd
	// that fails on a request answers.
	Broken string
}

func New() *Fake {
	f := &Fake{invoices: map[string]*invoice{}, byHash: map[string]*invoice{}, offers: map[string]*offer{}, outgoing: map[string]*outgoing{},
		outcomes: map[string]Outcome{}, release: map[string]chan struct{}{}, calls: map[string]int{},
		InboundSat: 1_900_000, FeeCreditDelay: 20 * time.Millisecond}
	f.Server = httptest.NewServer(http.HandlerFunc(f.serve))
	return f
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Invoice makes an invoice someone else wants paid (a terminal's), for amountMsat.
func (f *Fake) Invoice(amountMsat int64) (bolt11, paymentHash string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.newInvoice(amountMsat, "", "", 3600)
}

// InvoiceWithDescription is Invoice with a description, as LNVPS's renewal
// invoices have ("VM renewal 1009 to …").
func (f *Fake) InvoiceWithDescription(amountMsat int64, description string) (bolt11, paymentHash string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.newInvoice(amountMsat, "", description, 600)
}

// ExpiredInvoice is like Invoice but expired an hour ago.
func (f *Fake) ExpiredInvoice(amountMsat int64) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, _ := f.newInvoice(amountMsat, "", "", 60)
	f.invoices[b].created = time.Now().Add(-time.Hour)
	return b
}

// ChainInvoice is like Invoice but for another chain, named as phoenixd's
// decodeinvoice names it (lightning-kmp's chain name in lower case: "testnet3",
// "testnet4", "signet", "regtest").
func (f *Fake) ChainInvoice(amountMsat int64, chain string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, _ := f.newInvoice(amountMsat, "", "", 0)
	f.invoices[b].chain = chain
	return b
}

func (f *Fake) newInvoice(amountMsat int64, externalID, description string, expiry int64) (string, string) {
	inv := &invoice{amountMsat: amountMsat, hash: randomHex(32), externalID: externalID, description: description, created: time.Now(), expiry: expiry}
	bolt11 := "lnbcfake1" + inv.hash
	f.invoices[bolt11], f.byHash[inv.hash] = inv, inv
	return bolt11, inv.hash
}

// InvoiceInfo is what an invoice was made with.
type InvoiceInfo struct {
	AmountMsat    int64
	ExternalID    string
	Description   string
	ExpirySeconds int64
	PaymentHash   string
}

// InvoiceInfo reports how an invoice was made, and whether the fake has it.
func (f *Fake) InvoiceInfo(bolt11 string) (InvoiceInfo, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	inv := f.invoices[bolt11]
	if inv == nil {
		return InvoiceInfo{}, false
	}
	return InvoiceInfo{AmountMsat: inv.amountMsat, ExternalID: inv.externalID, Description: inv.description, ExpirySeconds: inv.expiry, PaymentHash: inv.hash}, true
}

// InvoiceCount is how many invoices the fake has made.
func (f *Fake) InvoiceCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.invoices)
}

// SetOutcome chooses what paying the invoice with this payment hash does.
func (f *Fake) SetOutcome(paymentHash string, o Outcome) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.outcomes[paymentHash] = o
	if o.Hang {
		f.release[paymentHash] = make(chan struct{})
	}
}

// SetCompleted sets when phoenixd says an outgoing payment ended (its
// completedAt), as if it had been paid that long before cardd asked.
func (f *Fake) SetCompleted(paymentHash string, at time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if o := f.outgoing[paymentHash]; o != nil {
		o.completedMs = at.UnixMilli()
	}
}

// Release lets a hanging payment finish: it succeeds with feeMsat, or fails.
// While it hung its amount was already off the balance, as phoenixd's is.
func (f *Fake) Release(paymentHash string, fail bool, feeMsat int64) {
	f.mu.Lock()
	o := f.outgoing[paymentHash]
	if o != nil {
		o.paid, o.failed, o.feesMsat, o.completedMs = !fail, fail, feeMsat, time.Now().UnixMilli()
		if fail {
			f.BalanceSat += o.amountMsat / 1000
		} else {
			o.preimage = randomHex(32)
			f.BalanceSat -= feeMsat / 1000
		}
	}
	ch := f.release[paymentHash]
	f.mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

// Receive pays an invoice phoenixd made, as phoenixd reports it:
// receivedSat is what arrived after feesMsat (a channel's fee) was taken.
// It sends the webhook.
func (f *Fake) Receive(bolt11 string, receivedSat, feesMsat int64) {
	f.receive(bolt11, receivedSat, feesMsat, false)
}

// ReceiveAsFeeCredit pays an invoice whose money phoenixd sets aside toward
// a channel or more room: it reports the whole amount with no fees, and
// keeps it as fee credit, which shows it FeeCreditDelay after the webhook.
func (f *Fake) ReceiveAsFeeCredit(bolt11 string) {
	f.mu.Lock()
	sat := f.invoices[bolt11].amountMsat / 1000
	f.mu.Unlock()
	f.receive(bolt11, sat, 0, true)
}

// ReceiveBuyingRoom pays an invoice whose payment bought a channel or more
// room: feesMsat is the room's whole price, feeCreditUsedSat the part of it
// earlier fee credit paid (gone from the fee credit before the webhook, as
// ACINQ takes it when the purchase is signed). What reached the balance is
// worked out as phoenixd does (lightning-kmp: the payment less the fee, plus
// the fee credit used, in whole sats).
func (f *Fake) ReceiveBuyingRoom(bolt11 string, feesMsat, feeCreditUsedSat int64) {
	f.mu.Lock()
	receivedSat := (f.invoices[bolt11].amountMsat - feesMsat + feeCreditUsedSat*1000) / 1000
	f.FeeCreditSat -= feeCreditUsedSat
	f.Channel = true
	f.InboundSat += 2_000_000 // what phoenixd buys at a time
	f.mu.Unlock()
	f.receive(bolt11, receivedSat, feesMsat, false)
}

func (f *Fake) receive(bolt11 string, receivedSat, feesMsat int64, feeCredit bool) {
	f.mu.Lock()
	inv := f.invoices[bolt11]
	inv.paid, inv.receivedSat, inv.feesMsat, inv.completedMs = true, receivedSat, feesMsat, time.Now().UnixMilli()
	hook, delay := f.WebhookURL, f.FeeCreditDelay
	switch {
	case !feeCredit:
		// Money that reaches the balance takes up that much of the channel's room.
		f.BalanceSat += receivedSat
		f.InboundSat = max(0, f.InboundSat-receivedSat)
	case hook == "":
		f.FeeCreditSat += receivedSat
	default:
		time.AfterFunc(delay, func() {
			f.mu.Lock()
			f.FeeCreditSat += receivedSat
			f.mu.Unlock()
		})
	}
	f.mu.Unlock()
	if hook != "" {
		f.SendWebhook(hook, inv.hash, WebhookSecret)
	}
}

// Calls is how many requests the fake has served for a path ("/getbalance").
func (f *Fake) Calls(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[path]
}

// Set changes the fake's fields while it is in use by other goroutines.
func (f *Fake) Set(change func(f *Fake)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

// FeeCredit reads the fee credit while the fake is in use by other goroutines.
func (f *Fake) FeeCredit() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.FeeCreditSat
}

// SendWebhook posts payment_received for a payment hash, signed with secret.
func (f *Fake) SendWebhook(url, paymentHash, secret string) (int, error) {
	f.mu.Lock()
	inv := f.byHash[paymentHash]
	body, _ := json.Marshal(map[string]any{"type": "payment_received", "amountSat": inv.receivedSat, "paymentHash": inv.hash, "externalId": inv.externalID})
	f.mu.Unlock()
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Phoenix-Signature", hex.EncodeToString(mac.Sum(nil)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

// SetDown makes every call fail (or succeed again) while the fake is in use
// by other goroutines.
func (f *Fake) SetDown(down bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Down = down
}

// PaidMsat is what phoenixd paid for this payment hash (0 if not paid).
func (f *Fake) PaidMsat(paymentHash string) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if o := f.outgoing[paymentHash]; o != nil && o.paid {
		return o.amountMsat
	}
	return 0
}

// Paid lists the payment hashes phoenixd paid out.
func (f *Fake) Paid() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for h, o := range f.outgoing {
		if o.paid {
			out = append(out, h)
		}
	}
	return out
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func (f *Fake) serve(w http.ResponseWriter, r *http.Request) {
	if _, pw, _ := r.BasicAuth(); pw != Password {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	f.mu.Lock()
	down, missing, broken := f.Down, f.MissingRoute, f.Broken
	f.calls[r.URL.Path]++
	f.mu.Unlock()
	if missing != "" && strings.HasPrefix(r.URL.Path, missing) {
		http.NotFound(w, r)
		return
	}
	if broken != "" && strings.HasPrefix(r.URL.Path, broken) {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	if down {
		hj, _ := w.(http.Hijacker)
		conn, _, _ := hj.Hijack()
		conn.Close()
		return
	}
	r.ParseForm()
	path := r.URL.Path
	switch {
	case path == "/decodeinvoice":
		f.mu.Lock()
		inv := f.invoices[r.PostForm.Get("invoice")]
		f.mu.Unlock()
		if inv == nil {
			http.Error(w, "invalid invoice", http.StatusBadRequest)
			return
		}
		chain := inv.chain
		if chain == "" {
			chain = "mainnet"
		}
		out := map[string]any{"chain": chain, "paymentHash": inv.hash,
			"timestampSeconds": inv.created.Unix(), "expirySeconds": inv.expiry}
		// As phoenixd 0.9.2: its decodeinvoice answers lightning-kmp 1.13.2's
		// Bolt11InvoiceSurrogate (json/JsonSerializers.kt), whose description is
		// the invoice's Description tag, null for a hash-only invoice; Api.kt
		// sets explicitNulls = false, so a null is left out.
		if inv.description != "" {
			out["description"] = inv.description
		}
		if inv.amountMsat > 0 {
			out["amount"] = inv.amountMsat
		}
		if inv.descHash != "" {
			out["descriptionHash"] = inv.descHash
		}
		writeJSON(w, out)
	case path == "/createinvoice":
		amt, _ := strconv.ParseInt(r.PostForm.Get("amountSat"), 10, 64)
		exp, _ := strconv.ParseInt(r.PostForm.Get("expirySeconds"), 10, 64)
		// As phoenixd: a description, or the hash of one (LNURL-pay), which
		// leaves the invoice with no description of its own.
		description := r.PostForm.Get("description")
		f.mu.Lock()
		b, h := f.newInvoice(amt*1000, r.PostForm.Get("externalId"), description, exp)
		f.invoices[b].descHash = r.PostForm.Get("descriptionHash")
		f.mu.Unlock()
		writeJSON(w, map[string]any{"amountSat": amt, "paymentHash": h, "serialized": b})
	case strings.HasPrefix(path, "/payments/incoming/"):
		f.mu.Lock()
		inv := f.byHash[strings.TrimPrefix(path, "/payments/incoming/")]
		var out map[string]any
		if inv != nil {
			out = incomingJSON(inv) // read under the lock: a payment may arrive meanwhile
		}
		f.mu.Unlock()
		if inv == nil {
			http.Error(w, "Not found", http.StatusNotFound) // as phoenixd v0.9.2 answers
			return
		}
		writeJSON(w, out)
	case path == "/payments/incoming":
		from, _ := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		f.mu.Lock()
		var paid []*invoice
		for _, inv := range f.byHash {
			if inv.paid && inv.completedMs >= from {
				paid = append(paid, inv)
			}
		}
		// Newest first, as phoenixd lists them (its query orders by the time
		// received, descending: PaymentsIncoming.sq at v0.9.2).
		sort.Slice(paid, func(i, j int) bool {
			if paid[i].completedMs != paid[j].completedMs {
				return paid[i].completedMs > paid[j].completedMs
			}
			return paid[i].hash < paid[j].hash
		})
		var all []map[string]any
		for _, inv := range paid {
			all = append(all, incomingJSON(inv))
		}
		f.mu.Unlock()
		if offset > len(all) {
			offset = len(all)
		}
		all = all[offset:]
		if limit > 0 && len(all) > limit {
			all = all[:limit]
		}
		writeJSON(w, append([]map[string]any{}, all...))
	case path == "/payinvoice":
		amountSat, _ := strconv.ParseInt(r.PostForm.Get("amountSat"), 10, 64)
		f.payInvoice(w, r.PostForm.Get("invoice"), amountSat)
	case strings.HasPrefix(path, "/payments/outgoingbyhash/"):
		hash := strings.TrimPrefix(path, "/payments/outgoingbyhash/")
		f.mu.Lock()
		o := f.outgoing[hash]
		f.mu.Unlock()
		if o == nil {
			http.Error(w, "Not found", http.StatusNotFound)
			return
		}
		f.mu.Lock()
		out := o.json()
		f.mu.Unlock()
		writeJSON(w, out)
	case path == "/decodeoffer":
		f.mu.Lock()
		of := f.offers[r.PostForm.Get("offer")]
		var out map[string]any
		if of != nil {
			chain := of.chain
			if chain == "" {
				chain = "mainnet"
			}
			out = map[string]any{"chain": chain}
			if of.currency != "" {
				out["currency"] = of.currency
			} else if of.amountMsat > 0 {
				out["amount"] = of.amountMsat
			}
			if of.description != "" {
				out["description"] = of.description
			}
			if of.issuer != "" {
				out["issuer"] = of.issuer
			}
			if of.expiresAt != 0 {
				out["expirySeconds"] = of.expiresAt
			}
		}
		f.mu.Unlock()
		if out == nil {
			http.Error(w, "invalid offer", http.StatusBadRequest)
			return
		}
		writeJSON(w, out)
	case path == "/payoffer":
		amountSat, _ := strconv.ParseInt(r.PostForm.Get("amountSat"), 10, 64)
		f.payOffer(w, r.PostForm.Get("offer"), amountSat)
	case path == "/payments/outgoing":
		q := r.URL.Query()
		from, _ := strconv.ParseInt(q.Get("from"), 10, 64)
		to, _ := strconv.ParseInt(q.Get("to"), 10, 64)
		limit, _ := strconv.Atoi(q.Get("limit"))
		offset, _ := strconv.Atoi(q.Get("offset"))
		f.mu.Lock()
		var all []map[string]any
		for _, o := range f.outgoing {
			// all=true: by creation time, pending ones too, in no set order.
			if o.createdMs >= from && (to == 0 || o.createdMs <= to) {
				all = append(all, o.json())
			}
		}
		f.mu.Unlock()
		// phoenixd's order isn't relied on, but the fake's paging is set.
		sort.Slice(all, func(i, j int) bool {
			if all[i]["createdAt"].(int64) != all[j]["createdAt"].(int64) {
				return all[i]["createdAt"].(int64) < all[j]["createdAt"].(int64)
			}
			return all[i]["paymentId"].(string) < all[j]["paymentId"].(string)
		})
		if offset > len(all) {
			offset = len(all)
		}
		all = all[offset:]
		if limit > 0 && len(all) > limit {
			all = all[:limit]
		}
		writeJSON(w, append([]map[string]any{}, all...))
	case strings.HasPrefix(path, "/payments/outgoing/"):
		id := strings.TrimPrefix(path, "/payments/outgoing/")
		var out map[string]any
		f.mu.Lock()
		for _, o := range f.outgoing {
			if o.id == id {
				out = o.json()
			}
		}
		f.mu.Unlock()
		if out == nil {
			http.Error(w, "Not found", http.StatusNotFound)
			return
		}
		writeJSON(w, out)
	case path == "/getbalance":
		f.mu.Lock()
		writeJSON(w, map[string]any{"balanceSat": f.BalanceSat, "feeCreditSat": f.FeeCreditSat})
		f.mu.Unlock()
	case path == "/getinfo":
		f.mu.Lock()
		chans := []map[string]any{}
		if f.Channel {
			state := f.ChannelState
			if state == "" {
				state = "Normal"
			}
			chans = append(chans, map[string]any{"state": state, "inboundLiquiditySat": f.InboundSat})
		}
		f.mu.Unlock()
		writeJSON(w, map[string]any{"nodeId": "02fake", "channels": chans, "chain": "mainnet"})
	case path == "/estimateliquidityfees":
		writeJSON(w, map[string]any{"miningFeeSat": 411, "serviceFeeSat": 21000})
	default:
		http.NotFound(w, r)
	}
}

func incomingJSON(inv *invoice) map[string]any {
	out := map[string]any{"paymentHash": inv.hash, "externalId": inv.externalID, "isPaid": inv.paid,
		"receivedSat": inv.receivedSat, "fees": inv.feesMsat, "completedAt": nil}
	if inv.paid {
		out["completedAt"] = inv.completedMs
	}
	return out
}

func (f *Fake) payInvoice(w http.ResponseWriter, bolt11 string, amountSat int64) {
	f.mu.Lock()
	inv := f.invoices[bolt11]
	var o Outcome
	if inv != nil {
		o = f.outcomes[inv.hash]
	}
	if inv == nil || o.Refuse || inv.amountMsat == 0 && amountSat == 0 {
		f.mu.Unlock()
		http.Error(w, "invalid request", http.StatusBadRequest) // as phoenixd: nothing sent
		return
	}
	amountMsat := inv.amountMsat
	if amountSat > 0 {
		amountMsat = amountSat * 1000
	}
	if !o.Unrecorded {
		f.outgoing[inv.hash] = newOutgoing(inv.hash, amountMsat)
	}
	ch := f.release[inv.hash]
	if o.Hang && !o.Unrecorded {
		f.BalanceSat -= amountMsat / 1000 // on its way: off the balance until it fails
	}
	f.mu.Unlock()
	if o.Hang {
		<-ch
		f.mu.Lock()
		if f.outgoing[inv.hash] == nil {
			f.outgoing[inv.hash] = newOutgoing(inv.hash, amountMsat)
			f.outgoing[inv.hash].failed, f.outgoing[inv.hash].completedMs = true, time.Now().UnixMilli()
		}
		out := *f.outgoing[inv.hash]
		f.mu.Unlock()
		if out.failed {
			writeJSON(w, map[string]any{"paymentHash": inv.hash, "reason": "released as failed"})
		} else {
			writeJSON(w, map[string]any{"recipientAmountSat": amountMsat / 1000, "routingFeeSat": out.feesMsat / 1000,
				"paymentId": out.id, "paymentHash": inv.hash, "paymentPreimage": out.preimage})
		}
		return
	}
	f.mu.Lock()
	out := f.outgoing[inv.hash]
	out.completedMs = time.Now().UnixMilli()
	if o.Fail {
		out.failed = true
	} else {
		out.paid, out.feesMsat, out.preimage = true, o.FeeMsat, randomHex(32)
		f.BalanceSat -= (amountMsat + o.FeeMsat) / 1000
	}
	id, preimage := out.id, out.preimage
	f.mu.Unlock()
	if o.Fail {
		writeJSON(w, map[string]any{"paymentHash": inv.hash, "reason": "no route"})
		return
	}
	writeJSON(w, map[string]any{"recipientAmountSat": amountMsat / 1000, "routingFeeSat": o.FeeMsat / 1000,
		"paymentId": id, "paymentHash": inv.hash, "paymentPreimage": preimage})
}

// Offer makes an offer someone else wants paid: amountMsat 0 is an offer
// with no amount. It reads as "lno1fake…", which only this fake decodes.
func (f *Fake) Offer(amountMsat int64, description, issuer string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := "lno1fake" + randomHex(20)
	f.offers[s] = &offer{amountMsat: amountMsat, description: description, issuer: issuer}
	return s
}

// OfferCurrency prices an offer in a currency: decodeoffer then gives no amount.
func (f *Fake) OfferCurrency(s, currency string) {
	f.Set(func(f *Fake) { f.offers[s].currency = currency })
}

// OfferChain puts an offer on another chain ("testnet3", "regtest", "unknown").
func (f *Fake) OfferChain(s, chain string) { f.Set(func(f *Fake) { f.offers[s].chain = chain }) }

// OfferExpired gives an offer an expiry an hour ago.
func (f *Fake) OfferExpired(s string) {
	f.Set(func(f *Fake) { f.offers[s].expiresAt = time.Now().Add(-time.Hour).Unix() })
}

// SetOfferOutcome chooses what paying this offer does next.
func (f *Fake) SetOfferOutcome(s string, o OfferOutcome) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.offers[s].outcome = o
	if o.Hang {
		f.offers[s].release = make(chan struct{})
	}
}

// ReleaseOffer lets a hanging payoffer end: paid with feeMsat, or failed. A
// payment held Unrecorded (its invoice never came) that fails leaves no
// record and answers ""; otherwise it answers the payment's hash. Call it
// once the payment is under way (OfferPayments shows it); a second call does
// nothing more.
func (f *Fake) ReleaseOffer(s string, fail bool, feeMsat int64) string {
	f.mu.Lock()
	of := f.offers[s]
	p, ch := of.pending, of.release
	of.release = nil
	hash := ""
	switch {
	case p == nil:
	case fail && of.outcome.Unrecorded:
		of.pending = nil
	default:
		p.paid, p.failed, p.feesMsat, p.completedMs = !fail, fail, feeMsat, time.Now().UnixMilli()
		if !fail {
			p.preimage = randomHex(32)
			f.BalanceSat -= (p.amountMsat + feeMsat) / 1000
		}
		f.outgoing[p.hash] = p
		hash = p.hash
	}
	f.mu.Unlock()
	if ch != nil {
		close(ch)
	}
	return hash
}

// OfferPayments lists the hashes payoffer made for an offer, oldest first.
func (f *Fake) OfferPayments(s string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.offers[s].payments...)
}

// OnChainOut adds an on-chain payment out (a splice-out's record: no hash).
func (f *Fake) OnChainOut(amountMsat int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o := newOutgoing("", amountMsat)
	o.subType, o.paid, o.completedMs = "splice_out", true, time.Now().UnixMilli()
	f.outgoing["onchain:"+o.id] = o
}

// PaymentCreatedAt moves a payment's createdAt, for tests of Resolve's window.
func (f *Fake) PaymentCreatedAt(paymentHash string, at time.Time) {
	f.Set(func(f *Fake) { f.outgoing[paymentHash].createdMs = at.UnixMilli() })
}

func (f *Fake) payOffer(w http.ResponseWriter, s string, amountSat int64) {
	f.mu.Lock()
	of := f.offers[s]
	if of == nil || of.outcome.Refuse || amountSat <= 0 {
		f.mu.Unlock()
		http.Error(w, "invalid request", http.StatusBadRequest) // as phoenixd: nothing sent
		return
	}
	o := of.outcome
	amountMsat := amountSat * 1000
	if o.Fail != "" {
		f.mu.Unlock()
		writeJSON(w, map[string]any{"offerId": "fake", "reason": o.Fail})
		return
	}
	hash := randomHex(32)
	of.payments = append(of.payments, hash)
	if o.EarlyFail {
		f.mu.Unlock()
		writeJSON(w, map[string]any{"paymentHash": hash, "reason": "payment is already in progress"})
		return
	}
	p := newOutgoing(hash, amountMsat)
	of.pending = p
	if !o.Unrecorded {
		f.outgoing[hash] = p
	}
	ch := of.release
	f.mu.Unlock()
	if o.Hang {
		<-ch
		f.mu.Lock()
		p = of.pending
		failed := p == nil || p.failed
		var out map[string]any
		if failed {
			out = map[string]any{"offerId": "fake", "reason": "released as failed"}
			if p != nil {
				out["paymentHash"] = p.hash
			}
		} else {
			out = map[string]any{"recipientAmountSat": p.amountMsat / 1000, "routingFeeSat": p.feesMsat / 1000,
				"paymentId": p.id, "paymentHash": p.hash, "paymentPreimage": p.preimage}
		}
		f.mu.Unlock()
		writeJSON(w, out)
		return
	}
	f.mu.Lock()
	p.completedMs = time.Now().UnixMilli()
	if o.FailPaid {
		p.failed = true
	} else {
		p.paid, p.feesMsat, p.preimage = true, o.FeeMsat, randomHex(32)
		f.BalanceSat -= (amountMsat + o.FeeMsat) / 1000
	}
	out := map[string]any{"recipientAmountSat": amountSat, "routingFeeSat": o.FeeMsat / 1000, "paymentId": p.id, "paymentHash": hash, "paymentPreimage": p.preimage}
	if o.FailPaid {
		out = map[string]any{"paymentHash": hash, "reason": "no route"}
	}
	f.mu.Unlock()
	writeJSON(w, out)
}

// Preimage is a paid payment's preimage as the fake's record has it ("" for
// none).
func (f *Fake) Preimage(paymentHash string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if o := f.outgoing[paymentHash]; o != nil {
		return o.preimage
	}
	return ""
}

// Forget drops the fake's record of an outgoing payment, as a restored
// server's phoenixd has none of the payments made before the restore.
func (f *Fake) Forget(paymentHash string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.outgoing, paymentHash)
}

// Age moves an invoice's making back by d, so it reads as expired: an old
// send's invoice, as the fill-in pass meets them. The fake's /decodeinvoice
// ignores expiry, as phoenixd's does.
func (f *Fake) Age(bolt11 string, d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if inv := f.invoices[bolt11]; inv != nil {
		inv.created = inv.created.Add(-d)
	}
}

// String helps test failure messages.
func (f *Fake) String() string { return fmt.Sprintf("fake phoenixd at %s", f.URL) }
