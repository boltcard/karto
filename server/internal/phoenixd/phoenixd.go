// Package phoenixd is cardd's client for phoenixd's HTTP API (v0.9.2):
// invoices, payments, balance and channels. Every request uses HTTP basic
// auth with an empty user and the http-password phoenixd writes into its
// phoenix.conf, which cardd reads from phoenixd's volume (ReadConf).
//
// The API is ACINQ's, documented at https://phoenix.acinq.co/server/api
// (its source: github.com/ACINQ/phoenixd, Api.kt and json/JsonSerializers.kt).
// What cardd uses of it, and for what:
//   - POST /createinvoice with an externalId: every top-up's and sale's invoice.
//   - The payment_received webhook (X-Phoenix-Signature, an HMAC-SHA256 of
//     the body): the moment a payment arrives. phoenixd sends each once and
//     never again; GET /payments/incoming (a list from a time) is the sweep
//     that finds one that was missed.
//   - GET /payments/incoming/{paymentHash}
//     (https://phoenix.acinq.co/server/api#get-incoming-payment): an
//     invoice's own state, isPaid (a completedAt is set) with receivedSat and
//     fees. It is how a sale is read as paid, and what a credit is made from.
//     404 for an unknown hash.
//   - GET /getbalance (balanceSat, feeCreditSat) and GET /getinfo (each
//     channel's state and inboundLiquiditySat): the books' check, and what
//     a payment brought in. An incoming payment's JSON doesn't say whether
//     it was set aside as fee credit: feeCreditSat is the only sign.
//   - POST /decodeinvoice and POST /payinvoice: paying out. payinvoice
//     answers when the payment has ended, with a paymentId when it was sent.
//   - GET /payments/outgoing/{paymentId}
//     (https://phoenix.acinq.co/server/api#get-outgoing-payment): a payment
//     out's own state, isPaid with its exact fees, and phoenixd's times for
//     it (createdAt, completedAt). It is what a sent payment is settled from
//     and where its duration is read. GET /payments/outgoingbyhash/{paymentHash}
//     gives the same record (the best of that hash's attempts) when there is
//     no id: a payinvoice that gave no answer, or one that failed.
//   - POST /decodeoffer and POST /payoffer
//     (https://phoenix.acinq.co/server/api#decode-offer,
//     https://phoenix.acinq.co/server/api#pay-offer): paying a BOLT12 offer.
//     payoffer fetches the offer's invoice itself (up to 30 s) and
//     answers when the payment has ended; its payment hash and id are only
//     in that answer, and phoenixd has no record of the payment until the
//     invoice came. decodeoffer gives the chain, amount (none when priced in
//     a currency), issuer, description and expiry; phoenixd's payoffer
//     checks none of them.
//   - GET /payments/outgoing?all=true
//     (https://phoenix.acinq.co/server/api#list-outgoing-payments): payments
//     out made in a time window, pending ones included, in no set order:
//     how an offer's payment is found again after a lost answer. sent is
//     whole sats of amount + fee, rounded down; fees is msat, 0 until paid.
//   - GET /estimateliquidityfees: what the first channel will cost, for the
//     top-up sheet.
//
// Not used: the /websocket, which carries the same payment_received events
// as the webhook (one of the two is enough, and the webhook needs no
// connection kept), /paylnaddress (cardd resolves names itself),
// LNURL and on-chain calls.
package phoenixd

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Conf is what cardd needs from phoenixd's phoenix.conf.
type Conf struct {
	HTTPPassword  string
	WebhookSecret string
}

// ReadConf reads http-password and webhook-secret from phoenix.conf.
func ReadConf(path string) (Conf, error) {
	f, err := os.Open(path)
	if err != nil {
		return Conf{}, err
	}
	defer f.Close()
	var c Conf
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(strings.TrimSpace(sc.Text()), "=")
		switch {
		case !ok:
		case k == "http-password":
			c.HTTPPassword = v
		case k == "webhook-secret":
			c.WebhookSecret = v
		}
	}
	if err := sc.Err(); err != nil {
		return Conf{}, err
	}
	if c.HTTPPassword == "" || c.WebhookSecret == "" {
		return Conf{}, fmt.Errorf("%s: no http-password or webhook-secret yet", path)
	}
	return c, nil
}

