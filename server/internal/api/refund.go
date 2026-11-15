package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/boltcard/karto/server/internal/deviceauth"
	"github.com/boltcard/karto/server/internal/ledger"
	"github.com/boltcard/karto/server/internal/lnaddr"
	"github.com/boltcard/karto/server/internal/store"
)

// Refunds of till sales.

var (
	errBadReturnLink = errors.New("api: a link to this server that isn't one of its refund links")
	errWrongAmount   = errors.New("api: not the sale's amount")
)

// maxReturnLink is the longest return link a till may send.
const maxReturnLink = 2000

// returnLinkOf checks a till's return link and gives it as https: "" for
// none; lnurlp:// (LUD-17's form, as LUD-19's payLink is) becomes https://.
func returnLinkOf(link string) (string, error) {
	link = strings.TrimSpace(link)
	lower := strings.ToLower(link)
	switch {
	case link == "":
		return "", nil
	case len(link) > maxReturnLink:
		return "", fmt.Errorf("%w: a return link is at most %d characters", errBadRequest, maxReturnLink)
	case strings.HasPrefix(lower, "lnurlp://"):
		link = "https://" + link[len("lnurlp://"):]
	case !strings.HasPrefix(lower, "https://"):
		return "", fmt.Errorf("%w: a return link is lnurlp:// or https://", errBadRequest)
	}
	if u, err := url.Parse(link); err != nil || u.Host == "" {
		return "", fmt.Errorf("%w: a return link is a URL", errBadRequest)
	}
	return link, nil
}

// saleCard is the till's card step: its optional body names the
// card's return link. An old till sends none, which is no link.
func (a *api) saleCard(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		writeError(w, err)
		return
	}
	var req struct {
		ReturnLink string `json:"returnLink"`
	}
	if len(bytes.TrimSpace(body)) > 0 {
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed", "message": err.Error()})
			return
		}
	}
	link, err := returnLinkOf(req.ReturnLink)
	if err != nil {
		writeError(w, err)
		return
	}
	a.saleStep(w, r, func(ctx context.Context, id, device string) (store.Sale, error) {
		return a.money.Store.SaleCard(ctx, id, device, link)
	})
}

var refundPath = regexp.MustCompile(`^/refund/([0-9a-f]{32})$`)

// isOwnName reports whether host is this server's name, written with or
// without DNS's trailing dot.
func (a *api) isOwnName(host string) bool {
	return strings.EqualFold(strings.TrimSuffix(host, "."), a.money.Host)
}

// ownHost reports whether to names this server: a link whose host, or an
// address whose domain, is cardd's own name (a trailing dot or not), or a
// link to this server's IP address (meta vm.ipv4, written at install and
// restore). A Lightning address can't be an IP: it needs a TLD.
func (a *api) ownHost(ctx context.Context, to string) bool {
	if lnaddr.IsAddress(to) {
		_, domain, _ := strings.Cut(to, "@")
		return a.isOwnName(domain)
	}
	u, err := url.Parse(to)
	if err != nil {
		return false
	}
	if a.isOwnName(u.Hostname()) {
		return true
	}
	ip, err := a.money.Store.GetMeta(ctx, "vm.ipv4")
	return err == nil && ip != "" && u.Hostname() == ip
}

// ownCard is the card a link pays into when it is one of this server's live
// refund links ("own" means a known token, not "our host").
func (a *api) ownCard(ctx context.Context, link string) (store.Card, bool) {
	u, err := url.Parse(link)
	if err != nil || !strings.EqualFold(u.Scheme, "https") || !a.isOwnName(u.Hostname()) {
		return store.Card{}, false
	}
	m := refundPath.FindStringSubmatch(u.Path)
	if m == nil {
		return store.Card{}, false
	}
	c, err := a.money.Store.RefundLinkCard(ctx, m[1])
	return c, err == nil
}

// returnAddressJSON is what the owner sees of a sale's return link: another
// server's host, or one of this server's cards.
type returnAddressJSON struct {
	Host string         `json:"host,omitempty"`
	Card *returnCardRef `json:"card,omitempty"`
}

type returnCardRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (a *api) returnAddress(ctx context.Context, link string) *returnAddressJSON {
	if link == "" {
		return nil
	}
	if c, ok := a.ownCard(ctx, link); ok {
		// A card of this wallet that can't take money now (wiped since the
		// sale) is no return address: the wallet asks for an invoice instead.
		if c.State != store.StateActive && c.State != store.StateFrozen {
			return nil
		}
		return &returnAddressJSON{Card: &returnCardRef{ID: c.ID, Name: c.Name}}
	}
	u, err := url.Parse(link)
	if err != nil {
		return nil
	}
	return &returnAddressJSON{Host: strings.ToLower(u.Hostname())}
}

// refundJSON is a sale's refund on the wire: pending while its hold
// is open, paid once booked; nil (null) for none.
type refundJSON struct {
	State      string `json:"state"`
	TxID       int64  `json:"txId,omitempty"`
	At         int64  `json:"at,omitempty"`
	AmountMsat int64  `json:"amountMsat,omitempty"`
	From       string `json:"from,omitempty"`
}

