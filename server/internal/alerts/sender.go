package alerts

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/boltcard/karto/server/internal/rates"
	"github.com/boltcard/karto/server/internal/store"
	"github.com/boltcard/karto/server/internal/webpush"
)

// Store is the slice of the store the sender uses.
type Store interface {
	Reader
	PushEndpointOf(ctx context.Context, keyID string) (store.PushEndpoint, error)
	OwnerPushEndpoints(ctx context.Context) ([]store.PushEndpoint, error)
	DeletePushEndpoint(ctx context.Context, keyID string) error
	PushDelivered(ctx context.Context, keyID string, at time.Time) error
	PushFailed(ctx context.Context, keyID string, at time.Time, why string) error
	VAPIDKey(ctx context.Context) (string, error)
}

// DefaultSubject is the VAPID subject when Sender.Subject is "".
const DefaultSubject = "mailto:alerts@karto.invalid"

// ErrGone: the push service said the endpoint is gone (404 or 410), and it
// was deleted; the phone registers again when the app opens.
var ErrGone = errors.New("alerts: the push service says the endpoint is gone")

// errNotSent: cardd itself couldn't make the message (encrypting it
// failed); logged, not booked against the endpoint.
var errNotSent = errors.New("alerts: the message wasn't made")

const (
	queueSize       = 256     // jobs waiting for Run
	deviceQueueSize = 64      // messages waiting for one device's worker
	ttl             = "86400" // 24 h, as ntfy's cache
	vapidLife       = 12 * time.Hour
	endpointsRetry  = 10 * time.Second // a refusal's job, after the endpoints couldn't be read
)

// retryDelays are the waits before each retry of a failed send: about a
// minute in all, then a failure in a row.
var retryDelays = []time.Duration{2 * time.Second, 10 * time.Second, 45 * time.Second}

// Sender sends the owner's phones their alerts. Posted and
// Refused only queue, and never wait; Run builds each alert and hands it to
// each owner device's own worker, which sends that device's messages in
// order, so a device whose push service is slow or down never holds up
// another's, and a retry waits on a timer of its own. Each endpoint is read
// when its message is sent, not when queued, so a phone revoked meanwhile
// gets nothing.
//
// An endpoint whose origin is NtfyPublic, the server's own ntfy, must be a
// UnifiedPush topic: it is posted to NtfyInternal (inside the stack) with
// the topic's path and "?up=1" and NtfyToken as a bearer token, ntfy taking
// no VAPID. Any other is checked (Check, CheckEndpoint by default), signed
// with the server's VAPID key and posted with HTTP, by default a client
// that refuses addresses that aren't public.
type Sender struct {
	Store                               Store
	Prices                              func() (rates.Prices, bool)
	HTTP                                *http.Client
	NtfyPublic, NtfyInternal, NtfyToken string
	Subject                             string
	Log                                 *log.Logger
	Now                                 func() time.Time
	Check                               func(string) error

	// Test seams: after runs fn in d (time.AfterFunc); onJob is told each
	// job Run handled, onSend each message a device's worker handled.
	after  func(d time.Duration, fn func())
	onJob  func()
	onSend func()

	once     sync.Once
	queue    chan job
	folds    folds
	guarded  *http.Client
	internal *http.Client

	mu      sync.Mutex
	devices map[string]chan message // each device's worker's queue, by key id
}

// job is one thing to send: a committed transaction (tx), a card's
// refusals (card), its open notification or the hour's summary, or a
// payload made elsewhere (payload, at urg: hosting's low-funding alert).
type job struct {
	tx      int64
	card    string
	summary bool
	payload *Payload
	urg     Urgency
}

// message is one alert for one device, on its try'th try (0 the first).
// card, tag and gen are a refusal notification's, so a retry of it is
// dropped once a newer count of it was taken to send.
type message struct {
	keyID     string
	plain     []byte
	urg       Urgency
	try       int
	card, tag string
	gen       int
}

func (s *Sender) setup() {
	s.once.Do(func() {
		s.queue = make(chan job, queueSize)
		s.devices = map[string]chan message{}
		s.guarded = s.HTTP
		s.internal = s.HTTP
		if s.HTTP == nil {
			s.guarded, s.internal = guardedClient(), internalClient()
		}
		if s.after == nil {
			s.after = func(d time.Duration, fn func()) { time.AfterFunc(d, fn) }
		}
	})
}