// VerifyWebhook checks X-Phoenix-Signature: hex HMAC-SHA256 of the body
// with the webhook secret.
func VerifyWebhook(secret string, body []byte, sigHex string) bool {
	sig, err := hex.DecodeString(sigHex)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(sig, mac.Sum(nil))
}

// Client talks to one phoenixd.
type Client struct {
	URL      string // e.g. http://phoenixd:9740
	Password string
	// HTTP is for quick calls; Pay for payinvoice, which only answers once
	// the payment has an outcome.
	HTTP, Pay *http.Client
}

func New(baseURL, password string) *Client {
	return &Client{
		URL: strings.TrimRight(baseURL, "/"), Password: password,
		HTTP: &http.Client{Timeout: 15 * time.Second},
		Pay:  &http.Client{Timeout: 3 * time.Minute},
	}
}

var (
	// ErrUnreachable wraps every failure to get a usable answer from
	// phoenixd: no answer, a 5xx (or any status but 200 and 4xx), or a body
	// that isn't the JSON asked for. Each is phoenixd's trouble, not the
	// request's, so callers answer "phoenixd unreachable", never a 500.
	ErrUnreachable = errors.New("phoenixd: no answer")
	// ErrRefused: phoenixd answered HTTP 4xx. phoenixd 0.9.2 checks a
	// request's parameters before acting on it, so a refused payinvoice
	// sent nothing (re-check on a phoenixd upgrade).
	ErrRefused = errors.New("phoenixd: refused the request")
)

// RefusedError is ErrRefused with phoenixd's HTTP status (errors.Is(err,
// ErrRefused) holds): a 400 is a request phoenixd will never answer, a 401
// or 429 one it may answer later.
type RefusedError struct {
	Status int    // HTTP 4xx
	Detail string // the request and phoenixd's answer
}

func (e *RefusedError) Error() string        { return ErrRefused.Error() + ": " + e.Detail }
func (e *RefusedError) Is(target error) bool { return target == ErrRefused }

// ServerError is phoenixd answering HTTP 5xx: it was reached and failed on
// the request. It is not ErrRefused: a payinvoice or payoffer that answers
// 500 may have sent the payment, so its outcome is found out later.
// It is ErrUnreachable (errors.Is holds), as every failure to get a usable
// answer is, so a caller that only asks "did phoenixd answer?" says
// "phoenixd unreachable", never a 500; the fill-in pass, which
// must tell phoenixd failing on one question from phoenixd not answering at
// all, looks for the type itself (errors.As), which a lost connection never is.
type ServerError struct {
	Status int    // HTTP 5xx
	Detail string // the request and phoenixd's answer
}

func (e *ServerError) Error() string        { return "phoenixd: " + e.Detail }
func (e *ServerError) Is(target error) bool { return target == ErrUnreachable }

// call sends one request and decodes a JSON answer into out. For a lookup
// (one payment, by hash) it reports false and no error for "no such
// payment": phoenixd v0.9.2 answers 404 with the body "Not found" (its source
// reads as 204, which is accepted too). Any other 404, such as a route this
// phoenixd doesn't have, is an error.
func (c *Client) call(ctx context.Context, hc *http.Client, method, path string, form url.Values, out any, lookup bool) (bool, error) {
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, c.URL+path, body)
	if err != nil {
		return false, err
	}
	req.SetBasicAuth("", c.Password)
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	resp, err := hc.Do(req)
	if err != nil {
		return false, fmt.Errorf("%w: %s %s: %v", ErrUnreachable, method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return false, fmt.Errorf("%w: %s %s: %v", ErrUnreachable, method, path, err)
	}
	text := strings.TrimSpace(string(raw))
	if lookup && (resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound && text == "Not found") {
		return false, nil
	}
	if resp.StatusCode >= 400 && resp.StatusCode < 500 {
		return false, &RefusedError{Status: resp.StatusCode, Detail: fmt.Sprintf("%s %s: HTTP %d: %s", method, path, resp.StatusCode, text)}
	}
	if resp.StatusCode >= 500 {
		return false, &ServerError{Status: resp.StatusCode, Detail: fmt.Sprintf("%s %s: HTTP %d: %s", method, path, resp.StatusCode, text)}
	}
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("%w: %s %s: HTTP %d: %s", ErrUnreachable, method, path, resp.StatusCode, text)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return false, fmt.Errorf("%w: %s %s: %v", ErrUnreachable, method, path, err)
	}
	return true, nil
}