func refundOut(txID int64, pending bool, at time.Time, msat int64, from store.Account) *refundJSON {
	switch {
	case txID != 0:
		return &refundJSON{State: "paid", TxID: txID, At: at.Unix(), AmountMsat: msat, From: accountName(from)}
	case pending:
		return &refundJSON{State: "pending"}
	}
	return nil
}

func saleRefundOut(s store.Sale) *refundJSON {
	var at time.Time
	if s.RefundAt != nil {
		at = *s.RefundAt
	}
	return refundOut(s.RefundTxID, s.RefundPending, at, s.RefundMsat, s.RefundFrom)
}

// refundAmountOK checks a refund's amount: the sale's own sats, or,
// for a sale priced in a currency, its price at cardd's rate now within 2%.
// figure is what the server would pay, for wrong_amount. With no rate, or
// another currency since, only the sale's sats.
func (a *api) refundAmountOK(ctx context.Context, s store.Sale, msat int64) (ok bool, figure int64) {
	if msat == s.AmountMsat {
		return true, msat
	}
	figure = s.AmountMsat
	if s.PriceCurrency != "" {
		if at, _, err := a.money.priced(ctx, priceJSON{Currency: s.PriceCurrency, Minor: s.PriceMinor}); err == nil {
			figure = at
			d := msat - at
			if d < 0 {
				d = -d
			}
			if d*100 <= at*2 {
				return true, at
			}
		}
	}
	return false, figure
}

// refundSale refunds a paid till sale, whole: to the sale's return
// link, or to the invoice, address, link or offer the owner gives; from
// shop or pool as Check showed, never switched; once per sale.
func (a *api) refundSale(w http.ResponseWriter, r *http.Request) {
	if deviceauth.RoleOf(r.Context()) != deviceauth.Owner {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not_allowed", "message": "only the wallet refunds a sale"})
		return
	}
	saleID, ok := saleID(w, r)
	if !ok {
		return
	}
	var req struct {
		ID         string  `json:"id"`
		AmountMsat int64   `json:"amountMsat"`
		From       string  `json:"from"`
		To         *string `json:"to"`
	}
	body, ok := readBody(w, r, &req)
	if !ok {
		return
	}
	// The phone's offset east of UTC, for the note's time: in the query, which an older cardd ignores, as
	// sales/days takes it; anything else is no offset.
	var offset *int
	if v, err := strconv.Atoi(r.URL.Query().Get("offset")); err == nil && v >= -840 && v <= 840 {
		offset = &v
	}
	a.once(w, r, req.ID, body, func() (int, any) {
		m := a.money
		ctx, cancel := context.WithTimeout(r.Context(), m.SendWait)
		defer cancel()
		ref := "request:" + req.ID
		// A retry after a dropped connection answers the payment it made.
		if h, err := m.Store.HoldByRef(ctx, ref); err == nil {
			return sendAnswer(holdOutcome(h))
		} else if !errors.Is(err, store.ErrNotFound) {
			return errorAnswer(err)
		}
		var from store.Account
		switch req.From {
		case "shop":
			from = store.Shop
		case "pool":
			from = store.Pool
		default:
			return errorAnswer(fmt.Errorf("%w: from is shop or pool", errBadRequest))
		}
		s, err := m.Store.SaleByID(ctx, saleID)
		if err != nil {
			return errorAnswer(err)
		}
		if s.State != store.SalePaid {
			return errorAnswer(store.ErrNotPaid)
		}
		if ok, figure := a.refundAmountOK(ctx, s, req.AmountMsat); !ok {
			return http.StatusConflict, map[string]any{"error": "wrong_amount", "message": errWrongAmount.Error(), "amountMsat": figure}
		}
		to := s.ReturnLink
		if req.To != nil {
			to = strings.TrimSpace(*req.To)
		}
		if to == "" {
			return errorAnswer(fmt.Errorf("%w: the sale has no return link: give an invoice or an address", errBadRequest))
		}
		if c, own := a.ownCard(ctx, to); own {
			// One of this server's cards: booked inside it, no fee.
			if _, err := m.Store.RefundToCard(ctx, ref, saleID, from, c.ID, req.AmountMsat); err != nil {
				return errorAnswer(err)
			}
			return http.StatusOK, map[string]any{"status": "sent", "amountMsat": req.AmountMsat, "feeMsat": 0, "paymentHash": ""}
		}
		if a.ownHost(ctx, to) {
			return errorAnswer(errBadReturnLink)
		}
		// An invoice or offer for another amount is other_amount, from
		// payOut's own decode.
		// The customer's note: sent when their address or link takes one.
		name, err := m.Store.WalletName(ctx)
		if err != nil {
			return errorAnswer(err)
		}
		var paidAt time.Time
		if s.PaidAt != nil {
			paidAt = *s.PaidAt
		}
		return a.payOut(ctx, ref, from, store.KindRefund, to, "", req.AmountMsat, store.HoldAbout{SaleID: saleID}, refundNote(name, paidAt, offset))
	})
}

// holdOutcome is a hold's state as a send's or a refund's answer says it.
func holdOutcome(h store.Hold) ledger.Outcome {
	return ledger.Outcome{Hold: h, Pending: h.State == store.HoldOpen}
}