func (s *Sender) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Sender) logf(format string, args ...any) {
	if s.Log != nil {
		s.Log.Printf(format, args...)
	} else {
		log.Printf(format, args...)
	}
}

func (s *Sender) enqueue(j job) bool {
	s.setup()
	select {
	case s.queue <- j:
		return true
	default:
		return false
	}
}

// Posted queues committed transactions for their alerts: the store's Posted
// hook. It never waits; with the queue full, the rest are dropped and logged.
func (s *Sender) Posted(ids []int64) {
	dropped := 0
	for _, id := range ids {
		if !s.enqueue(job{tx: id}) {
			dropped++
		}
	}
	if dropped > 0 {
		s.logf("alerts: queue full: %d transactions not alerted", dropped)
	}
}

// Send queues a payload made elsewhere for every owner device (hosting's
// low-funding alert). It never waits: false when the queue was full and
// the payload was dropped (the caller logs it and tries again later).
func (s *Sender) Send(p Payload, urg Urgency) bool {
	return s.enqueue(job{payload: &p, urg: urg})
}

// Refused counts a refused tap of a known card, called from the
// terminal's request: it takes a lock briefly and never waits.
func (s *Sender) Refused(r Refusal) {
	s.setup()
	queue, summaryAt := s.folds.add(r)
	if !summaryAt.IsZero() {
		s.after(summaryAt.Sub(s.now()), func() {
			if !s.enqueue(job{card: r.CardID, summary: true}) {
				s.folds.summary(r.CardID)
				s.logf("alerts: queue full: the hour's summary of card %s not alerted", r.CardID)
			}
		})
	}
	if queue && !s.enqueue(job{card: r.CardID}) {
		s.folds.unqueue(r.CardID)
		s.logf("alerts: queue full: a refused tap of card %s not alerted", r.CardID)
	}
}

// Run builds what is queued and hands it to the devices' workers until ctx
// ends; the workers stop with it.
func (s *Sender) Run(ctx context.Context) {
	s.setup()
	for {
		select {
		case <-ctx.Done():
			return
		case j := <-s.queue:
			s.handle(ctx, j)
			if s.onJob != nil {
				s.onJob()
			}
		}
	}
}

func (s *Sender) handle(ctx context.Context, j job) {
	// The endpoints before the payload: a refusal's payload takes its card's
	// fold, and a store error after that would lose its count.
	eps, err := s.Store.OwnerPushEndpoints(ctx)
	if err != nil {
		s.logf("alerts: reading the endpoints: %v", err)
		s.again(j)
		return
	}
	p, urg, gen, ok, err := s.payload(ctx, j)
	if err != nil {
		s.logf("alerts: %v", err)
	}
	if !ok {
		return
	}
	plain, err := json.Marshal(p)
	if err != nil {
		s.logf("alerts: %v", err)
		return
	}
	for _, ep := range eps {
		m := message{keyID: ep.KeyID, plain: plain, urg: urg}
		if p.Kind == "refused" {
			m.card, m.tag, m.gen = j.card, p.Tag, gen
		}
		s.toDevice(ctx, m)
	}
}

// again tries a card's refusal job once more in endpointsRetry, its fold
// untaken: the open notification still waits in the queue, so the card's
// refusals meanwhile join its count, and the hour's summary still holds
// them. With the queue full then, as in Refused. A transaction's job is
// not tried again.
func (s *Sender) again(j job) {
	if j.card == "" {
		return
	}
	s.after(endpointsRetry, func() {
		if s.enqueue(j) {
			return
		}
		if j.summary {
			s.folds.summary(j.card)
		} else {
			s.folds.unqueue(j.card)
		}
		s.logf("alerts: queue full: card %s's refusals not alerted", j.card)
	})
}