// Invoice is a decoded bolt11 invoice.
type Invoice struct {
	Chain            string `json:"chain"`
	AmountMsat       int64  `json:"amount"` // 0 when the invoice has no amount
	PaymentHash      string `json:"paymentHash"`
	Description      string `json:"description"`
	TimestampSeconds int64  `json:"timestampSeconds"`
	ExpirySeconds    int64  `json:"expirySeconds"`   // 0 means BOLT 11's default, 3600
	DescriptionHash  string `json:"descriptionHash"` // LNURL-pay invoices carry one instead of a description
	// AmountGiven: the invoice has no amount, and AmountMsat is the one the
	// payer gave (set by ledger.DecodeFor; paid with payinvoice's amountSat).
	AmountGiven bool `json:"-"`
}

// ExpiresAt is when the invoice can no longer be paid.
func (i Invoice) ExpiresAt() time.Time {
	exp := i.ExpirySeconds
	if exp == 0 {
		exp = 3600
	}
	return time.Unix(i.TimestampSeconds+exp, 0)
}

func (c *Client) DecodeInvoice(ctx context.Context, bolt11 string) (Invoice, error) {
	var inv Invoice
	_, err := c.call(ctx, c.HTTP, "POST", "/decodeinvoice", url.Values{"invoice": {bolt11}}, &inv, false)
	return inv, err
}

// Offer is a decoded BOLT12 offer, as /decodeoffer gives it (lightning-kmp's
// OfferSurrogate). AmountMsat is 0 for an offer with no amount, and for one
// priced in a currency (Currency set: phoenixd doesn't give that amount).
type Offer struct {
	Chain       string `json:"chain"`
	AmountMsat  int64  `json:"amount"`
	Currency    string `json:"currency"`
	Issuer      string `json:"issuer"`
	Description string `json:"description"`
	ExpiresAt   int64  `json:"expirySeconds"` // absolute unix seconds; 0: none
}

func (c *Client) DecodeOffer(ctx context.Context, offer string) (Offer, error) {
	var o Offer
	_, err := c.call(ctx, c.HTTP, "POST", "/decodeoffer", url.Values{"offer": {offer}}, &o, false)
	return o, err
}

// CreateInvoice makes an invoice for amountSat whose description hash is
// descriptionHash (LNURL-pay), labelled with externalID.
func (c *Client) CreateInvoice(ctx context.Context, amountSat int64, descriptionHash, externalID string, expiry time.Duration) (bolt11, paymentHash string, err error) {
	var out struct {
		PaymentHash string `json:"paymentHash"`
		Serialized  string `json:"serialized"`
	}
	_, err = c.call(ctx, c.HTTP, "POST", "/createinvoice", url.Values{
		"amountSat":       {strconv.FormatInt(amountSat, 10)},
		"descriptionHash": {descriptionHash},
		"externalId":      {externalID},
		"expirySeconds":   {strconv.FormatInt(int64(expiry.Seconds()), 10)},
	}, &out, false)
	return out.Serialized, out.PaymentHash, err
}

// CreateInvoiceDescribed makes an invoice for amountSat with a plain
// description, which the payer's wallet shows (a sale),
// labelled with externalID.
func (c *Client) CreateInvoiceDescribed(ctx context.Context, amountSat int64, description, externalID string, expiry time.Duration) (bolt11, paymentHash string, err error) {
	var out struct {
		PaymentHash string `json:"paymentHash"`
		Serialized  string `json:"serialized"`
	}
	_, err = c.call(ctx, c.HTTP, "POST", "/createinvoice", url.Values{
		"amountSat":     {strconv.FormatInt(amountSat, 10)},
		"description":   {description},
		"externalId":    {externalID},
		"expirySeconds": {strconv.FormatInt(int64(expiry.Seconds()), 10)},
	}, &out, false)
	return out.Serialized, out.PaymentHash, err
}

// Incoming is a payment phoenixd received, or an invoice it is waiting on.
type Incoming struct {
	PaymentHash string `json:"paymentHash"`
	ExternalID  string `json:"externalId"`
	IsPaid      bool   `json:"isPaid"`
	// ReceivedSat is what arrived after phoenixd's fees, in whole sats
	// (lightning-kmp's amountReceived: "if someone sent you 500 and the fee
	// was 10, this amount will be 490"). A payment that went to fee credit
	// shows its whole amount here with no fees: see HasChannel.
	ReceivedSat int64 `json:"receivedSat"`
	FeesMsat    int64 `json:"fees"`        // the channel's fee taken from it, if any
	CompletedAt int64 `json:"completedAt"` // unix ms
}