// payload is what a job sends, false for nothing; gen is a refusal
// notification's generation (0 for anything else).
func (s *Sender) payload(ctx context.Context, j job) (p Payload, urg Urgency, gen int, ok bool, err error) {
	if j.payload != nil {
		return *j.payload, j.urg, 0, true, nil
	}
	if j.tx != 0 {
		p, urg, ok, err = Build(ctx, Source{Store: s.Store, Prices: s.Prices}, j.tx, s.now())
		if err != nil {
			err = fmt.Errorf("transaction %d: %w", j.tx, err)
		}
		return p, urg, 0, ok, err
	}
	take := s.folds.take
	if j.summary {
		take = s.folds.summary
	}
	t, ok := take(j.card)
	if !ok {
		return Payload{}, "", 0, false, nil
	}
	card, err := s.Store.GetCard(ctx, j.card)
	if errors.Is(err, store.ErrNotFound) {
		return Payload{}, "", 0, false, nil
	}
	if err != nil {
		return Payload{}, "", 0, false, fmt.Errorf("card %s: %w", j.card, err)
	}
	return refusalPayload(t, card.Name), UrgencyHigh, t.gen, true, nil
}

// toDevice puts m on its device's worker's queue, starting the worker on
// the device's first message. It never waits: with the queue full, m is
// dropped and logged.
func (s *Sender) toDevice(ctx context.Context, m message) {
	s.setup()
	s.mu.Lock()
	ch, ok := s.devices[m.keyID]
	if !ok {
		ch = make(chan message, deviceQueueSize)
		s.devices[m.keyID] = ch
		go s.work(ctx, ch)
	}
	s.mu.Unlock()
	select {
	case ch <- m:
	default:
		s.logf("alerts: device %s's queue full: an alert dropped", m.keyID)
	}
}

// work sends one device's messages in order until ctx ends.
func (s *Sender) work(ctx context.Context, ch chan message) {
	for {
		select {
		case <-ctx.Done():
			return
		case m := <-ch:
			s.deliver(ctx, m)
			if s.onSend != nil {
				s.onSend()
			}
		}
	}
}

// deliver reads m's device's endpoint, sends m to it, and books what the
// push service said: a delivery, the endpoint gone, or a failure, retried on
// a timer while retryDelays lasts. A device with no endpoint now (revoked,
// or alerts turned off) gets nothing, and a retry of a refusal's count that
// a newer count replaced is dropped.
func (s *Sender) deliver(ctx context.Context, m message) {
	if m.try > 0 && s.folds.superseded(m.card, m.tag, m.gen) {
		return
	}
	ep, err := s.Store.PushEndpointOf(ctx, m.keyID)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			s.logf("alerts: reading device %s's endpoint: %v", m.keyID, err)
		}
		return
	}
	err = s.send(ctx, ep, m.plain, m.urg)
	switch {
	case ctx.Err() != nil:
		return // cardd is stopping
	case errors.Is(err, errNotSent):
		s.logf("alerts: device %s: %v", m.keyID, err)
		return
	case err == nil || errors.Is(err, ErrGone) || errors.Is(err, ErrBadEndpoint) || errors.Is(err, ErrNtfySh) || m.try >= len(retryDelays):
		s.book(ctx, m.keyID, err)
		return
	}
	delay := retryDelays[m.try]
	m.try++
	s.after(delay, func() {
		if ctx.Err() == nil {
			s.toDevice(ctx, m)
		}
	})
}

// book records a send's outcome on the endpoint.
func (s *Sender) book(ctx context.Context, keyID string, sent error) {
	var err error
	switch {
	case sent == nil:
		err = s.Store.PushDelivered(ctx, keyID, s.now())
	case errors.Is(sent, ErrGone):
		s.logf("alerts: device %s: %v; endpoint deleted", keyID, sent)
		err = s.Store.DeletePushEndpoint(ctx, keyID)
	default:
		s.logf("alerts: device %s: %v", keyID, sent)
		err = s.Store.PushFailed(ctx, keyID, s.now(), sent.Error())
	}
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.logf("alerts: booking device %s's send: %v", keyID, err)
	}
}

// Test sends the device's phone the test alert ("Alerts work") now, once,
// and says whether its endpoint took it: store.ErrNotFound for no endpoint,
// ErrGone for one the push service no longer knows (now deleted).
func (s *Sender) Test(ctx context.Context, keyID string) error {
	s.setup()
	ep, err := s.Store.PushEndpointOf(ctx, keyID)
	if err != nil {
		return err
	}
	plain, err := json.Marshal(testPayload(s.now()))
	if err != nil {
		return err
	}
	err = s.send(ctx, ep, plain, UrgencyHigh)
	if errors.Is(err, errNotSent) {
		s.logf("alerts: device %s: %v", keyID, err)
		return err
	}
	s.book(ctx, keyID, err)
	return err
}

// send encrypts plain for ep and posts it once: nil for 200, 201 or 202,
// ErrGone for 404 or 410.
func (s *Sender) send(ctx context.Context, ep store.PushEndpoint, plain []byte, urg Urgency) error {
	p256dh, err1 := unb64(ep.P256dh)
	auth, err2 := unb64(ep.Auth)
	if err := errors.Join(err1, err2); err != nil {
		return fmt.Errorf("%w: its keys: %v", ErrBadEndpoint, err)
	}
	body, err := webpush.Encrypt(webpush.Subscription{Endpoint: ep.Endpoint, P256dh: p256dh, Auth: auth}, plain)
	if err != nil {
		return fmt.Errorf("%w: encrypting: %v", errNotSent, err)
	}
	target, client, authz, err := s.route(ctx, ep.Endpoint)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("%w: not a URL a request can be made to", ErrBadEndpoint)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("TTL", ttl)
	req.Header.Set("Urgency", string(urg))
	req.Header.Set("Authorization", authz)
	resp, err := client.Do(req)
	if err != nil {
		return postError(err)
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK, http.StatusCreated, http.StatusAccepted:
		return nil
	case http.StatusNotFound, http.StatusGone:
		return fmt.Errorf("%w (HTTP %d)", ErrGone, resp.StatusCode)
	}
	return fmt.Errorf("the push service answered HTTP %d", resp.StatusCode)
}

// route is where an endpoint's message is posted, with which client and
// Authorization: the server's own ntfy inside the stack with its token,
// any other endpoint as it is, checked, with VAPID.
func (s *Sender) route(ctx context.Context, endpoint string) (target string, client *http.Client, authz string, err error) {
	if s.NtfyPublic != "" && sameOrigin(endpoint, s.NtfyPublic) {
		u, err := url.Parse(endpoint)
		if err != nil {
			return "", nil, "", fmt.Errorf("%w: not a URL", ErrBadEndpoint)
		}
		topic, ok := ntfyTopic(u)
		if !ok || s.NtfyInternal == "" {
			return "", nil, "", fmt.Errorf("%w: not a topic of this server's ntfy", ErrBadEndpoint)
		}
		target = strings.TrimSuffix(s.NtfyInternal, "/") + topic + "?up=1" // ntfy-android Util.kt:58
		return target, s.internal, "Bearer " + s.NtfyToken, nil
	}
	check := s.Check
	if check == nil {
		check = func(raw string) error { return CheckEndpoint(raw, s.NtfyPublic) }
	}
	if err := check(endpoint); err != nil {
		return "", nil, "", err
	}
	key, err := s.Store.VAPIDKey(ctx)
	if err != nil {
		return "", nil, "", fmt.Errorf("the VAPID key: %w", err)
	}
	v, err := webpush.ParseVAPID(key)
	if err != nil {
		return "", nil, "", fmt.Errorf("the VAPID key: %w", err)
	}
	subject := s.Subject
	if subject == "" {
		subject = DefaultSubject
	}
	authz, err = v.Header(endpoint, subject, s.now().Add(vapidLife))
	if err != nil {
		return "", nil, "", fmt.Errorf("%w: no VAPID header for it", ErrBadEndpoint)
	}
	return endpoint, s.guarded, authz, nil
}

// postError is a failed post's error as it is logged and kept as the
// endpoint's failure: with the push service's origin only, never the
// endpoint's path, which is the device's topic or token. Go's *url.Error
// quotes the whole URL.
func postError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return fmt.Errorf("posting to %s: %w", originOf(ue.URL), ue.Err)
	}
	return fmt.Errorf("posting: %w", err)
}

// originOf is a URL's scheme and host, or "the push service" for one that
// doesn't parse.
func originOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "the push service"
	}
	return u.Scheme + "://" + u.Host
}

// unb64 reads base64url, padded or not.
func unb64(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}