// CreditMsat is what the payment brought in: ReceivedSat, which is already
// net of the fees.
func (p Incoming) CreditMsat() int64 { return p.ReceivedSat * 1000 }

func (c *Client) IncomingPayment(ctx context.Context, paymentHash string) (Incoming, bool, error) {
	var p Incoming
	found, err := c.call(ctx, c.HTTP, "GET", "/payments/incoming/"+url.PathEscape(paymentHash), nil, &p, true)
	return p, found, err
}

// ListIncoming lists received payments completed at or after fromMs (unix ms).
func (c *Client) ListIncoming(ctx context.Context, fromMs int64, limit, offset int) ([]Incoming, error) {
	var ps []Incoming
	q := url.Values{"from": {strconv.FormatInt(fromMs, 10)}, "limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa(offset)}}
	_, err := c.call(ctx, c.HTTP, "GET", "/payments/incoming?"+q.Encode(), nil, &ps, false)
	return ps, err
}

// PayResult is payinvoice's and payoffer's answer.
type PayResult struct {
	Sent bool
	// PaymentID is phoenixd's id for a payment that was sent (a UUID): what
	// OutgoingByID reads it by. A failed one is answered without.
	PaymentID string
	// PaymentHash is the payment's hash when phoenixd says it: always for an
	// invoice; for an offer, once its invoice came (a failure before that has none).
	PaymentHash string
	// RecipientSat is what the payee was paid, when sent.
	RecipientSat int64
	Reason       string // why it failed
}

// PayInvoice pays a bolt11 invoice and waits for the outcome. amountSat is
// for an invoice without an amount (0 otherwise: the invoice's own amount is
// paid). An error wrapping ErrRefused means nothing was sent; any other error
// means the outcome is unknown: ask OutgoingByHash later.
func (c *Client) PayInvoice(ctx context.Context, bolt11 string, amountSat int64) (PayResult, error) {
	form := url.Values{"invoice": {bolt11}}
	if amountSat > 0 {
		form.Set("amountSat", strconv.FormatInt(amountSat, 10))
	}
	return c.pay(ctx, "/payinvoice", form)
}

// PayOffer pays a BOLT12 offer amountSat and waits for the outcome (the
// invoice fetch, then the payment). As PayInvoice: an error wrapping
// ErrRefused means nothing was sent; any other error means the outcome is
// unknown, and the payment is found in ListOutgoing later.
func (c *Client) PayOffer(ctx context.Context, offer string, amountSat int64) (PayResult, error) {
	return c.pay(ctx, "/payoffer", url.Values{"offer": {offer}, "amountSat": {strconv.FormatInt(amountSat, 10)}})
}

// pay is payinvoice's and payoffer's call: one answer shape for both
// (phoenixd's ApiType.PaymentSent and PaymentFailed, json/JsonSerializers.kt).
func (c *Client) pay(ctx context.Context, path string, form url.Values) (PayResult, error) {
	var out struct {
		PaymentPreimage    string `json:"paymentPreimage"`
		PaymentID          string `json:"paymentId"`
		PaymentHash        string `json:"paymentHash"`
		RecipientAmountSat int64  `json:"recipientAmountSat"`
		Reason             string `json:"reason"`
	}
	if _, err := c.call(ctx, c.Pay, "POST", path, form, &out, false); err != nil {
		return PayResult{}, err
	}
	if out.PaymentPreimage != "" {
		return PayResult{Sent: true, PaymentID: out.PaymentID, PaymentHash: out.PaymentHash, RecipientSat: out.RecipientAmountSat}, nil
	}
	return PayResult{PaymentHash: out.PaymentHash, Reason: out.Reason}, nil
}

// OutgoingStatus is where a payment phoenixd made stands.
type OutgoingStatus int

const (
	OutgoingNone    OutgoingStatus = iota // phoenixd has no record of it
	OutgoingPending                       // still in flight
	OutgoingPaid
	OutgoingFailed
)

// Outgoing is a payment phoenixd made, as its own record has it.
type Outgoing struct {
	Status   OutgoingStatus
	FeesMsat int64
	// Preimage is the proof of a paid payment, as phoenixd's record gives it
	// ("" without).
	Preimage string
	// CreatedAt is when phoenixd took the payment up and CompletedAt when it
	// ended, paid or failed (zero while it is on its way, and for one
	// phoenixd has no record of).
	CreatedAt, CompletedAt time.Time
}

// OutgoingByID reads a payment out by the id payinvoice answered with: the
// API's "Get outgoing payment",
// https://phoenix.acinq.co/server/api#get-outgoing-payment. An id phoenixd
// has no record of is OutgoingNone. The record's "preimage" field
// (phoenixd's ApiType.OutgoingPayment, json/JsonSerializers.kt) is Preimage.
func (c *Client) OutgoingByID(ctx context.Context, paymentID string) (Outgoing, error) {
	return c.outgoing(ctx, "/payments/outgoing/"+url.PathEscape(paymentID))
}

// OutgoingByHash reads a payment out by its payment hash, for one whose id
// isn't known (payinvoice gave no answer): the best of that hash's attempts,
// a paid one before one on its way before a failed one.
func (c *Client) OutgoingByHash(ctx context.Context, paymentHash string) (Outgoing, error) {
	return c.outgoing(ctx, "/payments/outgoingbyhash/"+url.PathEscape(paymentHash))
}

// outgoingJSON is one payment out as phoenixd's outgoing routes give it
// (ApiType.OutgoingPayment, json/JsonSerializers.kt).
type outgoingJSON struct {
	SubType     string `json:"subType"`
	PaymentID   string `json:"paymentId"`
	PaymentHash string `json:"paymentHash"`
	IsPaid      bool   `json:"isPaid"`
	SentSat     int64  `json:"sent"`
	FeesMsat    int64  `json:"fees"`
	CreatedAt   int64  `json:"createdAt"` // unix ms, as completedAt
	CompletedAt *int64 `json:"completedAt"`
	Preimage    string `json:"preimage"`
}

func (out outgoingJSON) outgoing() Outgoing {
	o := Outgoing{Status: OutgoingPending}
	if out.CreatedAt > 0 {
		o.CreatedAt = time.UnixMilli(out.CreatedAt)
	}
	if out.CompletedAt != nil {
		o.Status, o.CompletedAt = OutgoingFailed, time.UnixMilli(*out.CompletedAt)
	}
	if out.IsPaid {
		o.Status, o.FeesMsat, o.Preimage = OutgoingPaid, out.FeesMsat, out.Preimage
	}
	return o
}

func (c *Client) outgoing(ctx context.Context, path string) (Outgoing, error) {
	var out outgoingJSON
	found, err := c.call(ctx, c.HTTP, "GET", path, nil, &out, true)
	if err != nil {
		return Outgoing{}, err
	}
	if !found {
		return Outgoing{Status: OutgoingNone}, nil
	}
	return out.outgoing(), nil
}

// OutgoingRecord is one payment out in phoenixd's list: its state, and what
// tells it apart. SubType is "lightning" for a Lightning payment (an on-chain
// one has no hash); SentSat is amount + fee in whole sats, rounded down.
type OutgoingRecord struct {
	Outgoing
	ID, Hash, SubType string
	SentSat           int64
}

// ListOutgoing lists payments out created between fromMs and toMs (unix ms),
// pending ones included (all=true: phoenixd lists only succeeded ones
// without it), limit at a time from offset. phoenixd's query names no
// order (no ORDER BY), so rows come in its table's own order; that table is
// append-only, its rows updated in place, so paging by offset over a list
// that grows can't skip a record. A caller still counts each id once.
func (c *Client) ListOutgoing(ctx context.Context, fromMs, toMs int64, limit, offset int) ([]OutgoingRecord, error) {
	q := url.Values{"from": {strconv.FormatInt(fromMs, 10)}, "to": {strconv.FormatInt(toMs, 10)},
		"limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa(offset)}, "all": {"true"}}
	var raw []outgoingJSON
	if _, err := c.call(ctx, c.HTTP, "GET", "/payments/outgoing?"+q.Encode(), nil, &raw, false); err != nil {
		return nil, err
	}
	out := make([]OutgoingRecord, 0, len(raw))
	for _, r := range raw {
		out = append(out, OutgoingRecord{Outgoing: r.outgoing(), ID: r.PaymentID, Hash: r.PaymentHash, SubType: r.SubType, SentSat: r.SentSat})
	}
	return out, nil
}

// BalanceSat is phoenixd's spendable balance: fee credit is not in it, and
// a payment on its way out is already taken off.
func (c *Client) BalanceSat(ctx context.Context) (int64, error) {
	b, err := c.balance(ctx)
	return b.BalanceSat, err
}

type balanceJSON struct {
	BalanceSat   int64 `json:"balanceSat"`
	FeeCreditSat int64 `json:"feeCreditSat"`
}

func (c *Client) balance(ctx context.Context) (balanceJSON, error) {
	var out balanceJSON
	_, err := c.call(ctx, c.HTTP, "GET", "/getbalance", nil, &out, false)
	return out, err
}

type channelJSON struct {
	State      string `json:"state"`
	InboundSat int64  `json:"inboundLiquiditySat"`
}

// open reports whether a channel is open or opening. Offline and Syncing
// (phoenixd reconnecting) count: they wrap a channel that still exists.
func (ch channelJSON) open() bool {
	switch ch.State {
	case "Closing", "Closed", "Aborted":
		return false
	}
	return true
}

func (c *Client) channels(ctx context.Context) ([]channelJSON, error) {
	var info struct {
		Channels []channelJSON `json:"channels"`
	}
	_, err := c.call(ctx, c.HTTP, "GET", "/getinfo", nil, &info, false)
	return info.Channels, err
}

// HasChannel reports whether phoenixd has a channel. A payment received with
// no fees while it has none went to fee credit: phoenixd opens a channel for
// every payment that can pay for one.
func (c *Client) HasChannel(ctx context.Context) (bool, error) {
	chans, err := c.channels(ctx)
	if err != nil {
		return false, err
	}
	for _, ch := range chans {
		if ch.open() {
			return true, nil
		}
	}
	return false, nil
}

// Room is what phoenixd's channels can take in now, from its channels alone.
type Room struct {
	Channel    bool  // phoenixd has a channel (it may be reconnecting)
	Normal     bool  // and one is up, so phoenixd has heard from ACINQ since it started
	InboundSat int64 // what fits without buying more
}

// Room asks phoenixd for its channels' room (getinfo only).
func (c *Client) Room(ctx context.Context) (Room, error) {
	chans, err := c.channels(ctx)
	if err != nil {
		return Room{}, err
	}
	var r Room
	for _, ch := range chans {
		if ch.open() {
			r.Channel = true
			r.Normal = r.Normal || ch.State == "Normal"
			r.InboundSat += ch.InboundSat
		}
	}
	return r, nil
}

// FeeCreditSat is phoenixd's fee credit: money set aside toward a channel or
// more room, on no account. phoenixd learns it from ACINQ: after a restart
// it reads 0 until phoenixd has reconnected, and after a payment was set
// aside it rises only once ACINQ has confirmed it.
func (c *Client) FeeCreditSat(ctx context.Context) (int64, error) {
	b, err := c.balance(ctx)
	return b.FeeCreditSat, err
}

// Liquidity is what the app shows before a first top-up.
type Liquidity struct {
	Channel    bool  // phoenixd has a channel (it may be reconnecting)
	Usable     bool  // and it is up (Normal)
	InboundSat int64 // what it can receive without buying more
	// FeeCreditSat is money phoenixd keeps toward its next channel fee; it
	// can't be spent and is on no card.
	FeeCreditSat int64
	// FirstChannelFeeSat is phoenixd's own estimate of the fee for the
	// first 2M sat channel (mining + service); 0 once there is a channel.
	FirstChannelFeeSat int64
}

func (c *Client) Liquidity(ctx context.Context) (Liquidity, error) {
	chans, err := c.channels(ctx)
	if err != nil {
		return Liquidity{}, err
	}
	var l Liquidity
	for _, ch := range chans {
		if ch.open() {
			l.Channel = true
			l.Usable = l.Usable || ch.State == "Normal"
			l.InboundSat += ch.InboundSat
		}
	}
	b, err := c.balance(ctx)
	if err != nil {
		return Liquidity{}, err
	}
	l.FeeCreditSat = b.FeeCreditSat
	if !l.Channel {
		var fees struct {
			MiningFeeSat  int64 `json:"miningFeeSat"`
			ServiceFeeSat int64 `json:"serviceFeeSat"`
		}
		if _, err := c.call(ctx, c.HTTP, "GET", "/estimateliquidityfees?amountSat=2000000", nil, &fees, false); err != nil {
			return Liquidity{}, err
		}
		l.FirstChannelFeeSat = fees.MiningFeeSat + fees.ServiceFeeSat
	}
	return l, nil
}
